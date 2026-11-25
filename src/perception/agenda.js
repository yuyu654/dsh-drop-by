// agenda.js —— 课表：只读一段纯文本，不连教务系统、不联网。
//
// 一行一节，两种写法都认（怎么顺怎么写，全角冒号也行）：
//   周一 08:00-09:40 电机学 @教三201
//   周三 第3-4节 电力电子 1-16周 教三201
//
// 周次可选：`1-16周`、`1~8,10-16周`、`单周`、`双周`。填了「开学第一周的周一」
// （content.agenda.termStart）才按当前是第几周过滤；没填就当所有课每周都上。
// 教室可选：写在最后一个 `@教三201`，或者末尾带「楼/室/馆/场/教」的词、或 `3-201` 这种编号。
// 作息表（第几节对应几点）也可以自己填（content.agenda.periods）；填了就用它算，
// 课表里直接写了时间的行不受影响——这两种情况都不用填作息表。
//
// 为什么要它：别的由头都是「回头看今天」，课表是唯一「往前看」的——
// 明早有早八，今晚就该催睡；下一节二十分钟后开始，现在提一句才有用。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from '../settings/config.js';
import { dayKey, minutesOfDayOf } from '../settings/time.js';

const WD = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DAY = 86_400_000;

// 「周一 08:00-09:40 …」或「周一 第1-2节 …」
const HEAD = /^\s*(?:周|星期)\s*([一二三四五六日天1-7])\s*(.*)$/;
const TIME = /^(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*(.*)$/;
const PERIOD = /^第?\s*(\d{1,2})\s*[-–—~～至到]\s*(\d{1,2})\s*节\s*(.*)$/;
// 作息表一行：「1-2 08:00-09:40」，前面的「第…节」可有可无
const PERIOD_LINE =
  /^\s*(?:第\s*)?(\d{1,2})\s*[-–—~～至到]\s*(\d{1,2})\s*节?\s*(\d{1,2})\s*[:：]\s*(\d{2})\s*[-–—~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2})/;

// 教务系统爱写「第 1-2 节」。没填作息表时按最常见的作息折算（8:00 开始、45 分钟一节 + 10 分钟课间）
export const DEFAULT_PERIODS = [
  [1, 2, 480, 580],
  [3, 4, 600, 700],
  [5, 6, 840, 940],
  [7, 8, 960, 1060],
  [9, 10, 1140, 1240],
  [11, 12, 1250, 1350],
];

// 「1-16周」「1~8,10-16周」「第3-16周」：只认周次那一段，前面的「第」可有可无。
const WEEKSPEC =
  /(?:第\s*)?(\d{1,2}(?:\s*[-–—~～至到]\s*\d{1,2})?(?:\s*[,，、]\s*\d{1,2}(?:\s*[-–—~～至到]\s*\d{1,2})?)*)\s*周/;

/** 设置页那栏「上课时间表」→ 节次表；看不懂的行跳过，全空就回默认表。 */
export function parsePeriods(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = PERIOD_LINE.exec(line);
    if (!m) continue;
    const fromP = Number(m[1]);
    const toP = Number(m[2]);
    const fromMin = Number(m[3]) * 60 + Number(m[4]);
    const toMin = Number(m[5]) * 60 + Number(m[6]);
    if (!(fromP >= 1 && toP >= fromP && toP <= 30)) continue;
    if (fromMin >= 24 * 60 || toMin > 24 * 60 || toMin <= fromMin) continue;
    out.push([fromP, toP, fromMin, toMin]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/** 一个 key 代表一节课（周几+开始+课名+教室），勾选列表和去重都靠它。 */
export function courseKey(c) {
  const s = `${c.weekday}|${c.fromMin}|${c.name || ''}|${c.room || ''}`;
  let hv = 5381;
  for (let i = 0; i < s.length; i += 1) hv = ((hv << 5) + hv + s.charCodeAt(i)) >>> 0;
  return `${c.weekday}-${c.fromMin}-${hv.toString(16)}`;
}

/** 勾选列表里没被取消的才提醒。没给列表 = 全提。 */
export function courseEnabled(c, off) {
  if (!Array.isArray(off) || !off.length) return true;
  return !off.includes(courseKey(c));
}

/**
 * 一天的课切成两段：上午段（开始时间 ≤ splitMin）和下午/晚上段。
 * 只回答「这一段的最后一节是哪节」——段中间下课不当由头，整段上完才算一个时刻。
 * 归属看 fromMin 不看 toMin：11:00-12:10 这种跨午间的课属于上午，否则上午段会提前在 9:40 宣布上完。
 * @returns {{morning:object|null, last:object|null, onlyMorning:boolean, onlyLater:boolean}}
 */
export function courseSegments(courses, splitMin = 720) {
  const list = (Array.isArray(courses) ? courses : []).filter((c) => Number.isFinite(c?.fromMin));
  const split = Number.isFinite(Number(splitMin)) ? Number(splitMin) : 720;
  const morning = list.filter((c) => c.fromMin <= split);
  const later = list.filter((c) => c.fromMin > split);
  const maxByTo = (arr) => arr.reduce((best, c) => (!best || c.toMin > best.toMin ? c : best), null);
  const m = maxByTo(morning);
  const l = maxByTo(later);
  return { morning: m, last: maxByTo(list), onlyMorning: Boolean(m) && !l, onlyLater: !m && Boolean(l) };
}

function periodRange(fromP, toP, table) {
  const hit = table.find((p) => fromP >= p[0] && fromP <= p[1]) || table.find((p) => p[0] === fromP);
  if (!hit) return null;
  const end = table.find((p) => toP >= p[0] && toP <= p[1]) || hit;
  return { fromMin: hit[2], toMin: end[3] };
}

/** 从一行剩下的部分里抠出周次和单双周，返回 {ranges, parity, rest}。 */
function splitWeeks(s) {
  let rest = s;
  let ranges = null;
  let parity = null;
  const wm = WEEKSPEC.exec(rest);
  if (wm) {
    const parsed = wm[1]
      .split(/[,，、]/)
      .map((t) => {
        const one = /^(\d{1,2})$/.exec(t.trim());
        if (one) {
          const n = Number(one[1]);
          return n >= 1 && n <= 30 ? [n, n] : null;
        }
        const two = /^(\d{1,2})\s*[-–—~～至到]\s*(\d{1,2})$/.exec(t.trim());
        if (!two) return null;
        const a = Number(two[1]);
        const b = Number(two[2]);
        return a >= 1 && b <= 30 && a <= b ? [a, b] : null;
      })
      .filter(Boolean);
    if (parsed.length) ranges = parsed;
    rest = rest.slice(0, wm.index) + ' ' + rest.slice(wm.index + wm[0].length);
  }
  const pm = /[（(]?\s*(单|双)\s*周?\s*[）)]?/.exec(rest);
  // 课名里本来就有「单」「双」的（单摆、双电机）要靠「周」或括号区分，光一个单/双不算
  const isParity = pm && (/[（(]/.test(pm[0]) || /周/.test(pm[0]) || !rest.slice(pm.index + pm[0].length).replace(/[）)\s]/g, ''));
  if (isParity) {
    parity = pm[1] === '单' ? 'odd' : 'even';
    rest = rest.slice(0, pm.index) + ' ' + rest.slice(pm.index + pm[0].length);
  }
  return { ranges, parity, rest };
}

// 教室：显式 @教三201 / 地点：教三201 / 末尾带楼室馆场的词 / 3-201 这种编号
const ROOM_AT = /[@＠]\s*([^\s@＠]+)/;
const ROOM_KW = /(?:地点|教室|上课地点|实验地点)\s*[:：]\s*([^\s,，;；]+)/;
const ROOM_TAIL = /(?:^|\s)([^\s]*(?:教|楼|室|馆|场|机房|实验中心)[^\s]*)$/;
const ROOM_CODE = /(?:^|\s)([A-Za-z]{0,3}\d{1,3}[-－]\d{2,4})$/;

export function splitRoom(s) {
  let rest = s;
  let room = '';
  let m = ROOM_AT.exec(rest);
  if (m) {
    room = m[1];
    rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
  }
  if (!room) {
    m = ROOM_KW.exec(rest);
    if (m) {
      room = m[1];
      rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    }
  }
  if (!room) {
    m = ROOM_CODE.exec(rest);
    if (m) {
      room = m[1];
      rest = rest.slice(0, m.index) + ' ';
    }
  }
  if (!room) {
    m = ROOM_TAIL.exec(rest);
    if (m) {
      room = m[1];
      rest = rest.slice(0, m.index) + ' ';
    }
  }
  return { room: room.trim(), rest };
}

/**
 * 一行一节 → 结构；认不出的行直接跳过（别让一个错字毁掉整张表）。
 * opts.periods 可以是「作息表」文本，也可以是 parsePeriods 的结果。
 */
export function parseAgenda(text, opts = {}) {
  const table = Array.isArray(opts.periods) ? opts.periods : parsePeriods(opts.periods);
  const periods = table.length ? table : DEFAULT_PERIODS;
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const h = HEAD.exec(t);
    if (!h) continue;
    const wd = WD[h[1]] || Number(h[1]);
    if (!(wd >= 1 && wd <= 7)) continue;
    let rest = h[2];
    let fromMin = NaN;
    let toMin = NaN;
    const tm = TIME.exec(rest);
    if (tm) {
      fromMin = Number(tm[1]) * 60 + Number(tm[2]);
      toMin = Number(tm[3]) * 60 + Number(tm[4]);
      rest = tm[5];
    } else {
      const pm = PERIOD.exec(rest);
      if (!pm) continue;
      const pr = periodRange(Number(pm[1]), Number(pm[2]), periods);
      if (!pr) continue;
      fromMin = pr.fromMin;
      toMin = pr.toMin;
      rest = pm[3];
    }
    if (fromMin >= 24 * 60 || toMin > 24 * 60 || toMin <= fromMin) continue;
    const w = splitWeeks(rest);
    const r = splitRoom(w.rest);
    // 周次/教室抠掉之后剩下的才是课名；空括号、多余标点一起清掉
    const name = r.rest
      .replace(/[（(]\s*[）)]/g, ' ')
      .replace(/^[\s,，、:：;；\-–—]+|[\s,，、:：;；\-–—]+$/g, '')
      .trim();
    const weeks = w.ranges || w.parity ? { ranges: w.ranges, parity: w.parity } : null;
    out.push({ weekday: wd, fromMin, toMin, name, room: r.room, weeks, raw: t });
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.fromMin - b.fromMin);
}

/** 从配置内联文本、显式路径或插件/旧目录 data 文件读取纯文本配置。 */
export function resolveDataText(inlineRaw, fileCfg, filename, opts = {}) {
  const inline = String(inlineRaw || '');
  if (inline.trim()) return { text: inline, from: 'config' };
  if (fileCfg) {
    try {
      return { text: fs.readFileSync(fileCfg, 'utf8'), from: fileCfg };
    } catch {
      return { text: '', from: 'none' };
    }
  }
  const hasCustomDsh = Boolean(opts?.dsh);
  const dsh = opts?.dsh || path.join(os.homedir(), '.dsh');
  const candidates = hasCustomDsh
    ? [path.join(dsh, 'dsh-drop-by', 'data', filename), path.join(dsh, 'presence-gate', 'data', filename)]
    : [
        path.join(ROOT, 'data', filename),
        path.join(dsh, 'dsh-drop-by', 'data', filename),
        path.join(dsh, 'presence-gate', 'data', filename),
      ];
  for (const file of candidates) {
    try {
      return { text: fs.readFileSync(file, 'utf8'), from: file };
    } catch {}
  }
  return { text: '', from: 'none' };
}

/** 课的文本从哪来：设置页那个多行框优先，没填才看 data/agenda.txt。 */
export function agendaSource(cfg, opts = {}) {
  return resolveDataText(cfg?.content?.agenda?.text, cfg?.content?.agenda?.file, 'agenda.txt', opts);
}

/** 课表里填的「开学第一周的周一」→ 今天是第几周；没填/填错返回 null（= 不按周次过滤）。 */
export function currentWeek(now, tz, termStart) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(termStart || '').trim());
  if (!m) return null;
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const [y, mo, d] = dayKey(now, tz).split('-').map(Number);
  const cur = Date.UTC(y, mo - 1, d);
  if (!Number.isFinite(cur)) return null;
  const diff = Math.round((cur - start) / DAY);
  if (diff < 0) return 0; // 还没开学
  return Math.floor(diff / 7) + 1;
}

/** 这节课在这一周上不上：没写周次 = 每周都上；不知道第几周 = 不过滤（不猜）。 */
export function courseApplies(c, week) {
  if (!c?.weeks) return true;
  if (!Number.isFinite(week) || week <= 0) return true;
  if (c.weeks.parity === 'odd' && week % 2 === 0) return false;
  if (c.weeks.parity === 'even' && week % 2 === 1) return false;
  if (c.weeks.ranges && c.weeks.ranges.length) {
    return c.weeks.ranges.some(([a, b]) => week >= a && week <= b);
  }
  return true;
}

/** 1=周一 … 7=周日。 */
export function weekdayOf(now, tz) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'Asia/Shanghai', weekday: 'short' }).format(new Date(now));
  const map = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  return map[s] || 0;
}

/** 某一天的课，按开始时间排好。opts.week 给了就按周次/单双周过滤。 */
export function coursesOn(text, weekday, opts = {}) {
  return parseAgenda(text, opts).filter((c) => c.weekday === weekday && courseApplies(c, opts.week));
}

/** 明天的课（周日往后数到周一，不会漏）。termStart 给了就按明天的周次过滤。 */
export function coursesTomorrow(text, now, tz, opts = {}) {
  const tomorrow = now + DAY;
  const wd = weekdayOf(tomorrow, tz);
  const week = Number.isFinite(opts.week) ? opts.week : currentWeek(tomorrow, tz, opts.termStart);
  return coursesOn(text, wd, { ...opts, week });
}

/**
 * 下一节还没开始的课（7 天内）；课表空、或者全被勾掉了就是 null。
 * 带周次的课按那一周的周次筛。
 */
export function nextCourse(text, now, tz, opts = {}) {
  const mins = minutesOfDayOf(now, tz);
  const day = dayKey(now, tz);
  const all = parseAgenda(text, opts).filter((c) => courseEnabled(c, opts.off));
  let best = null;
  for (let i = 0; i < 8; i += 1) {
    const ts = now + i * DAY;
    const wd = weekdayOf(ts, tz);
    const week = Number.isFinite(opts.week) ? opts.week + i : currentWeek(ts, tz, opts.termStart);
    for (const c of all.filter((x) => x.weekday === wd && courseApplies(x, week))) {
      const start = i === 0 ? c.fromMin : i * 1440 + c.fromMin;
      if (i === 0 && c.fromMin <= mins) continue; // 今天这节课已经开始了
      if (!best || start < best.offsetMin) best = { ...c, key: courseKey(c), offsetMin: start, day: i === 0 ? day : null, inDays: i, week };
    }
    if (best && best.inDays === 0) break; // 今天还有课就一定是最近的
  }
  return best;
}