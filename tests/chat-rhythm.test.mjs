import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-chat-rhythm-'));
const envOverrides = {
  PG_CONFIG_PATH: path.join(tmp, 'config.json'),
  PG_STATE_PATH: path.join(tmp, 'state.json'),
  PG_LOG_DIR: path.join(tmp, 'logs'),
  PG_DSH_HOME: tmp,
};
const originalEnv = Object.entries(envOverrides).map(([k]) => [k, process.env[k]]);
Object.assign(process.env, envOverrides);
test.after(() => {
  for (const [k, v] of originalEnv) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const {
  detectWindDownSignals,
  closingCooldownActive,
  isHotChat,
  pickShareHook,
  recordShareHook,
  REPLY_PACING_RULE,
  CLOSING_EXPLICIT_HINT,
  CLOSING_SOFT_HINT,
} = await import('../src/chat/chat-rhythm.js');
const { loadConfig } = await import('../src/settings/config.js');
const { applyChange, listForUi } = await import('../src/settings/settings.js');
const { decide } = await import('../src/decision/decide.js');
const { explainRun } = await import('../src/decision/explain.js');
const { buildDailyReport } = await import('../src/decision/report.js');
const { shadowEligible } = await import('../src/decision/shadow.js');
const { createQqContinuation } = await import('../src/chat/qq-continuation.js');
const { buildReplyContext } = await import('../src/chat/qq-reply.js');
const { exploreRound } = await import('../src/explore/explore.js');

const MIN = 60_000;
const BASE_TS = Date.parse('2026-11-22T15:00:00+08:00');

test('纯代码识别明确收尾、连续短敷衍、未接问句与节奏变慢，且不误伤正常对话', () => {
  const bye = detectWindDownSignals([{ who: 'her', text: '我先去忙了', ts: BASE_TS }]);
  assert.equal(bye.windingDown, true);
  assert.equal(bye.explicit, true);
  assert.equal(bye.hint, CLOSING_EXPLICIT_HINT);
  assert.match(bye.hint, /不要输出“不发送”/);

  // 第三方叙述不误触发
  const story = detectWindDownSignals([{ who: 'her', text: '我同学说他先去忙了，明天再看', ts: BASE_TS }]);
  assert.equal(story.windingDown, false);

  // 连续两条敷衍短词
  const fade = detectWindDownSignals([
    { who: 'her', text: '哈哈', ts: BASE_TS },
    { who: 'me', text: '对吧', ts: BASE_TS + 10_000 },
    { who: 'her', text: '嗯', ts: BASE_TS + 30_000 },
  ]);
  assert.equal(fade.windingDown, true);
  assert.equal(fade.explicit, false);
  assert.ok(fade.reasons.includes('short_fade'));
  assert.equal(fade.hint, CLOSING_SOFT_HINT);

  // 角色发问但用户只回极短敷衍词
  const skippedQ = detectWindDownSignals([
    { who: 'me', text: '你们那栋电梯里能打电话吗？', ts: BASE_TS },
    { who: 'her', text: '哦', ts: BASE_TS + 20_000 },
  ]);
  assert.equal(skippedQ.windingDown, true);
  assert.ok(skippedQ.reasons.includes('unanswered_question'));

  // 节奏从 1 分钟拉长到 12 分钟且回复很短
  const slow = detectWindDownSignals([
    { who: 'her', text: '我刚把那段代码调通了', ts: BASE_TS },
    { who: 'her', text: '好像确实快不少', ts: BASE_TS + 1 * MIN },
    { who: 'her', text: '差不多吧', ts: BASE_TS + 13 * MIN },
  ]);
  assert.equal(slow.windingDown, true);
  assert.ok(slow.reasons.includes('slowing_down'));

  // 正常反问或展开聊天不误报
  const active = detectWindDownSignals([
    { who: 'me', text: '我今天看了一下午雨伞结构', ts: BASE_TS },
    { who: 'her', text: '你好闲啊，查出什么有意思的了吗？', ts: BASE_TS + 30_000 },
  ]);
  assert.equal(active.windingDown, false);
});

test('收尾后冷却拦主动、不拦回复，且设置页保存与非默认值生效', () => {
  const cfg = loadConfig();
  assert.equal(cfg.rules.closingCooldownMin, 120);
  const turns = [{ who: 'her', text: '先这样，我去忙了', ts: BASE_TS }];
  assert.equal(closingCooldownActive(turns, cfg, BASE_TS + 45 * MIN).active, true);
  assert.equal(closingCooldownActive(turns, cfg, BASE_TS + 125 * MIN).active, false);

  // 通过设置页改为 30 分钟后保存回显，45 分钟前不再拦截
  const changed = applyChange(cfg, 'rules.closingCooldownMin', 30);
  assert.ok(changed.ok);
  const fields = listForUi(changed.cfg).flatMap((g) => g.items);
  assert.equal(fields.find((f) => f.path === 'rules.closingCooldownMin')?.value, 30);
  assert.equal(closingCooldownActive(turns, changed.cfg, BASE_TS + 45 * MIN).active, false);
  assert.equal(closingCooldownActive(turns, changed.cfg, BASE_TS + 15 * MIN).active, true);

  // decide 只拦主动，不拦用户重新开口后的 reply 轨道
  const baseDecide = { cfg, now: BASE_TS + 10 * MIN, idleSec: 0, todaySent: 0, userWindingDown: true };
  assert.equal(decide(baseDecide).reason, 'USER_WINDING_DOWN');
  assert.equal(decide({ ...baseDecide, lastUserTs: BASE_TS + 10 * MIN - 1000 }).track, 'reply');

  // explain / report / shadow 全链路一致
  assert.match(explainRun({ record: { reason: 'USER_WINDING_DOWN' } }).summary, /收尾|忙/);
  const report = buildDailyReport({ day: '2026-11-22', records: [{ decision: 'skip', reason: 'USER_WINDING_DOWN' }] });
  assert.match(report, /克制记录.*对方在收尾 1 拍/);
  assert.equal(shadowEligible({ rules: { judge: { enabled: true, shadow: true } } }, 'USER_WINDING_DOWN'), false);
});

test('热聊补话受热度硬闸控制，敷衍短回或收尾词直接拦截，hotMinChars 可调生效', () => {
  const peer = '42';
  const makePair = (at, text) => ({
    incoming: { peer, kind: 'private', ts: at, observedAt: at, text },
    outgoing: { peer, firstAt: at + 1000, lastAt: at + 2000, count: 1, text: '我也觉得挺有意思' },
  });

  // 敷衍短回直接被热度闸挡掉
  const coldChat = createQqContinuation();
  coldChat.observe(makePair(BASE_TS, '哈哈'), peer, BASE_TS + 2000);
  coldChat.observe(makePair(BASE_TS + 20_000, '嗯嗯'), peer, BASE_TS + 22_000);
  assert.equal(coldChat.observe(makePair(BASE_TS + 20_000, '嗯嗯'), peer, BASE_TS + 37_000), null);

  // 明确收尾词直接被挡掉
  const byeChat = createQqContinuation();
  byeChat.observe(makePair(BASE_TS, '那个漫画真的好好笑啊'), peer, BASE_TS + 2000);
  byeChat.observe(makePair(BASE_TS + 20_000, '我去忙了先不聊了'), peer, BASE_TS + 22_000);
  assert.equal(byeChat.observe(makePair(BASE_TS + 20_000, '我去忙了先不聊了'), peer, BASE_TS + 37_000), null);

  // 设置页保存并调高 hotMinChars=12 后，7 字回复不再触发，14 字回复可触发
  const base = loadConfig();
  const enabled = applyChange(base, 'rules.qqContinuation', true);
  const stricter = applyChange(enabled.cfg, 'rules.qqTiming.hotMinChars', 12);
  assert.ok(stricter.ok);
  const fields = listForUi(stricter.cfg).flatMap((g) => g.items);
  assert.equal(fields.find((f) => f.path === 'rules.qqTiming.hotMinChars')?.value, 12);

  const turns7 = [makePair(BASE_TS, '那个漫画好好笑'), makePair(BASE_TS + 20_000, '你喜欢哪个角色')];
  assert.equal(isHotChat(turns7, enabled.cfg), true);
  assert.equal(isHotChat(turns7, stricter.cfg), false);

  const turns14 = [
    makePair(BASE_TS, '那个漫画里反转的桥段写得太绝了'),
    makePair(BASE_TS + 20_000, '你看到后面揭晓真相那一话了吗'),
  ];
  assert.equal(isHotChat(turns14, stricter.cfg), true);
});

test('私聊上下文注入续聊节律规则，遇到收尾消息时注入短收尾提示', async () => {
  const cfg = {
    ...loadConfig(),
    channels: { primary: 'qq', qq: { enabled: true, read: true, send: true, peerId: '10001' } },
    characterRest: { bed: '22:00', wake: '06:30', jitterMin: 0 },
  };
  const byeCtx = await buildReplyContext({}, {
    cfg, peer: '10001', kind: 'private', text: '我先去忙了', at: BASE_TS,
  });
  assert.match(byeCtx, /收尾提示/);
  assert.match(byeCtx, /严禁抛新问题/);
  assert.match(byeCtx, /不要输出“不发送”/);

  const normalCtx = await buildReplyContext({}, {
    cfg, peer: '10001', kind: 'private', text: '你刚才说那个电路怎么算来着？', at: BASE_TS,
  });
  assert.doesNotMatch(normalCtx, /收尾提示/);
  assert.ok(REPLY_PACING_RULE.includes('每条回复最多一个问句'));
});

test('探索开场接话点轮换避免重复，限制你猜与卖关子频次，偏晚切为无压力轻分享', async () => {
  let history = [];
  const picked = [];
  for (let i = 0; i < 7; i++) {
    const hook = pickShareHook(history, { now: BASE_TS + i * 3_600_000, night: false });
    if (picked.length >= 1) assert.notEqual(hook.style, picked.at(-1));
    if (picked.length >= 2) assert.notEqual(hook.style, picked.at(-2));
    picked.push(hook.style);
    history = recordShareHook(history, hook.style, BASE_TS + i * 3_600_000);
  }
  assert.ok(picked.filter((s) => s === 'guess').length <= 1);
  assert.ok(picked.filter((s) => s === 'tease').length <= 1);

  const nightHook = pickShareHook(history, { now: BASE_TS, night: true });
  assert.equal(nightHook.style, 'light_note');
  assert.match(nightHook.prompt, /不要带问句/);

  // 深度与轻量探索均把接话点注入 prompt 并记录 hookHistory
  const persona = { ok: true, text: '喜欢研究生活里的小机械和奇思妙想。' };
  let prev = null;
  for (const mode of ['deep', 'light']) {
    let seenPrompt = '';
    const res = await exploreRound({
      persona,
      previous: prev,
      exploreMode: mode,
      now: BASE_TS + (mode === 'light' ? 3_600_000 : 0),
      generate: async ({ prompt }) => {
        seenPrompt = prompt;
        return {
          ok: true,
          text: JSON.stringify(mode === 'light'
            ? { action: 'light', topic: '雨伞骨架', summary: '伞骨受力挺巧妙', share: '我今天居然研究了一下午雨伞骨架' }
            : { action: 'start', topic: '洗手池溢水孔', progress: '顺便兼顾进气', next: '看看虹吸', share: '我今天才搞明白洗手池小孔还有进气作用' }),
        };
      },
    });
    assert.equal(res.ok, true);
    assert.match(seenPrompt, /5 秒内能不能轻松回一句/);
    assert.ok(res.state.candidate?.hookStyle);
    assert.ok(Array.isArray(res.state.hookHistory) && res.state.hookHistory.length >= 1);
    prev = res.state;
  }
  assert.notEqual(prev.hookHistory[0].style, prev.hookHistory[1].style);

  const freshHook = pickShareHook([], { now: BASE_TS, night: false });
  assert.match(freshHook.prompt, /禁止套用.*你站哪派/);
  assert.match(freshHook.prompt, /你猜…随便猜一个/);
});
