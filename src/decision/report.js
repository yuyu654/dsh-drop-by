// report.js —— 阶段 5.2：每天一条日报。
//
// 数据源就是现有 decision-<day>.jsonl，不另存一份账。
// 「按天去重只记一次」靠文件本身：daily-<day>.md 已存在就不再写（想重算用 force）。
// 行数硬上限 15：日报是给人扫的，不是日志第二份。
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from '../settings/config.js';
import { recordDay, shiftDay } from '../settings/retention.js';
import { shadowLine } from './shadow.js';
import { isSpecificTopicMiss, phonePauseText, topicMissText } from './explain.js';

const MAX_LINES = 15;
const restraintLabels = { GLOBAL_QUIET: '全局静默', QUIET_HOURS: '全局静默', BUSY_HOURS: '你在忙',
  CHARACTER_ASLEEP: '角色休息', USER_WINDING_DOWN: '对方在收尾', GAP_TOO_SHORT: '间隔保护' };

function reviewStart(cfg, today) {
  const count = Math.max(1, Math.min(7, Math.trunc(Number(cfg.logging?.reportDays) || 7)));
  return shiftDay(today, 1 - count);
}

export function dayFile(day) {
  return path.join(LOG_DIR, `decision-${day}.jsonl`);
}
export function reportFile(day) {
  return path.join(LOG_DIR, `daily-${day}.md`);
}

/** 读某一天的判定日志；读不到就当空。 */
export function readDayRecords(day) {
  try {
    return fs
      .readFileSync(dayFile(day), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function topCounts(entries, n = 6) {
  return entries
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, c]) => `${k}×${c}`)
    .join('、');
}

/** 一行行拼出来；调用方保证 records 是这一天的。 */
export function buildDailyReport({ day, records = [], cfg = {}, st = {} }) {
  const sends = records.filter((r) => r?.decision === 'send' && r?.content_ok !== false);
  const real = sends.filter((r) => r?.delivery?.attempted === true && r?.delivery?.ok === true);
  const sim = sends.filter((r) => r?.delivery?.attempted !== true);

  const slotCount = new Map();
  const srcCount = new Map();
  for (const r of sends) {
    const slot = r?.topic?.slot || r?.content?.slot || '—';
    slotCount.set(slot, (slotCount.get(slot) || 0) + 1);
    const src = r?.content?.source || '—';
    srcCount.set(src, (srcCount.get(src) || 0) + 1);
  }

  const reasonCount = new Map();
  const restraint = new Map();
  const topicMissCount = new Map();
  for (const r of records) {
    if (r?.decision !== 'skip') continue;
    const k = String(r?.reason || '—');
    const label = Object.hasOwn(restraintLabels, k) ? restraintLabels[k] : '';
    if (label) restraint.set(label, (restraint.get(label) || 0) + 1);
    else reasonCount.set(k, (reasonCount.get(k) || 0) + 1);
    if (k === 'NO_TOPIC') {
      const codes = new Set((r.topicMisses || []).map(item => item.reason));
      for (const code of codes) {
        if (isSpecificTopicMiss(code)) {
          const label = topicMissText(code);
          topicMissCount.set(label, (topicMissCount.get(label) || 0) + 1);
        }
      }
    }
  }

  const replied = records.filter((r) => r?.backfill?.hit === true).length;

  const judged = records.filter((r) => r?.judge);
  const sayTrue = judged.filter((r) => r.judge.say === true).length;
  const sayFalse = judged.filter((r) => r.judge.say === false).length;
  const fail = judged.filter((r) => r.judge.fallback === true).length;

  const lines = [];
  lines.push(`# 日报 ${day}（记录日 ${cfg?.logging?.dayStartHour ?? 7}:00 起算）`);
  lines.push(
    `发了 ${sends.length} 条（真发 ${real.length} / 演练 ${sim.length}）` +
      (slotCount.size ? `：${topCounts([...slotCount])}` : ''),
  );
  if (srcCount.size) lines.push(`  来源：${topCounts([...srcCount])}`);
  const skipped = records.filter((r) => r?.decision === 'skip').length;
  lines.push(`被拦 ${skipped} 拍${reasonCount.size ? `：${topCounts([...reasonCount])}` : ''}`);
  if (restraint.size) {
    const labels = [...new Set(Object.values(restraintLabels))];
    const parts = labels.filter(label => restraint.has(label)).map(label => `${label} ${restraint.get(label)} 拍`);
    const count = [...restraint.values()].reduce((total, n) => total + n, 0);
    lines.push(`克制记录：这 ${count} 拍没有打扰（${parts.join('、')}）`);
  }
  if (topicMissCount.size) lines.push(`无合适由头：${topCounts([...topicMissCount], 3)}`);
  const phone = records.findLast(r => r?.phone?.stale || r?.phone?.missing)?.phone ||
    records.findLast(r => r?.kind === 'fish_stale');
  if (phone) lines.push(phonePauseText({ stale: true, ...phone }));
  lines.push(`她接住 ${replied} 条（发出后半小时内回话）`);
  if (judged.length) lines.push(`judge：真判 ${judged.length}（说 ${sayTrue} / 不说 ${sayFalse} / 判坏 ${fail}）`);
  const sl = shadowLine(st, cfg);
  if (sl) lines.push(`  ${sl}`);
  return lines.slice(0, MAX_LINES).join('\n') + '\n';
}

/**
 * 写当天日报。已存在且没 force → 不写（返回 written:false）。
 * st 只用于 judge 预演计数（shadowLine）。
 */
export function writeDailyReport({ cfg = {}, now = Date.now(), tz, day = null, force = false, st = {} } = {}) {
  const d = day || recordDay(now, tz || cfg.timezone, cfg);
  const file = reportFile(d);
  if (!force && fs.existsSync(file)) return { written: false, day: d, file };
  const text = buildDailyReport({ day: d, records: readDayRecords(d), cfg, st });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  return { written: true, day: d, file, text };
}

/**
 * 换日那一刻把「昨天」的日报补上（tick 每 10 分钟跑，最迟十分钟内落地）。
 * 一天只试一次：st.report = { day }。返回写了什么 / 没写的原因。
 */
export function maybeWriteYesterdayReport({ cfg = {}, now = Date.now(), tz, st = {} } = {}) {
  const today = recordDay(now, tz || cfg.timezone, cfg);
  if (st.report?.day === today) return { written: false, day: null, reason: 'ALREADY_TRIED' };
  const prev = shiftDay(today, -1);
  // 保留至少昨天的归档，即使设置页只看今天。
  const oldest = [prev, reviewStart(cfg, today)].sort()[0];
  let latest = { written: false, day: prev, reason: 'NO_RECORDS' };
  for (let day = prev; day >= oldest; day = shiftDay(day, -1)) {
    if (!fs.existsSync(dayFile(day)) || fs.existsSync(reportFile(day)) || !readDayRecords(day).length) continue;
    const result = writeDailyReport({ cfg, now, tz, day, st });
    if (!latest.written) latest = result;
  }
  st.report = { day: today, at: now };
  return latest;
}
/** Recent summaries can be read without creating or updating report files. */
export function recentReports({ cfg, st, now = Date.now() }) {
  const today = recordDay(now, cfg.timezone, cfg);
  const oldest = reviewStart(cfg, today);
  let files;
  try { files = fs.readdirSync(LOG_DIR); } catch { return []; }
  const days = new Set();
  for (const file of files) {
    const match = /^(?:decision-(\d{4}-\d{2}-\d{2})\.jsonl|daily-(\d{4}-\d{2}-\d{2})\.md)$/.exec(file);
    const day = match && (match[1] || match[2]);
    if (day && day >= oldest && day <= today) days.add(day);
  }
  return [...days].sort().reverse().flatMap(day => {
    const records = readDayRecords(day);
    const sent = records.some(r => r.delivery?.attempted === true && r.delivery?.ok === true);
    if (day !== today || !records.length) {
      try {
        const text = fs.readFileSync(reportFile(day), 'utf8').split('\n').slice(0, MAX_LINES).join('\n');
        return [{ day, text, sent: sent || /真发 [1-9]\d* \/ 演练/u.test(text) }];
      } catch { /* 没有现成的日报，按仍保留的决策日志生成。 */ }
    }
    if (!records.length) return [];
    return [{ day, text: buildDailyReport({ day, records, cfg, st: day === today ? st : {} }), sent }];
  });
}
