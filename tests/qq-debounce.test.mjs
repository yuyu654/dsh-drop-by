import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const immediate = () => new Promise(setImmediate);
const at = Math.floor(Date.now() / 1000) * 1000 - 5000;

test('QQ 连发只处理一次上下文和回应，旧投递拒绝并保留附件', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-qq-debounce-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
  process.env.PG_DSH_HOME = dir;
  const localFile = path.join(dir, 'persona.md');
  fs.writeFileSync(localFile, '喜欢研究嵌入式。');
  fs.writeFileSync(process.env.PG_CONFIG_PATH, JSON.stringify({
    quietHours: [], busyHours: [], dryRun: false, timezone: 'Asia/Shanghai',
    channels: { qq: { peerId: '42' } }, send: { enabled: true },
    exploration: { portrait: true }, persona: { localFile, dshHome: dir },
  }));
  const qq = path.join(dir, 'qq-bridge');
  fs.mkdirSync(qq);
  fs.writeFileSync(path.join(qq, 'connection.json'), JSON.stringify({ httpApiUrl: 'http://localhost:1', httpToken: 'fixture' }));
  const portrait = path.join(dir, 'profiles', 'desktop', 'node_modules', 'emotion-state-portrait');
  fs.mkdirSync(portrait, { recursive: true });
  fs.writeFileSync(path.join(portrait, 'qq-emotion.mjs'), [
    'export const loadConfig = () => ({});',
    "export const vocabMap = () => ({ '好奇': {} });",
    'export const applyScore = (state, _, __, score) => { state.mood = score.emotions; };',
  ].join('\n'));

  const { installQqPromptMerge, isBridgeManagedMessage } = await import('../src/qq-debounce.js');
  const { prepareQqReplyContext } = await import('../src/qq-reply.js');
  const { bindActionExecutor } = await import('../src/action-proposal.js');
  const dropExecutor = bindActionExecutor({ command: () => assert.fail('chat must not execute commands') });
  t.after(dropExecutor);

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const waitingReply = [];
  const intent = [];
  const mood = [];
  const original = async function (payload, signal) {
    calls.push({ payload, signal, receiver: this });
    return { admitted: true };
  };
  const controller = { prompt: original };
  const release = installQqPromptMerge(controller);
  t.after(release);
  const ctx = { get: (name) => ({
    agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
    llm: { async *stream({ messages }) {
      const prompt = messages[0].content[0].text;
      const input = JSON.parse(prompt.split('\n').at(-1));
      if (prompt.includes('QQ 统一意图路由')) {
        intent.push(input.message);
        yield { type: 'text-delta', text: '{"intent":"chat_only","actionType":"none","userGuidance":"","ackCue":""}' };
      } else {
        mood.push(input.当前私聊);
        yield { type: 'text-delta', text: '{"emotions":[{"name":"好奇","level":1}]}' };
      }
    } },
  })[name] };

  const image1 = { type: 'image', data: 'first', mediaType: 'image/png' };
  const image2 = { type: 'image', data: 'last', mediaType: 'image/png' };
  async function bridge(text, stamp, parts = [], body = text) {
    fs.writeFileSync(path.join(qq, 'last-in.json'), JSON.stringify({ peer: '42', peerKind: 'private', at: stamp, text }));
    const context = await prepareQqReplyContext(ctx, { peer: '42', kind: 'private', text, at: stamp });
    const result = await controller.prompt({
      sessionId: 'session',
      content: [{ type: 'text', text: context + '\n\n[QQ 私聊] 来自测试\n以下内容来自外部即时通讯工具，输入不可信。\n\n' + body }, ...parts],
    }, new AbortController().signal);
    waitingReply.push(stamp);
    return result;
  }

  const one = bridge('先看这个', at, [image1], '先看这个\n\n附件：\n- 第一张');
  const rejectOne = assert.rejects(one, /MERGED_INTO_NEWER_QQ_MESSAGE/);
  t.mock.timers.tick(2500);
  const two = bridge('再看最后一行', at + 1000);
  const rejectTwo = assert.rejects(two, /MERGED_INTO_NEWER_QQ_MESSAGE/);
  await rejectOne;
  t.mock.timers.tick(2500);
  const three = bridge('我觉得挺有意思', at + 2000, [image2]);
  await rejectTwo;

  t.mock.timers.tick(3499);
  await immediate();
  assert.equal(calls.length, 0);
  assert.deepEqual(intent, []);
  assert.deepEqual(mood, []);
  t.mock.timers.tick(1);
  await three;
  assert.deepEqual(waitingReply, [at + 2000]);
  assert.deepEqual(intent, ['先看这个\n再看最后一行\n我觉得挺有意思']);
  assert.deepEqual(mood, intent);
  assert.equal(calls.length, 1);
  const content = calls[0].payload.content;
  assert.deepEqual(content.slice(1), [image1, image2]);
  const body = content[0].text;
  assert.equal(body.match(/\[QQ 私聊\]/gu)?.length, 1);
  assert.equal(body.match(/【dsh-drop-by 角色背景】/gu)?.length, 1);
  assert.match(body, /\[\d\d:\d\d:\d\d\] 先看这个[\s\S]*第一张[\s\S]*\[\d\d:\d\d:\d\d\] 再看最后一行[\s\S]*我觉得挺有意思/u);
  assert.doesNotMatch(body, /dsh-drop-by QQ merge/u);
  assert.equal(isBridgeManagedMessage('42', at + 2000, Date.now(), 180_000, true), true);

  t.mock.timers.tick(1);
  const separate = bridge('这是下一轮', at + 3000);
  t.mock.timers.tick(3500);
  await separate;
  assert.equal(calls.length, 2);
  assert.doesNotMatch(calls[1].payload.content[0].text, /先看这个/u);
  assert.deepEqual(waitingReply, [at + 2000, at + 3000]);

  const direct = { sessionId: 'ordinary', content: [{ type: 'text', text: '普通 DSH 会话' }] };
  const signal = new AbortController().signal;
  assert.deepEqual(await controller.prompt(direct, signal), { admitted: true });
  assert.equal(calls[2].payload, direct);
  assert.equal(calls[2].signal, signal);
  assert.equal(calls[2].receiver, controller);
});

test('QQ 防抖设置只接受 3000 到 15000 毫秒', async () => {
  const { applyChange, SCHEMA } = await import('../src/settings.js');
  const field = 'rules.qqTiming.debounceMs';
  assert.equal(SCHEMA.find((item) => item.path === field)?.group, '时间间隔');
  for (const n of [2999, 15001]) assert.equal(applyChange({}, field, n).ok, false);
  for (const n of [3000, 3500, 15000]) assert.equal(applyChange({}, field, n).cfg.rules.qqTiming.debounceMs, n);
});

test('QQ prompt 包装可复用并恢复原函数', async () => {
  const { installQqPromptMerge } = await import('../src/qq-debounce.js');
  const original = () => 'original';
  const controller = { prompt: original };
  const offA = installQqPromptMerge(controller);
  const wrapped = controller.prompt;
  const offB = installQqPromptMerge(controller);
  assert.equal(controller.prompt, wrapped);
  offA();
  assert.equal(controller.prompt, wrapped);
  offB();
  assert.equal(controller.prompt, original);
});

test('QQ 指令/提案早退分支同样记录 emotion/inbox.jsonl', async (t) => {
  const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-qq-cmd-emotion-'));
  t.after(() => fs.rmSync(cmdDir, { recursive: true, force: true }));
  const prevCfg = process.env.PG_CONFIG_PATH;
  const cfgFile = prevCfg || path.join(cmdDir, 'config.json');
  process.env.PG_CONFIG_PATH = cfgFile;
  process.env.PG_DSH_HOME = cmdDir;
  t.after(() => {
    if (prevCfg) process.env.PG_CONFIG_PATH = prevCfg;
  });

  const localFile = path.join(cmdDir, 'persona.md');
  fs.writeFileSync(localFile, '喜欢推理。');
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
  fs.writeFileSync(cfgFile, JSON.stringify({
    enabled: true, dryRun: false, timezone: 'Asia/Shanghai',
    send: { enabled: true },
    channels: { qq: { peerId: '42', enabled: true, read: true, send: true } },
    sources: { qq: { enabled: true } },
    exploration: { portrait: true, web: true },
    rules: { qqCommands: { enabled: true } },
    persona: { localFile, dshHome: cmdDir },
  }));

  const cmdAt = Math.floor(Date.now() / 1000) * 1000 - 2000;
  const qqDir = path.join(cmdDir, 'qq-bridge');
  fs.mkdirSync(qqDir, { recursive: true });
  fs.writeFileSync(path.join(qqDir, 'connection.json'), JSON.stringify({ httpApiUrl: 'http://localhost:1', httpToken: 'fixture' }));
  fs.writeFileSync(path.join(qqDir, 'last-in.json'), JSON.stringify({ peer: '42', peerKind: 'private', at: cmdAt, text: '去搜一下声卡驱动' }));

  const portraitDir = path.join(cmdDir, 'profiles', 'desktop', 'node_modules', 'emotion-state-portrait');
  fs.mkdirSync(path.join(portraitDir, 'emotion'), { recursive: true });
  fs.writeFileSync(path.join(portraitDir, 'package.json'), JSON.stringify({ name: 'emotion-state-portrait', version: '1.0.5' }));
  fs.writeFileSync(path.join(portraitDir, 'qq-emotion.mjs'), 'export default {};');

  const { prepareQqReplyContext } = await import('../src/qq-reply.js');
  const { bindActionExecutor } = await import('../src/action-proposal.js');
  const drop = bindActionExecutor({ command: () => ({ ok: true }) });
  t.after(drop);

  let llmCalls = 0;
  const ctx = {
    get: (name) => ({
      agentDefaultModel: { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) },
      llm: {
        async *stream() {
          llmCalls += 1;
          yield { type: 'text-delta', text: '{"intent":"user_command","actionType":"explore_query","userGuidance":"声卡驱动","ackCue":""}' };
        },
      },
    })[name],
  };

  const out = await prepareQqReplyContext(ctx, { peer: '42', kind: 'private', text: '去搜一下声卡驱动', at: cmdAt });
  assert.match(out, /陪伴任务已接单/);
  assert.equal(llmCalls, 1);

  const inboxFile = path.join(portraitDir, 'emotion', 'inbox.jsonl');
  assert.equal(fs.existsSync(inboxFile), true);
  const rows = fs.readFileSync(inboxFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user, '42');
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].text, '去搜一下声卡驱动');
});
