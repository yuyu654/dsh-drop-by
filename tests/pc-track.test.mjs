// pc-track.test.mjs —— 电脑侧的「在不在 / 坐了多久 / 刚回来」记录。
// 这三类由头不接手机 App 也要能出，所以记录本身必须可靠：读不到就不猜，
// 离开超过阈值就断掉连续坐的时间，回来时把离开时长算准。
import test from 'node:test';
import assert from 'node:assert/strict';
import { trackPcPresence } from '../src/engine.js';

const TZ = 'Asia/Shanghai';
const cfg = { timezone: TZ, idle: { onlineSec: 30, awaySec: 600 } };
const MIN = 60_000;
const at = (h, m = 0) => Date.UTC(2026, 10, 4, h - 8, m);
const sysOf = (idleSec) => ({ ok: true, idle_ms: idleSec * 1000 });

test('连着在电脑前：第一次记下开始时间，之后不改', () => {
  const st = {};
  const t0 = at(13);
  assert.equal(trackPcPresence(st, sysOf(20), t0, cfg), null);
  assert.equal(st.pc.activeSince, t0);
  trackPcPresence(st, sysOf(40), t0 + 10 * MIN, cfg);
  assert.equal(st.pc.activeSince, t0, '中途动过鼠标不该重置起点');
});

test('空闲超过阈值 → 记离开，连续时间断掉', () => {
  const st = {};
  const t0 = at(13);
  trackPcPresence(st, sysOf(20), t0, cfg);
  trackPcPresence(st, sysOf(15 * 60), t0 + 60 * MIN, cfg);
  assert.equal(st.pc.activeSince, 0);
  assert.equal(st.pc.awaySince, t0 + 60 * MIN);
});

test('回来 → 算出离开多久，并把回来时间记下', () => {
  const st = {};
  const t0 = at(13);
  trackPcPresence(st, sysOf(20), t0, cfg);
  trackPcPresence(st, sysOf(15 * 60), t0 + 30 * MIN, cfg);
  const t2 = t0 + 75 * MIN;
  assert.equal(trackPcPresence(st, sysOf(5), t2, cfg), 'return');
  assert.equal(st.pc.lastReturnAt, t2);
  assert.equal(st.pc.lastAwayMs, 45 * MIN);
  assert.equal(st.pc.awaySince, 0);
  assert.equal(st.pc.activeSince, t2, '回来是新一段连续时间的起点');
});

test('探针读不到（idle -1）→ 不猜、不动已有记录', () => {
  const st = { pc: { day: '2026-11-04', activeSince: at(13), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 } };
  assert.equal(trackPcPresence(st, { ok: false, idle_ms: -1 }, at(15), cfg), null);
  assert.equal(st.pc.activeSince, at(13));
});

test('凌晨还醒着算前一夜：4 点起算，0 点不清零', () => {
  const st = {};
  trackPcPresence(st, sysOf(20), at(23), cfg);
  const before = st.pc.activeSince;
  trackPcPresence(st, sysOf(20), at(23) + 90 * MIN, cfg); // 次日 00:30
  assert.equal(st.pc.day, '2026-11-04', '跨零点还归同一晚（前一天的 4 点起算）');
  assert.equal(st.pc.activeSince, before);
});

test('锁屏中（如 UU 远控退出自动锁屏）：不累计离开，解锁后不误判「刚回电脑前」', () => {
  const st = {};
  const t0 = at(13);
  trackPcPresence(st, sysOf(20), t0, cfg);
  // 进程出现 logonui 或 sys.locked=true：哪怕 idle_ms 已经很大，也不记 awaySince
  assert.equal(trackPcPresence(st, { ok: true, idle_ms: 40 * MIN, procs: ['logonui'] }, t0 + 40 * MIN, cfg), null);
  assert.equal(st.pc.locked, true);
  assert.equal(st.pc.awaySince, 0);
  assert.equal(st.pc.activeSince, 0);

  // 解锁回到桌面后，不能伪造出 return / lastReturnAt
  const tUnlock = t0 + 90 * MIN;
  assert.equal(trackPcPresence(st, { ok: true, idle_ms: 5000, locked: false, procs: [] }, tUnlock, cfg), null);
  assert.equal(st.pc.locked, false);
  assert.equal(st.pc.lastReturnAt, 0);
  assert.equal(st.pc.lastAwayMs, 0);
  assert.equal(st.pc.activeSince, tUnlock);
});