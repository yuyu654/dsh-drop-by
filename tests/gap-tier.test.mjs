// gap-tier.test.mjs —— 阶段 1：间隔分档 + 「人不在」降级为信号。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, checkTierGap, tierGapMs } from '../src/decide.js';
import { SLOTS, tierOfSlot } from '../src/topics.js';
import { buildSnapshot } from '../src/snapshot.js';

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const cfg = (over = {}) => ({
  enabled: true,
  ...over,
  rules: {
    replyCooldownMin: 5,
    minGapMin: 240,
    dailyCap: 3,
    ...(over.rules || {}),
  },
  idle: { onlineSec: 30, awaySec: 600, ...(over.idle || {}) },
});

const tiered = (over = {}) =>
  cfg({
    ...over,
    rules: {
      gapByTier: { enabled: true, replyMin: 5, eventMin: 60, chatMin: 240 },
      judge: { enabled: true },
      presenceSignal: { enabled: true },
      ...(over.rules || {}),
    },
  });

test('分档映射表完整：每个由头恰好一档', () => {
  const tiers = new Set(['reply', 'event', 'chat']);
  for (const slot of Object.keys(SLOTS)) {
    assert.ok(tiers.has(SLOTS[slot].tier), `${slot} 没有合法分档`);
    assert.equal(tierOfSlot(slot), SLOTS[slot].tier);
  }
  assert.equal(tierOfSlot('没登记的'), 'chat');
  assert.equal(SLOTS.reply.tier, 'reply');
  assert.equal(SLOTS.backHome.tier, 'event');
  assert.equal(SLOTS.sleep.tier, 'chat');
});

test('同档：事件档 30 分钟前发过，不够 60 分钟', () => {
  const g = checkTierGap({ cfg: tiered(), now: NOW, tier: 'event', lastByTier: { event: NOW - 30 * MIN }, lastSendTs: NOW - 30 * MIN });
  assert.equal(g.ok, false);
  assert.equal(g.needMin, 60);
  assert.equal(g.sinceMin, 30);
});

test('同档：事件档 61 分钟前发过 → 放行', () => {
  const g = checkTierGap({ cfg: tiered(), now: NOW, tier: 'event', lastByTier: { event: NOW - 61 * MIN }, lastSendTs: NOW - 61 * MIN });
  assert.equal(g.ok, true);
});

test('跨档：chat 的 240 分钟不压 event，只兜 replyMin 全局地板', () => {
  const g = checkTierGap({
    cfg: tiered(),
    now: NOW,
    tier: 'event',
    lastByTier: { chat: NOW - 10 * MIN }, // 同档 event 从没发过
    lastSendTs: NOW - 10 * MIN, // 距最近任何一条 10 分钟
  });
  assert.equal(g.ok, true);
});

test('跨档：距最近任何一条不足 replyMin（5 分钟）→ 拦', () => {
  const g = checkTierGap({ cfg: tiered(), now: NOW, tier: 'event', lastByTier: {}, lastSendTs: NOW - 2 * MIN });
  assert.equal(g.ok, false);
  assert.equal(g.sinceAnyMin, 2);
});

test('分档关着时 checkTierGap 不改变行为', () => {
  const g = checkTierGap({ cfg: cfg(), now: NOW, tier: 'chat', lastByTier: {}, lastSendTs: NOW - 1 * MIN });
  assert.equal(g.ok, true);
  assert.equal(tierGapMs(cfg(), 'chat'), 240 * MIN);
});

test('decide：分档开着时全局限用 replyMin，不再用 240 一刀切', () => {
  const d = decide({
    cfg: tiered(),
    now: NOW,
    idleSec: 10,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 8 * 60 * MIN, // 早就回过
    lastSendTs: NOW - 10 * MIN,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.decision, 'send');
});

test('人不在：presenceSignal 开着且 judge 开着 → 不再拦（降级为信号）', () => {
  const d = decide({
    cfg: tiered(),
    now: NOW,
    idleSec: 4000,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 8 * 60 * MIN,
    lastSendTs: NOW - 7 * 60 * MIN,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.decision, 'send');
  assert.equal(d.away, true);
  assert.equal(d.presenceSignal, true);
});

test('人不在：开启 requirePcOnline 且 presenceSignal 开着但 judge 关着 → 仍是硬拦', () => {
  const d = decide({
    cfg: tiered({ rules: { requirePcOnline: true, judge: { enabled: false } } }),
    now: NOW,
    idleSec: 4000,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 8 * 60 * MIN,
    lastSendTs: NOW - 7 * 60 * MIN,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.reason, 'AWAY');
});

test('人不在：开启 requirePcOnline 且 presenceSignal 关着 → 硬拦（单机模式）', () => {
  const d = decide({
    cfg: tiered({ rules: { requirePcOnline: true, presenceSignal: { enabled: false } } }),
    now: NOW,
    idleSec: 4000,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 8 * 60 * MIN,
    lastSendTs: NOW - 7 * 60 * MIN,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.reason, 'AWAY');
});

test('人不在：多端默认（requirePcOnline=false）即使 presenceSignal 关着也能主动找', () => {
  const d = decide({
    cfg: tiered({ rules: { presenceSignal: { enabled: false } } }),
    now: NOW,
    idleSec: 4000,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 8 * 60 * MIN,
    lastSendTs: NOW - 7 * 60 * MIN,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.decision, 'send');
  assert.equal(d.away, true);
});

test('回复轨道不看电脑空不空（人拿手机发的话照样回）', () => {
  const d = decide({
    cfg: tiered(),
    now: NOW,
    idleSec: 4000,
    quiet: false,
    busy: false,
    lastUserTs: NOW - 10 * MIN,
    lastSendTs: null,
    todaySent: 0,
    allDown: false,
  });
  assert.equal(d.track, 'reply');
  assert.equal(d.decision, 'send');
  assert.equal(d.away, true);
});

test('快照：电脑暂无动静时写清多端可达，不按失联处理', () => {
  const text = buildSnapshot({
    cfg: tiered(),
    now: NOW,
    tz: 'Asia/Shanghai',
    ctx: {
      presence: { idleSec: 2400 },
      her: { lastAgoSec: 2 * 3600, lastText: '嗯', lastChannel: 'qq' },
      me: {},
    },
  });
  assert.match(text, /她的在场：电脑端暂无动静（40 分钟没碰电脑）/);
  assert.match(text, /QQ \/ 抖音在手机端随时可达/);
  assert.match(text, /不在电脑前不等于不在/);
  assert.doesNotMatch(text, /手机情况未知/);
});

test('快照：她刚说过话时写「可能在」，不写不在', () => {
  const text = buildSnapshot({
    cfg: tiered(),
    now: NOW,
    tz: 'Asia/Shanghai',
    ctx: {
      presence: { idleSec: 2400 },
      her: { lastAgoSec: 12 * 60, lastText: '在', lastChannel: 'qq' },
      me: {},
    },
  });
  assert.match(text, /在手机上说过话（可能在）/);
  assert.doesNotMatch(text, /电脑判定不在/);
});

test('快照：presenceSignal 关着时整段不出现（0.13 快照）', () => {
  const text = buildSnapshot({
    cfg: cfg(),
    now: NOW,
    tz: 'Asia/Shanghai',
    ctx: { presence: { idleSec: 2400 }, her: { lastAgoSec: 2 * 3600 }, me: {} },
  });
  assert.doesNotMatch(text, /她的在场/);
});