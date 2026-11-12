import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-continuation-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
for (const [key, file] of Object.entries({
  PG_CONFIG_PATH: 'config.json', PG_STATE_PATH: 'state.json', PG_LOG_DIR: 'logs', PG_DSH_HOME: '.',
})) process.env[key] = path.join(dir, file);
const { createQqContinuation, runQqContinuation } = await import('../src/qq-continuation.js');

const peer = '42';
const now = 2_000_000;
const pair = (at, text = '那个漫画好好笑') => ({
  incoming: { peer, kind: 'private', ts: at, observedAt: at, text },
  outgoing: { peer, firstAt: at + 1000, lastAt: at + 2000, count: 1, text: '我也喜欢那段' },
});

test('only recently observed back-and-forth arms one continuation after a pause', () => {
  const chat = createQqContinuation();
  const first = pair(now);
  const second = pair(now + 20_000, '你喜欢哪个角色');
  assert.equal(chat.observe(first, peer, now + 2000), null);
  assert.equal(chat.observe(second, peer, now + 22_000), null);
  const due = chat.observe(second, peer, now + 37_000);
  assert.equal(due?.turns.length, 2);
  chat.consume(due);
  assert.equal(chat.observe(second, peer, now + 39_000), null);
});

test('an unrelated peer, in-flight reply or new incoming message cannot count as the previous round', () => {
  const chat = createQqContinuation();
  const first = pair(now);
  chat.observe(first, peer, now + 2000);
  const second = pair(now + 20_000);
  chat.observe({ ...second, outgoing: { ...second.outgoing, peer: '99' } }, peer, now + 22_000);
  chat.observe({ ...second, outgoing: { ...second.outgoing, lastAt: 0 } }, peer, now + 23_000);
  assert.equal(chat.observe({ ...second, incoming: { ...second.incoming, observedAt: now + 25_000 } }, peer, now + 37_000), null);
});

test('a new QQ message while the draft is being written discards it', async () => {
  let latest = pair(now);
  let delivered = 0;
  const result = await runQqContinuation({
    candidate: { ...latest, turns: [latest] },
    read: () => latest,
    allowed: () => true,
    generate: async () => {
      latest = { ...latest, incoming: pair(now + 3000, '我先去上课').incoming };
      return { ok: true, text: '我刚想起她后来还把书还回去了。' };
    },
    deliver: async () => { delivered++; },
  });
  assert.equal(result.reason, 'QQ_CONTINUATION_STALE');
  assert.equal(delivered, 0);
});

test('a valid new line is delivered once; skip, duplicate and commentary are not sent', async () => {
  const markers = pair(now);
  const delivered = [];
  for (const text of ['__SKIP__', markers.outgoing.text, '想法：可以继续聊漫画\n最终回复：哈哈', '我刚想起她后来还把书还回去了。']) {
    await runQqContinuation({
      candidate: { ...markers, turns: [markers] },
      read: () => markers,
      allowed: () => true,
      generate: async () => ({ ok: true, text }),
      deliver: async (line) => delivered.push(line),
    });
  }
  assert.deepEqual(delivered, ['我刚想起她后来还把书还回去了。']);
});

test('engine preview uses the shared quota and never calls the QQ transport', async (t) => {
  const { tickQqContinuation } = await import('../src/engine.js');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    dryRun: true, quietHours: [], busyHours: [], persona: { enabled: false },
    rules: { qqContinuation: true, dailyCap: 1 }, channels: { qq: { peerId: peer } },
  }));
  const when = Date.now();
  const markers = pair(when - 20_000);
  let generated = 0;
  t.mock.method(globalThis, 'fetch', () => assert.fail('preview must not call QQ'));
  const run = (round) => tickQqContinuation({
    candidate: { ...round, turns: [round], expiresAt: when + 50_000 },
    read: () => round, active: () => true,
    generate: async () => {
      generated++;
      return { ok: true, text: '我刚想起她后来还把书还回去了。' };
    },
  });
  await run(markers);
  await run(pair(when + 500));
  const st = JSON.parse(fs.readFileSync(process.env.PG_STATE_PATH, 'utf8'));
  assert.equal(generated, 1);
  assert.equal(st.sim.todaySent, 1);
  assert.equal(st.real.todaySent, 0);
  const records = fs.readdirSync(process.env.PG_LOG_DIR);
  const record = JSON.parse(fs.readFileSync(path.join(process.env.PG_LOG_DIR, records[0]), 'utf8'));
  assert.equal(record.delivery.reason, 'DRY_RUN');
});
