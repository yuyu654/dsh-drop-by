import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

test('settings API switches exploration.mode to light, fetches at most 1 page, and skips long thread', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-light-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.PG_STATE_PATH = path.join(dir, 'state.json');
  process.env.PG_DSH_HOME = dir;
  const personaFile = path.join(dir, 'persona.md');
  fs.writeFileSync(personaFile, '喜欢看推理短篇和手冲咖啡。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [], dryRun: false, send: { enabled: true },
    exploration: { mode: 'deep', web: true },
    persona: { localFile: personaFile, dshHome: dir },
  }));
  const { apply } = await import('../src/plugin.js');
  let route;
  let fetched = 0;
  const services = {
    webServer: { register: (r) => { route = r; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'text' }) },
    llm: { async *stream({ messages }) {
      const prompt = messages[0].content[0].text;
      if (prompt.includes('挑一件简单')) {
        yield { type: 'text-delta', text: '{"kind":"web","query":"冰滴咖啡"}' };
        return;
      }
      yield { type: 'text-delta', text: JSON.stringify({
        action: 'light', topic: '冰滴咖啡萃取', summary: '慢速冰滴确实比热冲更甜一点。',
        share: '刚看了一眼冰滴做法，慢滴出来听说苦味少很多，你喜欢喝冰滴吗？',
        progressSourceIndex: 0, sourceIndex: 0,
      }) };
    } },
  };
  const tools = { get: (name) => ({
    web_search: { execute: () => ({ sources: [{ url: 'https://example.org/1' }, { url: 'https://example.org/2' }] }) },
    web_fetch: { execute: () => { fetched++; return { statusCode: 200, body: { content: '冰滴正文内容' } }; } },
  })[name] };
  const api = apply({
    get: (k) => services[k], effect: (f) => f(),
    inject: ([key], callback) => callback({ get: (name) => name === 'tools' && key === 'tools' ? tools : services[name] }),
  }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  // 通过设置页 HTTP 口切到 light 模式并验证回显
  const req = Readable.from([Buffer.from(JSON.stringify({ path: 'exploration.mode', value: 'light' }))]);
  req.method = 'POST';
  req.url = '/api/dsh-drop-by/config';
  req.headers = {};
  let cfgBody;
  await route.handler(req, { setHeader() {}, end(s) { cfgBody = JSON.parse(s); } });
  assert.equal(cfgBody.ok, true);
  assert.equal(cfgBody.explorationItems.find((i) => i.path === 'exploration.mode')?.value, 'light');

  let body;
  await route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
    setHeader() {}, end(s) { body = JSON.parse(s); },
  });
  assert.equal(body.ok, true);
  assert.equal(body.action, 'light');
  assert.equal(fetched, 1, '轻量化探索最多抓 1 页正文');
  assert.equal(body.state.exploration.thread, null);
  assert.equal(body.state.exploration.light.topic, '冰滴咖啡萃取');
  assert.equal(body.state.exploration.mode, 'light');
});
