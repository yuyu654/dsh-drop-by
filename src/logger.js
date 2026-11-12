// logger.js —— 每个 tick 一行 JSONL，按「记录日」分文件。
//
// 「一天」以 logging.dayStartHour（默认 07:00）为界，跟邮件归档、感知记录同一套。
// 清理不在这里做了：统一交给 retention.js，否则会变成两套规则互相打架
// （这里按自然日算 cutoff、那边按健康日算，边界那几个小时就会漏删/错删）。
import fs from 'node:fs';
import path from 'node:path';
import { LOG_DIR } from './config.js';
import { recordDay } from './retention.js';

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function logFile(now, timezone, cfg = null) {
  return path.join(LOG_DIR, `decision-${recordDay(now, timezone, cfg)}.jsonl`);
}

/** 写一行（对象会被压成单行 JSON）。 */
export function append(record, now, timezone, cfg = null) {
  ensureDir();
  fs.appendFileSync(logFile(now, timezone, cfg), JSON.stringify(record) + '\n', 'utf8');
}

/**
 * 同一种 kind 在一个记录日里只写一次。
 * 用来落「数据断供」这类告警：每 10 分钟一拍，不能每拍都写一条；而 tail 只读当天的文件，
 * 天然就是「按天去重」，不用往 state 里塞任何东西（dryRun 也不该碰 state）。
 * 返回是否真写了。
 */
export function appendOnce(record, now, timezone, cfg = null) {
  const kind = String(record?.kind || '');
  if (kind && tail(500, now, timezone, cfg).some((r) => r?.kind === kind)) return false;
  append(record, now, timezone, cfg);
  return true;
}

/** 读最近 N 行，给 --status / 回看用。 */
export function tail(n, now, timezone, cfg = null) {
  try {
    const lines = fs.readFileSync(logFile(now, timezone, cfg), 'utf8').trim().split('\n');
    return lines
      .slice(-n)
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
