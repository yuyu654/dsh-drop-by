// time.test.mjs —— 时间/时长工具。--sleep-set 靠它把用户写的"6h30"变成分钟。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDur, hmToMin, minToHm, healthDay } from '../src/settings/time.js';

const TZ = 'Asia/Shanghai';

test('parseDur：几种写法都认', () => {
  assert.equal(parseDur('7h'), 420);
  assert.equal(parseDur('7小时'), 420);
  assert.equal(parseDur('7h30'), 450);
  assert.equal(parseDur('7:30'), 450);
  assert.equal(parseDur('6.5h'), 390);
  assert.equal(parseDur('2h05'), 125);
  assert.equal(parseDur('420'), 420);
  assert.equal(parseDur('420分'), 420);
  assert.equal(parseDur('90m'), 90);
  assert.equal(parseDur(' 7H '), 420);
});

test('parseDur：认不出就 null，不瞎猜', () => {
  assert.equal(parseDur(''), null);
  assert.equal(parseDur(null), null);
  assert.equal(parseDur('abc'), null);
  assert.equal(parseDur('7h75'), null); // 分钟 > 59
  assert.equal(parseDur('-7'), null);
  assert.equal(parseDur('7.5.5h'), null);
});

test('hmToMin / minToHm：往返一致，跨零点不翻车', () => {
  assert.equal(hmToMin('00:30'), 30);
  assert.equal(hmToMin('07:57'), 477);
  assert.equal(hmToMin('7:5'), null); // 分钟必须两位
  assert.equal(minToHm(30), '00:30');
  assert.equal(minToHm(-10), '23:50');
  assert.equal(minToHm(1440 + 65), '01:05');
});

test('healthDay：7 点前算前一天', () => {
  // 北京 11-04 06:59 → 健康日仍是 11-03
  assert.equal(healthDay(Date.UTC(2026, 10, 3, 22, 59), TZ, 7), '2026-11-03');
  // 北京 11-04 07:00 → 11-04
  assert.equal(healthDay(Date.UTC(2026, 10, 3, 23, 0), TZ, 7), '2026-11-04');
  // 北京 11-04 23:59 → 还是 11-04
  assert.equal(healthDay(Date.UTC(2026, 10, 4, 15, 59), TZ, 7), '2026-11-04');
});
