import test from 'node:test';
import assert from 'node:assert/strict';
import { createOwnedReplies } from '../src/channels/douyin-session.js';
import { switchToQq, localApiOrigin, localChatApi } from '../src/channels/chat-switch.js';

test('only the turn with the expected RPC id returns a reply', () => {
  const capture = createOwnedReplies();
  capture.expect('session', 'mine');
  const send = (type, data) => capture.observe('session', { type, data });
  const assistant = (turn, text) => send('assistant/message', { turn, message: { content: [{ type: 'text', text }] } });
  send('turn/start', { turn: 1 });
  send('user/message', { source: { kind: 'user', rpcId: 'desktop' } });
  assistant(1, 'private desktop answer');
  assert.equal(send('turn/end', { turn: 1 }), undefined);
  send('turn/start', { turn: 2 });
  send('user/message', { source: { kind: 'user', rpcId: 'mine' } });
  assistant(2, 'answer');
  assert.deepEqual(send('turn/end', { turn: 2 }), { requestId: 'mine', text: 'answer' });
  assert.equal(send('turn/end', { turn: 2 }), undefined);
});

test('cutback rebinds the current shared session without re-enabling Douyin watcher', async () => {
  const calls = [];
  await switchToQq({ sessionId: 'after-rollover', qqBinding: { sessionId: 'old', peerId: 'qq-peer' } },
    async (route, body) => { calls.push([route, body]); });
  assert.deepEqual(calls, [['/dsh-qq-bridge/bind', { sessionId: 'after-rollover', peerId: 'qq-peer' }]]);
});

test('coordination follows the actual local origin and rejects a foreign origin', () => {
  assert.equal(localApiOrigin({ host: '127.0.0.1:53276', origin: 'http://127.0.0.1:53276' }), 'http://127.0.0.1:53276');
  assert.equal(localApiOrigin({ host: '127.0.0.1:53276' }), 'http://127.0.0.1:53276');
  assert.equal(localApiOrigin({ host: 'localhost:53276', referer: 'http://localhost:53276/settings' }), 'http://localhost:53276');
  assert.throws(() => localApiOrigin({ host: '127.0.0.1:53276', origin: 'https://foreign.test' }));
  assert.throws(() => localApiOrigin({ host: '127.0.0.1:53276', referer: 'https://foreign.test/x' }));
});

test('localChatApi forwards auth headers and surfaces non-JSON errors clearly', async (t) => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('Unauthorized', { status: 401 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const call = localChatApi('http://127.0.0.1:53276', {
    timeoutMs: 2000,
    headers: { cookie: 'sid=abc', authorization: 'Bearer tok' },
  });
  await assert.rejects(() => call('/api/douyin-duty/config'), /HTTP 401/);
  assert.equal(calls[0].init.headers.cookie, 'sid=abc');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
});
