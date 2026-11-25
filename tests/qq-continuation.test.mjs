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
const { createQqContinuation, runQqContinuation } = await import('../src/chat/qq-continuation.js');
const { qqContinuationTone } = await import('../src/decision/persona.js');

const peer = '42';
const grounded = (anchor = '那个漫画', line = '那个漫画最戳你的是哪一格？') =>
  ({ ok: true, text: JSON.stringify({ send: true, anchor, line }) });
const yes = { ok: true, text: 'YES' };
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

test('dialogue comes before style, and persona facts never reach either prompt', async () => {
  const markers = pair(now);
  const persona = { text: '角色爱喝饮料，喜欢吃甜，也会每天去书店。口吻克制，习惯说短句。' };
  const prompts = [];
  const delivered = [];
  await runQqContinuation({
    candidate: { ...markers, turns: [markers] }, read: () => markers, allowed: () => true,
    tone: qqContinuationTone(persona),
    generate: async ({ prompt }) => prompts.push(prompt) === 1 ? grounded() : yes,
    deliver: async (line) => delivered.push(line),
  });
  assert.equal(prompts.length, 2);
  assert.ok(prompts[0].indexOf('那个漫画好好笑') < prompts[0].indexOf('【口吻要求】'));
  assert.match(prompts[0], /语气收一点，句子短一些/);
  for (const prompt of prompts) assert.doesNotMatch(prompt, /爱喝饮料|喜欢吃甜|每天去书店/);
  assert.deepEqual(delivered, ['那个漫画最戳你的是哪一格？']);
});

test('waiting for the user is a one-call skip', async () => {
  const markers = pair(now, '我先把右上角改一下');
  markers.outgoing.text = '改好了再发一张，我等着看。';
  let generated = 0;
  const result = await runQqContinuation({
    candidate: { ...markers, turns: [markers] }, read: () => markers, allowed: () => true,
    generate: async ({ prompt }) => {
      generated++;
      assert.match(prompt, /改好了再发一张，我等着看/);
      assert.match(prompt, /在等对方行动或发图/);
      return { ok: true, text: '{"send":false}' };
    },
    deliver: () => assert.fail('must not send'),
  });
  assert.equal(result.reason, 'QQ_CONTINUATION_NO_LINE');
  assert.equal(generated, 1);
});

test('draft must cite actual dialogue and pass a separate topical review', async () => {
  const markers = pair(now);
  const cases = [
    [{ ok: true, text: '不是 JSON' }, null, 'QQ_CONTINUATION_NO_LINE'],
    [{ ok: true, text: '{"send":true,"line":"那个漫画哪段好笑？"}' }, null, 'QQ_CONTINUATION_NO_LINE'],
    [grounded('', '那个漫画哪段好笑？'), null, 'QQ_CONTINUATION_NO_LINE'],
    [grounded('滑板比赛'), null, 'QQ_CONTINUATION_OFF_TOPIC'],
    [grounded('我也喜欢那段', markers.outgoing.text), null, 'QQ_CONTINUATION_REJECTED'],
    [grounded('那个漫画', '聊着聊着我想喝杯奶茶。'), { ok: true, text: 'NO' }, 'QQ_CONTINUATION_OFF_TOPIC'],
  ];
  for (const [draft, review, reason] of cases) {
    let generated = 0;
    const result = await runQqContinuation({
      candidate: { ...markers, turns: [markers] }, read: () => markers, allowed: () => true,
      generate: async () => ++generated === 1 ? draft : review,
      deliver: () => assert.fail('must not send'),
    });
    assert.equal(result.reason, reason);
    assert.equal(generated, review ? 2 : 1);
  }
});

test('a new incoming message during semantic review prevents delivery', async () => {
  const markers = pair(now);
  let latest = markers;
  let generated = 0;
  const result = await runQqContinuation({
    candidate: { ...markers, turns: [markers] }, read: () => latest, allowed: () => true,
    generate: async () => {
      if (++generated === 1) return grounded();
      latest = pair(now + 10_000, '我先去忙');
      return yes;
    },
    deliver: () => assert.fail('must not send'),
  });
  assert.equal(result.reason, 'QQ_CONTINUATION_STALE');
});

test('use a full recent inbound message for drafting without changing its bridge marker', async () => {
  const { waitForQqBurst } = await import('../src/chat/qq-debounce.js');
  const { readBridgeDialogue } = await import('../src/chat/outbound.js');
  const folder = path.join(dir, 'qq-bridge');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = Date.now();
  const tail = '最后一格里，猫把伞抢走了';
  const full = '前面我说的是第一格。'.repeat(10) + tail;
  fs.writeFileSync(path.join(folder, 'last-in.json'), JSON.stringify({ peer, peerKind: 'private', at: stamp, text: full.slice(0, 80) }));
  fs.writeFileSync(path.join(folder, 'last-out.json'), JSON.stringify({ peer, firstAt: stamp + 1000, lastAt: stamp + 2000, count: 1, text: '对对这格太逗了' }));
  await waitForQqBurst({ peer, text: full, at: stamp, debounceMs: 1 });
  const marker = readBridgeDialogue();
  assert.equal(marker.incoming.text.length, 80);
  let generated = 0;
  let sent;
  await runQqContinuation({
    candidate: { ...marker, turns: [marker] }, read: readBridgeDialogue, allowed: () => true,
    generate: async ({ prompt }) => {
      assert.match(prompt, /猫把伞抢走了/);
      return ++generated === 1 ? grounded('猫把伞抢走了', '猫抢伞那下，你也是在那格笑的吗？') : yes;
    },
    deliver: (line) => { sent = line; },
  });
  assert.equal(sent, '猫抢伞那下，你也是在那格笑的吗？');
  assert.deepEqual(readBridgeDialogue(), marker);
});

test('engine preview uses the shared quota and never calls the QQ transport', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T12:00:00+08:00'));
  const { tickQqContinuation } = await import('../src/decision/engine.js');
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
      return ++generated === 1 ? grounded() : yes;
    },
  });
  await run(markers);
  await run(pair(when + 500));
  const st = JSON.parse(fs.readFileSync(process.env.PG_STATE_PATH, 'utf8'));
  assert.equal(generated, 2);
  assert.equal(st.sim.todaySent, 1);
  assert.equal(st.real.todaySent, 0);
  const records = fs.readdirSync(process.env.PG_LOG_DIR);
  const record = JSON.parse(fs.readFileSync(path.join(process.env.PG_LOG_DIR, records[0]), 'utf8'));
  assert.equal(record.delivery.reason, 'DRY_RUN');
});

test('tickQqContinuation passes portrait mood-map tone into generation prompt when enabled', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-22T12:00:00+08:00'));
  const { tickQqContinuation } = await import('../src/decision/engine.js');
  fs.writeFileSync(process.env.PG_STATE_PATH, '{}');
  const emDir = path.join(dir, 'profiles', 'desktop', 'node_modules', 'emotion-state-portrait', 'emotion');
  fs.mkdirSync(emDir, { recursive: true });
  t.after(() => fs.rmSync(path.join(dir, 'profiles'), { recursive: true, force: true }));
  fs.writeFileSync(path.join(path.dirname(emDir), 'package.json'), JSON.stringify({ name: 'emotion-state-portrait', version: '1.0.5' }));
  fs.writeFileSync(path.join(emDir, 'state.json'), JSON.stringify({ updatedAt: Date.now() }));
  fs.writeFileSync(path.join(path.dirname(emDir), 'mood-map.json'), JSON.stringify({
    [peer]: '心情：雀跃Lv1；对她：熟悉；硬规则：别直念',
  }));
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    dryRun: true, quietHours: [], busyHours: [], persona: { enabled: false },
    exploration: { portrait: true }, rules: { qqContinuation: true, dailyCap: 5 },
    channels: { qq: { peerId: peer } },
  }));
  const when = Date.now();
  const round = pair(when - 20_000);
  let seenPrompt = '';
  await tickQqContinuation({
    candidate: { ...round, turns: [round], expiresAt: when + 50_000 },
    read: () => round,
    active: () => true,
    generate: async ({ prompt }) => {
      if (!seenPrompt) seenPrompt = prompt;
      return grounded();
    },
  });
  assert.match(seenPrompt, /雀跃Lv1/);
});
