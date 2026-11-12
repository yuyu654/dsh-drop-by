// report.js —— 阶段 5.2：每天一条日报。
//
// 数据源就是现有 decision-<day>.jsonl，不另存一份账。
// 「按天去重只记一次」靠文件本身：daily-<day>.md 已存在就不再写（想重算用 force）。
// 行数硬上限 15：日报是给人扫的，不是日志第二份。
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';
import { recordDay, shiftDay } from './retention.js';
import { shadowLine } from './shadow.js';

const MAX_LINES = 15;

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
  for (const r of records) {
    if (r?.decision !== 'skip') continue;
    const k = String(r?.reason || '—');
    reasonCount.set(k, (reasonCount.get(k) || 0) + 1);
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
  st.report = { day: today, at: now };
  if (!prev || !fs.existsSync(dayFile(prev))) return { written: false, day: prev, reason: 'NO_RECORDS' };
  return writeDailyReport({ cfg, now, tz, day: prev, st });
}