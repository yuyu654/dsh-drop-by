import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONS } from '../src/decision/decide.js';
import * as explanations from '../src/decision/explain.js';

test('每种决策都有中文解释，静默显示当前时段', () => {
  for (const reason of Object.keys(REASONS)) {
    const result = explanations.explainRun({ record: { reason } });
    assert.match(result.summary, /[\u4e00-\u9fff]/u, reason);
    assert.equal(typeof result.detail, 'string', reason);
    assert.equal(typeof result.actionHint, 'string', reason);
  }
  const quiet = explanations.explainRun({
    record: { reason: 'GLOBAL_QUIET', ts: Date.UTC(2026, 10, 21, 15) },
    cfg: { timezone: 'Asia/Shanghai', quietHours: [['12:00', '13:00'], ['22:30', '07:30']] },
  });
  assert.match(quiet.summary, /22:30–07:30/);
  assert.doesNotMatch(quiet.summary, /12:00/);
  assert.match(quiet.actionHint, /全局静默/);
});

test('无由头的解释合并过期的手机话题，给出下一步', () => {
  const result = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [
      { slot: 'sleep', reason: 'fish_stale' },
      { slot: 'steps', reason: 'fish_stale' },
      { slot: 'chitchat', reason: 'chitchat_budget' },
    ], phone: { stale: true, ageHours: 74, limitHours: 36 } },
  });
  assert.match(result.detail, /74 小时/);
  assert.match(result.detail, /睡眠、压力、步数、屏幕时间/);
  assert.match(result.detail, /随口话.*上限/);
  assert.match(result.actionHint, /邮箱/);
});

test('无由头的说明只展示具体原因，省略泛化的无数据由头', () => {
  const { detail } = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [
      { slot: 'reply', reason: 'no_data' },
      { slot: 'share', reason: 'no_data' },
      { slot: 'steps', reason: 'out_of_window' },
      { slot: 'stress', reason: 'cooldown' },
    ] },
  });
  assert.match(detail, /步数还没到适用时段/);
  assert.match(detail, /压力还在冷却中/);
  assert.doesNotMatch(detail, /没有可用的资料|回话|分享/);
});

test('无具体原因时用一句话概括日常未触发的话题', () => {
  const { detail } = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [
      { slot: 'reply', reason: 'no_data' },
      { slot: 'share', reason: 'no_data' },
      { slot: 'chitchat', reason: 'disabled' },
      { slot: 'sleep', reason: 'phone_disabled' },
    ] },
  });
  assert.equal(detail, '当前没有待回复消息、待提醒日程或新的可分享进展。');
});

test('探索分享被同主题冷却、反馈避开或未开分享开关拦下时，给出明确原因', async () => {
  const { topicCandidates } = await import('../src/decision/topics.js');
  const misses = new Map();
  const list = [...topicCandidates(
    { self: null, selfMiss: 'share_topic_cooldown', fish: { ok: false }, her: {}, me: {}, pc: {} },
    { content: { topics: {} }, timezone: 'Asia/Shanghai' },
    Date.now(),
    {},
    () => {},
    misses,
  )];
  assert.equal(list.length, 0);
  assert.equal(misses.get('share'), 'share_topic_cooldown');

  const cooldown = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [{ slot: 'share', reason: 'share_topic_cooldown' }] },
  });
  assert.match(cooldown.detail, /分享同一探索主题 6 小时内刚分享过/);

  const offerOff = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [{ slot: 'share', reason: 'share_offer_off' }] },
  });
  assert.match(offerOff.detail, /让探索进展参与主动分享/);
  assert.match(offerOff.actionHint, /自主探索/);

  const avoided = explanations.explainRun({
    record: { reason: 'NO_TOPIC', topicMisses: [{ slot: 'share', reason: 'share_avoided' }] },
  });
  assert.match(avoided.detail, /换个方向/);
});
