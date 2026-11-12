// retention.js —— 「记录什么」和「记多久」。
//
// 两件事：
//   1) 归档：每封 FISH 邮件解析完落到 data/fish/<健康日>.json，不只留最新一封。
//      只有 latest 的话，昨天的睡眠数据第二天就被覆盖，回看不了、也没法验证判定。
//   2) 清理：所有按天切分的记录只留最近 keepDays 天（默认 2 = 今天 + 昨天），
//      更早的整文件删掉。不做行级裁剪——按天删文件，简单、可预测、不会写坏。
//
// 「一天」= 健康日：默认早上 07:00 起算（logging.dayStartHour）。
// 所以凌晨 2 点仍算前一天，07:00 那一刻换日、并触发一次清理。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, LOG_DIR } from './config.js';
import { healthDay } from './time.js';

export const FISH_ARCHIVE_DIR = path.join(ROOT, 'data', 'fish');

/** 记录日的起点小时：默认 7 点，跟睡眠/压力同一套「一天」。 */
export function dayStartHour(cfg) {
  const h = Number(cfg?.logging?.dayStartHour ?? 7);
  return Number.isFinite(h) && h >= 0 && h < 24 ? h : 7;
}

/** 这一刻属于哪一个记录日（YYYY-MM-DD，07:00 起算）。 */
export function recordDay(now, tz, cfg) {
  return healthDay(now, tz || cfg?.timezone || 'Asia/Shanghai', dayStartHour(cfg));
}

/** 日期字符串 ±N 天，纯字符串进出，避免时区再插一脚。 */
export function shiftDay(day, delta) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ''));
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + Number(delta) * 86400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** 保留 keepDays 天时，最早还该留的那一天。keepDays=2 → 昨天。 */
export function cutoffDay(cfg, now, tz) {
  const keep = Math.max(1, Number(cfg?.logging?.keepDays ?? 2) || 2);
  return shiftDay(recordDay(now, tz, cfg), -(keep - 1));
}

const LOG_RE = /^(decision|perception|mail)-(\d{4}-\d{2}-\d{2})(?:\.jsonl)$/;
const ARCHIVE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

function listFiles(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * 删掉早于 cutoff 的记录文件。幂等：随时可跑，跑多少遍结果一样。
 * 返回 { cutoff, removed:[{file,day}], kept:[{file,day}], errors:[] }
 */
export function pruneOldRecords(cfg, now, { logDir = LOG_DIR, fishDir = FISH_ARCHIVE_DIR, tz } = {}) {
  const cutoff = cutoffDay(cfg, now, tz || cfg?.timezone);
  const keepDays = Math.max(1, Number(cfg?.logging?.keepDays ?? 2) || 2);
  const removed = [];
  const kept = [];
  const errors = [];

  for (const dir of [logDir, fishDir]) {
    for (const name of listFiles(dir)) {
      const m = LOG_RE.exec(name) || ARCHIVE_RE.exec(name);
      if (!m) continue;
      const day = LOG_RE.test(name) ? m[2] : m[1];
      if (!day || day >= cutoff) {
        kept.push({ file: path.join(dir, name), day });
        continue;
      }
      try {
        fs.unlinkSync(path.join(dir, name));
        removed.push({ file: path.join(dir, name), day });
      } catch (e) {
        errors.push({ file: path.join(dir, name), note: String(e?.message || e).slice(0, 120) });
      }
    }
  }
  removed.sort((a, b) => (a.day < b.day ? -1 : 1));
  return { cutoff, keepDays, removed, kept, errors };
}

// ---------------------------------------------------------------- 邮件归档

/**
 * 一天里来了第二封邮件怎么办？三种口径，写在 logging.mailUpdateMode：
 *
 *   merge   （默认）补充：这一天只留一条，新邮件**并在原内容上**——
 *           新邮件有的字段用新的，缺的用旧的补；摘要按行去重、最新在前。
 *           早上那封有睡眠+起床、中午那封只有压力/屏幕时，合并后两样都在。
 *   replace 替换：这一天只留最新一封，旧内容整条丢掉。
 *   append  追加：一封一条，各算各的（新增行为，回看时能看到当天每一封）。
 */
export const MAIL_UPDATE_MODES = ['merge', 'replace', 'append'];

export function mailUpdateMode(cfg) {
  const v = String(cfg?.logging?.mailUpdateMode ?? 'merge').trim().toLowerCase();
  return MAIL_UPDATE_MODES.includes(v) ? v : 'merge';
}

/** 摘要合并：新的一封在前，旧的按行补进来，同文不重复。 */
function mergeSummary(newer, older) {
  const out = [];
  const seen = new Set();
  for (const block of [newer, older]) {
    for (const raw of String(block || '').split('\n')) {
      const line = raw.replace(/\s+$/u, '');
      const key = line.trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(line);
    }
  }
  return out.join('\n').slice(0, 4000);
}

/** 新邮件优先；它没有（null/undefined）的字段才用旧的补。 */
function fillMissing(base, older) {
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(older || {})) {
    if ((out[k] === null || out[k] === undefined) && v !== null && v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * 一封邮件落进 data/fish/<健康日>.json。
 * 同一天同一 uid 再写不会堆重复（邮箱重连会重复抓到同一封）。
 * 解析结果一起存：只存原文的话，下次回看还得再解析一遍，而且解析规则一改旧记录就对不上。
 */
export function archiveFishMail(payload, { cfg, now = Date.now(), dir = FISH_ARCHIVE_DIR, parsed = null, mode = null } = {}) {
  // 按邮件自己的日期归档，不按抓取日期：昨天晚上的邮件今天才抓到，
  // 也该落在昨天那本账里，不然「今天」的合并摘要会混进昨天的数字。
  const ts = Number(payload?.dateTs) || Number(payload?.fetchedAt) || now;
  const day = recordDay(ts, cfg?.timezone, cfg);
  const file = path.join(dir, `${day}.json`);
  const uid = Number(payload?.uid) || 0;
  const how = mode || mailUpdateMode(cfg);

  let doc = { day, updatedAt: null, mode: how, mails: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (prev && Array.isArray(prev.mails)) doc = { day, updatedAt: prev.updatedAt || null, mode: how, mails: prev.mails };
  } catch {
    /* 没有就新建 */
  }

  const summary = String(payload?.summary || '');
  const entry = {
    uid,
    subject: String(payload?.subject || ''),
    date: payload?.date || '',
    dateTs: payload?.dateTs ?? null,
    fetchedAt: ts,
    fetchedLocal: new Date(ts).toISOString(),
    chars: Number(payload?.chars) || summary.length,
    summary: summary.slice(0, 4000),
    // 原文只留 8000 字：排查够用，又不至于把 data 目录撑大
    text: String(payload?.text || summary).slice(0, 8000),
    parsed: parsed || {},
  };

  const sameIdx = doc.mails.findIndex((m) => Number(m.uid) === uid);
  const same = sameIdx >= 0 ? doc.mails[sameIdx] : null;
  const others = doc.mails.filter((_, i) => i !== sameIdx);

  let outEntry = entry;

  if (how === 'append') {
    if (sameIdx >= 0) doc.mails[sameIdx] = entry;
    else doc.mails.push(entry);
    doc.mails.sort((a, b) => (a.fetchedAt || 0) - (b.fetchedAt || 0));
  } else if (how === 'replace') {
    // 直接顶掉当天原内容：旧封不留，只记丢了几条
    outEntry = { ...entry, replaced: others.length || undefined };
    doc.mails = [outEntry];
  } else {
    // merge：拿这一封当底，把当天已有的内容（含之前合过的整天记录）按「新的在前」铺进去
    const layers = [];
    if (same) layers.push(same); // 同一封重取：它本身可能就是合过的，要先继承
    for (const o of others) layers.push(o);
    layers.sort((a, b) => (Number(b.fetchedAt) || 0) - (Number(a.fetchedAt) || 0));

    const merged = { ...entry };
    const uids = [];
    const earlier = [];
    const seenUid = new Set();
    const addUid = (u) => {
      const n = Number(u) || 0;
      if (!n || seenUid.has(n)) return;
      seenUid.add(n);
      uids.push(n);
    };
    addUid(uid);

    for (const L of layers) {
      merged.summary = mergeSummary(merged.summary, L.summary);
      merged.parsed = fillMissing(merged.parsed, L.parsed);
      for (const u of Array.isArray(L.uids) ? L.uids : [L.uid]) addUid(u);
      for (const e of Array.isArray(L.earlier) ? L.earlier : []) addUid(e?.uid);
      merged.firstAt = Math.min(Number(merged.firstAt) || ts, Number(L.fetchedAt) || ts);
    }

    // earlier 只记「这一天更早还有哪几封」，文字已经在合并摘要里了
    for (const L of layers) {
      const lu = Number(L.uid) || 0;
      if (!lu || lu === uid) continue;
      earlier.push({ uid: lu, subject: String(L.subject || ''), fetchedAt: Number(L.fetchedAt) || 0 });
    }
    earlier.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));

    merged.uids = uids;
    merged.mailCount = uids.length;
    merged.firstAt = merged.firstAt || ts;
    merged.chars = merged.summary.length;
    merged.merged = uids.length > 1;
    if (earlier.length) merged.earlier = earlier;
    doc.mails = [merged];
    outEntry = merged;
  }

  doc.updatedAt = new Date(now).toISOString();

  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { file, day, uid, mode: how, total: doc.mails.length, entry: outEntry, mailsToday: outEntry.mailCount || 1 };
}

/** 读最近 keepDays 天的归档，最新的邮件在前。 */
export function readFishArchive(cfg, now, { dir = FISH_ARCHIVE_DIR, days = null } = {}) {
  const keep = Math.max(1, Number(days ?? cfg?.logging?.keepDays ?? 2) || 2);
  const cutoff = shiftDay(recordDay(now, cfg?.timezone, cfg), -(keep - 1));
  const out = [];
  for (const name of listFiles(dir)) {
    const m = ARCHIVE_RE.exec(name);
    if (!m || m[1] < cutoff) continue;
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      for (const mail of Array.isArray(doc.mails) ? doc.mails : []) out.push({ day: m[1], ...mail });
    } catch {
      /* 坏文件跳过，不阻塞 */
    }
  }
  return out.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
}

/** 给 --records 用：现在各留了几天、大概多少字节。 */
export function recordSummary(cfg, now, { logDir = LOG_DIR, fishDir = FISH_ARCHIVE_DIR } = {}) {
  const cutoff = cutoffDay(cfg, now, cfg?.timezone);
  const today = recordDay(now, cfg?.timezone, cfg);
  const groups = { decision: [], perception: [], mail: [], fish: [] };
  for (const dir of [logDir, fishDir]) {
    for (const name of listFiles(dir)) {
      let key = null;
      let day = null;
      const lm = LOG_RE.exec(name);
      const am = ARCHIVE_RE.exec(name);
      if (lm) {
        key = lm[1];
        day = lm[2];
      } else if (am) {
        key = 'fish';
        day = am[1];
      }
      if (!key) continue;
      let size = 0;
      try {
        size = fs.statSync(path.join(dir, name)).size;
      } catch {
        /* ignore */
      }
      groups[key].push({ file: path.join(dir, name), name, day, size, stale: day < cutoff });
    }
  }
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => (a.day < b.day ? -1 : 1));
  return { today, cutoff, keepDays: Math.max(1, Number(cfg?.logging?.keepDays ?? 2) || 2), groups };
}
