import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-notebook-'));
process.env.PG_CONFIG_PATH = path.join(tmp, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(tmp, 'data');
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_LOG_DIR = path.join(tmp, 'logs');
process.env.PG_DSH_HOME = tmp;
process.env.PG_FISH_LATEST_PATH = path.join(tmp, 'fish-latest.json');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { agreementAnchor, observeAgreement, flushAgreementIntake, listAgreements, dueAgreement, dismissAgreement,
  claimAgreement, releaseAgreement, markAgreementSent } = await import('../src/chat/agreements.js');
const at = Date.parse('2026-11-22T12:00:00+08:00');
const cfg = { timezone: 'Asia/Shanghai', agreements: { enabled: true } };
const input = { cfg, at, now: at, peer: '1001', channel: 'qq' };
const abs = value => Date.parse(value + '+08:00');
const mock = (title, anchor, quote) => async () => ({
  ok: true, text: JSON.stringify({ items: [{ index: 0, title, anchor, quote }] }),
});

test('时间初筛覆盖分钟小时、跨日、日期和纯时刻，拒绝日期残片', () => {
  for (const [anchor, time] of [
    ['三分钟后', '2026-11-22T12:03'], ['半小时后', '2026-11-22T12:30'], ['两个小时后', '2026-11-22T14:00'],
    ['1.5小时后', '2026-11-22T13:30'], ['等会儿', '2026-11-22T12:10'], ['今晚', '2026-11-22T18:00'],
    ['几分钟后', '2026-11-22T12:10'], ['几小时后', '2026-11-22T14:00'], ['今晚八点', '2026-11-22T20:00'],
    ['11月25日下午3点', '2026-11-25T15:00'], ['11/25', '2026-11-25T18:00'], ['11.25', '2026-11-25T18:00'],
    ['2026-11-25', '2026-11-25T18:00'], ['25号', '2026-11-25T18:00'], ['周四14:30', '2026-11-26T14:30'],
    ['明天早上8点半', '2026-11-23T08:30'], ['下午3点', '2026-11-22T15:00'], ['后天', '2026-11-24T18:00'],
    ['大后天', '2026-11-25T18:00'], ['下周一', '2026-11-23T18:00'], ['周末', '2026-11-22T18:00'], ['三点', '2026-11-22T15:00'],
  ]) assert.equal(agreementAnchor(anchor + '交作业', at, cfg)[0]?.dueAt, abs(time), anchor);
  for (const bad of ['2026-02-30下午3点', '昨天15:00', '当前版本 1.27.34', '下午25:00', '哈哈在干嘛']) {
    assert.deepEqual(agreementAnchor(bad, at, cfg), [], bad);
  }
});

test('只处理有时间的消息，模型不能另造日期或事项，短时明确约定只在到点触发', async () => {
  let calls = 0;
  for (const text of ['你在干嘛', '不用十分钟后提醒我交作业', '如果十分钟后提醒我会怎样']) {
    await observeAgreement({ ...input, text, generate: async () => { calls++; } });
  }
  assert.equal(calls, 0);
  const quote = '十分钟后提醒我交作业';
  await observeAgreement({ ...input, text: quote, generate: mock('交作业', '下午3点', quote) });
  assert.deepEqual(listAgreements(cfg, at), []);
  await observeAgreement({ ...input, at: at + 1, now: at + 1, text: quote, generate: mock('交作业', '十分钟后', quote) });
  const [item] = listAgreements(cfg, at + 1);
  assert.equal(item.explicit, true);
  assert.equal(dueAgreement(cfg, item.dueAt - 1, input), null);
  assert.equal(dueAgreement(cfg, item.dueAt, { ...input, peer: 'wrong' }), null);
  assert.equal(claimAgreement(item.id, cfg, item.dueAt, input), true);
  assert.equal(claimAgreement(item.id, cfg, item.dueAt, input), false);
  assert.equal(dueAgreement(cfg, item.dueAt, input), null);
  assert.equal(releaseAgreement(item.id, cfg, item.dueAt), true);
  assert.equal(claimAgreement(item.id, cfg, item.dueAt, input), true);
  assert.equal(markAgreementSent(item.id, cfg, item.dueAt), true);
  assert.equal(dueAgreement(cfg, item.dueAt, input), null);
});

test('远期线索合并限频，短时不排在远期队尾，划掉后保持删除', async () => {
  const src = { ...input, peer: 'douyin-one', channel: 'douyin', cfg: { ...cfg,
    agreements: { ...cfg.agreements, slowIntervalMin: 4, maxItems: 8 } } };
  let calls = 0;
  const record = (time, title, quote, anchor) => observeAgreement({ ...src, at: time, now: time, text: quote,
    generate: async () => { calls++; return mock(title, anchor, quote)(); } });
  await record(at, '看书', '明天去看书', '明天');
  await record(at + 1000, '寄信', '后天要寄信', '后天');
  assert.equal(calls, 1);
  await record(at + 2000, '关烤箱', '五分钟后提醒我关烤箱', '五分钟后');
  assert.equal(calls, 2);
  await flushAgreementIntake(src.cfg, at + 240000, src);
  assert.equal(calls, 3);
  const row = listAgreements(src.cfg, at + 240000).find(item => item.title === '寄信');
  assert.ok(row);
  assert.equal(dismissAgreement(row.id, src.cfg, at + 240000), true);
  assert.ok(!listAgreements(src.cfg, at + 240000).find(item => item.id === row.id));
});

test('设置回显及容量生效，专用到点通道只为明确短时约定跳过普通间隔', async (t) => {
  const { saveConfig, loadConfig, loadState, saveState } = await import('../src/settings/config.js');
  const { listForUi, applyChange } = await import('../src/settings/settings.js');
  const { tickDueAgreement } = await import('../src/decision/engine.js');
  const { writeChatData } = await import('../src/channels/douyin-im.js');
  writeChatData('agreements', { items: ['额外备忘', '更远备忘'].map((title, index) => ({
    id: 'fixture-' + index, title, dueAt: at + (index + 1) * 86_400_000, status: 'pending', peer: 'someone-else', channel: 'qq',
  })) });
  const short = { ...input, peer: 'schedule-qq', cfg: { ...cfg, agreements: { ...cfg.agreements, soonMin: 2 } } };
  const quote = '等会儿提醒我下楼取餐';
  await observeAgreement({ ...short, text: quote, generate: mock('下楼取餐', '等会儿', quote) });
  let now = at + 120000;
  t.mock.method(Date, 'now', () => now);
  const base = { ...short.cfg, enabled: true, dryRun: false, quietHours: [], busyHours: [],
    send: { enabled: true }, characterRest: { bed: '22:00', wake: '06:30', jitterMin: 0 },
    channels: { primary: 'qq', qq: { enabled: true, read: true, send: true, peerId: short.peer } },
    rules: { proactive: true, dailyCap: 3, minGapMin: 360 } };
  saveConfig(base);
  const change = applyChange(loadConfig(), 'agreements.maxItems', '2');
  assert.ok(change.ok);
  saveConfig(change.cfg);
  const actual = loadConfig();
  assert.equal(listForUi(actual).flatMap(group => group.items).find(row => row.path === change.path).value, 2);
  assert.equal(listAgreements(actual, now).length, 2);

  saveState({ day: '2026-11-22', real: { todaySent: 1, lastSendAt: now - 1000 } });
  let calls = 0;
  const bridge = path.join(tmp, 'qq-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  fs.writeFileSync(path.join(bridge, 'connection.json'), JSON.stringify({ httpApiUrl: 'http://127.0.0.1:1', httpToken: 'fixture' }));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(new URL(url).pathname, '/send_private_msg');
    assert.match(JSON.parse(init.body).message, calls === 0 ? /下楼取餐/ : /下楼取件/);
    calls++;
    return Response.json({ status: 'ok', data: { message_id: 1 } });
  });
  saveConfig({ ...actual, quietHours: [['11:00', '13:00']] });
  assert.equal(await tickDueAgreement(), null);
  saveConfig({ ...actual, characterRest: { bed: '11:00', wake: '13:00', jitterMin: 0 } });
  assert.equal(await tickDueAgreement(), null);
  saveConfig({ ...actual, send: { enabled: false } });
  assert.equal(await tickDueAgreement(), null);
  assert.equal(calls, 0);
  saveConfig(actual);
  const later = { ...short, text: '一分钟后再下楼取件', at: now - 60000, now, generate: mock('下楼取件', '一分钟后', '一分钟后再下楼取件') };
  await observeAgreement(later);
  assert.deepEqual(await tickDueAgreement(), { ok: true });
  assert.equal(await tickDueAgreement(), null);
  assert.equal(calls, 1);
  assert.equal(loadState().real.todaySent, 2);
  now += 2 * 60_000;
  saveConfig({ ...actual, rules: { ...actual.rules, minGapMin: 1 } });
  assert.deepEqual(await tickDueAgreement(), { ok: true });
  assert.equal(loadState().real.todaySent, 3);
});

test('QQ 桥短时来信由秒级轮询抽取和到点发送，无需等待普通拍或私聊回复', async (t) => {
  const { apply } = await import('../src/plugin.js');
  const { saveConfig, loadConfig } = await import('../src/settings/config.js');
  const { writeChatData } = await import('../src/channels/douyin-im.js');
  const start = Date.parse('2026-11-23T13:00:00+08:00');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start });
  const peer = '10001';
  const quote = '一分钟后提醒我关烤箱';
  const bridge = path.join(tmp, 'qq-bridge');
  fs.mkdirSync(bridge, { recursive: true });
  writeChatData('agreements', { items: [] });
  fs.writeFileSync(path.join(bridge, 'last-in.json'), JSON.stringify({ peer, peerKind: 'private', at: start, text: quote }));
  fs.writeFileSync(path.join(bridge, 'connection.json'), JSON.stringify({ httpApiUrl: 'http://127.0.0.1:1', httpToken: 'fixture' }));
  saveConfig({ enabled: true, dryRun: false, quietHours: [], busyHours: [], send: { enabled: true },
    channels: { primary: 'qq', qq: { enabled: true, peerId: peer } },
    rules: { qqTiming: { pollSec: 2 }, dailyCap: 3 }, agreements: { enabled: true } });
  const models = [];
  const sends = [];
  const services = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'heavy' }) },
    llm: {
      listProviders: () => [{ id: 'fixture', models: ['heavy', 'fixture-flash'] }, { id: 'other', models: ['remote-lite'] }],
      async *stream({ model, messages }) {
        assert.match(messages[0].content[0].text, /私聊约定抽取/);
        models.push(model);
        const result = await mock('关烤箱', '一分钟后', quote)();
        yield { type: 'text-delta', text: result.text };
      },
    },
  };
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    sends.push(JSON.parse(init.body).message);
    return Response.json({ status: 'ok', data: { message_id: 2 } });
  });
  const app = apply({ get: key => services[key], effect: fn => fn() }, { startupDelaySec: 3600, tool: false, statusApi: false });
  t.after(() => app.stop());
  const flush = () => new Promise(setImmediate);
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(models, ['fixture-flash']);
  assert.equal(listAgreements(loadConfig())[0].dueAt, start + 60000);
  assert.equal(sends.length, 0);
  t.mock.timers.tick(58000);
  await flush();
  assert.equal(sends.length, 1);
  assert.match(sends[0], /关烤箱/);
  assert.equal(app.snapshot().ticks, 0);
  t.mock.timers.tick(2000);
  await flush();
  assert.equal(sends.length, 1);
});

test('抖音只把新收的私信交给小本本，未等待会话回复也可记下', async (t) => {
  const { saveConfig, loadConfig } = await import('../src/settings/config.js');
  const { writeChatData } = await import('../src/channels/douyin-im.js');
  const { createDouyinSession } = await import('../src/channels/douyin-session.js');
  const { observePrivateMessage } = await import('../src/chat/qq-reply.js');
  const now = Date.parse('2026-11-24T12:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  const peer = 'MS4w-fake';
  const base = { quietHours: [], channels: { primary: 'douyin', douyin: { enabled: true, peerSecUid: peer } },
    agreements: { enabled: true } };
  saveConfig(base);
  writeChatData('agreements', { items: [] });
  writeChatData('external-chat', { sessionId: 'fake-douyin' });
  writeChatData('douyin-im', {});
  const old = { from: 'them', text: '一分钟后提醒我读书', kind: 'text', at: new Date(now - 1000).toISOString() };
  const quote = '两分钟后提醒我拿快递';
  let messages = [old];
  let calls = 0;
  const fakeHost = { get(key) {
    if (key === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'test', model: 'flash' }) };
    if (key === 'llm') return { async *stream() {
      calls++;
      const result = await mock('拿快递', '两分钟后', quote)();
      yield { type: 'text-delta', text: result.text };
    } };
  } };
  const poller = createDouyinSession({ getConfig: loadConfig, controller: () => null,
    watcherDisabled: () => true, read: async () => ({ conv_id: 'fixture', messages }),
    prepare: () => assert.fail('No session should reply in this test'),
    onIncoming({ cfg, peer, text, ts }) { observePrivateMessage(fakeHost, { cfg, peer, text, at: ts }); },
  });
  t.after(() => poller.stop());
  await poller.pollNow();
  assert.equal(calls, 0);
  messages = [...messages, { from: 'them', text: quote, kind: 'text', at: new Date(now).toISOString() }];
  await poller.pollNow();
  await new Promise(setImmediate);
  assert.equal(calls, 1);
  const [item] = listAgreements(loadConfig(), now);
  assert.equal(item.title, '拿快递');
  assert.equal(item.channel, 'douyin');
  assert.equal(item.dueAt, now + 2 * 60_000);
  await poller.pollNow();
  assert.equal(calls, 1);
});
