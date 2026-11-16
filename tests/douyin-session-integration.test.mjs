import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDouyinSession } from '../src/channels/douyin-session.js';
import { writeChatData, readDouyinState } from '../src/channels/douyin-im.js';

test('read, merge, route and send a real owned turn through the fake host', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-douyin-'));
  const previous = process.env.PG_CHAT_DATA_DIR;
  process.env.PG_CHAT_DATA_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.PG_CHAT_DATA_DIR;
    else process.env.PG_CHAT_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  writeChatData('external-chat', { sessionId: 'shared', qqBinding: { peerId: 'qq' } });
  const cfg = { channels: { primary: 'douyin', douyin: { peerSecUid: 'dy', pollSec: 30 } }, send: { timeoutMs: 5000 }, timezone: 'UTC' };
  const now = Date.now();
  const m = (text, offset) => ({ text, at: new Date(now - offset).toISOString(), from: 'them', kind: 'text' });
  const messages = [m('旧消息', 20000)];
  const prompts = [];
  const sent = [];
  const modelInputs = [];
  const host = { async prompt(request) { prompts.push(request); return { accepted: true }; } };
  const app = createDouyinSession({
    getConfig: () => cfg, controller: () => host, watcherDisabled: () => true,
    read: async () => ({ conv_id: 'conv', messages }),
    prepare: async (input) => { modelInputs.push(input.text); return '角色背景'; },
    send: async ({ peer, text }) => { sent.push({ peer, text }); return { ok: true }; },
  });
  t.after(() => app.stop());
  await app.pollNow();
  assert.equal(prompts.length, 0);
  messages.push(m('我先说一半', 11000), m('再补半句', 10000));
  await app.pollNow();
  await app.pollNow();
  assert.deepEqual(modelInputs, ['我先说一半\n再补半句']);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].sessionId, 'shared');
  assert.match(prompts[0].content[0].text, /角色背景[\s\S]*我先说一半\n再补半句/u);
  const session = { id: 'shared' };
  const emit = (type, data) => app.observe(session, { type, data });
  emit('turn/start', { turn: 1 });
  emit('user/message', { source: { kind: 'user', rpcId: 'desktop' } });
  emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '桌面上的回复' }] } });
  emit('turn/end', { turn: 1 });
  emit('turn/start', { turn: 2 });
  emit('user/message', { source: { kind: 'user', rpcId: prompts[0].requestId } });
  emit('assistant/message', { turn: 2, message: { content: [{ type: 'text', text: '只回抖音这一轮' }] } });
  emit('turn/end', { turn: 2 });
  await app.drain();
  assert.deepEqual(sent, [{ peer: 'dy', text: '只回抖音这一轮' }]);
  assert.equal(readDouyinState('dy').pending.length, 0);
  assert.match(prompts[0].content[0].text, /TA：旧消息/);

  // Simulate a proactive message sent outside the session, then another user reply.
  const { updateDouyinState } = await import('../src/channels/douyin-im.js');
  const proactiveTs = now - 6000;
  updateDouyinState('dy', (s) => ({
    ...s,
    dialogue: [...(s.dialogue || []), { who: 'me', text: '我去买饭，顺手给你带一份？', ts: proactiveTs, source: 'companion' }],
  }));
  messages.push(m('我要吃寿司', 4000));
  await app.pollNow();
  await app.pollNow();
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].content[0].text, /我：我去买饭，顺手给你带一份？/);
  assert.equal(/TA：旧消息/.test(prompts[1].content[0].text), false, '已同步过的前情不应重复注入');
});
