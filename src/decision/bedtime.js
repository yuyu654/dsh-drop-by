// bedtime.js —— 她的「睡着时段」从哪来。
//
// 随口说话不该在凌晨开口，但「凌晨」不该由我拍一个 00:00–07:00 了事：
// 鱼鱼邮件里每天都有起床时间，七天的中位数比任何常数都准。
// 有效天数 ≥3 才用；不够就退回 23:00–07:00（宁可保守，也别在她刚躺下时说话）。
//
// 时间表示：内部统一用「夜晚刻度」——凌晨 06:00 之前的时刻 +1440，
// 这样 23:40（1420）和 01:10（1510）能落在同一根轴上算中位数，不会在午夜处断裂。
import fs from 'node:fs';
import path from 'node:path';
import { minutesOfDayOf, dayKey } from '../settings/time.js';
import { FISH_ARCHIVE_DIR } from '../settings/retention.js';

const MIN_NIGHTS = 3;
const DAY_MS = 86_400_000;

export const FALLBACK_REST = { from: 'fallback', nights: 0, bedMin: 1380, wakeMin: 420, startMin: 1380, endMin: 420 };

/** 'HH:MM' → 夜晚刻度分钟（00:30 → 1470，23:40 → 1420）。读不到 null。 */
export function nightMinutes(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!(h >= 0 && h <= 24) || !(mi >= 0 && mi <= 59)) return null;
  // 只把「凌晨那一段」（06:00 之前）挪到夜晚轴上：23:40 → 1420、00:30 → 1470，
  // 而 07:00 仍然是 420（起床时刻），不会因为「中午前都加一天」而跑到中位数另一边。
  const raw = (h % 24) * 60 + mi;
  return raw < 360 ? raw + 1440 : raw;
}

/** 夜晚刻度 → 'HH:MM'。 */
export function clockOf(min) {
  const v = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
}

export function median(nums) {
  const a = (Array.isArray(nums) ? nums : []).filter((n) => Number.isFinite(n)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

/** 从一天的邮件解析结果里取「入睡点」（分钟）与起床点。入睡点优先直接用，缺了才用起床−睡眠反推。 */
export function nightOf(parsed) {
  if (!parsed) return null;
  const wake = nightMinutes(parsed.wakeHm);
  let bed = nightMinutes(parsed.bedHm);
  if (bed == null && wake != null && Number(parsed.sleepMin) > 0) {
    bed = ((wake - Number(parsed.sleepMin)) % 1440 + 1440) % 1440;
    if (bed < 720) bed += 1440; // 反推落在下午/凌晨的一律挪到夜晚刻度
  }
  if (bed == null && wake == null) return null;
  return { bed, wake };
}

/** 读 data/fish/ 最近的 N 个档案日，取每天最后一封自带入睡/起床的邮件。 */
export function readNights({ dir = FISH_ARCHIVE_DIR, days = 7 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse();
  } catch {
    return [];
  }
  const nights = [];
  for (const f of files) {
    if (nights.length >= days) break;
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    const mails = Array.isArray(doc?.mails) ? doc.mails.slice().reverse() : [];
    for (const m of mails) {
      const n = nightOf(m?.parsed);
      if (n && n.bed != null && n.wake != null) {
        nights.push({ day: doc.day || f.slice(0, 10), ...n });
        break;
      }
      if (n && n.wake != null) {
        // 只有起床、没有入睡也留着：至少能定「早上几点起」
        nights.push({ day: doc.day || f.slice(0, 10), bed: null, wake: n.wake });
        break;
      }
    }
  }
  return nights;
}

/**
 * 推导睡着时段：入睡中位数往前 30 分钟、起床中位数往后 30 分钟。
 * 返回 { from:'history'|'fallback', nights, bedMin, wakeMin, startMin, endMin, why }。
 */
export function deriveRest({ dir = FISH_ARCHIVE_DIR, days = 7, paddingMin = 30, fallbackStartMin = 1380, fallbackEndMin = 420 } = {}) {
  const nights = readNights({ dir, days });
  const beds = nights.map((n) => n.bed).filter((n) => Number.isFinite(n));
  const wakes = nights.map((n) => n.wake).filter((n) => Number.isFinite(n));
  if (beds.length < MIN_NIGHTS || wakes.length < MIN_NIGHTS) {
    return { ...FALLBACK_REST, nights: nights.length, bedMin: fallbackStartMin, wakeMin: fallbackEndMin,
      startMin: fallbackStartMin, endMin: fallbackEndMin,
      why: `有效天数 ${Math.min(beds.length, wakes.length)} < ${MIN_NIGHTS}，先按 ${clockOf(fallbackStartMin)}–${clockOf(fallbackEndMin)}` };
  }
  const bedMin = median(beds);
  const wakeMin = median(wakes);
  const startMin = ((bedMin - paddingMin) % 1440 + 1440) % 1440;
  const endMin = ((wakeMin + paddingMin) % 1440 + 1440) % 1440;
  return { from: 'history', nights: Math.min(beds.length, wakes.length), bedMin, wakeMin, startMin, endMin, why: null };
}

/** 某个时刻（0..1439）是否落在 [startMin, endMin) 里（允许跨午夜）。 */
export function inRest(mins, rest) {
  const start = Number(rest?.startMin);
  const end = Number(rest?.endMin);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  const m = Number(mins);
  if (!Number.isFinite(m)) return false;
  const width = ((end - start) % 1440 + 1440) % 1440;
  if (width === 0) return false;
  const delta = ((m - start) % 1440 + 1440) % 1440;
  return delta < width;
}

/**
 * 带缓存：一天只推导一次（state.rest 存 {day, ...}）。
 * 没给 st 就直接算（--health 用）。
 */
export function restFor({ cfg, now = Date.now(), tz = 'Asia/Shanghai', st = null, dir = FISH_ARCHIVE_DIR } = {}) {
  const day = dayKey(now, tz);
  const c = cfg?.rules?.chitchat || {};
  const timing = { days: c.restHistoryDays ?? 7, paddingMin: c.restPaddingMin ?? 30,
    fallbackStartMin: c.restFallbackStartMin ?? 1380, fallbackEndMin: c.restFallbackEndMin ?? 420 };
  const timingKey = JSON.stringify(timing);
  if (st?.rest?.day === day && st.rest.timingKey === timingKey) return st.rest;
  const r = deriveRest({ dir, ...timing });
  const out = { v: 2, day, timingKey, ...r, at: now };
  if (st && typeof st === 'object') st.rest = out;
  return out;
}

/** 一句话描述，给 --health / --why 用。 */
export function restLine(rest) {
  const w = `${clockOf(rest.startMin)}–${clockOf(rest.endMin)}`;
  return rest.from === 'history'
    ? `睡着时段 ${w}（${rest.nights} 天中位数：入睡 ${clockOf(rest.bedMin)}、起床 ${clockOf(rest.wakeMin)}）`
    : `睡着时段 ${w}（鱼鱼数据不够，退回默认）`;
}

export const REST_TUNING = { MIN_NIGHTS, DAY_MS };