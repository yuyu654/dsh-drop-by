import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [dir, bridgePath] = process.argv.slice(2);
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_DSH_HOME = dir;
let now = Date.parse('2026-11-15T12:00:00+08:00');
Date.now = () => now;
// Exact debounce boundaries are covered by fake-clock unit tests. Keep this bridge fixture quick.
const setTimer = globalThis.setTimeout;
globalThis.setTimeout = (callback, delay, ...args) => setTimer(callback, delay === 3500 ? 8 : delay, ...args);
const localFile = path.join(dir, 'persona.md');
fs.writeFileSync(localFile, '喜欢研究反时限算法。');
fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
  quietHours: [], dryRun: false, send: { enabled: true }, channels: { qq: { peerId: '10001' } },
  characterRest: { bed: '11:00', wake: '13:00', jitterMin: 0 },
  rules: { actionGate: { enabled: true, expiresMinutes: 1, ackWaitSec: 5 } },
  exploration: { web: true, offerShare: true, leisureEvery: 0 }, persona: { localFile, dshHome: dir },
}));
fs.mkdirSync(path.join(dir, 'qq-bridge'));
fs.writeFileSync(path.join(dir, 'qq-bridge', 'connection.json'), JSON.stringify({
  selfId: '90001', autoConnect: false, httpToken: 'fixture-out', httpApiUrl: 'http://127.0.0.1:1',
}));
const routes = new Map(), listeners = new Map(), disposers = [];
const prompts = [], sends = [], fetched = [], queries = [];
const oldUrl = 'https://www.example.org/abstract', newUrl = 'https://example.com/article';
const csdnUrl = 'https://blog.csdn.net/notes';
const query = '反时限算法', proposal = '我自己去翻翻其他来源，方便吗？';
let modelCalls = 0;
let hasBody = true;
let fetchBlock = null;
let summaryBlock = null;
const services = {
  webServer: { register: (route) => { routes.set(route.path, route.handler); } },
  sessionController: { prompt: async (request) => { prompts.push(request); } },
  agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'text' }) },
  llm: { async *stream({ messages }) {
    const prompt = messages[0].content[0].text;
    modelCalls++;
    if (prompt.includes('【QQ 统一意图路由】')) {
      const { message, pendingProposal } = JSON.parse(prompt.split('\n').at(-1));
      let output = { intent: 'chat_only', actionType: 'none', userGuidance: '', ackCue: '' };
      if (pendingProposal) {
        assert.equal(pendingProposal.prompt, proposal);
        if (message === '可以' || message === '行，去CSDN找找') output = {
          intent: 'accept_proposal', actionType: 'explore_retry', userGuidance: message.includes('CSDN') ? 'CSDN' : '', ackCue: '简短',
        };
        if (message === '不用') output = { intent: 'decline_proposal', actionType: 'explore_retry', userGuidance: '', ackCue: '' };
      } else if (message === '帮我查反时限算法') {
        output = { intent: 'user_command', actionType: 'explore_query', userGuidance: query, ackCue: '自然' };
      }
      yield { type: 'text-delta', text: JSON.stringify(output) };
      return;
    }
    if (prompt.includes('本轮已确认换源') && summaryBlock) await summaryBlock;
    const output = prompt.includes('替角色选')
      ? { mode: 'research', kind: 'web', query }
      : prompt.includes('本轮已确认换源')
        ? { action: 'continue', progress: '正文确认了反时限算法', next: '比较两条曲线', progressSourceIndex: 0 }
        : { action: 'start', topic: query, progress: '只读到摘要', next: '找正文' };
    yield { type: 'text-delta', text: JSON.stringify(output) };
  } },
  tools: { get(name) {
    const execute = {
      advanced_search: ({ query }) => { queries.push(query); return { sources: [{ url: oldUrl }] }; },
      web_search: ({ queries: [query] }) => { queries.push(query); return { sources: [{ url: oldUrl }, { url: newUrl }, ...(query.includes('site:csdn.net') ? [{ url: csdnUrl }] : [])] }; },
      web_fetch: async ({ url }) => {
        fetched.push(url);
        if (url === newUrl && fetchBlock) await fetchBlock;
        return { url, statusCode: 200, body: { content: url === newUrl && hasBody ? '反时限算法正文' : '' } };
      },
    }[name];
    return execute ? { execute } : null;
  } },
};
const ctx = { ...services, get: (key) => services[key],
  on: (name, callback) => listeners.set(name, callback),
  effect: (fn) => { const off = fn(); if (typeof off === 'function') disposers.push(off); },
  inject: (_keys, callback) => callback(ctx) };
globalThis.fetch = async (raw, options) => {
  const url = new URL(raw);
  assert.equal(url.origin + url.pathname, 'http://127.0.0.1:1/send_private_msg');
  if (url.search) assert.equal(url.searchParams.get('access_token'), 'fixture-out');
  const payload = JSON.parse(options.body);
  assert.equal(payload.user_id, 10001);
  sends.push(payload.message);
  return Response.json({ status: 'ok', data: { message_id: 1000 + sends.length } });
};
const { apply } = await import('../../src/plugin.js');
const { actionProposalCandidate, prepareActionProposal } = await import('../../src/chat/action-proposal.js');
const { sendQQRound } = await import('../../src/chat/send.js');
const { loadConfig } = await import('../../src/settings/config.js');
const { loadPersona } = await import('../../src/decision/persona.js');
const { pickTopic } = await import('../../src/decision/topics.js');
const { apply: applyBridge } = await import(pathToFileURL(bridgePath));
const api = apply(ctx, { startupDelaySec: 3600, tool: true });
applyBridge(ctx, { home: dir });
function read(name) {
  const file = path.join(dir, 'data', name + '.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
}
const pending = () => read('action-consent').content?.pendingAction ?? null;
async function post(route, body = {}, headers = {}) {
  const handler = routes.get(route) ?? (route.startsWith('/api/dsh-drop-by/') && routes.get('/api/dsh-drop-by'));
  assert.equal(typeof handler, 'function', route);
  const req = { method: 'POST', url: route, headers: { 'sec-fetch-site': 'same-origin', ...headers },
    on(name, cb) { if (name === 'data') cb(Buffer.from(JSON.stringify(body))); if (name === 'end') cb(); return this; } };
  let json;
  const res = { statusCode: 200, setHeader() {}, end(text) { json = JSON.parse(text); } };
  await handler(req, res);
  return { json, status: res.statusCode };
}
let eventId = 0;
function event(message, { id = ++eventId, headers = { 'x-self-id-token': 'fixture' } } = {}) {
  return post('/dsh-qq-bridge/event', { message, post_type: 'message', message_type: 'private', sub_type: 'friend',
    message_id: id, user_id: 10001, self_id: '90001', time: Math.floor(now / 1000) }, headers);
}
let turn = 0;
async function answer(text) {
  const count = sends.length;
  const session = { id: 'test-session' }, data = { turn: ++turn };
  const listener = listeners.get('session/event');
  listener(session, { type: 'assistant/message', data: { ...data, message: { content: [{ type: 'text', text }] } } });
  listener(session, { type: 'turn/end', data });
  for (let i = 0; i < 10 && sends.length === count; i++) await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(sends[count], text);
}
async function offer() {
  now += 2000;
  const cfg = loadConfig(), state = read('exploration');
  const self = actionProposalCandidate({ cfg, peer: '10001', now, state, persona: loadPersona({ cfg }) });
  const topic = pickTopic({ self }, cfg, now, {});
  assert.equal(topic.evidence.actionRetry, true);
  const actionProposal = prepareActionProposal({ peer: '10001', text: proposal, cfg, now,
    source: topic.evidence.source.url, roundAt: topic.evidence.at });
  assert.ok(actionProposal);
  assert.ok((await sendQQRound({ to: '10001', text: proposal, dryRun: false, now, split: { enabled: false }, actionProposal })).ok);
  assert.equal(sends.at(-1), proposal);
  assert.equal(pending()?.type, 'explore_retry');
}

const latestPrompt = () => prompts.at(-1)?.content[0].text || '';
async function waitForSend(text) {
  for (let i = 0; i < 300; i++) {
    if (sends.at(-1) === text) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(sends.at(-1), text);
}
try {
  assert.equal((await post('/dsh-qq-bridge/bind', { sessionId: 'test-session', peerKind: 'private', peerId: '10001' })).json.ok, true);
  assert.equal((await post('/api/dsh-drop-by/explore')).json.ok, true);
  assert.deepEqual(fetched, [oldUrl]);

  await event('我去睡了');
  await answer('我也去躺会儿');
  await event('好');
  assert.equal(pending(), null);
  assert.deepEqual(fetched, [oldUrl]);
  await answer('晚安');

  await offer();
  now += 2000;
  await event('不用');
  assert.equal(pending(), null);
  assert.match(latestPrompt(), /陪伴动作已取消/);
  await answer('行，那就先放着。');
  assert.deepEqual(fetched, [oldUrl]);

  await offer();
  now += 2000;
  await event('先聊漫画');
  assert.equal(pending(), null);
  await answer('你想聊哪部');
  await event('好');
  assert.deepEqual(fetched, [oldUrl]);
  await answer('行');

  await offer();
  await event('行');
  assert.equal(pending(), null);
  await answer('行');
  assert.deepEqual(fetched, [oldUrl]);

  await offer();
  now += 2000;
  await event([{ type: 'text', data: { text: '可以' } }, { type: 'face', data: { id: '1' } }]);
  assert.equal(pending(), null);
  await answer('收到');
  assert.deepEqual(fetched, [oldUrl]);

  await offer();
  now += 60_000;
  await event('行');
  assert.equal(pending(), null);
  await answer('行');
  assert.deepEqual(fetched, [oldUrl]);

  await offer();
  now += 2000;
  assert.ok(pending());
  let release, releaseSummary;
  fetchBlock = new Promise((resolve) => { release = resolve; });
  summaryBlock = new Promise((resolve) => { releaseSummary = resolve; });
  const callsBefore = modelCalls;
  const beforeConfirmation = sends.length;
  await event('可以', { headers: {} });
  assert.equal(pending(), null);
  assert.match(latestPrompt(), /陪伴动作已接单/);
  assert.equal(sends.length, beforeConfirmation);
  assert.notEqual(read('exploration').lastRun.alternateSourceRetry, true);
  now += 1000;
  await answer('好，那我去找找看');
  release();
  await waitForSend('换了个站，正文找到了。');
  assert.equal(modelCalls, callsBefore + 2);
  assert.deepEqual(sends.slice(beforeConfirmation), ['好，那我去找找看', '换了个站，正文找到了。']);
  assert.deepEqual(fetched, [oldUrl, newUrl]);
  assert.deepEqual(queries, [query, query]);
  assert.equal(read('exploration').lastRun.sources[0].url, oldUrl, 'callback arrives before the summary finishes');
  releaseSummary();
  for (let i = 0; i < 30 && read('exploration').thread.progress !== '正文确认了反时限算法'; i++) await new Promise(setImmediate);
  assert.equal(read('exploration').lastRun.sources[0].url, newUrl);
  assert.equal(read('exploration').thread.progress, '正文确认了反时限算法');

  await event('好');
  assert.doesNotMatch(latestPrompt(), /陪伴动作已接单/);
  await answer('嗯');
  fetchBlock = null;
  summaryBlock = null;
  hasBody = false;
  now += 2000;
  assert.equal((await post('/api/dsh-drop-by/explore')).json.ok, true);
  await offer();
  now += 2000;
  await event('行，去CSDN找找');
  assert.match(latestPrompt(), /陪伴动作已接单.*CSDN/);
  now += 1000;
  await answer('好，我找找');
  now += 5000;
  await waitForSend('换了来源找过，还是没拿到正文。');
  assert.deepEqual(fetched, [oldUrl, newUrl, oldUrl, csdnUrl]);
  assert.equal(queries.at(-1), query + ' site:csdn.net');
  assert.equal(read('exploration').lastRun.alternateSourceRetry, true);

  now += 2000;
  await event('今天天气真好');
  assert.doesNotMatch(latestPrompt(), /陪伴任务/);
  assert.equal(queries.length, 4);
  await answer('嗯，没定');

  now += 2000;
  const politeCommand = '帮我查反时限算法';
  const beforeCommand = sends.length;
  const id = ++eventId;
  await event(politeCommand, { id });
  assert.match(latestPrompt(), /陪伴任务已接单/);
  assert.match(latestPrompt(), /刚被这条消息吵醒/);
  assert.equal(sends.length, beforeCommand);
  now += 1000;
  await answer('好，我去翻翻');
  now += 5000;
  await waitForSend('翻到这些线索\n\nwww.example.org（仅摘要）\n' + oldUrl);
  assert.equal(queries.length, 5);
  assert.equal(queries.at(-1), query);
  now -= 6000;
  await event(politeCommand, { id });
  assert.match(latestPrompt(), /这条已接过/);
  assert.equal(queries.length, 5);
  await answer('嗯，这条已经查过啦');

  now += 3000;
  const promptCount = prompts.length;
  const routeCalls = modelCalls;
  const firstHalf = event('给你说个事');
  const secondHalf = event('今天才发现这条曲线有拐点');
  await Promise.all([firstHalf, secondHalf]);
  assert.equal(prompts.length, promptCount + 1);
  assert.equal(modelCalls, routeCalls + 1);
  assert.match(latestPrompt(), /给你说个事[\s\S]*今天才发现这条曲线有拐点/u);
  assert.equal(latestPrompt().match(/\[QQ 私聊\]/gu)?.length, 1);
  await answer('哪一段拐得最明显？');
} finally {
  api.stop();
  for (const dispose of disposers.reverse()) dispose();
}
