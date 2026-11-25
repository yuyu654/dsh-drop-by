// decide.test.mjs —— 判定纯函数。重点验证「全局静默压在所有轨道之上」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../src/decision/decide.js';

const cfg = (over = {}) => ({
  enabled: true,
  ...over,
  rules: { replyCooldownMin: 5, minGapMin: 240, dailyCap: 3, ...(over.rules || {}) },
  idle: { onlineSec: 30, awaySec: 600, ...(over.idle || {}) },
});

const NOW = 1_700_000_000_000;
const base = {
  cfg: cfg(),
  now: NOW,
  idleSec: 10,
  quiet: false,
  lastUserTs: NOW - 30 * 60_000, // 半小时前她说过
  lastUserChannel: 'qq',
  lastSendTs: null,
  todaySent: 0,
  allDown: false,
};

test('静默里即使有未回消息也不发（回复轨道同样被压住）', () => {
  const d = decide({ ...base, quiet: true });
  assert.equal(d.decision, 'skip');
  assert.equal(d.reason, 'GLOBAL_QUIET');
  assert.equal(d.track, null);
});

test('静默优先级高于「人不在」和「配额满了」', () => {
  const d = decide({ ...base, quiet: true, idleSec: 9999, todaySent: 99 });
  assert.equal(d.reason, 'GLOBAL_QUIET');
});

test('总开关关着时先说总开关，不说静默', () => {
  const d = decide({ ...base, quiet: true, cfg: cfg({ enabled: false }) });
  assert.equal(d.reason, 'PLUGIN_DISABLED');
});

test('不静默时，未回的消息照旧走回复轨道', () => {
  const d = decide({ ...base, quiet: false });
  assert.equal(d.decision, 'send');
  assert.equal(d.track, 'reply');
  assert.equal(d.reason, 'SEND');
});

test('所有通道都跳过（读到空）→ DATA_UNAVAILABLE', () => {
  const d = decide({ ...base, allDown: true, lastUserTs: null, lastSendTs: NOW - 10 * 3_600_000 });
  assert.equal(d.reason, 'DATA_UNAVAILABLE');
});

test('主动轨道：间隔不够 / 配额满了 两个老闸没坏', () => {
  const gap = decide({ ...base, lastUserTs: null, lastSendTs: NOW - 60 * 60_000 });
  assert.equal(gap.reason, 'GAP_TOO_SHORT');

  const cap = decide({ ...base, lastUserTs: null, todaySent: 3 });
  assert.equal(cap.reason, 'DAILY_CAP');
});

test('主动轨道：多端默认下人不在电脑前或锁屏也允许主动找 → SEND', () => {
  const idle = decide({ ...base, lastUserTs: null, idleSec: 1200 });
  assert.equal(idle.decision, 'send');
  assert.equal(idle.track, 'proactive');

  const locked = decide({ ...base, lastUserTs: null, idleSec: 10, locked: true });
  assert.equal(locked.decision, 'send');
  assert.equal(locked.track, 'proactive');
});

test('主动轨道：开启 requirePcOnline 后，人不在或锁屏 → AWAY', () => {
  const c = cfg();
  c.rules.requirePcOnline = true;
  const idle = decide({ ...base, cfg: c, lastUserTs: null, idleSec: 1200 });
  assert.equal(idle.reason, 'AWAY');

  const locked = decide({ ...base, cfg: c, lastUserTs: null, idleSec: 10, locked: true });
  assert.equal(locked.reason, 'AWAY');
});

test('主动轨道：三道闸都过 → SEND', () => {
  const d = decide({ ...base, lastUserTs: null, lastSendTs: null, idleSec: 5 });
  assert.equal(d.decision, 'send');
  assert.equal(d.track, 'proactive');
});

test('关掉「她说话我自动回」：她刚说完也不走回复轨道', () => {
  const c = cfg();
  c.rules.autoReply = false;
  const d = decide({ ...base, cfg: c });
  assert.equal(d.track, 'proactive');
  assert.equal(d.decision, 'send');
});

test('关掉「我会主动找你」：没人说话时不出手，她说话照回', () => {
  const c = cfg();
  c.rules.proactive = false;
  const quietTick = decide({ ...base, cfg: c, lastUserTs: null, lastSendTs: null });
  assert.equal(quietTick.reason, 'PROACTIVE_OFF');
  const reply = decide({ ...base, cfg: c });
  assert.equal(reply.track, 'reply');
  assert.equal(reply.decision, 'send');
});

// —— 阶段 3：自然触发拍。事件只能「提前到那一秒」，间隔让不让路由 takeGap 决定。
const ntCfg = (nt = {}) => cfg({ rules: { naturalTriggers: { enabled: true, ...nt } } });

test('阶段 3：事件拍默认不让路——间隔没满照样 GAP_TOO_SHORT', () => {
  const d = decide({
    ...base,
    cfg: ntCfg(),
    lastUserTs: null,
    lastSendTs: NOW - 30 * 60_000,
    triggered: true,
  });
  assert.equal(d.reason, 'GAP_TOO_SHORT');
  assert.equal(d.triggered, true);
});

test('阶段 3：takeGap 开着，事件拍越过 minGap，但仍要隔够 floorMin', () => {
  const mk = (mins) =>
    decide({
      ...base,
      cfg: ntCfg({ takeGap: true, floorMin: 20 }),
      lastUserTs: null,
      lastSendTs: NOW - mins * 60_000,
      triggered: true,
    });
  assert.equal(mk(10).reason, 'GAP_TOO_SHORT');
  assert.equal(mk(25).decision, 'send');
});

test('阶段 3：没有事件时 takeGap 一点用都没有', () => {
  const d = decide({
    ...base,
    cfg: ntCfg({ takeGap: true, floorMin: 20 }),
    lastUserTs: null,
    lastSendTs: NOW - 30 * 60_000,
    triggered: false,
  });
  assert.equal(d.reason, 'GAP_TOO_SHORT');
});

test('阶段 3：事件拍也越不过每日上限', () => {
  const d = decide({
    ...base,
    cfg: ntCfg({ takeGap: true, floorMin: 20 }),
    lastUserTs: null,
    lastSendTs: NOW - 120 * 60_000,
    todaySent: 3,
    triggered: true,
  });
  assert.equal(d.reason, 'DAILY_CAP');
});

test('回话不看电脑空不空：她从手机上发的，人不在电脑前也要回', () => {
  // 2026-11-08 她说：人不在电脑前本来就会发到手机。手机上收到她的话，
  // 电脑那头空着十个小时也不该因此不回——AWAY 只该拦「我先开口」。
  const d = decide({ ...base, idleSec: 4000 });
  assert.equal(d.track, 'reply');
  assert.equal(d.decision, 'send');
  assert.equal(d.away, true);
});
