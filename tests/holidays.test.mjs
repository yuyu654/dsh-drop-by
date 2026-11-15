import test from 'node:test';
import assert from 'node:assert/strict';
import { isHoliday, busyNow, lastBusyEnd } from '../src/holidays.js';
import { inQuiet } from '../src/schedule.js';

const TZ = 'Asia/Shanghai';
const cfgOf = (extra = {}) => ({ timezone: TZ, busyHours: [['08:00', '12:00']], ...extra });
const at = (iso) => Date.parse(iso);

test('国庆当天白天：忙碌时段不生效', () => {
  const now = at('2026-10-01T09:00:00+08:00'); // 周四，原本 08:00-12:00 是忙碌
  const cfg = cfgOf();
  assert.equal(isHoliday(now, cfg), true);
  assert.equal(busyNow(now, cfg), false);
  assert.equal(lastBusyEnd(now, cfg), 0);
});

test('普通工作日同一时段：忙碌照常', () => {
  const now = at('2026-11-16T09:00:00+08:00'); // 周一
  const cfg = cfgOf();
  assert.equal(isHoliday(now, cfg), false);
  assert.equal(busyNow(now, cfg), true);
});

test('静默不受节假日影响', () => {
  const now = at('2026-10-01T23:00:00+08:00');
  const cfg = cfgOf({ quietHours: [['22:30', '07:30']] });
  assert.equal(isHoliday(now, cfg), true);
  assert.equal(inQuiet(now, cfg.quietHours, TZ), true);
  assert.equal(busyNow(now, cfg), false);
});

test('调休上班的周末算工作日：忙碌照常', () => {
  const now = at('2026-10-10T09:00:00+08:00'); // 周六，但 10-10 上班
  const cfg = cfgOf();
  assert.equal(isHoliday(now, cfg), false);
  assert.equal(busyNow(now, cfg), true);
});

test('config 手填的额外放假 / 调休都能覆盖', () => {
  const now = at('2026-11-17T09:00:00+08:00');
  assert.equal(busyNow(now, cfgOf({ content: { holidays: '2026-11-17' } })), false);
  assert.equal(busyNow(now, cfgOf({ content: { holidays: '2026-11-17', workdays: ['2026-11-17'] } })), true);
});

test('没有 busyHours 时任何日子都不忙', () => {
  const now = at('2026-11-16T09:00:00+08:00');
  assert.equal(busyNow(now, { timezone: TZ, busyHours: [] }), false);
});