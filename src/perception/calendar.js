// calendar.js —— 节假日日历接口：放假表不再只靠代码里那张硬编码表。
//
// 为什么要这个：`holidays.js` 里的 2026 表过一年就废，每年都得改一次源码。
// 这里给一个「日历接口」的薄封装：配好 URL，让模型（或用户）调一次 refresh，
// 把某一年的放假/调休写成 data/holidays-<年>.json；之后每次判断都读缓存，
// 不联网。缓存也是纯数据，删掉就退回内置表。
//
// 接口形状不挑：官方/第三方返回的 JSON 只要能被 normalizeCalendar 认出来
// （{year, off, work}、{holidays, workdays}、timor.tech 的 {holiday: {"01-01": {...}}} 都行）。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from '../settings/config.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const YEAR = /^\d{4}$/;

/** 缓存目录：跟 config.json 放在一起的 data/（测试可传 cfg.calendar.dir 覆盖）。 */
export function dataDir(cfg = {}) {
  const custom = cfg?.calendar?.dir;
  return custom ? String(custom) : path.join(path.dirname(CONFIG_PATH), 'data');
}

export function fileOf(year, cfg = {}) {
  return path.join(dataDir(cfg), `holidays-${Number(year)}.json`);
}

const toDate = (v, year) => {
  const s = String(v ?? '').trim().replace(/[/.]/g, '-');
  if (DATE.test(s)) return s;
  if (new RegExp(`^${year}-`).test(s)) return s;
  const m = /^(\d{2})-(\d{2})$/.exec(s);
  return m ? `${year}-${m[1]}-${m[2]}` : '';
};

const arr = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、;；]+/)).filter(Boolean);

/**
 * 把各种形状的响应压成 { year, off: [...], work: [...], source }。
 * 认不出来就抛错，别把半截表写进缓存。
 */
export function normalizeCalendar(raw, year, source = '') {
  const y = Number(year);
  if (!YEAR.test(String(y))) throw new Error(`年份不对：${year}`);
  if (!raw || typeof raw !== 'object') throw new Error('响应不是 JSON 对象');

  const off = new Set();
  const work = new Set();

  const take = (list, into) => {
    for (const d of arr(list)) {
      const s = toDate(d, y);
      if (s) into.add(s);
    }
  };

  if (raw.off || raw.holidays) take(raw.off ?? raw.holidays, off);
  if (raw.work || raw.workdays || raw.makeupDays) take(raw.work ?? raw.workdays ?? raw.makeupDays, work);

  // timor.tech 风格：{ holiday: { "01-01": { holiday: true, name, date, after } } }
  if (raw.holiday && typeof raw.holiday === 'object') {
    for (const [key, v] of Object.entries(raw.holiday)) {
      if (!v || typeof v !== 'object') continue;
      const d = toDate(v.date || key, y);
      if (!d) continue;
      if (v.holiday === true) off.add(d);
      // 补班日：holiday=false，名字里带「调休/补班/上班」之类的才算（周末本来就 false，不能当补班）
      else if (v.holiday === false && /调休|补班|上班|工作日/.test(String(v.name || ''))) work.add(d);
    }
  }

  if (!off.size && !work.size) throw new Error('响应里没找到放假/调休日期');
  // 同一天既放假又上班：以调休为准（她人得上班）
  for (const d of work) off.delete(d);
  return {
    year: y,
    off: [...off].sort(),
    work: [...work].sort(),
    source: String(source || raw.source || raw.url || '').slice(0, 200),
    fetchedAt: Date.now(),
  };
}

export function loadYear(year, cfg = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(fileOf(year, cfg), 'utf8'));
    if (Number(j?.year) === Number(year) && Array.isArray(j.off) && Array.isArray(j.work)) return j;
    return null;
  } catch {
    return null;
  }
}

export function saveYear(rec, cfg = {}) {
  const dir = dataDir(cfg);
  fs.mkdirSync(dir, { recursive: true });
  const file = fileOf(rec.year, cfg);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/** data/ 里所有 holidays-<年>.json，按年排序。 */
export function cachedYears(cfg = {}) {
  let names = [];
  try {
    names = fs.readdirSync(dataDir(cfg));
  } catch {
    return [];
  }
  return names
    .map((n) => /^holidays-(\d{4})\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

/** 所有年份的缓存合并成 off/work 两个集合（节假日判断用这个）。 */
export function cachedSets(cfg = {}) {
  const off = new Set();
  const work = new Set();
  for (const y of cachedYears(cfg)) {
    const rec = loadYear(y, cfg);
    if (!rec) continue;
    for (const d of rec.off) if (DATE.test(d)) off.add(d);
    for (const d of rec.work) if (DATE.test(d)) work.add(d);
  }
  return { off, work };
}

/**
 * 拉一次接口并写缓存。url 为空就报错（不猜默认地址——接口挂了会污染判断）。
 * fetchImpl 可注入，测试不联网。
 */
export async function refreshCalendar({ year, url, cfg = {}, timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  const y = Number(year) || new Date().getFullYear();
  if (!url) return { ok: false, reason: 'CALENDAR_NO_URL' };
  if (typeof fetchImpl !== 'function') return { ok: false, reason: 'CALENDAR_NO_FETCH' };
  const target = String(url).replace(/\{year\}/g, String(y)).replace(/\{yyyy\}/g, String(y));
  let res;
  try {
    res = await fetchImpl(target, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  } catch (e) {
    return { ok: false, reason: 'CALENDAR_FETCH_FAILED', note: String(e?.message || e).slice(0, 160) };
  }
  if (!res?.ok) return { ok: false, reason: 'CALENDAR_HTTP_' + (res?.status ?? '?') };
  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    return { ok: false, reason: 'CALENDAR_BAD_JSON', note: String(e?.message || e).slice(0, 160) };
  }
  let rec;
  try {
    rec = normalizeCalendar(raw, y, target);
  } catch (e) {
    return { ok: false, reason: 'CALENDAR_SHAPE', note: String(e?.message || e).slice(0, 160) };
  }
  const file = saveYear(rec, cfg);
  return { ok: true, year: y, off: rec.off.length, work: rec.work.length, file };
}

/** 看一眼：缓存了哪几年、今年有没有、接口配没配。 */
export function calendarStatus(cfg = {}, now = Date.now()) {
  const year = new Date(now).getFullYear();
  const years = cachedYears(cfg);
  const cur = years.includes(year) ? loadYear(year, cfg) : null;
  return {
    year,
    url: String(cfg?.calendar?.url || ''),
    cached: years,
    covered: Boolean(cur),
    current: cur ? { off: cur.off.length, work: cur.work.length, fetchedAt: cur.fetchedAt } : null,
    dir: dataDir(cfg),
  };
}