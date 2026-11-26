import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-runtime-six-'));
process.env.PG_DSH_HOME = path.join(tmp, 'dsh');
process.env.PG_CONFIG_PATH = path.join(tmp, 'config.json');
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_LOG_DIR = path.join(tmp, 'logs');
process.env.PG_SECRETS_PATH = path.join(tmp, 'credentials.json');
process.env.PG_CHAT_DATA_DIR = path.join(tmp, 'chat-data');

const dsh = process.env.PG_DSH_HOME;
fs.mkdirSync(path.join(dsh, 'node_modules', 'dsh-plugin-qq-bridge'), { recursive: true });
fs.writeFileSync(
  path.join(dsh, 'node_modules', 'dsh-plugin-qq-bridge', 'package.json'),
  JSON.stringify({ name: 'dsh-plugin-qq-bridge', version: '1.0.0' })
);
fs.mkdirSync(path.join(dsh, 'qq-bridge'), { recursive: true });
fs.writeFileSync(path.join(dsh, 'qq-bridge', 'connection.json'), '{}');

const { readQq } = await import('../src/channels/qq.js');
const { buildContext } = await import('../src/decision/context.js');
const { bridgeLastIn, bridgeLastOut } = await import('../src/chat/outbound.js');
const { handleAgreementChatCommand, listAgreements } = await import('../src/chat/agreements.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { tick, tickDueAgreement } = await import('../src/decision/engine.js');
const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const { probe } = await import('../src/perception/probe.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('运行问题 1：关闭 channels.qq.send 后不再发送普通主动消息', async (t) => {
  const now = Date.parse('2026-11-24T15:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  fs.writeFileSync(process.env.PG_STATE_PATH, '{}');
  saveConfig({
    enabled: true,
    dryRun: false,
    quietHours: [],
    busyHours: [],
    timezone: 'Asia/Shanghai',
    send: { enabled: true },
    channels: {
      primary: 'qq',
      qq: { enabled: true, read: true, send: false, peerId: '10001', activeHours: [] },
      main: { enabled: false, read: false, send: false, activeHours: [] },
      douyin: { enabled: false, read: false, send: false, activeHours: [] },
    },
    sources: { phone: { enabled: false }, memory: { enabled: false } },
    perception: { l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    content: { mode: 'fixed', fixedText: '测试消息' },
    rules: { minGapMin: 0, dailyCap: 5, judge: { enabled: false } },
    mail: { enabled: false },
  });
  const res = await tick({ persist: true, probeSystem: async () => ({ ok: true, idle_ms: 0 }) });
  assert.equal(res.delivery?.attempted, false);
  assert.equal(res.delivery?.reason, 'SEND_DISABLED');
});

test('运行问题 2：QQ 联系人 B 的私信与出站记录不会串入联系人 A 的通道与上下文', () => {
  const now = Date.parse('2026-11-24T15:00:00+08:00');
  fs.writeFileSync(
    path.join(dsh, 'qq-bridge', 'last-in.json'),
    JSON.stringify({ peer: '20002', peerKind: 'private', at: now - 60_000, text: '联系人B的消息' })
  );
  fs.writeFileSync(
    path.join(dsh, 'qq-bridge', 'last-out.json'),
    JSON.stringify({ peer: '20002', firstAt: now - 30_000, lastAt: now - 30_000, count: 1, text: '回复给B' })
  );

  // 绑定联系人 A (10001) 时，必须完全忽略 20002 的消息
  assert.equal(bridgeLastIn({ dsh, peer: '10001' }).ts, 0);
  assert.equal(bridgeLastOut({ dsh, peer: '10001' }).ts, 0);
  assert.equal(bridgeLastIn({ dsh, peer: '20002' }).text, '联系人B的消息');

  const qqA = readQq({ peerId: '10001' }, now, 'Asia/Shanghai');
  assert.equal(qqA.lastUserTs, null);
  assert.equal(qqA.lastSendTs, null);

  const cfgA = { channels: { primary: 'qq', qq: { enabled: true, peerId: '10001' } } };
  const ctxA = buildContext({ cfg: cfgA, now, st: {}, ch: {}, sys: {}, tz: 'Asia/Shanghai' });
  assert.equal(ctxA.recent.some((m) => m.text.includes('联系人B')), false);
});

test('运行问题 3：引号/第三人称转述不清空提醒；1 字关键词不匹配时不误删无关提醒', () => {
  const now = Date.parse('2026-11-24T15:00:00+08:00');
  const cfg = { ...loadConfig(), agreements: { enabled: true }, timezone: 'Asia/Shanghai', channels: { primary: 'qq', qq: { peerId: '10001' } } };
  writeChatData('agreements', {
    items: [{
      id: 'ag-1',
      title: '喝水吃药',
      anchor: '半小时后',
      dueAt: now + 30 * 60_000,
      createdAt: now - 60_000,
      explicit: true,
      short: true,
      status: 'pending',
      channel: 'qq',
      peer: '10001',
    }],
  });
  assert.equal(listAgreements(cfg, now).length, 1);

  // 引号/第三人称转述不触发清空
  const quoted = handleAgreementChatCommand({ text: '他说“取消所有提醒”', cfg, now, channel: 'qq', peer: '10001' });
  assert.equal(quoted, '');
  assert.equal(listAgreements(cfg, now).length, 1);

  // 1 字关键词「课」不匹配「喝水吃药」时，绝不误删「喝水吃药」
  const missOneChar = handleAgreementChatCommand({ text: '别提醒我课了', cfg, now, channel: 'qq', peer: '10001' });
  assert.match(missOneChar, /没找到匹配该关键词/);
  assert.equal(listAgreements(cfg, now).length, 1);
});

test('运行问题 4 & 5：探针失败 idle_ms=-1 不发提醒；明确发送失败不记成 sent', async (t) => {
  const now = Date.parse('2026-11-24T16:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  fs.writeFileSync(process.env.PG_STATE_PATH, '{}');
  const baseCfg = {
    ...loadConfig(),
    enabled: true,
    dryRun: false,
    agreements: { enabled: true },
    quietHours: [],
    busyHours: [],
    timezone: 'Asia/Shanghai',
    send: { enabled: true },
    channels: {
      primary: 'qq',
      qq: { enabled: true, read: true, send: true, peerId: '10001', activeHours: [] },
      main: { enabled: false, read: false, send: false, activeHours: [] },
      douyin: { enabled: false, read: false, send: false, activeHours: [] },
    },
    idle: { awaySec: 600 },
    rules: { ...loadConfig().rules, dailyCap: 5, minGapMin: 0, requirePcOnline: true },
    content: { ...loadConfig().content, topics: { ...loadConfig().content.topics, agreement: true } },
  };
  saveConfig(baseCfg);
  writeChatData('agreements', {
    items: [{
      id: 'ag-2',
      title: '提交实验报告',
      anchor: '16:00',
      dueAt: now - 10_000,
      createdAt: now - 60_000,
      explicit: true,
      short: true,
      status: 'pending',
      channel: 'qq',
      peer: '10001',
    }],
  });

  // 问题 5：探针失败（ok: false, idle_ms: -1）在 requirePcOnline=true 时必须跳过
  let sendCalls = 0;
  const skipped = await tickDueAgreement({
    now,
    probeSystem: async () => ({ ok: false, idle_ms: -1 }),
    send: async () => {
      sendCalls += 1;
      return { ok: true };
    },
  });
  assert.equal(skipped, null);
  assert.equal(sendCalls, 0);

  // 问题 4：探针正常，但 transport 明确返回 HTTP 400 失败 → 提醒释放回 pending，不标成 sent
  const failed = await tickDueAgreement({
    now,
    probeSystem: async () => ({ ok: true, idle_ms: 1000 }),
    send: async ({ canDispatch }) => {
      assert.equal(canDispatch(), true);
      return { ok: false, error: 'HTTP 400 Bad Request', parts: 0 };
    },
  });
  assert.equal(failed?.ok, false);
  assert.equal(failed?.reason, 'SEND_FAILED');
  const pendingAfter = listAgreements(baseCfg, now);
  assert.equal(pendingAfter.length, 1, '明确发送失败的提醒不应被记成 sent 消失');
  assert.equal(pendingAfter[0].title, '提交实验报告');
});

test('运行问题 6：winprobe 使用版本化 DLL（winprobe-v2.dll），不会因旧 DLL 锁定而反复内存编译', { skip: process.platform !== 'win32' }, async () => {
  const res = await probe(true, { perception: { anticheat: { skip: false }, probeTimeoutMs: 8000 } }, { readOnly: false });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(process.cwd(), 'tools', 'winprobe-v2.dll')));
});
