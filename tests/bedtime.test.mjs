// bedtime.test.mjs —— 她的睡着时段：从鱼鱼邮件推，不够就保守回退。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { nightMinutes, clockOf, median, nightOf, readNights, deriveRest, inRest, restFor, FALLBACK_REST } from '../src/decision/bedtime.js';

const DAY_MS = 86_400_000;

function dayFile(dir, day, parsed) {
  fs.writeFileSync(path.join(dir, `${day}.json`), JSON.stringify({ day, mails: [{ uid: 1, parsed }] }), 'utf8');
}

function tmpFish() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bed-'));
}

test('时间刻度：凌晨归到夜晚那根轴上（00:30 > 23:40）', () => {
  assert.equal(nightMinutes('00:30'), 1470);
  assert.equal(nightMinutes('23:40'), 1420);
  assert.equal(nightMinutes('07:00'), 420);
  assert.equal(nightMinutes('乱七八糟'), null);
  assert.equal(clockOf(1470), '00:30');
  assert.equal(clockOf(1420), '23:40');
});

test('中位数：偶数个取中间两数平均并取整', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // (2+3)/2 → 2.5 → 3（四舍五入）
  assert.equal(median([]), null);
});

test('nightOf：邮件自带入睡就直接用；没有才用起床−睡眠反推', () => {
  const direct = nightOf({ bedHm: '00:10', wakeHm: '07:20', sleepMin: 430 });
  assert.equal(direct.bed, nightMinutes('00:10'));
  const inferred = nightOf({ bedHm: null, wakeHm: '07:20', sleepMin: 430 });
  assert.equal(inferred.bed, nightMinutes('00:10')); // 07:20 − 430 分 = 00:10
  assert.equal(nightOf({}), null);
});

test('推导：3 天以上才用中位数，入睡前 30 分、起床后 30 分', () => {
  const dir = tmpFish();
  dayFile(dir, '2026-11-04', { bedHm: '23:20', wakeHm: '07:00', sleepMin: 460 });
  dayFile(dir, '2026-11-05', { bedHm: '00:20', wakeHm: '07:40', sleepMin: 440 });
  dayFile(dir, '2026-11-06', { bedHm: '23:50', wakeHm: '07:20', sleepMin: 450 });
  const nights = readNights({ dir, days: 7 });
  assert.equal(nights.length, 3);
  const r = deriveRest({ dir, days: 7 });
  assert.equal(r.from, 'history');
  assert.equal(r.nights, 3);
  assert.equal(clockOf(r.startMin), '23:20'); // 入睡中位数 23:50 − 30
  assert.equal(clockOf(r.endMin), '07:50'); // 起床中位数 07:20 + 30
});

test('不足 3 天：退回 23:00–07:00，并说明原因', () => {
  const dir = tmpFish();
  dayFile(dir, '2026-11-06', { bedHm: '00:10', wakeHm: '07:20', sleepMin: 430 });
  const r = deriveRest({ dir, days: 7 });
  assert.equal(r.from, 'fallback');
  assert.match(r.why, /有效天数 1 < 3/);
  assert.deepEqual([r.startMin, r.endMin], [FALLBACK_REST.startMin, FALLBACK_REST.endMin]);
});

test('inRest：跨午夜也判得对', () => {
  const rest = { startMin: 1380, endMin: 420 }; // 23:00–07:00
  assert.equal(inRest(23 * 60 + 30, rest), true);
  assert.equal(inRest(2 * 60, rest), true);
  assert.equal(inRest(7 * 60, rest), false);
  assert.equal(inRest(12 * 60, rest), false);
  assert.equal(inRest(22 * 60 + 59, rest), false);
});

test('restFor 一天只推一次：同一天复用 state.rest', () => {
  const dir = tmpFish();
  dayFile(dir, '2026-11-06', { bedHm: '00:00', wakeHm: '07:30', sleepMin: 450 });
  const st = {};
  const tz = 'Asia/Shanghai';
  const now = Date.UTC(2026, 10, 7, 4, 0); // 北京 12:00
  const a = restFor({ now, tz, st, dir });
  a.startMin = 1; // 篡改一次，确认第二次直接拿缓存
  const b = restFor({ now, tz, st, dir });
  assert.equal(b.startMin, 1);
  // 换一天就重算
  const c = restFor({ now: now + DAY_MS, tz, st, dir });
  assert.notEqual(c.startMin, 1);
});