import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-stage-a-api-'));
const env = {
  PG_CONFIG_PATH: path.join(dir, 'config.json'),
  PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_LOG_DIR: path.join(dir, 'logs'),
  PG_DSH_HOME: path.join(dir, 'dsh'),
  PG_FISH_LATEST_PATH: path.join(dir, 'fish-latest.json'),
  PG_SECRETS_PATH: path.join(dir, 'credentials.json'),
};
const originalEnv = Object.entries(env).map(([key]) => [key, process.env[key]]);
Object.assign(process.env, env);
const { apply } = await import('../src/plugin.js');
const LATEST_PATH = env.PG_FISH_LATEST_PATH;
const { recordDay } = await import('../src/retention.js');
const { loadConfig, loadState, saveState } = await import('../src/config.js');
const { coldSlots, noteSent, settle, slotStats, sweep } = await import('../src/feedback.js');

const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
};
const now = Date.parse('2026-11-22T12:00:00+08:00');
const base = { enabled: true, dryRun: false, send: { enabled: true }, quietHours: [],
  rules: { minGapMin: 240, dailyCap: 3 },
  channels: { qq: { enabled: true, read: true, send: true, peerId: '10001', activeHours: [] } },
  sources: { phone: { enabled: true, staleHours: 36 } },
  perception: { signals: { enabled: false }, l3: { enabled: false } },
  content: { mode: 'fixed', fixedText: '试跑草稿' }, mail: { enabled: false },
};
write(env.PG_CONFIG_PATH, base);
const day = recordDay(now, base.timezone, loadConfig());
write(env.PG_STATE_PATH, { day, real: { todaySent: 0 }, sim: { todaySent: 3, lastSendAt: now },
  feedback: { streak: 1 }, chitchat: { count: 2 } });
const originalState = fs.readFileSync(env.PG_STATE_PATH, 'utf8');
const oldDecision = path.join(env.PG_LOG_DIR, 'decision-2000-01-01.jsonl');
write(oldDecision, { reason: 'old' });

test.beforeEach(t => t.mock.method(Date, 'now', () => now));

test.after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function start(t, services = {}) {
  let route;
  const all = {
    ...services,
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(r) { route = r; return () => {}; } },
  };
  const api = apply({ get: key => all[key], effect: fn => fn() }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());
  return async (method, endpoint, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: '/api/dsh-drop-by' + endpoint, headers });
    let result;
    const res = { setHeader() {}, end(raw) { result = JSON.parse(raw); } };
    await route.handler(req, res);
    return { status: res.statusCode, ...result };
  };
}

test('安全试跑连续放行旧 sim 冷却，真实模式下仍不发送、不改状态或日志', async (t) => {
  const request = start(t);
  const home = env.PG_DSH_HOME;
  write(path.join(home, 'qq-bridge', 'connection.json'), { httpApiUrl: 'http://127.0.0.1:1', httpToken: 'fixture' });
  const send = t.mock.method(globalThis, 'fetch', async () => { throw Error('unexpected network'); });
  const invalid = await request('POST', '/tick', JSON.stringify({ preview: true }));
  assert.equal(invalid.status, 400);
  for (const dryRun of [false, true]) {
    write(env.PG_CONFIG_PATH, { ...base, dryRun });
    for (let i = 0; i < 2; i++) {
      const result = await request('POST', '/tick', { preview: true });
      assert.equal(result.ok, true);
      assert.equal(result.preview, true);
      assert.equal(result.run.decision, 'send', result.run.why);
      assert.equal(result.run.text, '试跑草稿');
      assert.equal(result.run.delivery.attempted, false);
      assert.match(result.run.explanation.summary, /草稿/);
    }
  }
  assert.equal(send.mock.callCount(), 0);
  assert.equal(fs.readFileSync(env.PG_STATE_PATH, 'utf8'), originalState);
  assert.deepEqual(fs.readdirSync(env.PG_LOG_DIR).filter(f => f.startsWith('decision-')), [path.basename(oldDecision)]);
  assert.equal((await request('GET', '/state')).last, null);
});

test('默认配置从未收到鱼鱼邮件时，只在自检提示手机作息数据为可选', async (t) => {
  write(env.PG_CONFIG_PATH, {});
  const request = start(t);
  const diagnostic = await request('GET', '/diagnostics');
  assert.equal(diagnostic.status, 200);
  const phone = diagnostic.items.find(item => item.key === 'phone');
  assert.equal(phone.level, 'warn');
  assert.match(phone.detail, /未开启读邮箱.*暂未使用手机作息数据/);
  assert.equal(Object.hasOwn(phone, 'pausedSlots'), false);
  assert.ok(!diagnostic.alerts.some(item => item.key === 'phone'));
});

test('诊断列出缺失或超时的手机缓存、主通道与模型提示，并汇总日报', async (t) => {
  const request = start(t);
  write(env.PG_CONFIG_PATH, { ...base, mail: { enabled: true } });
  const record = { decision: 'skip', reason: 'NO_TOPIC', topicMisses: [{ slot: 'steps', reason: 'out_of_window' }] };
  fs.writeFileSync(path.join(env.PG_LOG_DIR, 'decision-' + day + '.jsonl'), JSON.stringify(record) + '\n');
  const missing = await request('GET', '/diagnostics');
  assert.equal(missing.status, 200);
  const missingPhone = missing.alerts.find(item => item.key === 'phone');
  assert.equal(missingPhone.ageHours, null);
  assert.equal(missingPhone.level, 'bad');
  assert.deepEqual(missingPhone.pausedSlots, ['sleep', 'stress', 'steps', 'screen']);
  assert.ok(missing.alerts.some(item => item.key === 'channel'));
  assert.ok(missing.alerts.some(item => item.key === 'llm'));
  assert.match(missing.reports[0].text, /还没到适用时段/);
  assert.equal(typeof missing.chitchat.effectivePerDay, 'number');
  write(LATEST_PATH, { dateTs: now - 74 * 3_600_000, fetchedAt: now });
  write(env.PG_CONFIG_PATH, base);
  const stale = await request('GET', '/diagnostics');
  const phone = stale.alerts.find(item => item.key === 'phone');
  assert.equal(phone.ageHours, 74);
  assert.equal(phone.level, 'warn');
  assert.match(phone.detail, /74 小时/);
  assert.deepEqual(phone.pausedSlots, ['sleep', 'stress', 'steps', 'screen']);
  write(env.PG_CONFIG_PATH, { ...base, sources: { phone: { staleGuard: false } } });
  assert.ok(!(await request('GET', '/diagnostics')).alerts.some(item => item.key === 'phone'));
});

test('连通检查读取实际配对和联系人绑定、模型和邮箱就绪，响应不带凭据', async (t) => {
  const request = start(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'test-model' }) },
    llm: { async *stream() { assert.fail('readiness must not call the model'); } },
  });
  const home = env.PG_DSH_HOME;
  write(path.join(home, 'node_modules', 'dsh-plugin-qq-bridge', 'package.json'), { name: 'dsh-plugin-qq-bridge' });
  write(path.join(home, 'qq-bridge', 'connection.json'), { httpApiUrl: 'http://127.0.0.1:1', httpToken: 'fixture' });
  write(path.join(home, 'qq-bridge', 'bindings.json'), { sessions: {
    wrong: { peerId: '20002', peerKind: 'private' },
  } });
  write(env.PG_SECRETS_PATH, { user: 'private@example.invalid', authCode: 'private-app-password' });
  write(env.PG_CONFIG_PATH, { ...base, mail: { enabled: true } });
  const saved = await request('POST', '/config', { path: 'channels.qq.peerId', value: ' 10001 ' });
  assert.equal(saved.value, '10001');
  const current = await request('GET', '/config');
  assert.equal(current.channelItems.find(item => item.path === 'channels.qq.peerId').value, '10001');
  const before = await request('POST', '/connectivity');
  assert.equal(before.status, 200);
  assert.equal(before.items.find(item => item.key === 'channel').level, 'bad');
  write(path.join(home, 'qq-bridge', 'bindings.json'), { sessions: {
    bound: { peerId: '10001', peerKind: 'private', enabled: true },
  } });
  const after = await request('POST', '/connectivity');
  assert.equal(after.items.find(item => item.key === 'channel').level, 'ok');
  assert.match(after.items.find(item => item.key === 'llm').detail, /test-provider.*test-model/);
  assert.equal(after.items.find(item => item.key === 'mail').level, 'ok');
  assert.doesNotMatch(JSON.stringify(after), /private@example|private-app-password/);
  for (const item of after.items) {
    assert.ok(['ok', 'warn', 'bad'].includes(item.level));
    for (const key of ['key', 'label', 'detail', 'actionHint']) assert.equal(typeof item[key], 'string');
  }
});

test('新增接口和预览沿用宿主准入检查', async (t) => {
  const request = start(t, { connection: { requestRejection: () => 401 } });
  for (const [method, endpoint] of [['GET', '/diagnostics'], ['POST', '/connectivity'], ['POST', '/tick']]) {
    const result = await request(method, endpoint, { preview: true });
    assert.equal(result.status, 401);
    assert.equal(result.error, 'UNAUTHORIZED');
  }
});

test('NO_TOPIC 的分由头原因进入日志和最近一拍快照', async (t) => {
  const request = start(t);
  const st = JSON.parse(originalState);
  st.sim = {};
  write(env.PG_STATE_PATH, st);
  write(env.PG_CONFIG_PATH, { ...base, dryRun: true, content: { mode: 'template', topics: { share: false, lateUp: false } } });
  fs.rmSync(LATEST_PATH, { force: true });
  const result = await request('POST', '/tick');
  assert.equal(result.run.why, 'NO_TOPIC');
  assert.deepEqual(result.run.topicMisses.find(item => item.slot === 'share'), { slot: 'share', reason: 'disabled' });
  assert.deepEqual((await request('GET', '/state')).last.topicMisses, result.run.topicMisses);
  const lines = fs.readFileSync(path.join(env.PG_LOG_DIR, 'decision-' + day + '.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(lines.at(-1)).topicMisses, result.run.topicMisses);
});

test('安全试跑返回实际用来写草稿的宿主模型及由头', async (t) => {
  const noon = Date.UTC(2026, 10, 21, 4);
  t.mock.method(Date, 'now', () => noon);
  let calls = 0;
  const request = start(t, {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test-provider', model: 'draft-model' }) },
    llm: { async *stream() {
      calls++;
      yield { type: 'text-delta', text: '要是想歇会儿，就把手上的事先放一放。' };
    } },
  });
  write(env.PG_CONFIG_PATH, { ...base, content: { mode: 'llm' } });
  const prior = {
    day: recordDay(noon, 'Asia/Shanghai', loadConfig()),
    sim: { todaySent: 3, lastSendAt: noon - 60_000 },
    content: { stressDay: '2026-11-21', stressCount: 1, lastStressAt: noon - 60_000, recentSlots: ['stress', 'stress'] },
  };
  write(env.PG_STATE_PATH, prior);
  write(LATEST_PATH, { dateTs: noon, summary: '压力 87' });
  const result = await request('POST', '/tick', { preview: true });
  assert.equal(result.run.decision, 'send', JSON.stringify(result));
  assert.equal(result.run.slot, 'stress');
  assert.equal(result.run.topicLabel, '压力');
  assert.deepEqual(result.run.llm, { via: 'host', provider: 'test-provider', model: 'draft-model' });
  assert.equal(result.run.text, '要是想歇会儿，就把手上的事先放一放。');
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(env.PG_STATE_PATH, 'utf8'), JSON.stringify(prior));
});

test('抖音连通检查按脚本、sec_uid、绑定和最近读取结果分级', async (t) => {
  write(env.PG_CONFIG_PATH, base);
  const request = start(t);
  const cfg = { ...base, channels: { primary: 'douyin', douyin: { peerSecUid: 'MS4w-test' } } };
  write(env.PG_CONFIG_PATH, cfg);
  const channel = async () => (await request('POST', '/connectivity')).items.find(item => item.key === 'channel');
  assert.match((await channel()).detail, /脚本/);
  const plugin = path.join(env.PG_DSH_HOME, 'node_modules', 'dsh-douyin-scroll');
  write(path.join(plugin, 'package.json'), { name: 'dsh-douyin-scroll' });
  for (const script of ['im-http.py', 'im-send.mjs']) write(path.join(plugin, 'tools', script), {});
  assert.match((await channel()).detail, /DSH 会话/);
  write(path.join(dir, 'data', 'external-chat.json'), { sessionId: 'fixture-session' });
  assert.equal((await channel()).level, 'warn');
  write(path.join(dir, 'data', 'douyin-im.json'), { 'MS4w-test': { polledAt: now } });
  assert.equal((await channel()).level, 'ok');
  write(path.join(env.PG_DSH_HOME, 'douyin-duty', 'config.json'), { chatWatch: true });
  assert.match((await channel()).detail, /原聊天盯梢还开着/);
});

test('接住率明细按真实发送时间定位，手动标记持久化、幂等且可撤销', async (t) => {
  const cfg = { ...base, timezone: 'Asia/Shanghai', rules: { feedback: { coldAfter: 1, coldRate: 0.75 } } };
  write(env.PG_CONFIG_PATH, cfg);
  const st = { feedback: { slots: { sleep: { sent: 2, replied: 1, missed: 1, latencySum: 600_000, pairs: [
    { ts: Date.parse('2026-11-21T11:10:00+08:00'), latencyMin: 10, kind: 'hit', herReply: '旧回复' },
  ] } } } };
  const sent = Date.parse('2026-11-22T11:10:00+08:00');
  const hour = 3_600_000;
  const options = { tz: cfg.timezone, cfg };
  noteSent(st, 'sleep', sent - 60_000, '主动消息原文', { sentAt: sent });
  sweep(st, sent + 5 * hour, options);
  noteSent(st, 'sleep', sent + 5 * hour, '另一条原文');
  settle(st, sent + 5 * hour + 600_000, sent + 5 * hour + 600_000, '这条真的回了', options);
  noteSent(st, 'sleep', sent + 6 * hour, '沉默豁免', { expect: false });
  settle(st, sent + 6 * hour + 600_000, sent + 6 * hour + 600_000, '豁免的回复', options);
  noteSent(st, 'sleep', sent + 7 * hour, '等待回应');
  write(env.PG_STATE_PATH, st);
  const request = start(t);
  const getSlot = async () => (await request('GET', '/diagnostics')).slots.find(row => row.slot === 'sleep');
  const patch = (id, received) => request('POST', '/feedback/receipt', { slot: 'sleep', id, received });
  let slot = await getSlot();
  assert.deepEqual([slot.replied, slot.sent, slot.missed], [2, 5, 2]);
  assert.deepEqual(slot.receipts.map(row => [row.at, row.received, row.manual]), [
    ['11-22日 18:10', null, false], ['11-22日 16:10', true, false], ['11-22日 11:10', false, false], ['11-21日 11:00', true, false],
  ]);
  assert.doesNotMatch(JSON.stringify(slot.receipts), /原文|真的回了|旧回复/);
  const [pending, automatic, missed] = slot.receipts;
  assert.equal(pending.status, 'pending');
  assert.equal(slot.unlistedMisses, 1);
  assert.equal((await patch(pending.id, true)).status, 409);
  assert.equal((await patch(automatic.id, false)).status, 409);
  assert.equal((await patch(automatic.id, true)).status, 409);
  assert.equal((await patch('missing-id', true)).status, 409);
  assert.equal((await patch(missed.id, 'true')).status, 400);

  st.feedback.slots.sleep.coldUntil = sent + 8 * hour;
  assert.ok(coldSlots(st, { rules: { feedback: { coldAfter: 1, coldRate: 0.5 } } }, sent + 7 * hour).has('sleep'));
  const result = await patch(missed.id, true);
  assert.equal(result.status, 200);
  assert.equal(result.slots.find(row => row.slot === 'sleep').replied, 3);
  assert.equal((await patch(missed.id, true)).status, 200);
  saveState(st); // 已在跑的 tick 仍拿着标记前的状态。
  slot = await getSlot();
  assert.deepEqual([slot.replied, slot.sent, slot.missed, slot.avgLatMin], [3, 5, 1, 10]);
  assert.equal(slot.unlistedMisses, 1);
  assert.deepEqual(slot.receipts.find(row => row.id === missed.id), { ...missed, received: true, manual: true });
  assert.ok(!coldSlots(loadState(), { rules: { feedback: { coldAfter: 1, coldRate: 0.5 } } }, sent + 7 * hour).has('sleep'));

  const staleTick = loadState();
  assert.equal((await patch(missed.id, false)).status, 200);
  assert.equal((await patch(missed.id, false)).status, 200);
  saveState(staleTick); // 撤销不会被旧快照写回。
  slot = await getSlot();
  assert.deepEqual([slot.replied, slot.missed], [2, 2]);
  assert.deepEqual(slot.receipts.find(row => row.id === missed.id), missed);
});

test('手动接住可在近期记录滚动后撤销', async (t) => {
  write(env.PG_CONFIG_PATH, base);
  const st = {};
  const sent = Date.parse('2026-11-21T11:10:00+08:00');
  noteSent(st, 'share', sent, '早些时候的消息');
  sweep(st, sent + 5 * 3_600_000);
  write(env.PG_STATE_PATH, st);
  const request = start(t);
  const before = (await request('GET', '/diagnostics')).slots.find(row => row.slot === 'share');
  const id = before.receipts[0].id;
  const patch = received => request('POST', '/feedback/receipt', { slot: 'share', id, received });
  await patch(true);
  const more = loadState();
  for (let i = 1; i <= 11; i++) {
    const at = sent + 86_400_000 + i * 600_000;
    noteSent(more, 'share', at, '新的消息');
    settle(more, at + 60_000, at + 60_000, '回了');
  }
  saveState(more);
  const marked = (await request('GET', '/diagnostics')).slots.find(row => row.slot === 'share');
  assert.equal(marked.receipts.length, 11);
  assert.equal(marked.receipts.at(-1).id, id);
  assert.equal(marked.receipts.at(-1).manual, true);
  assert.equal(marked.replied, 12);
  assert.equal((await patch(false)).status, 200);
  assert.equal(slotStats(loadState()).share.replied, 11);
  assert.equal(slotStats(loadState()).share.missed, 1);
});

test('旧版汇总可识别确定的最后一次未回，日志补齐近七天未回，真正不明的记录保持只读', async (t) => {
  write(env.PG_CONFIG_PATH, { ...base, timezone: 'Asia/Shanghai' });
  const sent = Date.parse('2026-11-22T11:10:00+08:00');
  const logMiss = Date.parse('2026-11-18T09:55:00+08:00');
  const logNight = Date.parse('2026-11-19T23:10:00+08:00');
  const logReplied = Date.parse('2026-11-20T13:57:00+08:00');
  fs.mkdirSync(env.PG_LOG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.PG_LOG_DIR, 'decision-2026-11-18.jsonl'), [
    JSON.stringify({ ts: logMiss, track: 'proactive', dry_run: false, delivery: { ok: true }, topic: { slot: 'share' } }),
    JSON.stringify({ ts: logNight, track: 'proactive', dry_run: false, delivery: { ok: true }, topic: { slot: 'share' } }),
    JSON.stringify({ ts: logReplied, track: 'proactive', dry_run: false, delivery: { ok: true }, topic: { slot: 'share' } }),
  ].join('\n') + '\n');
  write(env.PG_STATE_PATH, {
    day: '2026-11-22',
    chitchat: { day: '2026-11-22', count: 2 },
    feedback: { slots: {
      sleep: { sent: 3, replied: 0, missed: 3, lastSentAt: sent },
      share: { sent: 2, replied: 1, missed: 1, lastSentAt: logReplied, lastRepliedAt: logReplied + 60_000,
        pairs: [{ ts: logReplied + 60_000, latencyMin: 1, kind: 'hit' }] },
      agenda: { sent: 2, replied: 1, missed: 0, lastSentAt: sent },
      steps: { sent: 1, replied: 0, missed: 1 },
    } },
  });
  const request = start(t);
  const diag = await request('GET', '/diagnostics');
  assert.equal(diag.chitchat.todayCount, 2);
  const bySlot = Object.fromEntries(diag.slots.map(row => [row.slot, row]));

  // sleep: 全部未回，lastSentAt 确定为未回且可勾选并撤销，其余 2 条无时间仍计入 unlistedMisses
  assert.equal(bySlot.sleep.unlistedMisses, 2);
  assert.equal(bySlot.sleep.receipts.length, 1);
  const [sleepLast] = bySlot.sleep.receipts;
  assert.deepEqual(sleepLast, { id: sleepLast.id, at: '11-22日 11:10', received: false, manual: false });
  assert.equal((await request('POST', '/feedback/receipt', { slot: 'sleep', id: sleepLast.id, received: true })).status, 200);
  assert.equal(slotStats(loadState()).sleep.replied, 1);
  assert.equal((await request('POST', '/feedback/receipt', { slot: 'sleep', id: sleepLast.id, received: false })).status, 200);
  assert.equal(slotStats(loadState()).sleep.replied, 0);

  // share: 从 decision 日志精准补齐白天未回（忽略夜间记录和已配对记录），勾选后不额外拉入新条目
  assert.equal(bySlot.share.unlistedMisses, 0);
  const shareMiss = bySlot.share.receipts.find(row => row.at === '11-18日 09:55');
  assert.deepEqual(shareMiss, { id: 'log-share-' + logMiss, at: '11-18日 09:55', received: false, manual: false });
  assert.equal(bySlot.share.receipts.some(row => row.at === '11-19日 23:10'), false);
  const marked = await request('POST', '/feedback/receipt', { slot: 'share', id: shareMiss.id, received: true });
  assert.equal(marked.status, 200);
  const shareAfter = marked.slots.find(row => row.slot === 'share');
  assert.equal(shareAfter.replied, 2);
  assert.equal(shareAfter.unlistedMisses, 0);
  assert.deepEqual(shareAfter.receipts.find(row => row.id === shareMiss.id), { ...shareMiss, received: true, manual: true });

  // agenda: missed=0 时 lastSentAt 结果确实不明，保持只读
  const [agendaLast] = bySlot.agenda.receipts;
  assert.deepEqual(agendaLast, { id: agendaLast.id, at: '11-22日 11:10', received: null, manual: false, status: 'unknown' });
  assert.equal((await request('POST', '/feedback/receipt', { slot: 'agenda', id: agendaLast.id, received: true })).status, 409);

  // steps: 无时间无日志
  assert.equal(bySlot.steps.unlistedMisses, 1);
  assert.deepEqual(bySlot.steps.receipts, []);
  fs.rmSync(path.join(env.PG_LOG_DIR, 'decision-2026-11-18.jsonl'), { force: true });
});

test('小本本和探索反馈写入口走准入校验，路由更新结果可回读', async (t) => {
  const { writeChatData } = await import('../src/channels/douyin-im.js');
  const { loadPersona } = await import('../src/persona.js');
  const { exploreRound, saveExploration } = await import('../src/explore.js');
  const personaFile = path.join(dir, 'curiosity-persona.md');
  fs.writeFileSync(personaFile, '喜欢琢磨古典吉他。');
  write(env.PG_CONFIG_PATH, { ...base, persona: { localFile: personaFile, dshHome: dir }, agreements: { enabled: true } });
  const opts = loadConfig();
  const stageNow = Date.now();
  const request = start(t);
  const id = 'd'.repeat(24);
  writeChatData('agreements', { items: [{ id, title: '交作业', dueAt: stageNow + 3_600_000, status: 'pending', explicit: true }] });
  const round = await exploreRound({ persona: loadPersona({ cfg: opts }), now: stageNow,
    generate: async () => ({ ok: true, text: '{"action":"start","topic":"古典吉他","progress":"比较了两种指法","next":"试下一种"}' }) });
  assert.ok(round.ok);
  saveExploration(round.state);
  const state = await request('GET', '/state');
  assert.equal(state.agreements.items[0].id, id);
  const [topic] = state.exploration.feedback.entries;
  assert.equal(topic.topic, '古典吉他');
  const more = { id: topic.id, action: 'more' };
  const headers = { host: '127.0.0.1:1122', origin: 'https://example.org', 'sec-fetch-site': 'cross-site' };
  assert.equal((await request('POST', '/agreements/dismiss', { id }, headers)).status, 403);
  assert.equal((await request('POST', '/exploration/feedback', more, headers)).status, 403);
  assert.equal((await request('GET', '/state')).agreements.items.length, 1);
  assert.equal((await request('POST', '/exploration/feedback', { ...more, action: 'invalid' })).status, 400);
  assert.equal((await request('POST', '/exploration/feedback', more)).state.exploration.feedback.entries[0].action, 'more');
  assert.deepEqual((await request('POST', '/agreements/dismiss', { id })).state.agreements.items, []);
  assert.equal((await request('POST', '/agreements/dismiss', { id })).status, 409);
  const saved = await request('POST', '/config', { path: 'logging.reportDays', value: 2 });
  assert.equal(saved.value, 2);
  assert.equal(saved.groups.flatMap(group => group.items).find(item => item.path === 'logging.reportDays').value, 2);
});
