// holidays.js —— 法定节假日：整天不按「忙碌时段」算，静默照旧。
//
// 为什么要单拎出来：忙碌时段填的是「她周几几点在上课/上班」，是按星期循环的；
// 法定节假日那天课表本来就不执行，她还按工作日算就变成「放假了还当她忙」。
// 所以这一天的 busies 全当没有，静默（quietHours）不受影响——那是作息，不是课表。
//
// 数据来源：国务院办公厅每年的放假通知（2026 年为国办发明电〔2025〕7 号）。
// 现在是硬编码的表：一年发一次，新一年加一项即可；漏了就用 content.holidays 手动补。
import { dayKey } from './time.js';
import { cachedSets } from './calendar.js';
import { inBusy, lastWindowEnd } from './schedule.js';

const TABLE = {
  2026: {
    // 放假（含调休借来的工作日）
    off: [
      '2026-01-01', '2026-01-02', '2026-01-03', // 元旦
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节
      '2026-04-04', '2026-04-05', '2026-04-06', // 清明
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节
      '2026-06-19', '2026-06-20', '2026-06-21', // 端午
      '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
      '2026-10-06', '2026-10-07', // 国庆
    ],
    // 调休上班的周末：这些天即使在周末也当工作日，忙碌时段照常生效
    work: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
  },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 内置表里有哪些年份（给状态/提示用）。 */
export function builtinYears() {
  return Object.keys(TABLE).map(Number).sort((a, b) => a - b);
}

/** 逗号/空格/顿号分隔的日期串或数组，都认。 */
function list(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((x) => DATE.test(x));
  return String(v ?? '')
    .split(/[\s,，、;；]+/)
    .map((x) => x.trim())
    .filter((x) => DATE.test(x));
}

/** 表里的放假/上班日，加上 config 里手动补的（手动优先）。 */
export function holidaySets(cfg = {}) {
  const off = new Set();
  const work = new Set();
  for (const y of Object.values(TABLE)) {
    for (const d of y.off) off.add(d);
    for (const d of y.work) work.add(d);
  }
  // 日历接口写下来的缓存（data/holidays-<年>.json）也并进来：它比手填省事，
  // 但优先级低于手填（手填是当天临时调整，覆盖远程表）。
  const cached = cachedSets(cfg);
  for (const d of cached.off) off.add(d);
  for (const d of cached.work) work.add(d);
  for (const d of list(cfg?.content?.holidays)) off.add(d);
  for (const d of list(cfg?.content?.workdays)) work.add(d);
  for (const d of work) off.delete(d);
  return { off, work };
}

/** 这一天算不算「放假」。调休上班日优先（她人得上班）。 */
export function isHoliday(now, cfg = {}) {
  const key = dayKey(now, cfg?.timezone);
  const { off, work } = holidaySets(cfg);
  if (work.has(key)) return false;
  return off.has(key);
}

/** 这一拍算不算在忙碌时段里（节假日整天不算）。 */
export function busyNow(now, cfg = {}) {
  if (isHoliday(now, cfg)) return false;
  return inBusy(now, cfg?.busyHours, cfg?.timezone);
}

/** 节假日的忙碌结束时间恒为 0——那天根本没有忙碌段。 */
export function lastBusyEnd(now, cfg = {}) {
  if (isHoliday(now, cfg)) return 0;
  return lastWindowEnd(now, cfg?.busyHours, cfg?.timezone);
}