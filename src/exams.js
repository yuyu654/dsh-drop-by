// exams.js —— 考试：只读一段纯文本，不连教务系统、不联网。
//
// 一行一场，时间写在前面（怎么顺怎么写）：
//   2026-12-20 09:00 电机学 @教三201
//   12月20日 14:00-16:00 电力电子 教三201
//   2026/12/20 09:00 概率论            ← 场地可以不写
//
// 提醒两类：
//   · 复习：考前 N 天（默认 7，按「天」算，日历日差正好是 N 那天提一次）；
//   · 快考了：考前 M 分钟（默认 60，按「分钟」算，进窗口提一次）。
// 每场只提一次，靠 examKey 去重（改了时间/科目就是新的一场）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { splitRoom } from './agenda.js';
import { dayKey } from './time.js';

const LINE =
  /^\s*(?:(\d{4})\s*[-/.年]\s*)?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*(?:[-–—~～至到]\s*\d{1,2}\s*[:：]\s*\d{2})?\s+(.+)$/;

const pad = (n) => (n < 10 ? `0${n}` : String(n));

function localDate(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

/** 某个时区里「年月日 时:分」→ 时间戳（只用于本地判定，不联网）。 */
function zonedTs(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(guess))) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return guess - (asUtc - guess);
}

export function examKey(e) {
  const s = `${e.date}|${e.hm}|${e.subject || ''}|${e.room || ''}`;
  let hv = 5381;
  for (let i = 0; i < s.length; i += 1) hv = ((hv << 5) + hv + s.charCodeAt(i)) >>> 0;
  return `e-${hv.toString(16)}`;
}

/** 一行一场 → 结构；认不出的行跳过。没写年份就用今年（已经过去就当下一年）。 */
export function parseExams(text, { tz = 'Asia/Shanghai', now = Date.now() } = {}) {
  const out = [];
  const curYear = Number(dayKey(now, tz).slice(0, 4));
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = LINE.exec(t);
    if (!m) continue;
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const h = Number(m[4]);
    const mi = Number(m[5]);
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60)) continue;
    const baseYear = m[1] ? Number(m[1]) : curYear;
    let at = zonedTs(baseYear, mo, d, h, mi, tz);
    if (!m[1] && at < now - 86_400_000) at = zonedTs(baseYear + 1, mo, d, h, mi, tz); // 没写年份、日子已过 → 明年的
    const r = splitRoom(m[6]);
    const subject = r.rest.replace(/^[\s,，、:：;；\-–—]+|[\s,，、:：;；\-–—]+$/g, '').trim();
    const e = { at, date: localDate(at, tz), hm: `${pad(h)}:${pad(mi)}`, subject, room: r.room || '' };
    e.key = examKey(e);
    out.push(e);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 差几天（考试日 - 今天），按日历日算，不看时间。 */
export function dayDiff(exam, now, tz) {
  const [y1, m1, d1] = dayKey(now, tz).split('-').map(Number);
  const [y2, m2, d2] = exam.date.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000);
}

/** 该提醒复习的那一场：日历日差正好 N 天，且还没开考。 */
export function reviewDue(list, now, tz, days) {
  const n = Math.max(1, Math.round(Number(days) || 7));
  return list.find((e) => e.at > now && dayDiff(e, now, tz) === n) || null;
}

/** 快考了的那一场：进 M 分钟窗口、还没开考。 */
export function soonDue(list, now, min) {
  const m = Math.max(1, Math.round(Number(min) || 60));
  return list.find((e) => e.at > now && e.at - now <= m * 60_000) || null;
}

/** 考试文本从哪来：设置页优先，没填看 data/exams.txt。 */
export function examsSource(cfg, { dsh = path.join(os.homedir(), '.dsh') } = {}) {
  const inline = String(cfg?.content?.exams?.text || '');
  if (inline.trim()) return { text: inline, from: 'config' };
  const file = cfg?.content?.exams?.file || path.join(dsh, 'presence-gate', 'data', 'exams.txt');
  try {
    return { text: fs.readFileSync(file, 'utf8'), from: file };
  } catch {
    return { text: '', from: 'none' };
  }
}