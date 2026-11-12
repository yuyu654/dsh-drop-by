// no-brush-off.test.mjs —— 2026-11-08 她在抖音那边说的：
// 插件回了她中午发在抖音的消息，语气生硬（「虚拟不虚拟的另说」），后面又接一句另一个由头的话
// （「你先告诉我，中午那顿吃了没」）——回也没回好，聊也没聊好。
// 两件事：①主动由头里不许接她别的通道的话、更不许一句「另说」推开；②这种推开句直接判违规。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard, buildPrompt } from '../src/compose.js';

const cfgOf = (o = {}) => ({ content: { mode: 'llm', maxChars: 60, ...o } });
const topicOf = (slot) => ({ slot, label: slot, why: '', evidence: { since: '12:22', day: '2026-11-08', satMin: 488 }, brief: `由头 ${slot}`, at: Date.now() });
const ctxOf = (o = {}) => ({
  tz: 'Asia/Shanghai',
  clock: '20:30',
  presence: { idleSec: 0 },
  her: { lastTs: null, lastText: '大肥鱼那个是虚拟的吧', lastAgoSec: 28959, lastChannel: 'douyin' },
  me: { lastTs: null, lastText: '中午那顿吃了没', lastAgoSec: 3600 },
  fish: { ok: false },
  recent: [],
  ...o,
});

test('guard：把她说的事一句「另说」推开，直接判违规', () => {
  const g = guard('虚拟不虚拟的另说。你先告诉我，中午那顿吃了没。', cfgOf(), ctxOf());
  assert.equal(g.ok, false);
  assert.ok(g.violations.some((v) => v.code === 'BRUSH_OFF'));
});

test('guard：「扯远了」「回头再说」也算推开', () => {
  for (const t of ['扯远了，先喝口水吧。', '这事回头再说，你站起来走两步。']) {
    const g = guard(t, cfgOf(), ctxOf());
    assert.equal(g.ok, false, t);
    assert.ok(g.violations.some((v) => v.code === 'BRUSH_OFF'), t);
  }
});

test('prompt：主动由头里，她别通道的话只当背景，另加一条硬要求', () => {
  const p = buildPrompt({ ctx: ctxOf(), topic: topicOf('longSit'), persona: { text: '' }, cfg: cfgOf() });
  assert.match(p, /（今天早些时候，抖音）/);
  assert.match(p, /16\. 她最后一句是在别的通道/);
  assert.match(p, /只当背景/);
  assert.match(p, /别用「另说」推开/);
});

test('prompt：回复她那句（reply）时不加「只当背景」；noReply 问的是我发的那条，照样加', () => {
  // 2026-11-09 改：noReply 以前也被排除了，结果 20:43 那条把它当成「回她抖音那句」，
  // 在 QQ 上又把抖音已经答过的答案答了一遍。追问只问我发出去的那条，她那句只是背景。
  const r = buildPrompt({ ctx: ctxOf(), topic: topicOf('reply'), persona: { text: '' }, cfg: cfgOf() });
  assert.doesNotMatch(r, /16\. 她最后一句是在别的通道/);
  const n = buildPrompt({ ctx: ctxOf(), topic: topicOf('noReply'), persona: { text: '' }, cfg: cfgOf() });
  assert.match(n, /16\. 她最后一句是在别的通道/);
});

test('prompt：她的话来自 QQ 时也不算「别的通道」', () => {
  const p = buildPrompt({
    ctx: ctxOf({ her: { lastTs: null, lastText: '在', lastAgoSec: 300, lastChannel: 'qq' } }),
    topic: topicOf('longSit'), persona: { text: '' }, cfg: cfgOf(),
  });
  assert.doesNotMatch(p, /16\. 她最后一句是在别的通道/);
});