// feedback.test.mjs —— 反馈闭环：发出去她接没接，接不住的那类怎么被压下来。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  noteSent,
  settle,
  slotStats,
  coldSlots,
  adaptiveExtraMin,
  feedbackSummary,
} from '../src/decision/feedback.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 4, 12, 0);

const stOf = () => ({});

test('发一条、她接着回了：算接住，延迟记下来，连败清零', () => {
  const st = stOf();
  noteSent(st, 'sleep', T0, '睡了五个小时，别硬撑。');
  assert.equal(st.feedback.pending.length, 1);
  assert.equal(st.feedback.streak, 1);
  const n = settle(st, T0 + 8 * MIN, T0 + 9 * MIN);
  assert.equal(n, 1);
  const s = slotStats(st).sleep;
  assert.equal(s.sent, 1);
  assert.equal(s.replied, 1);
  assert.equal(s.rate, 1);
  assert.equal(s.avgLatMin, 8);
  assert.equal(st.feedback.streak, 0);
});

test('她先说的话不算「接住」后来的那条', () => {
  const st = stOf();
  noteSent(st, 'longSit', T0, '坐了三个小时了。');
  settle(st, T0 - 5 * MIN, T0);
  assert.equal(slotStats(st).longSit.replied, 0);
  assert.equal(st.feedback.streak, 1);
});

test('超过一天还没回：不再等，但也不算接住', () => {
  const st = stOf();
  noteSent(st, 'steps', T0, '今天才两千步。');
  settle(st, 0, T0 + 25 * HOUR);
  assert.equal(st.feedback.pending.length, 0);
  assert.equal(slotStats(st).steps.replied, 0);
});

test('同一类发够冷启动次数还接不住 → 先试一次，然后压几天', () => {
  const st = stOf();
  const cfg = { rules: { feedback: { enabled: true, coldAfter: 3, coldRate: 0.5, coldDays: 2 } } };
  for (let i = 0; i < 3; i += 1) noteSent(st, 'lateUp', T0 + i * HOUR, '还不睡？');
  // 第一次判定：让它再试一次（只登记观察期，不拦）
  assert.equal(coldSlots(st, cfg, T0 + 3 * HOUR).has('lateUp'), false);
  // 第二次判定：观察期内仍不达标 → 真的压住
  assert.equal(coldSlots(st, cfg, T0 + 4 * HOUR).has('lateUp'), true);
  // 压着的这段时间里一直压
  assert.equal(coldSlots(st, cfg, T0 + 30 * HOUR).has('lateUp'), true);
});

test('接住率回来就解冻，不用等压满', () => {
  const st = stOf();
  const cfg = { rules: { feedback: { enabled: true, coldAfter: 2, coldRate: 0.5, coldDays: 3 } } };
  noteSent(st, 'screen', T0, '今天屏幕太久了。');
  noteSent(st, 'screen', T0 + HOUR, '眼睛不疼？');
  coldSlots(st, cfg, T0 + 2 * HOUR); // 登记观察期
  assert.equal(coldSlots(st, cfg, T0 + 3 * HOUR).has('screen'), true);
  settle(st, T0 + 4 * HOUR, T0 + 4 * HOUR); // 她回了两条
  assert.equal(coldSlots(st, cfg, T0 + 5 * HOUR).has('screen'), false);
});

test('关掉开关就一条都不压', () => {
  const st = stOf();
  const cfg = { rules: { feedback: { enabled: false, coldAfter: 1, coldRate: 1 } } };
  noteSent(st, 'share', T0, 'x');
  assert.equal(coldSlots(st, cfg, T0).size, 0);
});

test('连着没回就自己少说点：连续性越高多等的越多，最多三倍', () => {
  const st = stOf();
  const cfg = { rules: { minGapMin: 240 } };
  assert.equal(adaptiveExtraMin(st, cfg), 0);
  noteSent(st, 'sleep', T0, 'x');
  assert.equal(adaptiveExtraMin(st, cfg), 0); // 只一条，不算连败
  noteSent(st, 'screen', T0 + HOUR, 'x');
  assert.equal(adaptiveExtraMin(st, cfg), 120); // 两条 → 1.5 倍
  noteSent(st, 'steps', T0 + 2 * HOUR, 'x');
  assert.equal(adaptiveExtraMin(st, cfg), 240); // 三条 → 2 倍
  for (let i = 0; i < 20; i += 1) noteSent(st, 'share', T0 + (3 + i) * HOUR, 'x');
  assert.equal(adaptiveExtraMin(st, cfg), 480); // 顶到 3 倍
  assert.equal(adaptiveExtraMin(st, { rules: { minGapMin: 240, adaptiveGap: false } }), 0);
});

test('summary：没有记录时说「还没发过」，有记录时按次数排', () => {
  const st = stOf();
  assert.equal(feedbackSummary(st, {}).text, '还没发过');
  noteSent(st, 'sleep', T0, 'x');
  noteSent(st, 'sleep', T0 + HOUR, 'x');
  noteSent(st, 'steps', T0 + 2 * HOUR, 'x');
  settle(st, T0 + 3 * HOUR, T0 + 3 * HOUR);
  // 她这一句之后又发了一条、这次没人应：连败从头算
  noteSent(st, 'catchup', T0 + 5 * HOUR, 'x');
  const sum = feedbackSummary(st, { rules: { minGapMin: 240 } });
  assert.match(sum.text, /sleep 2\/2/);
  assert.match(sum.text, /steps 1\/1/);
  assert.equal(sum.streak, 1);
});