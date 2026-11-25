import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ext-cmd-'));
process.env.PG_DSH_HOME = path.join(tmp, 'dsh');
process.env.PG_CONFIG_PATH = path.join(tmp, 'config.json');
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_LOG_DIR = path.join(tmp, 'logs');
process.env.PG_CHAT_DATA_DIR = path.join(tmp, 'chat-data');

const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const { applyChange, listForUi } = await import('../src/settings/settings.js');
const { parseCommandIntent, commandIntentPrompt } = await import('../src/chat/command-matcher.js');
const { executeQqCommand, latestLoginContext } = await import('../src/chat/qq-command.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { apply } = await import('../src/plugin.js');

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('开关默认关闭，设置页可保存与回显 extended 与 maxToolCallsPerTurn', () => {
  const base = loadConfig();
  assert.equal(base.rules.qqCommands.extended, false);
  assert.equal(base.rules.chatSession.maxToolCallsPerTurn, 0);
  assert.equal(base.rules.chatSession.notifyOnToolLimit, true);

  const c1 = applyChange(base, 'rules.qqCommands.extended', true);
  assert.equal(c1.ok, true);
  const c2 = applyChange(c1.cfg, 'rules.chatSession.maxToolCallsPerTurn', 8);
  assert.equal(c2.ok, true);
  const c3 = applyChange(c2.cfg, 'rules.chatSession.notifyOnToolLimit', false);
  assert.equal(c3.ok, true);

  const items = listForUi(c3.cfg).flatMap((g) => g.items || []);
  assert.equal(items.find((x) => x.path === 'rules.qqCommands.extended')?.value, true);
  assert.equal(items.find((x) => x.path === 'rules.chatSession.maxToolCallsPerTurn')?.value, 8);
  assert.equal(items.find((x) => x.path === 'rules.chatSession.notifyOnToolLimit')?.value, false);
});

test('扩展指令开关关闭时全部拒收；开启后校验 loginContext、公网链接与查询范围', () => {
  const loginContext = { url: 'https://manga.bilibili.com/detail/mc38749', site: 'B漫', topic: '漫画测试' };

  // 开关关闭 → 全部判 chat_only
  const rawOpen = JSON.stringify({ intent: 'user_command', actionType: 'open_login_page', userGuidance: '', ackCue: '干脆' });
  assert.equal(parseCommandIntent(rawOpen, '把网页调出来我给你登录', null, '', '', {}, { extended: false, loginContext }).intent, 'chat_only');
  assert.doesNotMatch(commandIntentPrompt('把网页调出来', null, '', '', {}, { extended: false, loginContext }), /open_login_page/);

  // 开关开启 + 有 loginContext → 识别 open_login_page 与 resume_after_login
  const parsedOpen = parseCommandIntent(rawOpen, '把网页调出来我给你登录', null, '', '', {}, { extended: true, loginContext });
  assert.equal(parsedOpen.intent, 'user_command');
  assert.equal(parsedOpen.cmd.type, 'open_login_page');
  assert.equal(parsedOpen.cmd.params.url, loginContext.url);

  const rawResume = JSON.stringify({ intent: 'user_command', actionType: 'resume_after_login', userGuidance: '', ackCue: '轻快' });
  const parsedResume = parseCommandIntent(rawResume, '登录好啦', null, '', '', {}, { extended: true, loginContext });
  assert.equal(parsedResume.intent, 'user_command');
  assert.equal(parsedResume.cmd.type, 'resume_after_login');
  assert.equal(parsedResume.cmd.params.topic, '漫画测试');

  // 没有 loginContext 时，open_login_page / resume_after_login 不触发
  assert.equal(parseCommandIntent(rawResume, '登录好啦', null, '', '', {}, { extended: true, loginContext: null }).intent, 'chat_only');

  // browse_url：接受原话中的公网链接
  const url = 'https://example.com/post/123';
  const rawBrowse = JSON.stringify({ intent: 'user_command', actionType: 'browse_url', userGuidance: url, ackCue: '自然' });
  const parsedBrowse = parseCommandIntent(rawBrowse, `帮我看看这篇 ${url}`, null, '', '', {}, { extended: true });
  assert.equal(parsedBrowse.intent, 'user_command');
  assert.equal(parsedBrowse.cmd.params.url, url);

  // query_local：接受合法范围，拒绝越界词
  const rawLocal = JSON.stringify({ intent: 'user_command', actionType: 'query_local', userGuidance: '课表', ackCue: '简短' });
  const parsedLocal = parseCommandIntent(rawLocal, '我今天还有什么课', null, '', '', {}, { extended: true });
  assert.equal(parsedLocal.intent, 'user_command');
  assert.equal(parsedLocal.cmd.params.scope, '课表');
});

test('executeQqCommand：执行 open_login_page / resume_after_login / browse_url / query_local', async () => {
  const cfg = {
    ...loadConfig(),
    timezone: 'Asia/Shanghai',
    content: {
      ...loadConfig().content,
      agenda: { text: '周三 14:00-15:40 电力系统分析 @教三201' },
      exams: { text: '2026-12-01 09:00 电机学' },
    },
  };
  const expState = {
    history: [{ topic: '测试漫画', url: 'https://manga.bilibili.com/detail/mc38749', loginSite: 'B漫', at: Date.now() }],
  };
  assert.equal(latestLoginContext(expState, cfg)?.site, 'B漫');

  let openedUrl = '';
  const rOpen = await executeQqCommand({
    cmd: { type: 'open_login_page', params: { url: 'https://manga.bilibili.com/detail/mc38749' } },
    cfg,
    state: () => expState,
    openUrl: async (u) => { openedUrl = u; return { ok: true, url: u }; },
  });
  assert.equal(openedUrl, 'https://manga.bilibili.com/detail/mc38749');
  assert.match(rOpen.text, /已经在桌面把页面打开了/);

  let exploredReq = null;
  const rResume = await executeQqCommand({
    cmd: { type: 'resume_after_login', params: { topic: '测试漫画' } },
    cfg,
    state: () => expState,
    explore: async (req) => {
      exploredReq = req;
      return { ok: true, action: 'deep', thread: { topic: '测试漫画', progress: '读完了第一话主线剧情。', next: '继续看第二话' } };
    },
  });
  assert.equal(exploredReq?.topic, '测试漫画');
  assert.equal(exploredReq?.sourceUrl, 'https://manga.bilibili.com/detail/mc38749');
  assert.match(rResume.text, /读完了第一话主线剧情/);

  // browse_url 拒绝内网链接，正常抓取公网链接
  const rPrivate = await executeQqCommand({
    cmd: { type: 'browse_url', params: { url: 'http://127.0.0.1:8080/secret' } },
    cfg,
    media: { web: true, fetch: async () => 'should not run' },
  });
  assert.match(rPrivate.text, /不是可访问的公开网址/);

  const rPublic = await executeQqCommand({
    cmd: { type: 'browse_url', params: { url: 'https://example.com/article' } },
    cfg,
    media: { web: true, fetch: async () => '这篇文章讨论了轻量级状态机的设计要点。' },
  });
  assert.match(rPublic.text, /轻量级状态机/);

  // query_local 零模型返回本地课表与考试
  const now = Date.parse('2026-11-25T10:00:00+08:00'); // 周三
  const rLocal = await executeQqCommand({
    cmd: { type: 'query_local', params: { scope: '' } },
    cfg,
    state: () => expState,
    now,
  });
  assert.match(rLocal.text, /电力系统分析/);
  assert.match(rLocal.text, /电机学/);
  assert.match(rLocal.text, /陪伴状态/);
});

test('聊天会话单轮工具调用上限：仅对绑定陪伴会话生效，超过上限立即 abort，不伤普通会话', async () => {
  const cfg = {
    ...loadConfig(),
    enabled: true,
    dryRun: true,
    channels: { ...loadConfig().channels, primary: 'internal' },
    rules: { ...loadConfig().rules, chatSession: { maxToolCallsPerTurn: 2, notifyOnToolLimit: false } },
  };
  saveConfig(cfg);
  writeChatData('external-chat', { sessionId: 'bound-chat-session' });

  const listeners = [];
  const controller = {
    async prompt(payload, signal) {
      const turn = payload.turn ?? 1;
      for (const fn of listeners) fn({ id: payload.sessionId }, { type: 'turn/start', data: { turn } });
      // 模拟干扰事件（旧 turn 的 tool/call 不应计入当前 turn）
      for (const fn of listeners) fn({ id: payload.sessionId }, { type: 'tool/call', data: { turn: turn - 1, name: 'stale' } });
      const calls = payload.calls ?? 3;
      for (let i = 1; i <= calls; i += 1) {
        for (const fn of listeners) fn({ id: payload.sessionId }, { type: 'tool/call', data: { turn, name: 'ops_bash', i } });
      }
      const aborted = Boolean(signal?.aborted);
      for (const fn of listeners) fn({ id: payload.sessionId }, { type: 'turn/end', data: { turn } });
      return { aborted };
    },
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    effect: (fn) => { const d = fn(); return typeof d === 'function' ? d : () => {}; },
    on: (ev, fn) => {
      if (ev === 'session/event') listeners.push(fn);
      return () => {};
    },
    get: (k) => (k === 'sessionController' ? controller : null),
    inject: (deps, cb) => {
      if (deps.includes('sessionController')) cb(ctx);
      return { dispose() {} };
    },
  };

  const api = apply(ctx, { enabled: true, startupDelaySec: 3600, tool: false, statusApi: false });
  try {
    // 0. 绑定会话刚好调用 2 次（未超过上限 2）+ 1 次旧 turn 干扰事件 → 不触发 abort
    const withinRes = await controller.prompt({ sessionId: 'bound-chat-session', turn: 5, calls: 2, content: [{ type: 'text', text: '查一下' }] });
    assert.equal(withinRes.aborted, false, '未超上限且忽略旧 turn 干扰事件不应触发 abort');

    // 1. 绑定的陪伴聊天会话：第 3 次 tool/call 触发硬刹车 abort
    const boundRes = await controller.prompt({ sessionId: 'bound-chat-session', turn: 6, calls: 3, content: [{ type: 'text', text: '读一下' }] });
    assert.equal(boundRes.aborted, true, '绑定聊天会话超过 2 次工具调用应触发 abort');

    // 2. 普通非陪伴会话（如写代码会话）：完全不受限制
    const otherRes = await controller.prompt({ sessionId: 'other-coding-session', turn: 1, calls: 5, content: [{ type: 'text', text: '跑测试' }] });
    assert.equal(otherRes.aborted, false, '非陪伴会话不应被工具上限拦截');
  } finally {
    api.stop();
  }
});
