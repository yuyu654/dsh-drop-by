import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-switch-pending-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'credentials.json');
process.env.PG_DSH_HOME = path.join(dir, 'home');
process.env.PG_CHAT_DATA_DIR = path.join(dir, 'chat-data');

fs.mkdirSync(path.join(dir, 'home', 'douyin-duty'), { recursive: true });
fs.writeFileSync(path.join(dir, 'home', 'douyin-duty', 'config.json'), JSON.stringify({
  chatWatch: false,
  dmTo: '测试联系人',
  dmToId: 'MS4wLjABAAAA_TEST',
}));
fs.writeFileSync(
  process.env.PG_CONFIG_PATH,
  JSON.stringify({
    enabled: true,
    dryRun: false,
    tickMinutes: 10,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    idle: { onlineSec: 30, awaySec: 600 },
    send: { enabled: true },
    rules: { replyCooldownMin: 5, minGapMin: 10, dailyCap: 3, judge: { enabled: false }, chitchat: { enabled: false } },
    channels: {
      primary: 'douyin',
      qq: { enabled: false, read: false, send: false, peerId: '10001', activeHours: [] },
      main: { enabled: false, read: false, send: false, activeHours: [] },
      douyin: { enabled: true, read: true, send: true, peerSecUid: '', activeHours: [] },
    },
    sources: { phone: { enabled: false }, qq: { enabled: false }, douyin: { enabled: true }, memory: { enabled: false } },
    content: { mode: 'fixed', fixedText: '测试句子' },
    perception: { l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    mail: { enabled: false },
  }),
);

const { performance } = await import('node:perf_hooks');
const { tick } = await import('../src/decision/engine.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
writeChatData('chat-switch', { boot: performance.timeOrigin, restartBoot: performance.timeOrigin });
writeChatData('external-chat', { sessionId: 'shared-1' });

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('CHANNEL_SWITCH_PENDING skips without incrementing todaySent or lastSendAt', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T12:00:00+08:00'));
  const res = await tick({ persist: true, probeSystem: async () => ({ idle_ms: 0 }) });
  assert.equal(res.record.decision, 'skip');
  assert.equal(res.record.reason, 'CHANNEL_SWITCH_PENDING');
  assert.equal(res.delivery.reason, 'CHANNEL_SWITCH_PENDING');
  const st = JSON.parse(fs.readFileSync(process.env.PG_STATE_PATH, 'utf8'));
  assert.equal(Number(st.real?.todaySent) || 0, 0);
  assert.equal(Number(st.real?.lastSendAt) || 0, 0);
});
