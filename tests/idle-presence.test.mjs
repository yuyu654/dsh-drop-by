// idle-presence.test.mjs —— 2026-11-08 她说的：做完任务就刷手机去了，
// 前台看着还是 WorkBuddy，人其实不在。所以「在干什么」不能只靠前台窗口，
// 得看她最后一次碰键鼠有多久；人不在就整条不给，免得写成「你在写代码吧」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/compose.js';

const cfgOf = (idle = {}) => ({ content: { mode: 'llm', maxChars: 60 }, idle });
const topicOf = (slot, evidence = {}) => ({ slot, label: slot, why: '', evidence, brief: `由头 ${slot}`, at: Date.now() });
const ctxOf = (o = {}) => ({
  tz: 'Asia/Shanghai',
  clock: '11:46',
  presence: { idleSec: 0 },
  her: { lastTs: null, lastText: '', lastAgoSec: 600 },
  me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
  fish: { ok: false },
  recent: [],
  ...o,
});
const coding = { kind: 'coding', speaking: false, fgTitle: 'WorkBuddy', fgName: 'workbuddy.exe' };

function prompt({ idleSec, activity = coding, idle } = {}) {
  return buildPrompt({
    ctx: ctxOf({ presence: { idleSec }, activity }),
    topic: topicOf('share'),
    persona: { text: '' },
    cfg: cfgOf(idle),
  });
}

test('人不在电脑前：键鼠空闲超过阈值就不说「在写代码」', () => {
  const p = prompt({ idleSec: 3000 });
  assert.match(p, /人不在电脑前/);
  assert.doesNotMatch(p, /在写代码/);
  assert.doesNotMatch(p, /她电脑前：/);
});

test('人在电脑前：空闲很短，照旧说她这会儿在干什么', () => {
  const p = prompt({ idleSec: 20 });
  assert.match(p, /在写代码/);
  assert.doesNotMatch(p, /人不在电脑前/);
});

test('阈值跟 idle.awaySec 走：设得比空闲长就仍算在电脑前', () => {
  const p = prompt({ idleSec: 700, idle: { awaySec: 1800 } });
  assert.match(p, /在写代码/);
  assert.doesNotMatch(p, /人不在电脑前/);
});

test('阈值没有隐藏下限：awaySec 设 60，空闲 170 秒就算走了', () => {
  const p = prompt({ idleSec: 170, idle: { awaySec: 60 } });
  assert.match(p, /人不在电脑前/);
  assert.doesNotMatch(p, /在写代码/);
});