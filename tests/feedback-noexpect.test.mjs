// feedback-noexpect.test.mjs —— 「回她 / 接转发」不该进接住率。
//
// 她的原话：我每句话都会回，她不会一直回下去，那我最后一句不管是什么
// 都会被记成「没接住」——是的，以前就是这样：回完一句她去看别的，
// 这条 pending 过了窗口判 miss，reply 那一类的接住率被自己拖低，
// 还会被 pendingFromFeedback 当成「我发过去、她一直没回」，追一句「你怎么不回」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSent, settle, sweep, slotStats, coldSlots } from '../src/feedback.js';
import { pendingFromFeedback } from '../src/noreply.js';

const MIN = 60_000;
const HOUR = 3_600_000;
// 北京时间 12:00：窗口完整落在白天，以前这种一定会被判 miss
const T0 = Date.UTC(2026, 10, 4, 4, 0);
const cfg = { content: { topics: { noReplyMin: 120 } } };

test('回她的话不算「没接住」：窗口过了也不判 miss、不进分母', () => {
  const st = {};
  noteSent(st, 'reply', T0, '行。卡住了就叫我。');
  sweep(st, T0 + 5 * HOUR, { tz: 'Asia/Shanghai' });
  const s = slotStats(st).reply;
  assert.ok(!s || s.sent === 0, `回话不该进 sent，实际 ${s && s.sent}`);
  assert.ok(!s || s.missed === 0);
  assert.equal(st.feedback.streak, 0);
});

test('回她的话不会被当成「我发过去她一直没回」的追问由头', () => {
  const st = {};
  noteSent(st, 'reply', T0, '行。');
  assert.equal(pendingFromFeedback(st, cfg, T0 + 200 * MIN), null);
});

test('主动由头照旧算账（别把整本账一起关掉）', () => {
  const st = {};
  noteSent(st, 'share', T0, '我想到一个事。');
  assert.equal(pendingFromFeedback(st, cfg, T0 + 200 * MIN), null, '分享默认不追，但仍记录反馈');
  sweep(st, T0 + 5 * HOUR, { tz: 'Asia/Shanghai' });
  assert.equal(slotStats(st).share.sent, 1);
  assert.equal(slotStats(st).share.missed, 1);
  assert.equal(st.feedback.streak, 1);
});

test('她接了回话：只留一对看回话，不记接住也不记没接住', () => {
  const st = {};
  noteSent(st, 'reply', T0, '别硬撑。');
  settle(st, T0 + 6 * MIN, T0 + 6 * MIN, '知道啦。');
  const s = slotStats(st).reply;
  assert.ok(!s || (s.sent === 0 && s.replied === 0));
  const pairs = st.feedback.slots.reply?.pairs || [];
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].myDraft, '别硬撑。');
  assert.equal(pairs[0].herReply, '知道啦。');
});

test('回话类永远不会被压冷（压冷了等于她说话我不回）', () => {
  const st = {};
  const c = { rules: { feedback: { enabled: true, coldAfter: 1, coldRate: 0.99, coldDays: 2 } } };
  for (let i = 0; i < 5; i += 1) noteSent(st, 'reply', T0 + i * HOUR, '嗯。');
  assert.equal(coldSlots(st, c, T0 + 6 * HOUR).has('reply'), false);
});
