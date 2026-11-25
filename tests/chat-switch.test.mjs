import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-chat-switch-'));
const home = path.join(dir, 'dsh');
const env = {
  PG_CONFIG_PATH: path.join(dir, 'config.json'),
  PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_LOG_DIR: path.join(dir, 'logs'),
  PG_SECRETS_PATH: path.join(dir, 'credentials.json'),
  PG_DSH_HOME: home,
  PG_CHAT_DATA_DIR: path.join(dir, 'data'),
};
const originals = Object.entries(env).map(([key]) => [key, process.env[key]]);
Object.assign(process.env, env);
test.after(() => {
  for (const [key, value] of originals) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const { apply } = await import('../src/plugin.js');
const { chatBinding, changePrimaryChannel, localChatApi } = await import('../src/channels/chat-switch.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { loadConfig } = await import('../src/settings/config.js');
const cfg = {
  channels: { primary: 'qq', qq: { peerId: '' }, douyin: { peerSecUid: 'MS4w-test', peerName: '测试昵称' } },
  rules: { qqRollover: { enabled: true, thresholdPercent: 80, prepareBindingFile: true } },
  send: { enabled: false },
};
const QQ_ID = '10001';
const oldBinding = (sessionId, options = {}) => ({
  sessionId, peerId: QQ_ID, peerKind: 'private', enabled: true, authoritative: true, ...options,
});
function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function fixture(t, { qq = false, peerId = '', primary = 'qq', external = {}, bindings = [], watcher = false } = {}) {
  write(env.PG_CONFIG_PATH, { ...cfg, channels: { ...cfg.channels, primary, qq: { peerId } } });
  writeChatData('external-chat', external);
  writeChatData('chat-switch', {});
  write(path.join(dir, 'data', 'session-handoff.json'), {});
  const qqPackage = path.join(home, 'node_modules', 'dsh-plugin-qq-bridge', 'package.json');
  const conn = path.join(home, 'qq-bridge', 'connection.json');
  function enableQq() {
    qq = true;
    write(qqPackage, { name: 'dsh-plugin-qq-bridge' });
    write(conn, { httpApiUrl: 'http://127.0.0.1:1', httpToken: 'test' });
  }
  if (qq) enableQq();
  else {
    fs.rmSync(qqPackage, { force: true });
    fs.rmSync(conn, { force: true });
  }
  const dy = path.join(home, 'node_modules', 'dsh-douyin-scroll');
  write(path.join(dy, 'package.json'), { name: 'dsh-douyin-scroll' });
  for (const file of ['im-http.py', 'im-send.mjs']) write(path.join(dy, 'tools', file), {});
  const dyCfg = path.join(home, 'douyin-duty', 'config.json');
  write(dyCfg, { chatWatch: watcher });
  const bridge = new Map(bindings.map(binding => [binding.sessionId, binding]));
  const calls = [], creations = [], renames = [];
  const sessions = new Set(['existing-douyin', 'standalone-douyin', 'qq-shared']);
  const controller = {
    async create(options) {
      creations.push(options);
      const sessionId = 'new-douyin-' + creations.length;
      sessions.add(sessionId);
      return { sessionId };
    },
    async rename(options) { renames.push(options); return options; },
    async inspect(id) {
      if (!sessions.has(id)) throw Object.assign(new Error('session not found'), { code: 'session/not-found' });
      return { meta: { cwd: '/fixture' }, events: [] };
    },
    async prompt() {},
    async projections() { return { values: { contextPressure: { projectedTokens: 90, contextWindow: 100 } } }; },
  };
  let route, event;
  const services = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(r) { route = r; return () => {}; } },
    sessionController: controller,
    workspaceRegistry: { list: () => [{ id: 'fixture-workspace', path: '/fixture', sessionIds: ['standalone-douyin'] }] },
  };
  const api = apply({
    get: key => services[key],
    effect: fn => fn(),
    on(name, receive) { if (name === 'session/event') event = receive; },
  }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());
  const failure = {};
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    const u = new URL(url);
    assert.equal(u.host, 'localhost:53276');
    const body = request.body && JSON.parse(request.body);
    calls.push([u.pathname, body]);
    if (u.pathname === '/api/douyin-duty/config') {
      if (body) write(dyCfg, body);
      return Response.json({ ok: true, config: JSON.parse(fs.readFileSync(dyCfg, 'utf8')) });
    }
    if (!qq) return Response.json({ error: 'QQ 插件未启用' }, { status: 404 });
    if (u.pathname === '/dsh-qq-bridge/state') {
      if (failure.stateStatus) return Response.json({ error: 'QQ 桥不可用' }, { status: failure.stateStatus });
      return Response.json({ sessions: [...bridge.keys()], binding: bridge.get(u.searchParams.get('sessionId')) || null });
    }
    if (u.pathname === '/dsh-qq-bridge/options') {
      const before = bridge.get(body.sessionId);
      bridge.set(body.sessionId, { ...before, enabled: body.enabled });
      if (body.enabled === false && failure.optionsAfterWrite) throw new Error('停用响应中断');
      return Response.json({ ok: true });
    }
    if (u.pathname === '/dsh-qq-bridge/bind') {
      if (failure.bind) return Response.json({ error: '绑定失败' }, { status: 500 });
      const binding = { ...body, enabled: true };
      bridge.set(binding.sessionId, binding);
      if (failure.bindAfterWrite) throw new Error('绑定响应中断');
      return Response.json({ ok: true, binding });
    }
    if (u.pathname === '/dsh-qq-bridge/unbind') {
      bridge.delete(body.sessionId);
      return Response.json({ ok: true });
    }
    assert.fail('unrecognized route ' + u.pathname);
  });
  return {
    calls, creations, renames, bridge, controller, failure, api,
    enableQq,
    emit: (session, payload) => event(session, payload),
    switchTo(value) { return this.save('channels.primary', value); },
    async save(path, value) {
      const req = Readable.from([Buffer.from(JSON.stringify({ path, value }))]);
      Object.assign(req, { method: 'POST', url: '/api/dsh-drop-by/config', headers: { host: 'localhost:53276' } });
      let response;
      await route.handler(req, { setHeader() {}, end(raw) { response = JSON.parse(raw); } });
      return response;
    },
  };
}

test('没装 QQ 桥时用宿主工作区新建抖音会话，并照常关闭旧盯梢', async (t) => {
  const f = fixture(t, { watcher: true });
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.externalChat.restartRequired, true);
  assert.deepEqual(f.creations, [{ workspaceId: 'fixture-workspace' }]);
  assert.equal(f.renames[0].sessionId, 'new-douyin-1');
  assert.match(f.renames[0].title, /抖音|测试昵称/);
  assert.deepEqual(chatBinding(), { sessionId: 'new-douyin-1', qqBinding: null });
  assert.ok(f.calls.some(([route, body]) => route === '/api/douyin-duty/config' && body?.chatWatch === false));
  assert.ok(f.calls.every(([route]) => !route.startsWith('/dsh-qq-bridge')));

  f.enableQq();
  const contact = await f.save('channels.qq.peerId', QQ_ID);
  assert.equal(contact.ok, true, contact.error);
  assert.equal(contact.channelItems.find(item => item.path === 'channels.qq.peerId').value, QQ_ID);
  const back = await f.switchTo('qq');
  assert.equal(back.ok, true, back.error);
  assert.equal(f.bridge.get('new-douyin-1').peerId, QQ_ID);
  assert.equal(chatBinding().sessionId, 'new-douyin-1');
  assert.equal(f.creations.length, 1);
});

test('QQ 桥已配对但没有联系人绑定时，复用可查到的独立会话', async (t) => {
  const f = fixture(t, { qq: true, peerId: QQ_ID, external: { sessionId: 'existing-douyin', qqBinding: null } });
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.state.externalChat.restartRequired, false);
  assert.equal(f.creations.length, 0);
  assert.deepEqual(chatBinding(), { sessionId: 'existing-douyin', qqBinding: null });
});

test('找不到已保存的抖音会话时新建一条', async (t) => {
  const f = fixture(t, { qq: true, peerId: QQ_ID, external: { sessionId: 'removed', qqBinding: null } });
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.equal(f.creations.length, 1);
  assert.deepEqual(chatBinding(), { sessionId: 'new-douyin-1', qqBinding: null });
});

test('仍沿用唯一权威 QQ 私聊绑定，多条启用绑定时要求整理', async (t) => {
  const f = fixture(t, { qq: true, peerId: QQ_ID, bindings: [oldBinding('qq-shared'), oldBinding('duplicate', { authoritative: false })] });
  const duplicate = await f.switchTo('douyin');
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.error, /绑定/);
  assert.equal(loadConfig().channels.primary, 'qq');
  f.bridge.delete('duplicate');
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.equal(chatBinding().sessionId, 'qq-shared');
  assert.equal(chatBinding().qqBinding.peerId, QQ_ID);
  assert.equal(f.bridge.get('qq-shared').enabled, false);
  assert.equal(f.creations.length, 0);
});

test('从独立抖音切回已配好的 QQ，停用冲突绑定后绑定同一会话', async (t) => {
  const f = fixture(t, { primary: 'douyin', qq: true, peerId: QQ_ID,
    external: { sessionId: 'standalone-douyin', qqBinding: null },
    bindings: [oldBinding('previous-qq'), oldBinding('group', { peerKind: 'group' }), oldBinding('other', { peerId: '20002' })],
  });
  const r = await f.switchTo('qq');
  assert.equal(r.ok, true, r.error);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.deepEqual(f.calls.filter(([, body]) => body), [
    ['/dsh-qq-bridge/options', { sessionId: 'previous-qq', enabled: false }],
    ['/dsh-qq-bridge/bind', { sessionId: 'standalone-douyin', peerKind: 'private', peerId: QQ_ID, authoritative: true }],
  ]);
  assert.deepEqual(chatBinding().qqBinding, f.bridge.get('standalone-douyin'));
  assert.equal(f.bridge.get('previous-qq').enabled, false);
  assert.equal(f.bridge.get('group').enabled, true);
  assert.equal(f.bridge.get('other').enabled, true);
});

test('自动回绑失败时恢复已停用的 QQ 绑定，继续使用抖音', async (t) => {
  const f = fixture(t, { primary: 'douyin', qq: true, peerId: QQ_ID,
    external: { sessionId: 'standalone-douyin', qqBinding: null }, bindings: [oldBinding('previous-qq')],
  });
  f.failure.bind = true;
  const r = await f.switchTo('qq');
  assert.equal(r.ok, false);
  assert.match(r.error, /绑定失败/);
  assert.equal(loadConfig().channels.primary, 'douyin');
  assert.equal(f.bridge.get('previous-qq').enabled, true);
  assert.equal(chatBinding().qqBinding, null);
});

test('无 QQ 桥仍可切回 QQ，并提示手动绑定到原会话', async (t) => {
  const f = fixture(t, { primary: 'douyin', peerId: QQ_ID,
    external: { sessionId: 'standalone-douyin', qqBinding: null },
  });
  const r = await f.switchTo('qq');
  assert.equal(r.ok, true, r.error);
  assert.match(r.notes[0], /手动绑定.*standalo/);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.equal(chatBinding().sessionId, 'standalone-douyin');
  assert.equal(f.calls.length, 0);
});

test('纯抖音的长会话接力使用抖音联系人，保留空 QQ 绑定', async (t) => {
  const f = fixture(t, { primary: 'douyin', external: { sessionId: 'standalone-douyin', qqBinding: null } });
  await f.emit({ id: 'standalone-douyin' }, { type: 'turn/end', data: {} });
  const r = f.api.snapshot().rollovers[0];
  assert.ok(r);
  assert.equal(r.peerId, 'MS4w-test');
  assert.equal(r.peerKind, 'private');
  assert.equal(r.peerName, '测试昵称');
  assert.equal(chatBinding().preparedSessionId, r.newSessionId);
  assert.equal(chatBinding().qqBinding, null);
});

test('未填 QQ 号时也可以切回 QQ，保留会话并提示后续手动绑定', async (t) => {
  const f = fixture(t, { primary: 'douyin', qq: true, external: { sessionId: 'standalone-douyin', qqBinding: null } });
  const r = await f.switchTo('qq');
  assert.equal(r.ok, true, r.error);
  assert.match(r.notes[0], /填写 QQ 联系人.*手动绑定.*standalo/);
  assert.equal(f.calls.length, 0);
  assert.equal(chatBinding().qqBinding, null);
});

test('QQ 桥未挂载路由时可独立切换，认证失败时保留原主通道', async (t) => {
  const f = fixture(t, { qq: true, peerId: QQ_ID });
  f.failure.stateStatus = 401;
  const denied = await f.switchTo('douyin');
  assert.equal(denied.ok, false);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.equal(f.creations.length, 0);
  f.failure.stateStatus = 404;
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(chatBinding(), { sessionId: 'new-douyin-1', qqBinding: null });
});

test('切回 QQ 后写配置失败，恢复切换前的绑定与会话记录', async (t) => {
  const external = { sessionId: 'standalone-douyin', qqBinding: null };
  const f = fixture(t, { primary: 'douyin', qq: true, peerId: QQ_ID, external, bindings: [oldBinding('previous-qq')] });
  await assert.rejects(changePrimaryChannel({
    from: 'douyin', to: 'qq', cfg: loadConfig(),
    call: localChatApi('http://localhost:53276', { timeoutMs: loadConfig().send.timeoutMs }),
    drain: async () => {}, save: () => { throw new Error('保存配置失败'); },
  }), /保存配置失败/);
  assert.deepEqual(chatBinding(), external);
  assert.equal(f.bridge.get('previous-qq').enabled, true);
  assert.equal(f.bridge.has('standalone-douyin'), false);
  assert.equal(loadConfig().channels.primary, 'douyin');
});

test('QQ 联系人改变后重新切到抖音，避开仍绑定着另一位联系人的旧会话', async (t) => {
  const f = fixture(t, { qq: true, peerId: '20002',
    external: { sessionId: 'qq-shared', qqBinding: oldBinding('qq-shared') },
    bindings: [oldBinding('qq-shared')],
  });
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(chatBinding(), { sessionId: 'new-douyin-1', qqBinding: null });
  assert.equal(f.bridge.get('qq-shared').enabled, true);
});

test('保存的 QQ 绑定属于另一位联系人时，切回前提示核对联系人', async (t) => {
  const f = fixture(t, { primary: 'douyin', qq: true, peerId: '20002',
    external: { sessionId: 'qq-shared', qqBinding: oldBinding('qq-shared') },
  });
  const r = await f.switchTo('qq');
  assert.equal(r.ok, false);
  assert.match(r.error, /联系人/);
  assert.equal(loadConfig().channels.primary, 'douyin');
  assert.equal(f.bridge.has('qq-shared'), false);
});

test('切到抖音时宿主新建会话失败，恢复原来开启的盯梢', async (t) => {
  const f = fixture(t, { watcher: true });
  f.controller.create = async () => { throw new Error('会话创建失败'); };
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, false);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'douyin-duty', 'config.json'), 'utf8')).chatWatch, true);
});

test('QQ 绑定已修改但响应丢失时，尝试恢复切换前的状态', async (t) => {
  const f = fixture(t, { primary: 'douyin', qq: true, peerId: QQ_ID,
    external: { sessionId: 'standalone-douyin', qqBinding: null }, bindings: [oldBinding('previous-qq')],
  });
  for (const fail of ['optionsAfterWrite', 'bindAfterWrite']) {
    f.failure[fail] = true;
    const r = await f.switchTo('qq');
    f.failure[fail] = false;
    assert.equal(r.ok, false);
    assert.equal(loadConfig().channels.primary, 'douyin');
    assert.equal(f.bridge.get('previous-qq').enabled, true);
    assert.equal(f.bridge.has('standalone-douyin'), false);
    assert.equal(chatBinding().qqBinding, null);
  }
});

test('新建抖音会话期间保存其他设置，切换完成后保留新值', async (t) => {
  const f = fixture(t);
  const create = f.controller.create;
  f.controller.create = async (options) => {
    assert.equal((await f.save('send.enabled', true)).ok, true);
    return create(options);
  };
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, true, r.error);
  assert.equal(loadConfig().channels.primary, 'douyin');
  assert.equal(loadConfig().send.enabled, true);
});

test('切换期间联系人改变时，请求重试且保留新联系人', async (t) => {
  const f = fixture(t, { watcher: true });
  const create = f.controller.create;
  f.controller.create = async (options) => {
    assert.equal((await f.save('channels.douyin.peerSecUid', 'MS4w-new')).ok, true);
    return create(options);
  };
  const r = await f.switchTo('douyin');
  assert.equal(r.ok, false);
  assert.match(r.error, /重试/);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.equal(loadConfig().channels.douyin.peerSecUid, 'MS4w-new');
  assert.deepEqual(chatBinding(), {});
});
