import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeCalendar, refreshCalendar, loadYear, cachedSets } from '../src/calendar.js';
import { busyNow, isHoliday } from '../src/holidays.js';

const dirs = [];
const tmpCfg = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cal-'));
  dirs.push(dir);
  return { timezone: 'Asia/Shanghai', busyHours: [['08:00', '12:00']], calendar: { dir, ...extra } };
};
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('认自家形状：YYYY-MM-DD / YYYY/MM/DD 都行', () => {
  const rec = normalizeCalendar({ year: 2027, off: ['2027-01-01', '2027/01/02'], work: ['2027-02-07'] }, 2027);
  assert.deepEqual(rec.off, ['2027-01-01', '2027-01-02']);
  assert.deepEqual(rec.work, ['2027-02-07']);
});

test('认 timor.tech 形状：holiday 映射，补班按名字认', () => {
  const rec = normalizeCalendar({
    code: 0,
    holiday: {
      '01-01': { holiday: true, name: '元旦', date: '2027-01-01' },
      '02-06': { holiday: false, name: '春节前调休', date: '2027-02-06' },
      '03-06': { holiday: false, name: '周末', date: '2027-03-06' },
    },
  }, 2027);
  assert.deepEqual(rec.off, ['2027-01-01']);
  assert.deepEqual(rec.work, ['2027-02-06'], '名字不带调休的周末不能当补班');
});

test('同一天既放假又上班：调休优先', () => {
  const rec = normalizeCalendar({ off: ['2027-01-04'], work: ['2027-01-04'] }, 2027);
  assert.deepEqual(rec.off, []);
  assert.deepEqual(rec.work, ['2027-01-04']);
});

test('认不出来就报错，不写半截表', () => {
  assert.throws(() => normalizeCalendar({ foo: 1 }, 2027), /没找到/);
});

test('refresh 写缓存，之后节假日判断直接读它', async () => {
  const cfg = tmpCfg({ url: 'https://example.test/{year}.json' });
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return { ok: true, status: 200, json: async () => ({ year: 2027, off: ['2027-10-01'], work: ['2027-10-10'] }) };
  };
  const r = await refreshCalendar({ year: 2027, url: cfg.calendar.url, cfg, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(seen[0], 'https://example.test/2027.json', '{year} 要替换');
  assert.equal(loadYear(2027, cfg).off[0], '2027-10-01');

  const sets = cachedSets(cfg);
  assert.ok(sets.off.has('2027-10-01'));
  assert.equal(isHoliday(Date.parse('2027-10-01T09:00:00+08:00'), cfg), true);
  assert.equal(busyNow(Date.parse('2027-10-01T09:00:00+08:00'), cfg), false);
  assert.equal(busyNow(Date.parse('2027-10-10T09:00:00+08:00'), cfg), true, '补班日照忙');
});

test('没配接口 / HTTP 失败 / 形状不对，都只返回原因', async () => {
  const cfg = tmpCfg();
  assert.equal((await refreshCalendar({ year: 2027, url: '', cfg })).reason, 'CALENDAR_NO_URL');
  const bad = await refreshCalendar({
    year: 2027, url: 'https://x.test', cfg,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) }),
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'CALENDAR_SHAPE');
  const http = await refreshCalendar({
    year: 2027, url: 'https://x.test', cfg,
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(http.reason, 'CALENDAR_HTTP_502');
});