import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-controls-'));
for (const [key, value] of Object.entries({
  PG_CONFIG_PATH: 'config.json', PG_STATE_PATH: 'state.json', PG_DSH_HOME: 'dsh',
  PG_LOG_DIR: 'logs', PG_SECRETS_PATH: 'credentials.json', PG_CHAT_DATA_DIR: 'data',
})) process.env[key] = path.join(root, value);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const { apply } = await import('../src/plugin.js');
const { buildReplyContext } = await import('../src/chat/qq-reply.js');
const { loadConfig } = await import('../src/settings/config.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function setup(t, { auto = false, web = false, topic = '主题：叙事节奏', interest = '', roundBudgetMs = 300_000, tools, stream } = {}) {
  fs.rmSync(path.join(root, 'data', 'exploration.json'), { force: true });
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'external-chat.json'), JSON.stringify({ sessionId: 'companion' }));
  const personaFile = path.join(root, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢比较不同叙事技巧。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    channels: { primary: 'internal' }, quietHours: [], busyHours: [],
    characterRest: { bed: '00:00', wake: '00:01', jitterMin: 0 },
    persona: { localFile: personaFile, dshHome: root },
    exploration: { auto, web, interest, nextTopic: topic, roundBudgetMs },
    calendar: { auto: false },
    startupDelaySec: 3600, rules: { qqTiming: { pollSec: 3600 } },
  }));
  let route;
  const services = {
    tools,
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'text' }) },
    llm: { stream },
  };
  const host = { get: (name) => services[name], effect: (f) => f() };
  const api = apply(host, { tool: false });
  t.after(() => api.stop());
  async function call(endpoint, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
    req.url = '/api/dsh-drop-by' + endpoint;
    req.method = 'POST';
    req.headers = {};
    let result;
    await route.handler(req, { setHeader() {}, end(s) { result = JSON.parse(s); } });
    return result;
  }
  return { api, call, host };
}

test('a preset that turns off automatic exploration cancels the in-flight automatic round', { timeout: 4000 }, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-25T05:00:00Z') });
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { api, call } = setup(t, {
    auto: true,
    async *stream({ signal }) {
      entered.resolve(signal);
      await release.promise;
    },
  });
  const round = api.runExploration();
  const signal = await Promise.race([
    entered.promise,
    round.then(result => assert.fail('Exploration ended before generation: ' + result.reason)),
  ]);
  const preset = await call('/presets/apply', { id: 'quiet' });
  assert.equal(preset.ok, true);
  assert.equal(loadConfig().exploration.auto, false);
  assert.equal(signal.aborted, true);
  assert.equal(preset.state.exploration.running, false);
  assert.equal((await round).reason, 'CANCELLED');
  assert.equal(loadConfig().exploration.nextTopic, '主题：叙事节奏');
});

test('stop route releases a hung model round, signals the provider, and ignores its late result', { timeout: 4000 }, async (t) => {
  const entered = deferred();
  const oldResult = deferred();
  let calls = 0;
  const { api, call } = setup(t, {
    async *stream({ signal }) {
      if (++calls === 1) {
        entered.resolve(signal);
        await oldResult.promise;
      }
      yield { type: 'text-delta', text: '{"action":"start","topic":"叙事节奏","progress":"记下一个案例","next":"再找一个案例"}' };
    },
  });
  const old = call('/explore');
  const signal = await entered.promise;
  const first = api.snapshot().exploration;
  assert.ok(first.runId);
  const stopped = await call('/explore/stop', { runId: first.runId });
  assert.equal(stopped.reason, 'CANCELLED');
  assert.equal(stopped.state.exploration.running, false);
  assert.equal((await old).reason, 'CANCELLED');
  assert.equal(signal.aborted, true);
  assert.equal(loadConfig().exploration.nextTopic, '主题：叙事节奏');
  assert.equal(fs.existsSync(path.join(root, 'data', 'exploration.json')), false);
  const next = await call('/explore');
  assert.equal(next.ok, true);
  const saved = fs.readFileSync(path.join(root, 'data', 'exploration.json'), 'utf8');
  oldResult.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fs.readFileSync(path.join(root, 'data', 'exploration.json'), 'utf8'), saved);
  assert.equal(loadConfig().exploration.nextTopic, '');
});

test('the bound chat can stop a round before any model or busy task routing, other sessions cannot', { timeout: 4000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { api, call, host } = setup(t, {
    async *stream({ signal }) {
      entered.resolve(signal);
      await release.promise;
    },
  });
  const round = call('/explore');
  await entered.promise;
  const msg = { cfg: loadConfig(), kind: 'private', text: '中止自主探索', at: Date.now(), observed: true };
  await buildReplyContext(host, { ...msg, peer: 'other', internalSession: 'other' });
  assert.equal(api.snapshot().exploration.running, true);
  const ack = await buildReplyContext(host, { ...msg, peer: 'companion', internalSession: 'companion' });
  assert.match(ack, /已中止/);
  assert.equal((await round).reason, 'CANCELLED');
});

test('a work with uncertain identity becomes a source selection, without opening search hits', { timeout: 4000 }, async (t) => {
  const executed = [];
  const { call } = setup(t, {
    web: true, topic: '雪国',
    stream() { throw Error('the model must not be called when work identity is unresolved'); },
    tools: { get: (name) => ({
      web_search: { execute(args) {
        executed.push([name, args]);
        return { sources: [{ url: 'https://example.org/bad-copy', title: '雪国' }] };
      } },
      web_fetch: { execute(args) { executed.push([name, args]); } },
    })[name] },
  });
  const result = await call('/explore');
  assert.equal(result.reason, 'TOPIC_AMBIGUOUS');
  assert.equal(result.state.exploration.topicIssue.input, '雪国');
  assert.equal(result.state.exploration.topicIssue.field, 'nextTopic');
  assert.equal(executed.some(([name]) => name === 'web_fetch'), false);
  const changed = await call('/explore/topic', { field: 'nextTopic', input: '雪国', choice: 'topic' });
  assert.equal(changed.ok, true);
  assert.equal(loadConfig().exploration.nextTopic, '主题：雪国');
});


test('the saved non-default round deadline interrupts the provider and leaves the next topic pending', { timeout: 4000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const { call } = setup(t, {
    async *stream({ signal }) {
      entered.resolve(signal);
      await release.promise;
    },
  });
  const saved = await call('/config', { path: 'exploration.roundBudgetMs', value: 10 });
  assert.equal(saved.ok, true);
  assert.equal(loadConfig().exploration.roundBudgetMs, 10_000);
  const field = saved.groups.flatMap(group => group.items).find(item => item?.path === 'exploration.roundBudgetMs');
  assert.equal(field?.value, 10);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const round = call('/explore');
  const signal = await entered.promise;
  t.mock.timers.tick(9_999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  const result = await round;
  assert.equal(result.reason, 'EXPLORATION_TIMEOUT');
  assert.equal(result.state.exploration.runNotice, 'EXPLORATION_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(loadConfig().exploration.nextTopic, '主题：叙事节奏');
});

test('cancelling during a catalogue lookup signals the search and discards late choices', { timeout: 4000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve({ sources: [{ url: 'https://manga.bilibili.com/detail/mc1', title: '雪国' }] }));
  const { call } = setup(t, {
    web: true, topic: '', interest: '雪国',
    stream() { assert.fail('the model should not be invoked'); },
    tools: { get: (name) => name === 'web_search' ? { execute(_, { signal }) {
      entered.resolve(signal);
      return release.promise;
    } } : null },
  });
  const round = call('/explore');
  const signal = await entered.promise;
  assert.equal((await call('/explore/stop')).reason, 'CANCELLED');
  assert.equal(signal.aborted, true);
  const result = await round;
  assert.equal(result.reason, 'CANCELLED');
  assert.equal(result.state.exploration.topicIssue, null);
  assert.equal(loadConfig().exploration.interest, '雪国');
});

test('an unresolved interest stays pending while the next ordinary item can run', { timeout: 4000 }, async (t) => {
  const { call } = setup(t, {
    topic: '', interest: '雪国\n主题：对比叙事节奏',
    async *stream({ messages }) {
      assert.match(messages[0].content[0].text, /对比叙事节奏/);
      yield { type: 'text-delta', text: '{"action":"start","topic":"对比叙事节奏","progress":"比较了两个片段","next":"找对照案例"}' };
    },
  });
  const result = await call('/explore');
  assert.equal(result.ok, true);
  assert.equal(result.state.exploration.topicIssue.field, 'interest');
  assert.equal(result.state.exploration.topicIssue.input, '雪国');
  const selected = await call('/explore/topic', { input: '雪国', field: 'interest', choice: 'source', url: 'https://publisher.example.org/work' });
  assert.equal(selected.ok, true);
  assert.equal(loadConfig().exploration.workSources, '雪国 | https://publisher.example.org/work');
  assert.equal(loadConfig().exploration.interest, '作品：雪国\n主题:对比叙事节奏');
});
