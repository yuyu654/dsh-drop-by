import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('manual exploration uses the host, saves progress across rounds and never sends', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.PG_STATE_PATH = path.join(dir, 'state.json');
  process.env.PG_DSH_HOME = dir;
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢推理小说和不可靠叙述者。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [], dryRun: false, send: { enabled: true },
    exploration: { web: true, leisureEvery: 0 },
    persona: { localFile: personaFile, dshHome: dir },
  }));
  const { apply } = await import('../src/plugin.js');
  let route;
  let calls = 0;
  let searched = 0;
  const services = {
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'text' }) },
    llm: { async *stream({ messages, maxTokens }) {
      const prompt = messages[0].content[0].text;
      assert.match(prompt, /不可靠叙述者/);
      if (prompt.includes('替角色选')) {
        yield { type: 'text-delta', text: '{"mode":"research","kind":"web","query":"推理短篇"}' };
        return;
      }
      assert.ok(maxTokens >= 1024, 'exploration needs room for reasoning and the JSON result');
      assert.match(prompt, /推理资料正文/);
      if (++calls === 2) assert.match(prompt, /再找个反例/);
      yield { type: 'text-delta', text: JSON.stringify({
        action: calls === 1 ? 'start' : 'continue', topic: '不可靠叙述者',
        progress: '区分误记和误导', next: '再找个反例', share: '我想到一个有意思的反例。',
      }) };
    } },
  };
  t.mock.method(globalThis, 'fetch', () => assert.fail('manual exploration must not use QQ transport'));
  const tools = { get: (name) => ({
    web_search: { execute: () => { searched++; return { sources: [{ url: 'https://example.org/story' }] }; } },
    web_fetch: { execute: () => ({ statusCode: 200, body: { content: '推理资料正文' } }) },
  })[name] };
  const api = apply({
    get: (k) => services[k], effect: (f) => f(),
    inject: ([key], callback) => callback({ get: (name) => name === 'tools' && key === 'tools' ? tools : services[name] }),
  }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());
  for (const expected of ['start', 'continue']) {
    let body;
    await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
      setHeader() {}, end(s) { body = JSON.parse(s); },
    });
    assert.equal(body.action, expected, JSON.stringify(body));
    assert.equal(body.state.exploration.thread.topic, '不可靠叙述者');
  }
  assert.equal(calls, 2);
  assert.equal(searched, 2);
  assert.equal(api.snapshot().today.real, 0);
});

test('manual exploration failure writes diagnostic note to plugin.log and returns note in response', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-fail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.PG_STATE_PATH = path.join(dir, 'state.json');
  process.env.PG_DSH_HOME = dir;
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢推理小说。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [], dryRun: false, send: { enabled: true },
    content: { llm: { retries: 0 } },
    exploration: { web: false, video: false },
    persona: { localFile: personaFile, dshHome: dir },
  }));
  const { apply } = await import('../src/plugin.js');
  let route;
  const services = {
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'ali', model: 'deepseek-v4.1-flash-1017' }) },
    llm: { async *stream() {
      yield { type: 'reasoning-delta', text: '一直想个不停' };
      yield { type: 'finish', reason: { kind: 'max-tokens' } };
    } },
  };
  const api = apply({ get: (k) => services[k], effect: (f) => f() }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  let body;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
    setHeader() {}, end(s) { body = JSON.parse(s); },
  });
  assert.equal(body.ok, false);
  assert.equal(body.reason, 'HOST_LLM_EMPTY');
  assert.match(body.note, /finish=max-tokens · reasoning=6字/);
  const pluginLog = fs.readFileSync(path.join(dir, 'logs', 'plugin.log'), 'utf8');
  assert.match(pluginLog, /生成最终失败（HOST_LLM_EMPTY：finish=max-tokens/);
  assert.match(pluginLog, /自主探索未完成：HOST_LLM_EMPTY/);
});
