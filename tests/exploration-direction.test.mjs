import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exploration-direction-'));
const home = path.join(dir, 'dsh');
const env = {
  PG_CONFIG_PATH: path.join(dir, 'config.json'),
  PG_STATE_PATH: path.join(dir, 'state.json'),
  PG_LOG_DIR: path.join(dir, 'logs'),
  PG_DSH_HOME: home,
  PG_CHAT_DATA_DIR: path.join(dir, 'data'),
  PG_SECRETS_PATH: path.join(dir, 'credentials.json'),
};
const previous = Object.keys(env).map(key => [key, process.env[key]]);
Object.assign(process.env, env);
test.after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const { loadConfig, saveConfig } = await import('../src/config.js');
const { loadPersona } = await import('../src/persona.js');
const { saveExploration } = await import('../src/explore.js');
const { rememberExplorationShare, explorationFeedbackHints } = await import('../src/exploration-feedback.js');
const { buildReplyContext } = await import('../src/qq-reply.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { apply } = await import('../src/plugin.js');
fs.writeFileSync(path.join(dir, 'persona.md'), '喜欢研究日常用品和闲时漫画。');
const bridgeFile = path.join(home, 'qq-bridge', 'last-in.json');
fs.mkdirSync(path.dirname(bridgeFile), { recursive: true });

function configure(primary, peer, nextTopic = '', enabled = true) {
  writeChatData('exploration-feedback', {});
  writeChatData('external-chat', {});
  writeChatData('chat-switch', {});
  const cfg = {
    ...loadConfig(),
    quietHours: [],
    channels: { primary, qq: { peerId: peer }, douyin: { peerSecUid: peer } },
    rules: { qqCommands: { enabled } },
    persona: { dshHome: home, localFile: path.join(dir, 'persona.md') },
    exploration: { nextTopic, feedback: { enabled: false }, portrait: false },
  };
  saveConfig(cfg);
  return loadConfig();
}

function setExploration(cfg, at, topic, extra = {}) {
  const personaKey = createHash('sha256').update(loadPersona({ cfg }).text).digest('hex');
  saveExploration({ personaKey, lastAt: at, thread: { at, topic, next: '继续阅读' }, ...extra });
}

function qq(text, { peer = '14101', markerPeer = peer, at = Date.now() } = {}) {
  const cfg = loadConfig();
  fs.writeFileSync(bridgeFile, JSON.stringify({ peer: markerPeer, peerKind: 'private', at, text: text.slice(0, 80) }));
  return buildReplyContext({}, { cfg, peer, kind: 'private', text, at, observed: true });
}

test('QQ 暂停最近分享，清掉同题预设；几条闲聊后仍可从前文指定 B 漫作品', async () => {
  const cfg = configure('qq', '14101', '插排负载');
  const at = Date.now() - 20_000;
  setExploration(cfg, at, '插排负载', { leisure: { at: at + 1, topic: '漫画分镜' } });
  rememberExplorationShare({ cfg: { ...cfg, exploration: { ...cfg.exploration, feedback: { enabled: true } } },
    peer: '14101', channel: 'qq', topic: '插排负载', at: at + 2 });
  assert.match(await qq('这个题材先放放', { at: at + 10 }), /陪伴探索方向已更新.*插排负载/su);
  assert.equal(loadConfig().exploration.nextTopic, '');
  assert.deepEqual(explorationFeedbackHints(loadConfig(), {}).avoid, ['插排负载']);

  await qq('今天的课上完了', { at: at + 20 });
  await qq('晚上看看再说', { at: at + 30 });
  await qq('我刚聊的是《哆哆嗦嗦逃离你》', { at: at + 40 });
  assert.match(await qq('去 B 漫看看这个漫画吧', { at: at + 50 }), /陪伴探索方向已更新.*哆哆嗦嗦逃离你/su);
  assert.match(loadConfig().exploration.nextTopic, /B\s*漫|哔哩哔哩漫画/iu);
  assert.match(loadConfig().exploration.nextTopic, /哆哆嗦嗦逃离你/u);
  assert.deepEqual(explorationFeedbackHints(loadConfig(), {}).avoid, ['插排负载']);
});

test('QQ 不使用其他联系人的上下文，拒绝伪造桥记录和凭据指代', async () => {
  let at = Date.now() - 10_000;
  configure('qq', '14101', '原预设');
  await qq('我说的是《邻居家的漫画》', { peer: '14101', at: ++at });
  configure('qq', '14501', '原预设');
  assert.doesNotMatch(await qq('去看看这个漫画吧', { peer: '14501', at: ++at }), /陪伴探索方向已更新/u);
  await qq('我说的是《漫画密码 secret-token》', { peer: '14501', at: ++at });
  assert.doesNotMatch(await qq('去看看这个漫画吧', { peer: '14501', at: ++at }), /陪伴探索方向已更新/u);
  assert.doesNotMatch(await qq('你去看看《海边的故事》吧', { peer: '14501', markerPeer: '14101', at: ++at }), /陪伴探索方向已更新/u);
  assert.equal(loadConfig().exploration.nextTopic, '原预设');

  configure('qq', '14501', '原预设', false);
  assert.doesNotMatch(await qq('你去看看《海边的故事》吧', { peer: '14501', at: ++at }), /陪伴探索方向已更新/u);
  assert.equal(loadConfig().exploration.nextTopic, '原预设');
});

test('抖音仅使用该私聊的已读原话，支持同一批消息里的指代', async () => {
  const peer = 'douyin-contact';
  const cfg = configure('douyin', peer);
  writeChatData('external-chat', { sessionId: 'douyin-session' });
  const at = Date.now() - 1000;
  const text = '你去看看这个漫画吧';
  writeChatData('douyin-im', {
    [peer]: {
      incoming: { peer, kind: 'private', ts: at, observedAt: at, text },
      dialogue: [{ who: 'me', ts: at - 10, text: '《角色提到的漫画》' }],
    },
    'other-contact': { dialogue: [{ who: 'her', ts: at - 5, text: '《其他联系人作品》' }] },
  });
  const input = { cfg, peer, kind: 'private', text, at, observed: true };
  assert.doesNotMatch(await buildReplyContext({}, input), /陪伴探索方向已更新/u);
  const directionTurns = [{ ts: at - 1, text: '刚才提到的是《扉页小故事》' }];
  assert.match(await buildReplyContext({}, { ...input, directionTurns }), /陪伴探索方向已更新.*扉页小故事/su);
  assert.equal(loadConfig().exploration.nextTopic, '扉页小故事');
});

test('只有内部已绑定的普通会话输入可修改探索方向', async t => {
  const peer = 'local-contact';
  const cfg = configure('internal', peer, '旧方向');
  const at = Date.now() - 1000;
  setExploration(cfg, at, '旧方向');
  writeChatData('external-chat', { sessionId: peer });
  writeChatData('internal-chat', { [peer]: { dialogue: [{ who: 'her', ts: at, text: '我刚提了《独立漫画小册》' }] } });
  const prompts = [];
  const services = {
    sessionController: { async prompt(payload) { prompts.push(payload); } },
    logger: { info() {}, warn() {}, error() {} },
  };
  const plugin = apply({ get: key => services[key], effect: fn => fn(), on() {} }, { startupDelaySec: 3600, tool: false });
  t.after(() => plugin.stop());
  const ask = (sessionId, text) => services.sessionController.prompt({ sessionId, content: [{ type: 'text', text }] });
  await ask('another-session', '换个探索方向吧');
  assert.equal(loadConfig().exploration.nextTopic, '旧方向');
  await ask(peer, '换个探索方向吧');
  assert.match(prompts.at(-1).content[0].text, /陪伴探索方向已更新.*旧方向/su);
  assert.equal(loadConfig().exploration.nextTopic, '');
  await ask(peer, '你去看看这个漫画吧');
  assert.match(prompts.at(-1).content[0].text, /陪伴探索方向已更新.*独立漫画小册/su);
  assert.equal(loadConfig().exploration.nextTopic, '独立漫画小册');
});

test('QQ 点名暂停旧方向时保留无关的单轮预设', async () => {
  const cfg = configure('qq', '14101', '海边散步地图');
  const at = Date.now() - 10_000;
  setExploration(cfg, at, '插排负载', { light: { topic: '动画配乐', at: at + 1 } });
  assert.match(await qq('别老看插排那事了', { at: at + 2 }), /陪伴探索方向已更新.*插排负载/su);
  assert.deepEqual(explorationFeedbackHints(loadConfig(), {}).avoid, ['插排负载']);
  assert.equal(loadConfig().exploration.nextTopic, '海边散步地图');
});

test('探索期间收到暂停，完成时不覆盖旧状态或恢复单轮预设', async t => {
  const at = Date.now() - 1000;
  const cfg = configure('qq', '14101', '插排负载');
  setExploration(cfg, at, '插排负载');
  let route;
  const launched = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const services = {
    webServer: { register(handler) { route = handler; return () => {}; } },
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'text' }) },
    llm: { async *stream() {
      launched.resolve();
      await resume.promise;
      yield { type: 'text-delta', text: JSON.stringify({
        action: 'start', topic: '插排负载', progress: '本轮旧方向不应落盘', next: '再次核对参数',
      }) };
    } },
    logger: { info() {}, warn() {}, error() {} },
  };
  const plugin = apply({ get: key => services[key], effect: fn => fn(), on() {} }, { startupDelaySec: 3600, tool: false });
  t.after(() => plugin.stop());
  let response;
  const run = route.handler({ url: '/api/dsh-drop-by/explore', method: 'POST' }, {
    setHeader() {}, end(body) { response = JSON.parse(body); },
  });
  await Promise.race([launched.promise, run.then(() => assert.fail('探索提前退出：' + response?.reason))]);
  try {
    assert.match(await qq('不要再继续这个方向', { at: Date.now() }), /陪伴探索方向已更新/u);
  } finally {
    resume.resolve();
  }
  await run;
  assert.equal(response.reason, 'CANCELLED');
  assert.equal(loadConfig().exploration.nextTopic, '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'data', 'exploration.json'), 'utf8')).lastAt, at);
});

test('聊天暂停当前方向时同时清空匹配的 exploration.interest', async () => {
  const cfg = configure('qq', '14101', '');
  saveConfig({
    ...cfg,
    exploration: { ...cfg.exploration, interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你' },
  });
  const at = Date.now() - 10_000;
  setExploration(loadConfig(), at, '哔哩哔哩漫画作品：《”哆哆嗦嗦“逃离你》');
  assert.match(await qq('不要再继续这个方向', { at: at + 2 }), /陪伴探索方向已更新/u);
  assert.equal(loadConfig().exploration.interest, '');
  assert.ok(explorationFeedbackHints(loadConfig(), {}).avoid.length >= 1);
});
