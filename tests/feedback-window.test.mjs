// feedback-window.test.mjs —— 接没接的判定：一条消息一生只判一次。
// 45 分钟内算接住；4 小时窗口（碰到 23:30 截断）内算晚回；超过窗口才算「隔了很久」；
// 只有整段窗口都在白天、她一句没说，才算一次没接住。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFeedback, noteSent, settle, sweep, classify, windowEnd, slotStats, recentPairs } from '../src/feedback.js';
import { buildSnapshot } from '../src/snapshot.js';

// 2026-11-04（周三）北京时间 h:m
const at = (h, m = 0, day = 4) => Date.UTC(2026, 10, day, h - 8, m);
const tz = 'Asia/Shanghai';
const MIN = 60_000;
const st = () => ({ feedback: emptyFeedback() });

test('45 分钟内回：hit', () => {
  const r = classify({ ts: at(10, 0) }, at(10, 20), tz);
  assert.deepEqual(r, { kind: 'hit', latMin: 20 });
});

test('45 分钟到窗口结束：late', () => {
  const r = classify({ ts: at(10, 0) }, at(12, 30), tz);
  assert.equal(r.kind, 'late');
  assert.equal(r.latMin, 150);
});

test('超过 4 小时窗口：stray，仍然算她回过', () => {
  const s = st();
  noteSent(s, 'sleep', at(10, 0), '昨晚睡得怎么样');
  settle(s, at(16, 0), at(16, 1), '还行', { tz });
  const v = slotStats(s).sleep;
  assert.equal(v.replied, 1);
  assert.equal(v.sent, 1);
  assert.equal(v.missed, 0);
  assert.equal(recentPairs(s, 'sleep')[0].kind, 'stray');
});

test('晚上发、第二天早上回：stray，不判没接住', () => {
  const r = classify({ ts: at(21, 0) }, at(8, 0, 5), tz);
  assert.equal(r.kind, 'stray');
  assert.equal(windowEnd(at(21, 0), tz), at(23, 30));
});

test('白天发、到窗口结束还没有人说话：判一次 miss', () => {
  const s = st();
  noteSent(s, 'steps', at(10, 0), '今天才两千步');
  sweep(s, at(13, 0), { tz, canJudge: true }); // 窗口还没过，不动
  assert.equal(s.feedback.pending.length, 1);
  assert.equal(slotStats(s).steps.missed, 0);
  sweep(s, at(15, 0), { tz, canJudge: true });
  const v = slotStats(s).steps;
  assert.equal(v.missed, 1);
  assert.equal(v.replied, 0);
  assert.equal(v.sent, 1);
  assert.equal(s.feedback.pending.length, 0);
});

test('miss 只判一次，之后再扫也不会重复计数', () => {
  const s = st();
  noteSent(s, 'steps', at(10, 0), 'x');
  sweep(s, at(15, 0), { tz, canJudge: true });
  sweep(s, at(16, 0), { tz, canJudge: true });
  assert.equal(slotStats(s).steps.missed, 1);
});

test('夜里发的、窗口跨进夜里：直接不算数，不进分母也不记 miss', () => {
  const s = st();
  noteSent(s, 'lateUp', at(21, 0), '还不睡？');
  sweep(s, at(23, 40), { tz, canJudge: false }); // 静默期，不判
  assert.equal(s.feedback.pending.length, 1);
  sweep(s, at(9, 0, 5), { tz, canJudge: true });
  const v = slotStats(s).lateUp;
  assert.equal(v.sent, 0);
  assert.equal(v.missed, 0);
  assert.equal(s.feedback.pending.length, 0);
});

test('看不清的时候（通道全断）只挂着不判', () => {
  const s = st();
  noteSent(s, 'sleep', at(10, 0), 'x');
  sweep(s, at(15, 0), { tz, canJudge: false });
  assert.equal(s.feedback.pending.length, 1);
  assert.equal(slotStats(s).sleep.sent, 1);
  assert.equal(slotStats(s).sleep.missed, 0);
});

test('超过一天才回：不算这段对话，从分母里去掉', () => {
  const s = st();
  noteSent(s, 'share', at(10, 0), 'x');
  settle(s, at(12, 0, 5), at(12, 0, 5), '嗯', { tz });
  assert.equal(slotStats(s).share.sent, 0);
  assert.equal(slotStats(s).share.replied, 0);
  assert.equal(s.feedback.pending.length, 0);
});

test('miss 不清连败，晚回才清', () => {
  const s = st();
  noteSent(s, 'steps', at(10, 0), 'x');
  sweep(s, at(15, 0), { tz, canJudge: true });
  assert.equal(s.feedback.streak, 1);
  noteSent(s, 'steps', at(16, 0), 'y');
  settle(s, at(16, 10), at(16, 10), '嗯', { tz });
  assert.equal(s.feedback.streak, 0);
});

test('快照：接住 / 晚回 / 隔很久，三种标签不混', () => {
  const s = st();
  noteSent(s, 'forward', at(9, 0), '看了，那个猫也太……');
  settle(s, at(9, 2), at(9, 2), '哈哈哈哈', { tz });
  noteSent(s, 'sleep', at(9, 30), '昨晚睡得怎么样');
  settle(s, at(12, 30), at(12, 30), '还行', { tz });
  noteSent(s, 'steps', at(13, 0), '今天才两千步');
  settle(s, at(18, 0), at(18, 0), '懒得动', { tz });
  const text = buildSnapshot({ cfg: {}, now: at(18, 5), tz, ctx: { her: {}, me: {} }, st: s });
  assert.match(text, /那个猫也太……」→ 她过了 2 分钟回「哈哈哈哈」（接住了）/);
  assert.match(text, /昨晚睡得怎么样」→ 她过了 3 小时回「还行」\n/);
  assert.match(text, /今天才两千步」→ 她过了 5 小时回「懒得动」（隔了很久才回）/);
});