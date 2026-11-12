// answered-elsewhere.test.mjs —— 2026-11-09 20:43
// 她在抖音发了动画视频，值班鱼在抖音答过「注意力就是各查各的」；
// presence-gate 又把同一句答到了 QQ，她收到两遍：
// 「你刚给我回的消息，是关于我抖音分享给你的视频的，但是你在抖音已经回过我了」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/compose.js';
import { hasAnsweredOnOwnChannel } from '../src/context.js';
import { buildSnapshot } from '../src/snapshot.js';
import { judgePrompt } from '../src/judge.js';

const cfgOf = (o = {}) => ({ content: { mode: 'llm', maxChars: 60, ...o } });
const topicOf = (slot, evidence = {}) => ({ slot, label: slot, why: '', evidence, brief: `由头 ${slot}`, at: Date.now() });
const ctxOf = (her = {}) => ({
  tz: 'Asia/Shanghai',
  clock: '10:20',
  presence: { idleSec: 0 },
  her: { lastTs: null, lastText: '', lastAgoSec: 600, lastChannel: null, ...her },
  me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
  fish: { ok: false },
  recent: [],
});
const noReplyOf = () => topicOf('noReply', {
  channel: 'douyin',
  kind: 'text',
  text: '给大肥鱼换了个有感情的声音（实操）',
  silenceMin: 162,
});

test('她那条在抖音已回过：QQ 的 prompt 不再把它当素材，也不许再答一遍', () => {
  const p = buildPrompt({
    ctx: ctxOf({
      lastText: '一个动画搞懂AI大模型工作原理 从词向量到Transformer',
      lastChannel: 'douyin',
      lastAgoSec: 6800,
      answeredOnOwnChannel: true,
    }),
    topic: noReplyOf(),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.doesNotMatch(p, /她最后一条/);
  assert.match(p, /已经在它自己的通道（抖音\/主会话）里回过我了/);
  assert.match(p, /别再答一遍/);
});

test('她那条没在抖音回过：照常给事实，不加第 19 条', () => {
  const p = buildPrompt({
    ctx: ctxOf({
      lastText: '一个动画搞懂AI大模型工作原理',
      lastChannel: 'douyin',
      lastAgoSec: 6800,
      answeredOnOwnChannel: false,
    }),
    topic: noReplyOf(),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /她最后一条：「一个动画搞懂AI大模型工作原理」/);
  assert.doesNotMatch(p, /已经在它自己的通道（抖音\/主会话）里回过我了/);
});

test('noReply 也把她别的通道那句当背景：只问自己发的那条', () => {
  const p = buildPrompt({
    ctx: ctxOf({
      lastText: '一个动画搞懂AI大模型工作原理',
      lastChannel: 'douyin',
      lastAgoSec: 6800,
      answeredOnOwnChannel: false,
    }),
    topic: noReplyOf(),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /16\. 她最后一句是在别的通道（抖音\/主会话）说的，不是这条要回的话/);
  assert.match(p, /我给她发了一条：「给大肥鱼换了个有感情的声音/);
});

test('hasAnsweredOnOwnChannel：只认同一个通道里的回话', () => {
  const her = { channel: 'douyin', ts: 1000 };
  assert.equal(hasAnsweredOnOwnChannel(her, [{ channel: 'douyin', ts: 1600 }]), true);
  assert.equal(hasAnsweredOnOwnChannel(her, [{ channel: 'qq', ts: 1600 }]), false, 'QQ 里说过话不等于在抖音回过');
  assert.equal(hasAnsweredOnOwnChannel(her, [{ channel: 'douyin', ts: 900 }]), false, '比她那句还早的不算回');
  assert.equal(hasAnsweredOnOwnChannel({ channel: null, ts: 1000 }, [{ channel: 'douyin', ts: 1600 }]), false);
  assert.equal(hasAnsweredOnOwnChannel(her, null), false);
});

test('快照：回过的那句标出来，judge 也不许再拿它当这一拍的事', () => {
  const now = 1_700_000_000_000;
  const snap = buildSnapshot({
    cfg: {},
    now,
    tz: 'Asia/Shanghai',
    ctx: {
      her: { lastTs: now - 600_000, lastText: '一个动画搞懂AI大模型工作原理', lastAgoSec: 600, lastChannel: 'douyin', answeredOnOwnChannel: true },
      me: { lastTs: now - 500_000, lastText: '注意力就是各查各的', lastAgoSec: 500 },
    },
  });
  assert.match(snap, /我已经在那边回过了——别再答一遍/);
  assert.match(judgePrompt({ snapshot: snap, persona: { text: '' } }), /标着「我已经在那边回过了」/);
});

test('快照：没回过的照旧只带通道，不加那句提醒', () => {
  const now = 1_700_000_000_000;
  const snap = buildSnapshot({
    cfg: {},
    now,
    tz: 'Asia/Shanghai',
    ctx: {
      her: { lastTs: now - 600_000, lastText: '一个动画搞懂AI大模型工作原理', lastAgoSec: 600, lastChannel: 'douyin', answeredOnOwnChannel: false },
      me: { lastTs: null, lastText: '', lastAgoSec: null },
    },
  });
  assert.match(snap, /，抖音）/);
  assert.doesNotMatch(snap, /我已经在那边回过了/);
});