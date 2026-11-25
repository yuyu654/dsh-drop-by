// time.js —— 时区相关的少量工具。跨天归零、日志时间都走这里，避免用本机时区瞎猜。
export function nowMs() {
  return Date.now();
}

// 时段判定统一走 src/schedule.js（多段 / 跨零点 / 冲突检测都在那边），
// 这里只留日历相关的工具，避免同一套规则写两遍。

/** 本地日期键 YYYY-MM-DD，用于「今天」计数归零。 */
export function dayKey(now, timezone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return f.format(new Date(now));
}

export function hhmm(now, timezone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return f.format(new Date(now));
}

function minutesOfDay(now, timezone) {
  const s = hhmm(now, timezone);
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}

/** 一天中的第几分钟（0-1439），schedule.js 按本机时区算不动，这里给需要的人用。 */
export function minutesOfDayOf(now, timezone) {
  return minutesOfDay(now, timezone);
}

/** 秒差，负数归零。 */
export function agoSec(now, ts) {
  if (!ts) return null;
  return Math.max(0, Math.round((now - ts) / 1000));
}

/**
 * 健康日：以 startHour（默认 7 点，北京时间）为新一天的开始。
 * 07:00 之前的时刻属于「前一天」——睡眠数据、每日一次的计数都按这个切，
 * 否则凌晨那几拍会把昨天的觉醒当成今天。
 */
export function healthDay(ts, timezone, startHour = 7) {
  const shifted = Number(ts) - Math.max(0, Number(startHour) || 0) * 3_600_000;
  return dayKey(shifted, timezone);
}

/** "07:57" / "7:5" → 一天中的第几分钟；读不到 null。 */
export function hmToMin(hm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 24 || mm > 59) return null;
  return h * 60 + mm;
}

/** 分钟数 → "07:57"。 */
export function minToHm(min) {
  const t = ((Math.round(Number(min) || 0) % 1440) + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * 时长写法 → 分钟："7h" / "7h30" / "7:30" / "6.5h" / "2h05" / "420分" / "420"。
 * 认不出返回 null（调用方负责报错，不在这里猜）。
 */
export function parseDur(v) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return null;
  let m;
  if ((m = /^(\d{1,2}(?:\.\d+)?)\s*(?:h|小时|时)(?:\s*(\d{1,2})\s*(?:分|m|min)?)?$/.exec(s))) {
    const h = Number(m[1]);
    const mm = m[2] ? Number(m[2]) : 0;
    if (mm > 59) return null;
    return Math.round(h * 60 + mm);
  }
  if ((m = /^(\d{1,2}):(\d{2})$/.exec(s))) {
    const h = Number(m[1]);
    const mm = Number(m[2]);
    if (mm > 59) return null;
    return h * 60 + mm;
  }
  if ((m = /^(\d{1,4})\s*(?:分|m|min)$/.exec(s))) return Number(m[1]);
  if (/^\d{1,4}$/.test(s)) return Number(s);
  return null;
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 0–99 的中文数字（时长、条数够用）。 */
export function cnNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v <= 10) return CN_NUM[v];
  if (v < 20) return `十${CN_NUM[v - 10]}`;
  const tens = Math.floor(v / 10);
  const rest = v % 10;
  return `${CN_NUM[tens]}十${rest ? CN_NUM[rest] : ''}`;
}

/**
 * 说给人听的时长。真人不会说「今天屏幕 5 小时 4 分钟」——那是报表，
 * 说的是「五个多小时」「快六个小时」。模板、由头、提示词都按这个粗粒度走。
 */
export function coarseMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  if (n < 10) return '不到十分钟';
  if (n < 60) {
    if (n >= 25 && n <= 35) return '半个多小时';
    return `${cnNum(Math.floor(n / 10) * 10)}多分钟`;
  }
  const h = Math.floor(n / 60);
  const rest = n % 60;
  if (rest <= 15) return `${cnNum(h)}个多小时`;
  if (rest >= 45) return `快${cnNum(h + 1)}个小时`;
  if (rest >= 25 && rest <= 35) return `${cnNum(h)}个半小时`;
  return `${cnNum(h)}个小时`;
}
