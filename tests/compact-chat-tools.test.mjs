import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-chat-tools-'));
for (const [key, file] of Object.entries({
  PG_CONFIG_PATH: 'config.json',
  PG_STATE_PATH: 'state.json',
  PG_LOG_DIR: 'logs',
  PG_DSH_HOME: 'dsh',
  PG_CHAT_DATA_DIR: 'data',
  PG_SECRETS_PATH: 'credentials.json',
})) {
  process.env[key] = path.join(tmp, file);
}
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const { apply } = await import('../src/plugin.js');

function write(relative, value) {
  const file = path.join(tmp, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function setup(t, { supported = true, enabled = false } = {}) {
  write('config.json', {
    startupDelaySec: 3600,
    channels: { primary: 'qq', qq: { peerId: '10001' } },
    rules: { compactChatTools: enabled, qqTiming: { pollSec: 3600 } },
    calendar: { auto: false },
  });
  write('data/external-chat.json', { sessionId: 'old' });
  const bind = (sid) => write('dsh/qq-bridge/bindings.json', {
    sessions: Object.fromEntries(Object.entries({
      old: '10001',
      next: '10001',
      fresh: '10001',
      task: '10002',
    }).map(([id, peerId]) => [id, { peerKind: 'private', peerId, enabled: id === sid || id === 'task' }])),
  });
  bind('old');
  const events = new Map();
  function emit(name, ...args) {
    for (const fn of events.get(name) || []) fn(...args);
  }
  const globalTools = new Set(['video_zoom', 'workflow', 'presence_watch_video', 'video_storyboard', 'schedule_create', 'remember', 'ops_bash']);
  const agents = new Map();
  const restrictions = new Map();
  const schemas = (agent) => [...globalTools]
    .filter((name) => !restrictions.get(agent)?.has(name))
    .map((name) => ({ name }));
  function createAgent(id) {
    const agent = { id, session: { id }, ctx: {} };
    agent.ctx.tools = { schemas };
    if (supported) {
      agent.ctx.tools.restrict = ({ deny }) => {
        assert.ok(deny.every((name) => globalTools.has(name)), 'The host rejects absent tool names');
        assert.equal(restrictions.has(agent), false, 'The plugin should replace its prior restriction');
        restrictions.set(agent, new Set(deny));
        emit('tools/change');
        return () => {
          restrictions.delete(agent);
          emit('tools/change');
        };
      };
    }
    agents.set(id, agent);
    emit('agent/created', { agent });
    return agent;
  }
  const task = createAgent('task');
  const old = createAgent('old');
  let route;
  const services = {
    agents,
    logger: { info() {}, warn() {}, error() {} },
    tools: { schemas, ...(supported ? { restrict() { throw Error('Global tool restriction attempted'); } } : {}) },
    webServer: { register(r) { route = r; return () => {}; } },
  };
  const api = apply({
    get: (key) => services[key],
    effect(fn) { return fn(); },
    on(name, fn) {
      const group = events.get(name) || new Set();
      group.add(fn);
      events.set(name, group);
      return () => group.delete(fn);
    },
  }, { tool: false });
  t.after(() => api.stop());

  const visible = (agent) => schemas(agent).map((item) => item.name);
  async function config(method = 'GET', payload) {
    const req = Readable.from(payload ? [Buffer.from(JSON.stringify(payload))] : []);
    req.method = method;
    req.url = '/api/dsh-drop-by/config';
    req.headers = {};
    let json;
    await route.handler(req, {
      setHeader() {},
      end(body) { json = JSON.parse(body); },
    });
    return json;
  }
  const save = (value) => config('POST', { path: 'rules.compactChatTools', value });
  return { api, bind, config, createAgent, emit, globalTools, old, save, task, visible };
}

test('设置保存后只精简绑定会话的实际工具声明，关闭即恢复', async (t) => {
  const { config, globalTools, old, save, task, visible } = setup(t);
  const before = await config();
  const item = (response) => response.groups.flatMap((group) => group.items)
    .find((field) => field.path === 'rules.compactChatTools');
  assert.equal(item(before)?.value, false);
  assert.ok(visible(old).includes('video_zoom'));

  const response = await save(true);
  assert.equal(response.ok, true);
  assert.equal(item(await config()).value, true);
  assert.deepEqual(response.state.compactChatTools, { state: 'active', hiddenCount: 2 });
  assert.deepEqual(visible(old), ['presence_watch_video', 'video_storyboard', 'schedule_create', 'remember', 'ops_bash']);
  assert.deepEqual(visible(task), [...globalTools]);
  assert.deepEqual(visible(), [...globalTools]);

  const disabled = await save(false);
  assert.deepEqual(disabled.state.compactChatTools, { state: 'off', hiddenCount: 0 });
  assert.deepEqual(visible(old), [...globalTools]);
});

test('桥接续聊换绑前后仅当前联系人所绑定的会话应用筛选', (t) => {
  const { api, bind, createAgent, emit, globalTools, old, task, visible } = setup(t, { enabled: true });
  assert.ok(!visible(old).includes('workflow'), 'already loaded companion session is filtered');
  const next = createAgent('next');
  assert.deepEqual(visible(next), [...globalTools]);

  bind('next');
  emit('session/event', next.session, { type: 'turn/start' });
  assert.deepEqual(visible(old), [...globalTools]);
  assert.deepEqual(visible(task), [...globalTools]);
  assert.ok(!visible(next).includes('workflow'));
  assert.equal(api.snapshot().compactChatTools.hiddenCount, 2);

  globalTools.add('video_subtitles');
  emit('tools/change');
  assert.ok(!visible(next).includes('video_subtitles'));
  assert.equal(api.snapshot().compactChatTools.hiddenCount, 3);

  bind('fresh');
  emit('session/event', task.session, { type: 'turn/start' });
  assert.deepEqual(api.snapshot().compactChatTools, { state: 'waiting', hiddenCount: 0 });
  assert.deepEqual(visible(next), [...globalTools]);
  const fresh = createAgent('fresh');
  assert.ok(!visible(fresh).includes('video_subtitles'), 'starts filtered before the new session takes a turn');

  api.stop();
  assert.deepEqual(visible(fresh), [...globalTools]);
  assert.deepEqual(visible(next), [...globalTools]);
});

test('缺少作用域限制接口时保留工具并在设置中报告', (t) => {
  const { api, globalTools, old, visible } = setup(t, { supported: false, enabled: true });
  assert.deepEqual(api.snapshot().compactChatTools, { state: 'unsupported', hiddenCount: 0 });
  assert.deepEqual(visible(old), [...globalTools]);
});

