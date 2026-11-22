import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-preferences-'));
const env = { PG_CONFIG_PATH: path.join(dir, 'config.json'), PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_DSH_HOME: path.join(dir, 'home'), PG_LOG_DIR: path.join(dir, 'logs'),
  PG_FISH_LATEST_PATH: path.join(dir, 'fish-latest.json'), PG_CHAT_DATA_DIR: path.join(dir, 'data'),
  PG_SECRETS_PATH: path.join(dir, 'credentials.json') };
const before = Object.entries(env).map(([k]) => [k, process.env[k]]);
Object.assign(process.env, env);
test.after(() => {
  for (const [key, value] of before) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
const fb = await import('../src/feedback.js');
const { looksLikeTopicPreference, parseCommandIntent } = await import('../src/command-matcher.js');
const { loadConfig, loadState, saveConfig, saveState } = await import('../src/config.js');
const { pickNoReply } = await import('../src/noreply.js');
const { topicCandidates } = await import('../src/topics.js');
const { buildSnapshot } = await import('../src/snapshot.js');
const { buildReplyContext } = await import('../src/qq-reply.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { tick } = await import('../src/engine.js');
const { sendQQRound } = await import('../src/send.js');
const { applyChange, listForUi } = await import('../src/settings.js');
const { chitchatGate, noteChitchatSent } = await import('../src/chitchat.js');

const H = 3_600_000, now = Date.parse('2026-11-22T18:00:00+08:00');
const cfg = { timezone: 'Asia/Shanghai', rules: { feedback: { keepHours: 24 }, qqCommands: { enabled: true, freshSec: 120 } } };
const share = { slot: 'share', evidence: { source: { title: '游戏更新说明' } } };
const source = { channel: 'qq', peer: '10001', at: now };
const row = (mode, target) => ({ mode, target, quote: '本地原话', expiresAt: null, ...source });
const route = (mode, target, quote, until = '') => JSON.stringify({ intent: 'topic_preference', mode, target, quote, until });
const resetState = () => fs.writeFileSync(env.PG_STATE_PATH, '{}');

test('偏好意图认可明示原话，模糊闲聊、否定和引用回退', () => {
  for (const [mode, target, quote, until, expected] of [
    ['allow_silent', '游戏更新', '游戏更新你照发，我上课经常只看不回', '', { keyword: '游戏更新' }],
    ['allow_silent', '探索分享', '探索分享不用管我回不回', '', { slot: 'share' }],
    ['mute_less', '睡眠', '这周别提睡眠了', '这周', { slot: 'sleep' }],
    ['mute_less', '这类', '这类以后少发点', '', { recent: true }],
    ['reset', '游戏更新', '游戏更新恢复正常', '', { keyword: '游戏更新' }],
  ]) {
    const r = parseCommandIntent(route(mode, target, quote, until), quote);
    assert.equal(r.intent, 'topic_preference', quote);
    assert.deepEqual(r.preference.target, expected);
  }
  for (const [target, quote, actual = quote] of [
    ['游戏更新', '游戏更新你照发', '同学说「游戏更新你照发」'],
    ['我上课', '我上课经常只看不回'],
    ['游戏更新', '游戏更新不用照发'],
    ['这个游戏', '这个游戏你照发'],
    ['朋友', '朋友说你照发'],
    ['游戏更新', '游戏更新你照发，我这周别提睡眠只看不回'],
    ['游戏更新', '游戏更新你照发', '游戏更新你照发\n然后睡眠恢复正常'],
  ]) assert.equal(parseCommandIntent(route('allow_silent', target, quote), actual).intent, 'chat_only', actual);
  for (const target of ['睡眠', '我睡眠', '游戏更新好像']) {
    const status = target + '恢复正常';
    assert.equal(parseCommandIntent(route('reset', target, status), status).intent, 'chat_only');
  }
  const clear = '睡眠恢复默认';
  assert.equal(parseCommandIntent(route('reset', '睡眠', clear), clear).intent, 'topic_preference');
  const ungrounded = '睡眠这周少发点';
  assert.equal(parseCommandIntent(route('mute_less', '睡眠这周', ungrounded), ungrounded).intent, 'chat_only');
  const week = '这周别提睡眠了';
  for (const until of ['', '今天']) assert.equal(parseCommandIntent(route('mute_less', '睡眠', week, until), week).intent, 'chat_only');
});

test('口语偏好写法可进入私聊路由并保留原话', () => {
  for (const [mode, target, quote, until, expected] of [
    ['allow_silent', '游戏更新', '游戏更新你继续发，我不一定回', '', { keyword: '游戏更新' }],
    ['allow_silent', '游戏更新', '游戏更新照常发就行', '', { keyword: '游戏更新' }],
    ['mute_less', '睡眠', '对了，这周别提睡眠了', '这周', { slot: 'sleep' }],
    ['mute_less', '这类', '这类以后少发点吧', '', { recent: true }],
  ]) {
    assert.ok(looksLikeTopicPreference(quote), quote);
    assert.deepEqual(parseCommandIntent(route(mode, target, quote, until), quote), { intent: 'topic_preference',
      preference: { mode, target: expected, quote, until } });
  }
});

test('口语规则仍拒绝转述、疑问、否定以及模型改写原话', () => {
  for (const [target, quote, actual = quote] of [
    ['游戏更新', '朋友说游戏更新照常发就行'],
    ['游戏更新', '朋友说：游戏更新照常发就行'],
    ['游戏更新', '游戏更新可以继续发吗'],
    ['游戏更新可以', '游戏更新可以继续发？'],
    ['游戏更新能不能就', '游戏更新能不能就照常发'],
    ['游戏更新不用', '游戏更新不用照发'],
    ['游戏更新不需要', '游戏更新不需要照常发'],
    ['游戏更新别', '游戏更新别继续发'],
    ['游戏更新不用继续', '游戏更新不用继续照发'],
    ['游戏更新不想让你', '游戏更新不想让你照发'],
    ['游戏更新', '游戏更新你继续发,我不一定回', '游戏更新你继续发，我不一定回'],
    ['游戏公告', '游戏更新照常发就行'],
  ]) assert.equal(parseCommandIntent(route('allow_silent', target, quote), actual).intent, 'chat_only', actual);
  const week = '对了，这周别提睡眠了';
  assert.equal(parseCommandIntent(route('mute_less', '睡眠', week, '今天'), week).intent, 'chat_only');
});

test('同一目标跨通道覆盖，按配置时区过期，reset 后旧 tick 无法写回', () => {
  resetState();
  const stale = loadState();
  const pref = { mode: 'allow_silent', target: { keyword: '游戏更新' }, quote: '游戏更新照发', until: '' };
  fb.saveTopicPreference(pref, source, cfg);
  saveState({ ...stale, feedback: { streak: 2 } });
  assert.equal(fb.topicPreferenceMode(loadState(), share, now), 'allow_silent');
  assert.equal(loadState().feedback.streak, 2);
  fb.saveTopicPreference({ ...pref, mode: 'mute_less', until: '这周' }, { ...source, channel: 'douyin', peer: 'MS4w-test' }, cfg);
  const end = Date.parse('2026-11-23T00:00:00+08:00');
  const st = loadState();
  assert.equal(st.feedback.preferences.length, 1);
  assert.equal(st.feedback.preferences[0].channel, 'douyin');
  assert.equal(st.feedback.preferences[0].expiresAt, end);
  assert.equal(fb.topicPreferenceMode(st, share, end - 1), 'mute_less');
  assert.equal(fb.topicPreferenceMode(st, share, end), null);
  assert.deepEqual(fb.feedbackSummary(st, cfg, end).preferences, []);
  fb.saveTopicPreference({ ...pref, mode: 'reset' }, { ...source, at: now + 1 }, cfg);
  saveState({ ...st, real: { todaySent: 1 } });
  assert.deepEqual(loadState().feedback.preferences, []);
  assert.equal(loadState().real.todaySent, 1);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('这类引用不依赖 pending，核对来源及最长 24 小时有效期', () => {
  const st = { feedback: { pending: [] } };
  fb.noteProactive(st, share, source);
  assert.deepEqual(fb.lastProactiveTarget(st, { ...source, at: now + H }, cfg), { keyword: '游戏更新说明' });
  assert.equal(fb.lastProactiveTarget(st, { ...source, at: now + 24 * H }, cfg), null);
  assert.equal(fb.lastProactiveTarget(st, { ...source, channel: 'douyin', at: now + H }, cfg), null);
  const saved = applyChange(cfg, 'rules.feedback.keepHours', 2);
  assert.equal(saved.ok, true);
  assert.equal(listForUi(saved.cfg).flatMap(g => g.items).find(i => i.path === saved.path).value, 2);
  assert.equal(fb.lastProactiveTarget(st, { ...source, at: now + 3 * H }, saved.cfg), null);
  assert.ok(fb.lastProactiveTarget(st, { ...source, at: now + 3 * H }, cfg));
});

test('这类优先引用短主题，标题不能成为关键词时回退到由头', () => {
  const st = {};
  const reply = { ...source, at: now + 1 };
  const title = '《游戏更新》：【季节公告】';
  for (const field of ['section', 'topic', 'subject']) {
    fb.noteProactive(st, { ...share, evidence: { source: { title: '开发日志' }, [field]: '游戏更新' } }, source);
    assert.deepEqual(fb.lastProactiveTarget(st, reply, cfg), { keyword: '游戏更新' }, field);
  }
  for (const unusable of [title, '游戏更新'.repeat(20)]) {
    fb.noteProactive(st, { ...share, evidence: { source: { title: unusable } } }, source);
    assert.deepEqual(fb.lastProactiveTarget(st, reply, cfg), { slot: 'share' });
  }
});

test('随口话沉默豁免跳过无人回应熔断，其余门槛照常', () => {
  const pref = { ...row('allow_silent', { slot: 'chitchat' }), expiresAt: now + H };
  const gateCfg = { rules: { chitchat: { enabled: true }, judge: { enabled: true } } };
  const st = { chitchat: { cooldownUntil: now + 2 * H }, feedback: { preferences: [] } };
  const gate = (at = now, config = gateCfg) => chitchatGate({ cfg: config, st, now: at });
  assert.equal(gate().reason, 'NO_CHITCHAT_COOLDOWN');
  st.feedback.preferences = [pref];
  assert.equal(gate().ok, true);
  assert.equal(gate(now + H).reason, 'NO_CHITCHAT_COOLDOWN');
  assert.equal(gate(now, { ...gateCfg, quietHours: [['17:00', '19:00']] }).reason, 'NO_CHITCHAT_WINDOW');
  Object.assign(st.chitchat, { day: '2026-11-22', count: 1 });
  assert.equal(gate().reason, 'NO_CHITCHAT_BUDGET');
});

test('豁免不增加 streak、接住率分母或追问，随口话额度照常计数', () => {
  const st = { feedback: { streak: 2, slots: { share: { sent: 6, replied: 0, coldUntil: now + H } },
    preferences: [row('allow_silent', { slot: 'share' })] } };
  fb.noteSent(st, 'share', now, '游戏更新', { channel: 'qq', expect: false });
  assert.equal(st.feedback.pending.at(-1).expect, false);
  assert.equal(st.feedback.streak, 2);
  assert.equal(fb.slotStats(st).share.sent, 6);
  assert.ok(!fb.coldSlots(st, cfg, now).has('share'));
  assert.equal(pickNoReply({ st, cfg: { content: { topics: { followCasualSilence: true } } }, now: now + 3 * H }), null);
  assert.equal(st.feedback.slots.share.coldUntil, now + H);
  const chit = noteChitchatSent({}, now, cfg.timezone, '想跟你聊几句', '', { expect: false });
  assert.equal(chit.count, 1);
  assert.equal(chit.days, undefined);
});

test('关键词只放行匹配的候选，mute_less 优先，快照不展示原话', () => {
  const context = title => ({ tz: cfg.timezone, self: { exploration: true,
    discoveryId: 'fixture', line: '有一个新的内容值得分享', source: { title } } });
  const st = { feedback: { slots: { share: { sent: 8, replied: 0, coldUntil: now + H } },
    preferences: [row('allow_silent', { keyword: '游戏更新' })] } };
  const chosen = ctx => [...topicCandidates(ctx, cfg, now, st)].find(x => x.slot === 'share');
  assert.ok(chosen(context('某游戏更新说明')));
  assert.equal(chosen(context('数电资料')), undefined);
  st.feedback.preferences.push(row('mute_less', { slot: 'share' }));
  const misses = new Map();
  [...topicCandidates(context('某游戏更新说明'), cfg, now, st, undefined, misses)];
  assert.equal(misses.get('share'), 'preference_muted');
  const snapshot = buildSnapshot({ cfg, st, now });
  assert.match(snapshot, /偏好/);
  assert.match(snapshot, /分享/);
  assert.doesNotMatch(snapshot, /本地原话/);
});

test('QQ 与抖音复用同步确认，拒绝伪造私聊来源', async (t) => {
  t.mock.method(Date, 'now', () => now);
  resetState();
  const config = { ...cfg, channels: { qq: { peerId: '10001' }, douyin: { peerSecUid: 'MS4w-test' }, primary: 'qq' } };
  const quote = '探索分享照常发就行';
  let response = route('allow_silent', '探索分享', quote);
  const ctx = { get: key => ({
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
    llm: { async *stream() { yield { type: 'text-delta', text: response }; } },
  })[key] };
  const qqDir = path.join(env.PG_DSH_HOME, 'qq-bridge');
  fs.mkdirSync(qqDir, { recursive: true });
  const qqInput = { kind: 'private', peer: '10001', text: quote, at: now };
  fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify(config));
  const incoming = (peer, text = quote) => fs.writeFileSync(path.join(qqDir, 'last-in.json'), JSON.stringify({ peer, peerKind: 'private', at: now, observedAt: now, text }));
  incoming('other');
  await buildReplyContext(ctx, { ...qqInput, cfg: config });
  assert.deepEqual(loadState(), {});
  incoming('10001');
  assert.match(await buildReplyContext(ctx, { ...qqInput, cfg: config }), /偏好已保存/);
  assert.equal(fb.topicPreferenceMode(loadState(), share, now), 'allow_silent');

  const st = loadState();
  st.feedback.pending = [];
  fb.noteProactive(st, { slot: 'sleep' }, { ...source, at: now - 60_000 });
  saveState(st);
  const relative = '这类以后少发点吧';
  incoming('10001', relative);
  response = route('mute_less', '这类', relative);
  assert.match(await buildReplyContext(ctx, { ...qqInput, cfg: config, text: relative }), /偏好已保存/);
  assert.equal(fb.topicPreferenceMode(loadState(), { slot: 'sleep' }, now), 'mute_less');

  const reset = '探索分享恢复正常';
  const dyCfg = { ...config, channels: { ...config.channels, primary: 'douyin' } };
  fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify(dyCfg));
  writeChatData('external-chat', { sessionId: 'fixture' });
  writeChatData('douyin-im', { 'MS4w-test': { incoming: { kind: 'private', peer: 'MS4w-test', ts: now, observedAt: now, text: reset } } });
  response = route('reset', '探索分享', reset);
  assert.match(await buildReplyContext(ctx, { kind: 'private', peer: 'MS4w-test', text: reset, at: now, cfg: dyCfg }), /恢复默认/);
  assert.equal(fb.topicPreferenceMode(loadState(), share, now), null);
});

test('写入未完成时仍保留原状态，且清理临时文件', (t) => {
  const original = '{"feedback":{"streak":1}}';
  fs.writeFileSync(env.PG_STATE_PATH, original);
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename failed'); });
  assert.throws(() => saveState({ feedback: { streak: 2 } }), /rename failed/);
  assert.equal(fs.readFileSync(env.PG_STATE_PATH, 'utf8'), original);
  assert.deepEqual(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')), []);
});

test('真实发送路径应用豁免，保存实际发出时间，mute_less 不消耗额度', async (t) => {
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  resetState();
  const qqDir = path.join(env.PG_DSH_HOME, 'qq-bridge');
  fs.mkdirSync(qqDir, { recursive: true });
  fs.rmSync(path.join(qqDir, 'last-in.json'), { force: true });
  fs.rmSync(path.join(qqDir, 'last-out.json'), { force: true });
  fs.writeFileSync(path.join(qqDir, 'connection.json'), JSON.stringify({ httpApiUrl: 'http://127.0.0.1:1', httpToken: 'fixture' }));
  const config = { ...cfg, dryRun: false, quietHours: [], busyHours: [], send: { enabled: true, split: { enabled: false } },
    channels: { primary: 'qq', qq: { peerId: source.peer, read: false } },
    sources: { phone: { enabled: false }, memory: { enabled: false } },
    perception: { l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    content: { mode: 'template', exams: { text: '2026-11-22 18:30 电机学' } },
  };
  fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify(config));
  const sent = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).pathname, '/send_private_msg');
    assert.equal(JSON.parse(init.body).user_id, Number(source.peer));
    clock += 5000;
    return Response.json({ status: 'ok', data: { message_id: 8 } });
  });
  const pref = { target: { slot: 'examSoon' }, quote: '考前提醒少发点', until: '' };
  fb.saveTopicPreference({ ...pref, mode: 'mute_less' }, source, cfg);
  const options = { probeSystem: async () => ({ idle_ms: 0 }), llmReady: false };
  const muted = await tick(options);
  assert.equal(muted.record.topicMisses.find(x => x.slot === 'examSoon').reason, 'preference_muted');
  assert.equal(sent.mock.callCount(), 0);
  assert.equal(loadState().real.todaySent, 0);
  assert.equal(loadState().feedback.lastProactive, undefined);

  fb.saveTopicPreference({ ...pref, mode: 'allow_silent' }, source, cfg);
  const allowed = await tick(options);
  assert.equal(allowed.delivery.ok, true, JSON.stringify(allowed.record));
  assert.equal(sent.mock.callCount(), 1);
  const st = loadState();
  assert.equal(st.real.todaySent, 1);
  assert.equal(st.feedback.streak, 0);
  assert.equal(st.feedback.pending.at(-1).expect, false);
  assert.deepEqual(st.feedback.lastProactive, { slot: 'examSoon', theme: '电机学', ts: clock, channel: 'qq', peer: source.peer });
});

test('--status 只显示有效偏好，原话仅留在本地 state', () => {
  resetState();
  const at = Date.now();
  fb.saveTopicPreference({ mode: 'allow_silent', target: { slot: 'share' }, quote: '本地原话', until: '' },
    { ...source, at }, cfg);
  fb.saveTopicPreference({ mode: 'mute_less', target: { slot: 'sleep' }, quote: '已经过期的本地话', until: '今天' },
    { ...source, at: at - 48 * H }, cfg);
  const result = spawnSync(process.execPath, ['src/run.js', '--status'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /生效的话题偏好/);
  assert.match(result.stdout, /分享.*沉默豁免.*长期/);
  assert.doesNotMatch(result.stdout, /暂停主动提起|本地原话|已经过期的本地话/);
});

test('状态写锁按设置等待并重试，零等待仍会即时失败', (t) => {
  const key = 'rules.stateWriteWaitMs';
  const oldConfig = fs.existsSync(env.PG_CONFIG_PATH) ? fs.readFileSync(env.PG_CONFIG_PATH) : null;
  t.after(() => {
    if (oldConfig) fs.writeFileSync(env.PG_CONFIG_PATH, oldConfig);
    else fs.rmSync(env.PG_CONFIG_PATH, { force: true });
  });
  fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify(cfg));
  const loaded = loadConfig();
  assert.equal(loaded.rules.stateWriteWaitMs, 120);
  const lock = env.PG_STATE_PATH + '.lock.tmp';
  t.after(() => fs.rmSync(lock, { force: true }));
  const link = fs.linkSync;
  let attempts = 0;
  t.mock.method(fs, 'linkSync', (owner, target) => {
    if (++attempts === 2) fs.unlinkSync(target);
    link(owner, target);
  });
  const configure = (wait) => {
    const changed = applyChange(loaded, key, wait);
    assert.equal(changed.ok, true);
    saveConfig(changed.cfg);
    const field = listForUi(loadConfig()).flatMap(group => group.items).find(item => item.path === key);
    assert.equal(field.value, wait);
    assert.equal(field.unit, '毫秒');
  };
  resetState();
  fs.writeFileSync(lock, String(process.pid));
  configure(0);
  assert.throws(() => saveState({ count: 1 }), /STATE_WRITE_BUSY/);
  assert.equal(attempts, 1);
  configure(200);
  attempts = 0;
  saveState({ count: 2 });
  assert.equal(attempts, 2);
  assert.deepEqual(loadState(), { count: 2 });
  assert.equal(fs.existsSync(lock), false);
});

test('另一个进程来不及等待状态更新时不得覆盖偏好', (t) => {
  resetState();
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (tmp, file) => {
    if (file === env.PG_STATE_PATH) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        "import { saveState } from './src/config.js'; saveState({ feedback: { streak: 42 } });"
      ], { encoding: 'utf8' });
      assert.notEqual(child.status, 0);
      assert.match(child.stderr, /STATE_WRITE_BUSY/);
    }
    rename(tmp, file);
  });
  fb.saveTopicPreference({ mode: 'allow_silent', target: { slot: 'share' }, quote: '分享照发', until: '' }, source, cfg);
  assert.equal(fb.topicPreferenceMode(loadState(), share, now), 'allow_silent');
  assert.equal(loadState().feedback.streak, undefined);
  assert.ok(!fs.existsSync(env.PG_STATE_PATH + '.lock.tmp'));
});

test('QQ 分段可在真正发送前停止，已送达的前一段仍算一条', async (t) => {
  let allowed = true;
  const send = t.mock.method(globalThis, 'fetch', async () => {
    allowed = false;
    return Response.json({ status: 'ok', data: { message_id: 123 } });
  });
  const result = await sendQQRound({ to: source.peer, dryRun: false, text: '第一段\n\n第二段',
    split: { enabled: true, minFirstMs: 0, maxFirstMs: 0, firstJitterMs: 0, minGapMs: 0, maxGapMs: 0, gapJitterMs: 0 },
    canDispatch: () => allowed });
  assert.equal(send.mock.callCount(), 1);
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'TOPIC_PREFERENCE_MUTED');
  assert.equal(result.parts, 1);
});

test('抖音配送时切成演练，不记真实发送、反馈或 lastProactive', async (t) => {
  t.mock.method(Date, 'now', () => now);
  resetState();
  const config = { ...cfg, dryRun: false, quietHours: [], busyHours: [], send: { enabled: true },
    channels: { primary: 'douyin', douyin: { peerSecUid: 'MS4w-demo' } },
    sources: { phone: { enabled: false }, memory: { enabled: false } },
    perception: { l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    content: { mode: 'llm', exams: { text: '2026-11-22 18:30 电机学' } },
  };
  fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify(config));
  writeChatData('external-chat', { sessionId: 'fixture' });
  writeChatData('douyin-im', {});
  const result = await tick({ probeSystem: async () => ({ idle_ms: 0 }), llmReady: true,
    async generate() {
      fs.writeFileSync(env.PG_CONFIG_PATH, JSON.stringify({ ...config, dryRun: true }));
      return { ok: true, text: '快到考试时间了，带上证件再出门。' };
    },
  });
  assert.equal(result.record.reason, 'SEND_DISABLED', JSON.stringify(result.record));
  assert.equal(result.delivery.attempted, false);
  const st = loadState();
  assert.equal(st.real.todaySent, 0);
  assert.equal(st.feedback.pending.length, 0);
  assert.equal(st.feedback.lastProactive, undefined);
});
