import test from 'node:test';
import assert from 'node:assert/strict';
import { activeChatChannel, chatPeer, chatDialogue } from '../src/channels/external.js';

test('Douyin mode does not use the QQ dialogue adapter', () => {
  const cfg = { channels: { primary: 'douyin', douyin: { peerSecUid: 'dy' }, qq: { peerId: 'qq' } } };
  assert.equal(activeChatChannel(cfg), 'douyin');
  assert.equal(chatPeer(cfg), 'dy');
  const data = chatDialogue(cfg, {
    readQq() { assert.fail('QQ data was read'); },
    readDouyin(peer) { return { incoming: { peer }, outgoing: { lastAt: 5, source: 'reply' } }; },
  });
  assert.equal(data.incoming.peer, 'dy');
  assert.equal(data.outgoing.lastAt, 5);
});

test('a Douyin reply does not settle a QQ message still awaiting an answer', async () => {
  const { noteSent, settle } = await import('../src/decision/feedback.js');
  const st = {};
  const at = new Date('2026-11-16T12:00:00+08:00').getTime();
  noteSent(st, 'agenda', at, 'QQ 上说过', { channel: 'qq' });
  noteSent(st, 'agenda', at + 1, '抖音说过', { channel: 'douyin' });
  assert.equal(settle(st, at + 120000, at + 120000, '抖音用户的回复', { channel: 'douyin' }), 1);
  assert.deepEqual(st.feedback.pending.map(p => p.channel), ['qq']);
});
