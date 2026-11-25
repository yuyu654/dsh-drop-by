import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHoliday, busyNow, lastBusyEnd, deepseekPeakStatus, offPeakNow } from '../src/perception/holidays.js';
import { inQuiet } from '../src/perception/schedule.js';

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

test('DeepSeek 峰谷时：普通工作日仅 09:00-12:00 与 14:00-18:00 为高峰，其余为谷时', () => {
  const cfg = cfgOf();
  const cases = [
    ['2026-11-16T08:59:00+08:00', true],
    ['2026-11-16T09:00:00+08:00', false],
    ['2026-11-16T11:59:00+08:00', false],
    ['2026-11-16T12:00:00+08:00', true],
    ['2026-11-16T13:59:00+08:00', true],
    ['2026-11-16T14:00:00+08:00', false],
    ['2026-11-16T17:59:00+08:00', false],
    ['2026-11-16T18:00:00+08:00', true],
    ['2026-11-16T23:30:00+08:00', true],
  ];
  for (const [iso, expected] of cases) {
    assert.equal(offPeakNow(at(iso), cfg), expected, `${iso} 应为 ${expected ? '谷时' : '高峰'}`);
  }
});

test('DeepSeek 峰谷时：节假日但是周中（内置/日历缓存/手填）全天算谷时', (t) => {
  // 2026-05-01 是周五（劳动节法定节假日），即使在工作日 10:00 / 15:00 也全天算谷时
  assert.equal(offPeakNow(at('2026-05-01T10:00:00+08:00'), cfgOf()), true);
  assert.equal(deepseekPeakStatus(at('2026-05-01T15:00:00+08:00'), cfgOf()).reason, 'HOLIDAY_OFF_PEAK');

  // 通过节假日日历缓存 data/holidays-2027.json 接入的周中节假日（2027-01-01 周五）同样全天谷时
  const calDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cal-peak-'));
  t.after(() => fs.rmSync(calDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(calDir, 'holidays-2027.json'), JSON.stringify({
    year: 2027,
    off: ['2027-01-01'],
    work: ['2027-02-14'],
  }));
  const calCfg = cfgOf({ calendar: { dir: calDir } });
  assert.equal(deepseekPeakStatus(at('2027-01-01T10:30:00+08:00'), calCfg).reason, 'HOLIDAY_OFF_PEAK');

  // 手填周中放假也算谷时；若手填 workdays 把该周中改回上班日，则恢复工作日高峰判法
  assert.equal(offPeakNow(at('2026-11-18T10:00:00+08:00'), cfgOf({ content: { holidays: '2026-11-18' } })), true);
  assert.equal(offPeakNow(at('2026-11-18T10:00:00+08:00'), cfgOf({ content: { holidays: '2026-11-18', workdays: ['2026-11-18'] } })), false);
});

test('DeepSeek 峰谷时：周末但是调休上班，个人日程照常忙碌，但按 DS 官方规则全天仍算谷时', () => {
  // 2026-02-14（周六）和 2026-10-10（周六）均为法定调休上班的周末
  const cfg = cfgOf({ busyHours: [['09:00', '18:00']] });
  for (const iso of ['2026-02-14T10:00:00+08:00', '2026-10-10T15:00:00+08:00']) {
    const s = deepseekPeakStatus(at(iso), cfg);
    assert.equal(busyNow(at(iso), cfg), true, `${iso} 对个人日程应算调休工作日忙碌`);
    assert.equal(s.offPeak, true, `${iso} 对 DeepSeek 峰谷规则应算周末全天谷时`);
    assert.equal(s.reason, 'WEEKEND_WORKDAY_OFF_PEAK');
  }

  // 普通周末（周日）与手填调休周日同样全天算谷时
  assert.equal(deepseekPeakStatus(at('2026-11-15T10:00:00+08:00'), cfgOf()).reason, 'WEEKEND_OFF_PEAK');
  assert.equal(
    deepseekPeakStatus(at('2026-11-15T10:00:00+08:00'), cfgOf({ content: { workdays: '2026-11-15' } })).reason,
    'WEEKEND_WORKDAY_OFF_PEAK'
  );
});