import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-plugin-'));
const files = {
  PG_CONFIG_PATH: path.join(dir, 'config.json'),
  PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_LOG_DIR: path.join(dir, 'logs'),
  PG_CHAT_DATA_DIR: path.join(dir, 'chat-data'),
  PG_DSH_HOME: dir,
  PG_SECRETS_PATH: path.join(dir, 'credentials.json'),
};

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function isolate(t) {
  const original = Object.entries(files).map(([key]) => [key, process.env[key]]);
  Object.assign(process.env, files);
  t.after(() => {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test('manual exploration uses the host, saves progress across rounds and never sends', async (t) => {
  isolate(t);
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
  isolate(t);
  fs.rmSync(path.join(dir, 'data', 'exploration.json'), { force: true });
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

test('自主探索模型：默认跟随绑定会话模型，并可切换到当前账号上任意 API 供应商的模型', async (t) => {
  isolate(t);
  fs.rmSync(path.join(dir, 'data', 'exploration.json'), { force: true });
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢推理小说和独立游戏。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [], dryRun: false, send: { enabled: true },
    exploration: { web: false, video: false },
    persona: { localFile: personaFile, dshHome: dir },
  }));

  const { writeChatData } = await import('../src/channels/douyin-im.js');
  writeChatData('external-chat', { sessionId: 'bound-sess-1', sessionTitle: '陪伴会话' });

  const { loadConfig } = await import('../src/config.js');
  const { applyChange } = await import('../src/settings.js');
  const { apply } = await import('../src/plugin.js');

  assert.equal(loadConfig().exploration.model, '');

  let route;
  const calledModels = [];
  let boundEvents = [
    { type: 'request/header', data: { header: { config: { provider: 'ali', model: 'deepseek-v4.1-flash-1017' } } } },
    { type: 'model/selection', data: { provider: 'ali', model: 'qwen3.8-max' } },
  ];
  const services = {
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'ali', model: 'deepseek-v4.1-flash-1017' }) },
    sessions: {
      get: (id) => (id === 'bound-sess-1' ? { snapshotEvents: () => boundEvents } : null),
    },
    llm: {
      listProviders: () => [
        { id: 'ali', displayName: '阿里云百炼' },
        { id: 'deepseek', displayName: 'DeepSeek 官方' },
      ],
      listModels: async (pid) => pid === 'ali'
        ? [{ id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' }, { id: 'qwen3.8-max', name: 'Qwen 3.8 Max' }]
        : [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }, { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }],
      async *stream({ provider, model }) {
        calledModels.push(`${provider}:${model}`);
        yield {
          type: 'text-delta',
          text: JSON.stringify({ action: 'start', topic: '叙事节奏', progress: '记下一点观察', next: '继续对比' }),
        };
      },
    },
  };
  const listeners = new Map();
  const api = apply({
    get: (k) => services[k],
    effect: (f) => f(),
    on: (ev, fn) => { listeners.set(ev, fn); },
  }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  // 1. 请求 /config：自动列出账号上所有 API 供应商的模型，默认项标注当前绑定会话的模型
  let cfgRes;
  await route.handler({ url: '/api/dsh-drop-by/config', method: 'GET', headers: {} }, {
    setHeader() {}, end(s) { cfgRes = JSON.parse(s); },
  });
  const modelItem = cfgRes.explorationItems.find((i) => i.path === 'exploration.model');
  assert.ok(modelItem);
  assert.equal(modelItem.value, '');
  assert.match(modelItem.options[0][1], /跟随绑定会话.*ali \/ qwen3\.8-max/);
  assert.ok(modelItem.options.some(([v]) => v === 'deepseek:deepseek-reasoner'));
  assert.ok(modelItem.options.some(([v]) => v === 'ali:qwen3.8-max'));

  // 2. 默认情况跑一轮探索：跟随绑定会话模型（ali:qwen3.8-max），而不是全局默认（deepseek-v4.1-flash-1017）
  let exp1;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST', headers: {} }, {
    setHeader() {}, end(s) { exp1 = JSON.parse(s); },
  });
  assert.equal(exp1.ok, true);
  assert.equal(calledModels.at(-1), 'ali:qwen3.8-max');

  // 3. 在绑定会话里通过 session/event 实时切换到另一个模型，探索立刻跟着切
  boundEvents = [];
  listeners.get('session/event')?.({ id: 'bound-sess-1' }, {
    type: 'model/selection', data: { provider: 'deepseek', model: 'deepseek-chat' },
  });
  let exp2;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST', headers: {} }, {
    setHeader() {}, end(s) { exp2 = JSON.parse(s); },
  });
  assert.equal(exp2.ok, true);
  assert.equal(calledModels.at(-1), 'deepseek:deepseek-chat');

  // 4. 在设置页手动切换到当前账号另一个 API 供应商的模型（deepseek:deepseek-reasoner）
  const changed = applyChange(loadConfig(), 'exploration.model', 'deepseek:deepseek-reasoner');
  assert.equal(changed.ok, true);
  let saveRes;
  await route.handler({
    url: '/api/dsh-drop-by/config',
    method: 'POST',
    headers: {},
    on(ev, cb) {
      if (ev === 'data') cb(Buffer.from(JSON.stringify({ path: 'exploration.model', value: 'deepseek:deepseek-reasoner' })));
      if (ev === 'end') cb();
    },
  }, { setHeader() {}, end(s) { saveRes = JSON.parse(s); } });
  assert.equal(saveRes.ok, true);
  assert.equal(saveRes.explorationItems.find((i) => i.path === 'exploration.model')?.value, 'deepseek:deepseek-reasoner');

  let exp3;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST', headers: {} }, {
    setHeader() {}, end(s) { exp3 = JSON.parse(s); },
  });
  assert.equal(exp3.ok, true);
  assert.equal(calledModels.at(-1), 'deepseek:deepseek-reasoner');
});
