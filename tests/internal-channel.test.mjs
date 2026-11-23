import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-internal-ch-'));
const home = path.join(dir, 'dsh');
const env = {
  PG_CONFIG_PATH: path.join(dir, 'config.json'),
  PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_LOG_DIR: path.join(dir, 'logs'),
  PG_SECRETS_PATH: path.join(dir, 'credentials.json'),
  PG_DSH_HOME: home,
  PG_CHAT_DATA_DIR: path.join(dir, 'data'),
};
const originals = Object.entries(env).map(([k]) => [k, process.env[k]]);
Object.assign(process.env, env);
test.after(() => {
  for (const [k, v] of originals) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const { loadConfig, saveConfig } = await import('../src/config.js');
const { apply } = await import('../src/plugin.js');
const { chatBinding } = await import('../src/channels/chat-switch.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const {
  readInternalState, sendInternalMessage, wrapProactivePrompt, dispatchToHostSession,
} = await import('../src/channels/internal.js');
const { readChannels } = await import('../src/channels/index.js');
const { sendChatRound, activeChatChannel, canReadChat, chatPeer } = await import('../src/channels/external.js');
const { recentTurns, outboundFor } = await import('../src/outbound.js');
const { extractHandoffMessages } = await import('../src/session-rollover.js');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function setupHost(t, {
  config,
  qq = false,
  bindings = [],
  existingSessions = [],
  archivedSessionIds = [],
  sessionEvents = {},
  withResolveAgent = true,
  connectionReject = null,
} = {}) {
  fs.rmSync(env.PG_CONFIG_PATH, { force: true });
  if (config !== undefined) writeJson(env.PG_CONFIG_PATH, config);
  writeChatData('external-chat', {});
  writeChatData('internal-chat', {});
  writeChatData('chat-switch', {});
  writeJson(path.join(dir, 'data', 'session-handoff.json'), {});

  const qqPkg = path.join(home, 'node_modules', 'dsh-plugin-qq-bridge', 'package.json');
  const qqConn = path.join(home, 'qq-bridge', 'connection.json');
  if (qq) {
    writeJson(qqPkg, { name: 'dsh-plugin-qq-bridge' });
    writeJson(qqConn, { httpApiUrl: 'http://127.0.0.1:1', httpToken: 'test' });
  } else {
    fs.rmSync(qqPkg, { force: true });
    fs.rmSync(qqConn, { force: true });
  }
  const dy = path.join(home, 'node_modules', 'dsh-douyin-scroll');
  writeJson(path.join(dy, 'package.json'), { name: 'dsh-douyin-scroll' });
  for (const file of ['im-http.py', 'im-send.mjs']) writeJson(path.join(dy, 'tools', file), {});
  const dyCfg = path.join(home, 'douyin-duty', 'config.json');
  writeJson(dyCfg, { chatWatch: false });

  const bridge = new Map(bindings.map((b) => [b.sessionId, b]));
  const sessionStore = new Map(existingSessions.map((s) => [s.id, s]));
  const creations = [];
  const renames = [];
  const followups = [];
  const flushed = [];
  const prompts = [];

  const controller = {
    async create(opts) {
      creations.push(opts);
      const sessionId = 'shared-created-' + creations.length;
      sessionStore.set(sessionId, { id: sessionId, title: '', cwd: '/ws', updatedAt: Date.now() });
      return { sessionId };
    },
    async rename(opts) {
      renames.push(opts);
      const cur = sessionStore.get(opts.sessionId);
      if (cur) cur.title = opts.title;
      return opts;
    },
    async inspect(id) {
      if (!sessionStore.has(id)) throw Object.assign(new Error('not found'), { code: 'session/not-found' });
      const s = sessionStore.get(id);
      return { meta: { cwd: s.cwd || '/ws', title: s.title || '' }, events: sessionEvents[id] || [] };
    },
    async prompt(payload) {
      prompts.push(payload);
      return { ok: true };
    },
    async projections() {
      return { values: { contextPressure: { projectedTokens: 10, contextWindow: 100 } } };
    },
    ...(withResolveAgent ? {
      async resolveAgent(id) {
        if (!sessionStore.has(id)) throw new Error('missing session');
        const sessionObj = { id };
        return {
          agent: {
            session: sessionObj,
            followup(msg) { followups.push({ sessionId: id, msg }); },
          },
        };
      },
    } : {}),
  };

  const sessions = {
    list: () => [...sessionStore.values()].slice(0, 1).map((s) => ({
      id: s.id,
      header: { ...s },
      snapshotEvents: () => sessionEvents[s.id] || [],
    })),
    get: (id) => sessionStore.has(id) ? {
      id,
      header: sessionStore.get(id),
      snapshotEvents: () => sessionEvents[id] || [],
    } : null,
    async flush(sess) { flushed.push(sess.id); },
  };

  const sessionPersistence = {
    async list() {
      return [...sessionStore.values()].map((s) => ({ header: { ...s } }));
    },
  };

  const workspaceRegistry = {
    archivedSessionIds,
    headers: new Map([...sessionStore.values()].map((s) => [s.id, { ...s }])),
    list: () => [{ id: 'ws-1', path: '/ws', sessionIds: [...sessionStore.keys()] }],
  };

  let route = null;
  let onSessionEvent = null;
  const services = {
    logger: { info() {}, warn() {}, error() {} },
    webServer: { register(r) { route = r; return () => {}; } },
    sessionController: controller,
    sessions,
    sessionPersistence,
    workspaceRegistry,
    ...(connectionReject ? { connection: { requestRejection: connectionReject } } : {}),
  };

  const api = apply({
    get: (k) => services[k],
    effect: (fn) => fn(),
    on(name, cb) { if (name === 'session/event') onSessionEvent = cb; },
  }, { startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  t.mock.method(globalThis, 'fetch', async (url, req) => {
    const u = new URL(url);
    const body = req.body && JSON.parse(req.body);
    if (u.pathname === '/api/douyin-duty/config') {
      if (body) writeJson(dyCfg, body);
      return Response.json({ ok: true, config: JSON.parse(fs.readFileSync(dyCfg, 'utf8')) });
    }
    if (!qq) return Response.json({ error: 'QQ 插件未启用' }, { status: 404 });
    if (u.pathname === '/dsh-qq-bridge/state') {
      return Response.json({ sessions: [...bridge.keys()], binding: bridge.get(u.searchParams.get('sessionId')) || null });
    }
    if (u.pathname === '/dsh-qq-bridge/options') {
      const before = bridge.get(body.sessionId);
      bridge.set(body.sessionId, { ...before, enabled: body.enabled });
      return Response.json({ ok: true });
    }
    if (u.pathname === '/dsh-qq-bridge/bind') {
      const b = { ...body, enabled: true };
      bridge.set(b.sessionId, b);
      return Response.json({ ok: true, binding: b });
    }
    if (u.pathname === '/dsh-qq-bridge/unbind') {
      bridge.delete(body.sessionId);
      return Response.json({ ok: true });
    }
    assert.fail('unexpected fetch ' + u.pathname);
  });

  async function request(method, subPath, body, headers = { host: 'localhost:53276' }) {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: '/api/dsh-drop-by' + subPath, headers });
    const res = { statusCode: 200, headers: {}, body: '', setHeader(k, v) { this.headers[k] = v; }, end(s) { this.body = s || ''; } };
    await route.handler(req, res);
    return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null };
  }

  return {
    api, controller, bridge, creations, renames, followups, flushed, prompts,
    emit: (session, event) => onSessionEvent(session, event),
    request,
    save: (p, v) => request('POST', '/config', { path: p, value: v }),
  };
}

test('全新安装默认内部会话，旧配置升级未写 primary 时保持 QQ', () => {
  fs.rmSync(env.PG_CONFIG_PATH, { force: true });
  assert.equal(loadConfig().channels.primary, 'internal');

  writeJson(env.PG_CONFIG_PATH, { enabled: true, channels: { qq: { peerId: '10001' } } });
  assert.equal(loadConfig().channels.primary, 'qq');

  writeJson(env.PG_CONFIG_PATH, { enabled: true, channels: { primary: 'internal' } });
  assert.equal(loadConfig().channels.primary, 'internal');
});

test('内部会话列表、手动绑定已有会话、冷历史回填（忽略插件主动消息）以及准入检查', async (t) => {
  const now = Date.now();
  const h = setupHost(t, {
    existingSessions: [
      { id: 'sess-old', title: '日常聊天', cwd: '/ws', updatedAt: now - 1000 },
      { id: 'sess-archived', title: '已归档', cwd: '/ws', updatedAt: now },
      { id: 'sess-other', title: '开发项目', cwd: '/ws', updatedAt: now - 5000 },
    ],
    archivedSessionIds: ['sess-archived'],
    sessionEvents: {
      'sess-old': [
        { type: 'session/title', data: { title: '日常聊天' }, timestamp: now - 50000 },
        { type: 'user/message', data: { content: [{ type: 'text', text: '今天好累啊' }] }, timestamp: now - 40000 },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '辛苦啦，早点歇会儿。' }] } }, timestamp: now - 35000 },
        { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'dsh-drop-by', proactive: true }, content: [{ type: 'text', text: wrapProactivePrompt('你猜洗手池上沿小孔干嘛的') }] }, timestamp: now - 20000 },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你猜洗手池上沿那个小孔是干嘛的？' }] } }, timestamp: now - 18000 },
      ],
    },
    connectionReject: (req) => (req.headers?.['x-deny'] ? 403 : null),
  });

  // 准入检查：未授权请求被拦
  const deniedList = await h.request('GET', '/sessions', undefined, { host: 'localhost:53276', 'x-deny': '1' });
  assert.equal(deniedList.status, 403);
  const deniedBind = await h.request('POST', '/internal/session', { sessionId: 'sess-old' }, { host: 'localhost:53276', 'x-deny': '1' });
  assert.equal(deniedBind.status, 403);

  // 未绑定时连通检查提示需处理
  const diagBefore = await h.request('GET', '/diagnostics');
  assert.equal(diagBefore.json.items.find((i) => i.key === 'channel').level, 'bad');
  assert.equal(canReadChat(loadConfig()), false);

  // 列出会话：不包含已归档会话
  const listed = await h.request('GET', '/sessions');
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.sessions.map((s) => s.id), ['sess-old', 'sess-other']);

  // 手动绑定已有会话
  const bound = await h.request('POST', '/internal/session', { sessionId: 'sess-old' });
  assert.equal(bound.status, 200);
  assert.equal(bound.json.ok, true);
  assert.equal(chatBinding().sessionId, 'sess-old');
  assert.equal(bound.json.state.externalChat.sessionTitle, '日常聊天');

  // 冷历史回填正确：主动触发 prompt 不被当成用户消息
  const st = readInternalState('sess-old');
  assert.equal(st.incoming.text, '今天好累啊');
  assert.equal(st.outgoing.text, '你猜洗手池上沿那个小孔是干嘛的？');
  assert.deepEqual(st.dialogue.map((d) => [d.who, d.text]), [
    ['her', '今天好累啊'],
    ['me', '辛苦啦，早点歇会儿。'],
    ['me', '你猜洗手池上沿那个小孔是干嘛的？'],
  ]);

  // 续聊前情抽取也会跳过主动触发 envelope
  const handoff = extractHandoffMessages([
    { type: 'user/message', data: { content: [{ type: 'text', text: wrapProactivePrompt('早安') }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '早安呀' }] } } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '早呀' }] } },
  ], 10);
  assert.deepEqual(handoff, [
    { role: 'assistant', text: '早安呀' },
    { role: 'user', text: '早呀' },
  ]);

  // 绑定后连通检查就绪
  const diagAfter = await h.request('GET', '/diagnostics');
  assert.equal(diagAfter.json.items.find((i) => i.key === 'channel').level, 'ok');
  assert.equal(activeChatChannel(loadConfig()), 'internal');
  assert.equal(chatPeer(loadConfig()), 'sess-old');
  assert.equal(recentTurns({ cfg: loadConfig() }).length, 3);
  assert.equal(outboundFor('internal', { cfg: loadConfig() }).channel, 'internal');
});

test('三通道共用同一会话：首次切 QQ 自动新建会话，随后 internal ↔ douyin ↔ qq 全程沿用', async (t) => {
  const h = setupHost(t, {
    qq: true,
    config: {
      channels: { primary: 'internal', qq: { peerId: '10001' }, douyin: { peerSecUid: 'MS4w-dy', peerName: '测试好友' } },
      send: { enabled: false },
    },
  });

  // 1) 内部会话尚未绑定 -> 直接切到 QQ -> 自动新建一个共用会话并绑定 QQ
  const toQq = await h.save('channels.primary', 'qq');
  assert.equal(toQq.json.ok, true, toQq.json.error);
  assert.equal(loadConfig().channels.primary, 'qq');
  assert.equal(h.creations.length, 1);
  const sharedId = chatBinding().sessionId;
  assert.equal(sharedId, 'shared-created-1');
  assert.equal(h.bridge.get(sharedId).peerId, '10001');
  assert.equal(h.bridge.get(sharedId).enabled, true);

  // 2) QQ -> 内部会话：停用 QQ 桥绑定，沿用同一个 sharedId
  const toInt = await h.save('channels.primary', 'internal');
  assert.equal(toInt.json.ok, true, toInt.json.error);
  assert.equal(loadConfig().channels.primary, 'internal');
  assert.equal(chatBinding().sessionId, sharedId);
  assert.equal(h.bridge.get(sharedId).enabled, false);
  assert.equal(h.creations.length, 1);

  // 3) 内部会话 -> 抖音：沿用同一个 sharedId，不再新建会话
  const toDy = await h.save('channels.primary', 'douyin');
  assert.equal(toDy.json.ok, true, toDy.json.error);
  assert.equal(loadConfig().channels.primary, 'douyin');
  assert.equal(chatBinding().sessionId, sharedId);
  assert.equal(h.creations.length, 1);

  // 4) 抖音 -> 内部会话：继续沿用同一个 sharedId
  const backInt = await h.save('channels.primary', 'internal');
  assert.equal(backInt.json.ok, true, backInt.json.error);
  assert.equal(chatBinding().sessionId, sharedId);

  // 5) 内部会话 -> QQ：重新启用并绑定到同一个 sharedId
  const backQq = await h.save('channels.primary', 'qq');
  assert.equal(backQq.json.ok, true, backQq.json.error);
  assert.equal(chatBinding().sessionId, sharedId);
  assert.equal(h.bridge.get(sharedId).enabled, true);
  assert.equal(h.creations.length, 1);
});

test('内部会话一键新建、实时事件监听、主动发送（followup + prompt 兜底）及时段参数生效', async (t) => {
  const h = setupHost(t, {
    config: {
      enabled: true,
      dryRun: false,
      timezone: 'Asia/Shanghai',
      quietHours: [],
      send: { enabled: true },
      channels: { primary: 'internal', internal: { enabled: true, read: true, send: true, activeHours: [] } },
    },
  });

  // 一键新建陪伴会话
  const created = await h.request('POST', '/internal/session', { create: true, title: '小鱼陪伴' });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true);
  const sid = created.json.sessionId;
  assert.equal(chatBinding().sessionId, sid);
  assert.equal(h.renames[0].title, '小鱼陪伴');

  // 实时用户消息 -> 更新 incoming & dialogue
  const t1 = Date.now() - 5000;
  h.emit({ id: sid }, { type: 'turn/start', data: { turn: 1 } });
  h.emit({ id: sid }, { type: 'user/message', timestamp: t1, data: { turn: 1, content: [{ type: 'text', text: '我刚写完作业' }] } });
  h.emit({ id: sid }, { type: 'assistant/message', timestamp: t1 + 500, data: { turn: 1, message: { content: [{ type: 'text', text: '厉害，快歇会儿。' }] } } });
  h.emit({ id: sid }, { type: 'turn/end', data: { turn: 1 } });

  let st = readInternalState(sid);
  assert.equal(st.incoming.text, '我刚写完作业');
  assert.equal(st.outgoing.text, '厉害，快歇会儿。');
  assert.equal(st.outgoing.source, 'reply');

  // 通过 sendChatRound 主动发消息 -> 走 resolveAgent().agent.followup + sessions.flush
  const sent = await sendChatRound({ cfg: loadConfig(), to: sid, text: '晚上记得早点睡哦', dryRun: false, source: 'companion' });
  assert.equal(sent.ok, true, sent.error);
  assert.equal(h.followups.length, 1);
  assert.equal(h.followups[0].sessionId, sid);
  assert.equal(h.followups[0].msg.source.plugin, 'dsh-drop-by');
  assert.match(h.followups[0].msg.content[0].text, /晚上记得早点睡哦/);
  assert.deepEqual(h.flushed, [sid]);

  // 宿主把这条主动触发作为 user/message 广播回来时，不污染 incoming
  h.emit({ id: sid }, { type: 'user/message', timestamp: Date.now(), data: { turn: 2, source: { kind: 'plugin', plugin: 'dsh-drop-by', proactive: true }, content: h.followups[0].msg.content } });
  h.emit({ id: sid }, { type: 'assistant/message', timestamp: Date.now() + 100, data: { turn: 2, message: { content: [{ type: 'text', text: '晚上记得早点睡哦～' }] } } });
  h.emit({ id: sid }, { type: 'turn/end', data: { turn: 2 } });

  st = readInternalState(sid);
  assert.equal(st.incoming.text, '我刚写完作业', '主动消息不得覆盖 incoming');
  assert.equal(st.dialogue.filter((d) => d.who === 'her').length, 1);
  assert.equal(st.dialogue.at(-1).text, '晚上记得早点睡哦～');

  // resolveAgent 不可用时，dispatchToHostSession 自动退回 controller.prompt({ mode: 'queue' })
  const fallbackPrompts = [];
  const fb = await dispatchToHostSession({
    sessionId: sid,
    wrapped: wrapProactivePrompt('兜底测试'),
    cfg: loadConfig(),
    controller: { async prompt(payload) { fallbackPrompts.push(payload); } },
  });
  assert.equal(fb.ok, true);
  assert.equal(fb.via, 'prompt');
  assert.equal(fallbackPrompts[0].mode, 'queue');

  // 内部会话 activeHours 设置保存与非默认运行时生效
  const savedWin = await h.save('channels.internal.activeHours', [['09:00', '10:00']]);
  assert.equal(savedWin.json.ok, true);
  const outsideTs = Date.parse('2026-11-22T15:00:00+08:00');
  const chOut = readChannels(loadConfig(), outsideTs, { quiet: false });
  assert.equal(chOut.list.find((c) => c.channel === 'internal').state, 'window');
  const insideTs = Date.parse('2026-11-22T09:30:00+08:00');
  const chIn = readChannels(loadConfig(), insideTs, { quiet: false });
  assert.equal(chIn.list.find((c) => c.channel === 'internal').ok, true);

  // 关闭 channels.internal.send 时拦截发送
  const sendOff = await h.save('channels.internal.send', false);
  assert.equal(sendOff.json.ok, true);
  const blocked = await sendInternalMessage({ cfg: loadConfig(), sessionId: sid, text: '测试', dryRun: false });
  assert.equal(blocked.ok, false);
});

test('内部会话用户发消息经过 controller.prompt 时注入角色上下文，不污染其他会话与主动触发', async (t) => {
  const h = setupHost(t, {
    existingSessions: [
      { id: 'bound-s', title: '陪伴', cwd: '/ws', updatedAt: Date.now() },
      { id: 'other-s', title: '其他', cwd: '/ws', updatedAt: Date.now() },
    ],
    config: {
      enabled: true,
      dryRun: true,
      quietHours: [],
      channels: { primary: 'internal', internal: { enabled: true, read: true, send: true, activeHours: [] } },
    },
  });
  await h.request('POST', '/internal/session', { sessionId: 'bound-s' });

  // 绑定会话的用户发言 -> 注入上下文
  await h.controller.prompt({ sessionId: 'bound-s', content: [{ type: 'text', text: '今天天气不错' }] });
  assert.equal(h.prompts.length, 1);
  assert.match(h.prompts[0].content[0].text, /来源归属铁律/);
  assert.match(h.prompts[0].content[0].text, /今天天气不错/);

  // 其他未绑定会话 -> 原样透传
  await h.controller.prompt({ sessionId: 'other-s', content: [{ type: 'text', text: '写段代码' }] });
  assert.equal(h.prompts[1].content[0].text, '写段代码');

  // 主动消息触发 -> 原样透传，不重复包上下文
  const proactiveText = wrapProactivePrompt('该吃饭啦');
  await h.controller.prompt({ sessionId: 'bound-s', content: [{ type: 'text', text: proactiveText }] });
  assert.equal(h.prompts[2].content[0].text, proactiveText);
});

test('通用会话选择：QQ 和抖音模式下可直接选择已有会话或新建会话并实时切换绑定', async (t) => {
  const h = setupHost(t, {
    qq: true,
    existingSessions: [
      { id: 'sess-a', title: '日常聊 A', cwd: '/ws', updatedAt: Date.now() - 1000 },
      { id: 'sess-b', title: '新主题 B', cwd: '/ws', updatedAt: Date.now() },
    ],
    config: {
      channels: { primary: 'qq', qq: { peerId: '10001' }, douyin: { peerSecUid: 'MS4w-dy', peerName: '测试好友' } },
      send: { enabled: false },
    },
  });

  // QQ 模式下选择 sess-a
  const pickA = await h.request('POST', '/chat/session', { sessionId: 'sess-a' }, { host: '127.0.0.1:53276' });
  assert.equal(pickA.status, 200);
  assert.equal(pickA.json.ok, true, pickA.json.error);
  assert.equal(pickA.json.sessionId, 'sess-a');
  assert.equal(chatBinding().sessionId, 'sess-a');
  assert.equal(h.bridge.get('sess-a')?.enabled, true);
  assert.equal(h.bridge.get('sess-a')?.peerId, '10001');

  // QQ 模式下改选 sess-b：应停用旧绑定 sess-a，并绑定 sess-b
  const pickB = await h.request('POST', '/chat/session', { sessionId: 'sess-b' }, { host: '127.0.0.1:53276' });
  assert.equal(pickB.status, 200);
  assert.equal(pickB.json.ok, true, pickB.json.error);
  assert.equal(chatBinding().sessionId, 'sess-b');
  assert.equal(h.bridge.get('sess-a')?.enabled, false);
  assert.equal(h.bridge.get('sess-b')?.enabled, true);
  assert.equal(h.bridge.get('sess-b')?.peerId, '10001');

  // GET /sessions 应准确反映当前绑定会话
  const listed = await h.request('GET', '/sessions');
  assert.equal(listed.json.ok, true);
  assert.equal(listed.json.boundSessionId, 'sess-b');
  assert.equal(listed.json.primary, 'qq');

  // QQ 模式下新建并接入会话
  const created = await h.request('POST', '/chat/session', { create: true, title: '新建QQ会话' }, { host: '127.0.0.1:53276' });
  assert.equal(created.status, 200);
  assert.equal(created.json.ok, true, created.json.error);
  const newSid = created.json.sessionId;
  assert.ok(newSid);
  assert.equal(h.bridge.get('sess-b')?.enabled, false);
  assert.equal(h.bridge.get(newSid)?.enabled, true);
  assert.equal(chatBinding().sessionId, newSid);

  // 切到抖音模式后也能通过 /chat/session 选择已有会话
  const toDy = await h.save('channels.primary', 'douyin');
  assert.equal(toDy.json.ok, true, toDy.json.error);
  const pickDy = await h.request('POST', '/chat/session', { sessionId: 'sess-a' }, { host: '127.0.0.1:53276' });
  assert.equal(pickDy.status, 200);
  assert.equal(pickDy.json.ok, true, pickDy.json.error);
  assert.equal(chatBinding().sessionId, 'sess-a');
  assert.equal(chatBinding().sessionTitle, '日常聊 A');
});
