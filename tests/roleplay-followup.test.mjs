import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-roleplay-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(dir, 'chat');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const { applyChange, listForUi } = await import('../src/settings/settings.js');
const { readChatData, writeChatData } = await import('../src/channels/douyin-im.js');
const { tickRoleplayFollowup } = await import('../src/chat/roleplay-followup.js');

const base = Date.parse('2026-11-25T12:00:00Z');
const peer = 'bound';
function setup() {
  const cfg = loadConfig();
  saveConfig({ ...cfg, channels: { ...cfg.channels, primary: 'internal' },
    timezone: 'UTC', quietHours: [], busyHours: [], dryRun: false,
    send: { ...cfg.send, enabled: true }, rules: { ...cfg.rules, minGapMin: 480 },
    characterRest: { ...cfg.characterRest, enabled: false } });
  writeChatData('external-chat', { sessionId: peer });
  writeChatData('roleplay-followup', {});
}

function dialogue(user, assistant, { ts = base - 1000, lastAt = base, reply = true } = {}) {
  writeChatData('internal-chat', { [peer]: {
    incoming: { peer, kind: 'private', ts, observedAt: ts, text: user },
    outgoing: { peer, source: reply ? 'reply' : 'task', firstAt: lastAt - 10, lastAt, text: assistant },
  } });
}

test('a confirmed scene uses editable bounds, completes during quiet time, then sends once without the daily gap', async () => {
  setup();
  const a = applyChange(loadConfig(), 'rules.roleplayFollowup.minMinutes', 3);
  assert.equal(a.ok, true);
  const b = applyChange(a.cfg, 'rules.roleplayFollowup.maxMinutes', 5);
  assert.equal(b.ok, true);
  saveConfig({ ...b.cfg, quietHours: [['12:04', '12:05']] });
  const fields = listForUi(loadConfig()).flatMap(group => group.items);
  assert.equal(fields.find(item => item.path === 'rules.roleplayFollowup.maxMinutes')?.value, 5);

  const notices = [];
  let now = base;
  const tick = () => tickRoleplayFollowup({ now: () => now, startedAt: base - 5000, random: () => 0.5,
    send: async (msg) => { assert.equal(msg.canDispatch(), true); notices.push(msg.text); return { ok: true }; } });
  dialogue('剧情里，你去收拾房间，等会儿回来。', '我先去收拾房间，过会儿回来。');
  await tick();
  const row = readChatData('roleplay-followup').pending;
  assert.equal(row.dueAt, base + 4 * 60_000);
  now = row.dueAt;
  await tick();
  assert.deepEqual(notices, []);
  assert.equal(readChatData('roleplay-followup').pending.completedAt, row.dueAt);
  now += 60_000;
  await tick();
  await tick();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /剧情.*回来/);
});

test('a real research promise or a later unrelated message cannot produce a scene follow-up', async () => {
  setup();
  let now = base;
  const tick = () => tickRoleplayFollowup({ now: () => now, startedAt: base - 5000, random: () => 0,
    send() { assert.fail('unexpected follow-up'); } });
  dialogue('那篇资料帮我找找', '我先去找资料，过会儿回来告诉你。');
  await tick();
  assert.equal(readChatData('roleplay-followup').pending, undefined);
  dialogue('剧情里，你先去买杯咖啡', '我先去买杯咖啡，等会儿回来。', { lastAt: base + 1000 });
  now += 1000;
  await tick();
  assert.ok(readChatData('roleplay-followup').pending);
  dialogue('换个话题，聊聊明天的考试', '那聊聊考试吧。', { ts: now + 1000, lastAt: now + 2000 });
  now += 11 * 60_000;
  await tick();
  assert.equal(readChatData('roleplay-followup').pending, undefined);
});

test('the plugin poller observes the bound reply and sends the scene through its host dispatcher', async (t) => {
  setup();
  const cfg = loadConfig();
  saveConfig({ ...cfg, tickMinutes: 600, calendar: { ...cfg.calendar, auto: false },
    rules: { ...cfg.rules, roleplayFollowup: { enabled: true, minMinutes: 1, maxMinutes: 1 } } });
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: base - 1000 });
  const { apply } = await import('../src/plugin.js');
  const { bindInternalDispatcher } = await import('../src/channels/internal.js');
  const plugin = apply({ effect: fn => fn(), get: () => undefined }, { tool: false, startupDelaySec: 600 });
  t.after(() => plugin.stop());
  const sent = [];
  t.after(bindInternalDispatcher(async (msg) => { sent.push(msg); return { ok: true }; }));

  dialogue('剧情里，你去收拾房间。', '我先去收拾房间，等会儿回来。');
  t.mock.timers.tick(2500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(readChatData('roleplay-followup').pending?.dueAt, base + 60_000);
  t.mock.timers.tick(60_000);
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(2500);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.map(({ sessionId, source, text }) => ({ sessionId, source, text })),
    [{ sessionId: peer, source: 'roleplay', text: '（剧情）我回来啦。' }]);
});
