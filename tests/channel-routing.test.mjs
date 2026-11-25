// channel-routing.test.mjs —— 「哪来哪回」
//
// 为什么要有这条：插件只有 QQ 一条发送路。她在抖音/主会话说的话，
// 如果被 reply 由头捡起来发到 QQ，她收到的是一句和上下文对不上的话
// （2026-11-07 她问「抖音通道接上会不会和 QQ 冲突」，当场批准加这道闸）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerableOn } from '../src/decision/topics.js';
import { REASONS } from '../src/decision/decide.js';

test('哪来哪回：她 QQ 上说的，reply/forward 都能回', () => {
  assert.equal(answerableOn('reply', 'qq'), true);
  assert.equal(answerableOn('forward', 'qq'), true);
});

test('哪来哪回：抖音/主会话说的话，不从 QQ 追着回', () => {
  assert.equal(answerableOn('reply', 'douyin'), false);
  assert.equal(answerableOn('forward', 'douyin'), false);
  assert.equal(answerableOn('reply', 'main'), false);
});

test('哪来哪回：通道未知（老记录）照旧放行，别因为加闸吞掉回应', () => {
  assert.equal(answerableOn('reply', null), true);
  assert.equal(answerableOn('reply', undefined), true);
  assert.equal(answerableOn('reply', ''), true);
});

test('哪来哪回：别的由头跟通道无关，一律照旧', () => {
  for (const slot of ['share', 'catchup', 'noReply', 'examSoon', 'chitchat', 'fish']) {
    assert.equal(answerableOn(slot, 'douyin'), true, `${slot} 不该被通道闸拦住`);
  }
});

test('哪来哪回：以后有第二个发送通道时能换，不是写死 qq', () => {
  assert.equal(answerableOn('reply', 'douyin', 'douyin'), true);
  assert.equal(answerableOn('reply', 'qq', 'douyin'), false);
});

test('拦下时 reason 有解释文案', () => {
  assert.equal(typeof REASONS.REPLY_ON_OTHER_CHANNEL, 'string');
  assert.match(REASONS.REPLY_ON_OTHER_CHANNEL, /通道/);
});