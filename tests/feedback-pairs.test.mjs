// feedback-pairs.test.mjs —— 阶段 2：她的原话配对（我发出去什么 → 她怎么回）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFeedback, noteSent, settle, recentPairs } from '../src/decision/feedback.js';
import { buildSnapshot } from '../src/decision/snapshot.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = 1_700_000_000_000;
const st = () => ({ feedback: emptyFeedback() });

test('noteSent 记下原文前 80 字', () => {
  const s = st();
  noteSent(s, 'sleep', NOW, 'x'.repeat(120));
  assert.equal(s.feedback.pending.length, 1);
  assert.equal(s.feedback.pending[0].draft.length, 80);
});

test('settle 把话配到对应的那条 pending 上', () => {
  const s = st();
  noteSent(s, 'sleep', NOW, '昨晚睡得还好吗');
  settle(s, NOW + 3 * HOUR, NOW + 3 * HOUR, '还行');
  const pairs = recentPairs(s, 'sleep');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].myDraft, '昨晚睡得还好吗');
  assert.equal(pairs[0].herReply, '还行');
  assert.equal(pairs[0].latencyMin, 180);
});

test('配对按时间顺序归属：只配比她这句话更早的 pending', () => {
  const s = st();
  noteSent(s, 'sleep', NOW, '早的那条');
  noteSent(s, 'steps', NOW + 10 * MIN, '晚的那条');
  settle(s, NOW + 20 * MIN, NOW + 20 * MIN, '嗯');
  assert.equal(recentPairs(s, 'sleep').length, 1);
  assert.equal(recentPairs(s, 'steps').length, 1);
  assert.equal(recentPairs(s, 'sleep')[0].herReply, '嗯');
});

test('环形队列最多留 10 对，新的在后', () => {
  const s = st();
  for (let i = 0; i < 12; i += 1) {
    noteSent(s, 'sleep', NOW + i * HOUR, `第 ${i} 条`);
    settle(s, NOW + i * HOUR + 5 * MIN, NOW + i * HOUR + 5 * MIN, `回 ${i}`);
  }
  const pairs = s.feedback.slots.sleep.pairs;
  assert.equal(pairs.length, 10);
  assert.equal(pairs[0].myDraft, '第 2 条');
  assert.equal(pairs[9].myDraft, '第 11 条');
});

test('超过一天没回的 pending 被丢掉，但已有 pairs 不受影响', () => {
  const s = st();
  noteSent(s, 'sleep', NOW, '配上的那条');
  settle(s, NOW + HOUR, NOW + HOUR, '接了');
  assert.equal(s.feedback.slots.sleep.pairs.length, 1);
  noteSent(s, 'sleep', NOW + 2 * HOUR, '没人应的那条');
  settle(s, NOW + 3 * 24 * HOUR, NOW + 3 * 24 * HOUR, '');
  assert.equal(s.feedback.pending.length, 0);
  assert.equal(s.feedback.slots.sleep.pairs.length, 1);
});

test('旧 pending（没有 draft）不产生空配对', () => {
  const s = st();
  s.feedback.pending.push({ slot: 'sleep', ts: NOW - HOUR, chars: 4 });
  settle(s, NOW, NOW, '在');
  assert.equal(s.feedback.slots.sleep?.pairs?.length || 0, 0);
});

test('快照：有配对时写「我说了什么 → 她怎么回」', () => {
  const s = st();
  noteSent(s, 'sleep', NOW - 4 * HOUR, '昨晚睡得还好吗');
  settle(s, NOW, NOW, '还行');
  const text = buildSnapshot({ cfg: {}, now: NOW, tz: 'Asia/Shanghai', ctx: { her: {}, me: {} }, st: s });
  assert.match(text, /你最近的对话配对/);
  assert.match(text, /拿睡眠说事：「昨晚睡得还好吗」→ 她过了 4 小时回「还行」\n/);
});

test('快照：马上接住带「接住了」', () => {
  const s = st();
  noteSent(s, 'forward', NOW - 30_000, '看了，那个猫也太……');
  settle(s, NOW, NOW, '哈哈哈哈');
  const text = buildSnapshot({ cfg: {}, now: NOW, tz: 'Asia/Shanghai', ctx: { her: {}, me: {} }, st: s });
  assert.match(text, /她马上回「哈哈哈哈」（接住了）/);
});

test('快照：pair 都没有时整段省略', () => {
  const text = buildSnapshot({ cfg: {}, now: NOW, tz: 'Asia/Shanghai', ctx: { her: {}, me: {} }, st: st() });
  assert.doesNotMatch(text, /你最近的对话配对/);
});