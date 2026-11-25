import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contextUsage, createSessionRollover, dismissRollover, extractHandoffMessages, pendingRollovers } from '../src/chat/session-rollover.js';
import { qqRolloverAdapter, stripQqSourceHeader } from '../src/chat/qq-rollover-adapter.js';
import { installQqPromptMerge } from '../src/chat/qq-debounce.js';
import { applyChange } from '../src/settings/settings.js';

const text = (value) => ({ type: 'text', text: value });
const user = (value) => ({ type: 'user/message', data: { content: [text(value)] } });
const assistant = (value) => ({ type: 'assistant/message',
  data: { message: { content: [{ type: 'thinking', thinking: '内部思考' }, text(value)] } } });
const end = { type: 'turn/end' };
const old = { id: 'old-session' };
const nextId = 'new-session-1234';

function fixture(t, { prepareBindingFile = true, carryMessages = 2 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-rollover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'qq-bridge'));
  const bindingsFile = path.join(dir, 'qq-bridge', 'bindings.json');
  const file = path.join(dir, 'data', 'session-handoff.json');
  const oldBinding = { peerId: '42', peerKind: 'private', peerName: '友人', mentionOnly: false, authoritative: true, enabled: true };
  const data = { version: 1, sessions: { [old.id]: oldBinding, unrelated: { peerId: '123', peerKind: 'group', enabled: true } } };
  fs.writeFileSync(bindingsFile, JSON.stringify(data));
  const cfg = { rules: { qqRollover: { enabled: true, thresholdPercent: 80, carryMessages, prepareBindingFile } } };
  const calls = { create: [], rename: [], projections: [], inspect: [], notified: [], input: [] };
  let current = { projectedTokens: 799, pressureTokens: 900, contextWindow: 1000 };
  let events = [user('还没切换'), assistant('先接着聊'), { type: 'session/title', data: { title: '晚聊' } }];
  let failInspect = false;
  let failPrompt = false;
  const controller = {
    async projections(request, signal) {
      assert.ok(signal instanceof AbortSignal);
      calls.projections.push(request);
      return { values: { contextPressure: current } };
    },
    async inspect(id, signal) {
      assert.ok(signal instanceof AbortSignal);
      calls.inspect.push(id);
      if (failInspect) throw Error('offline');
      return { meta: { cwd: '/test/workspace' }, events };
    },
    async create(request) { calls.create.push(request); return { sessionId: nextId }; },
    async rename(request) { calls.rename.push(request); return { title: request.title }; },
    async prompt(payload) {
      if (failPrompt) throw Error('busy queue');
      calls.input.push(payload);
      return 'admitted';
    },
  };
  const base = { controller, projections: () => null,
    workspaceRegistry: () => ({ list: () => [{ id: 'ws-1', sessionIds: [old.id] }] }),
    file, adapter: qqRolloverAdapter(dir), getConfig: () => cfg, notify: (input) => { calls.notified.push(input); } };
  return { dir, base, calls, cfg, data, oldBinding, controller,
    bindings: () => JSON.parse(fs.readFileSync(bindingsFile)),
    writeBindings: (value) => fs.writeFileSync(bindingsFile, JSON.stringify(value)),
    state: () => JSON.parse(fs.readFileSync(file))[old.id],
    setPressure: (value) => { current = value; },
    setEvents: (value) => { events = value; },
    failInspect: () => { failInspect = true; },
    setPromptFailure: (value) => { failPrompt = value; },
  };
}

test('threshold prefers projected tokens, creates in the same workspace only once, and stages the binding on disk', async (t) => {
  assert.deepEqual(contextUsage({ pressureTokens: 800, contextWindow: 1000 }), { used: 800, limit: 1000, ratio: 0.8 });
  assert.equal(contextUsage({ pressureTokens: 2, contextWindow: 0 }), null);
  const f = fixture(t);
  const rollover = createSessionRollover(f.base);
  await rollover.handleEvent(old, end);
  assert.equal(f.calls.create.length, 0);
  f.setPressure({ projectedTokens: 800, pressureTokens: 1, contextWindow: 1000 });
  await Promise.all([rollover.handleEvent(old, end), rollover.handleEvent(old, end)]);
  await rollover.handleEvent(old, end);
  await createSessionRollover(f.base).handleEvent(old, end);
  assert.deepEqual(f.calls.create, [{ workspaceId: 'ws-1' }]);
  assert.deepEqual(f.calls.rename, [{ sessionId: nextId, title: '晚聊（续聊 2）' }]);
  assert.equal(f.calls.notified.length, 1);
  assert.deepEqual(f.calls.notified[0].usage, { used: 800, limit: 1000, ratio: 0.8 });
  assert.deepEqual(f.bindings().sessions[nextId], {
    ...f.oldBinding, sessionId: nextId, enabled: true, updatedAt: f.state().triggeredAt,
  });
  assert.equal(f.bindings().sessions[old.id].enabled, false);
  assert.deepEqual(f.bindings().sessions.unrelated, f.data.sessions.unrelated);
  assert.equal(f.oldBinding.enabled, true);
  assert.equal(f.state().fallbackMessages.length, 2);
});

test('conversation extraction ignores context envelopes, empty messages, and thinking, cutting by message', () => {
  const history = [
    user('最早一句'), assistant('前面的回复'),
    user('【上一会话近期对话前情（已切换新会话，仅作语境参考）】\n旧上下文\n\n' +
      '【dsh-drop-by 角色背景】\n人设事实\n\n[QQ 私聊] 来自友人\n来源警告\n\n[14:01:00] 最新问题\n[14:01:01] 补充一句'),
    assistant('最后的回答'), { type: 'assistant/message', data: { message: { content: [{ type: 'thinking', text: '不能带走' }] } } },
    user(' '), { type: 'turn/end' },
  ];
  assert.deepEqual(extractHandoffMessages(history, 2, stripQqSourceHeader), [
    { role: 'user', text: '最新问题\n补充一句' }, { role: 'assistant', text: '最后的回答' },
  ]);
  const xmlWrapped = [
    user('<qq_reply_context>\n【dsh-drop-by 角色背景】\n{}\n</qq_reply_context>\n\n真正的提问'),
    assistant('正常回复'),
  ];
  assert.deepEqual(extractHandoffMessages(xmlWrapped, 2, stripQqSourceHeader), [
    { role: 'user', text: '真正的提问' }, { role: 'assistant', text: '正常回复' },
  ]);
  assert.deepEqual(extractHandoffMessages(history, 0), []);
});

test('the prompt wrapper refreshes live history after restart and injects it into one admission only', async (t) => {
  const f = fixture(t);
  const oldRollover = createSessionRollover({ ...f.base, projections: () => ({ snapshot: (current) => {
    assert.equal(current, old);
    return { values: { contextPressure: { pressureTokens: 800, contextWindow: 1000 } } };
  } }) });
  await oldRollover.handleEvent(old, end);
  assert.equal(f.calls.projections.length, 0);
  f.setEvents([user('旧前情'), user('切换前新增问题'), assistant('切换前新增回复')]);
  const rollover = createSessionRollover(f.base);
  const stop = installQqPromptMerge(f.controller, rollover.prompt);
  t.after(stop);
  const signal = new AbortController().signal;
  const oldPayload = { sessionId: old.id, content: [text('旧会话继续聊')] };
  await f.controller.prompt(oldPayload, signal);
  assert.equal(f.calls.input[0], oldPayload);
  const first = { sessionId: nextId, content: [text('接着讲'), { type: 'image', data: 'image' }] };
  const second = { sessionId: nextId, content: [text('再补一句')] };
  await Promise.all([f.controller.prompt(first, signal), f.controller.prompt(second, signal)]);
  assert.match(f.calls.input[1].content[0].text, /上一会话近期对话前情[\s\S]+切换前新增问题[\s\S]+切换前新增回复[\s\S]+接着讲/);
  assert.doesNotMatch(f.calls.input[1].content[0].text, /旧前情/);
  assert.equal(f.calls.input[1].content[1], first.content[1]);
  assert.equal(f.calls.input[2], second);
  assert.equal(f.state().injected, true);
  assert.equal(f.calls.inspect.length, 2);
});

test('manual rebinding and unreadable old session use the saved fallback; rejected admission can retry', async (t) => {
  const f = fixture(t, { prepareBindingFile: false });
  f.setPressure({ pressureTokens: 810, contextWindow: 1000 });
  const rollover = createSessionRollover({ ...f.base, workspaceRegistry: () => null });
  await rollover.handleEvent(old, end);
  assert.deepEqual(f.calls.create, [{ cwd: '/test/workspace' }]);
  assert.equal(f.bindings().sessions[old.id].enabled, true);
  f.writeBindings({ version: 1, sessions: { 'user-created': f.oldBinding } });
  f.failInspect();
  f.setPromptFailure(true);
  const payload = { sessionId: 'user-created', content: [text('继续吧')] };
  await assert.rejects(rollover.prompt(payload, undefined, f.controller.prompt), /busy queue/);
  assert.equal(f.state().injected, false);
  f.setPromptFailure(false);
  await rollover.prompt(payload, undefined, f.controller.prompt);
  assert.match(f.calls.input[0].content[0].text, /还没切换[\s\S]*先接着聊/);
  assert.equal(f.state().injectedSessionId, 'user-created');
});

test('settings enforce threshold 10–95 percent and history 0–50 messages', () => {
  for (const [field, min, max] of [['thresholdPercent', 10, 95], ['carryMessages', 0, 50]]) {
    for (const n of [min - 1, max + 1, min + 0.5]) assert.equal(applyChange({}, 'rules.qqRollover.' + field, n).ok, false);
    for (const n of [min, max]) assert.equal(applyChange({}, 'rules.qqRollover.' + field, n).cfg.rules.qqRollover[field], n);
  }
});

test('pendingRollovers exposes binding metadata and dismissRollover hides dismissed handoffs', async (t) => {
  const f = fixture(t);
  f.setPressure({ projectedTokens: 850, contextWindow: 1000 });
  const rollover = createSessionRollover(f.base);
  await rollover.handleEvent(old, end);
  const pending = pendingRollovers(f.base.file, f.base.adapter);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].oldSessionId, old.id);
  assert.equal(pending[0].newSessionId, nextId);
  assert.equal(pending[0].peerName, '友人');
  assert.equal(pending[0].mentionOnly, false);
  assert.equal(pending[0].authoritative, true);
  assert.equal(pending[0].diskBound, true);
  assert.equal(dismissRollover(f.base.file, old.id), true);
  assert.equal(pendingRollovers(f.base.file, f.base.adapter).length, 0);
  assert.equal(dismissRollover(f.base.file, old.id), true);
  assert.equal(dismissRollover(f.base.file, 'missing-session'), false);
});

test('rollover uses actual contextWindow ratio by default and respects explicit maxWindowTokens cap', async (t) => {
  const f = fixture(t);
  f.cfg.rules.qqRollover.thresholdPercent = 35;
  f.setPressure({ projectedTokens: 67_021, contextWindow: 262_144 });
  const rollover = createSessionRollover(f.base);
  await rollover.handleEvent(old, end);
  assert.equal(f.calls.create.length, 0);

  f.cfg.rules.qqRollover.thresholdPercent = 80;
  f.cfg.rules.qqRollover.maxWindowTokens = 120_000;
  f.setPressure({ projectedTokens: 96_000, contextWindow: 1_000_000 });
  await rollover.handleEvent(old, end);
  assert.deepEqual(f.calls.create, [{ workspaceId: 'ws-1' }]);
  assert.equal(f.state().newSessionId, nextId);
});

test('conversation extraction skips DSH host-injected runtime, memory, time, and hindsight user messages', () => {
  const history = [
    user('第一句真实消息'),
    assistant('第一句回复'),
    user('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n## 人格设定（AGENT.md）'),
    user('<hindsight_pages>\nThis repository has Hindsight...\n</hindsight_pages>'),
    user('Time sampled while preparing turn 165, step 1: 2026-11-23T20:57:40+08:00'),
    user('MNEMON RUNTIME MEMORY SNAPSHOT\nUSER.md...'),
    user('[MNEMON] Search Documents for substantial project records...'),
    user('第二句真实消息'),
    assistant('第二句回复'),
  ];
  assert.deepEqual(extractHandoffMessages(history, 10, stripQqSourceHeader), [
    { role: 'user', text: '第一句真实消息' },
    { role: 'assistant', text: '第一句回复' },
    { role: 'user', text: '第二句真实消息' },
    { role: 'assistant', text: '第二句回复' },
  ]);
});
