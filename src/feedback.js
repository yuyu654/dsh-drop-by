// feedback.js —— 记「发出去之后她接没接」。
//
// 这是整个插件里唯一一个「反向」的信号：别的都由头决定发不发，这里用她的反应
// 反过来决定哪几类由头该歇一歇。只读写 state，不联网、不发消息。
//
// 规则（全部可关、可调）：
//   - 每次真发出去记一条 pending；她之后说的话（时间戳晚于它）算有回应。
//   - 一条消息一生只判一次，判定点只有两处：她开口时（settle）、或者窗口过了（sweep）。
//   - 判定按一条 4 小时窗口走，窗口碰到 23:30 就截断：
//       ≤45 分钟           → hit    接住
//       ≤窗口结束          → late   晚回（算接住，标签「隔了一阵」）
//       超过窗口、有回应   → stray  隔了很久才回（算接住，标签「隔了很久」）
//       超过窗口、没回应   → miss（只有整段窗口都落在白天才算；否则这次不算数）
//   - 同一类由头发够 coldAfter 次、接住率低于 coldRate → 压 coldDays 天。
//   - 连着几条都没回 → 两条之间自动拉长（最多 gapMaxX 倍），别在没人应的时候一直敲。
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOG_DIR, updateStatePreferences, updateStateReceiptOverrides } from './config.js';
import { dayKey, minutesOfDayOf } from './time.js';

const DAY = 86_400_000;
const MIN = 60_000;
const feedbackTiming = (cfg) => cfg?.rules?.feedback || {};
const chitTiming = (cfg) => cfg?.rules?.chitchat || {};

// 「回她」「接转发」和「角色睡前/刚醒」不是期待必回的搭话：
// 发完一句对方没接是常态，不算「没接住」。所以这几类**不进接住率、不进 streak、不变成追问的由头**，
// 只留一条 pending 用来配「我说了什么 → 她回了什么」的对照。
const NO_EXPECT = new Set(['reply', 'forward', 'characterRest']);

const PREFERENCE_MODES = new Set(['allow_silent', 'mute_less']);
const NON_PROACTIVE_SLOTS = new Set(['reply', 'forward', 'noReply', 'fixed']);

export function normalizePreferenceKeyword(value) {
  const text = String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return /^[\p{L}\p{N}][\p{L}\p{N} _·-]{1,47}$/u.test(text) ? text : '';
}

export function activeTopicPreferences(st, now = Date.now()) {
  const rows = st?.feedback?.preferences;
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => PREFERENCE_MODES.has(row?.mode) &&
    (row.target?.slot || normalizePreferenceKeyword(row.target?.keyword)) &&
    (row.expiresAt == null || (Number.isFinite(row.expiresAt) && now < row.expiresAt)));
}

function topicThemes(topic) {
  const e = topic?.evidence || {};
  return [e.section, e.topic, e.subject, e.source?.title, e.title, e.name, e.seed, e.theme]
    .filter(value => typeof value === 'string' && value.trim());
}

export function topicPreferenceMode(st, topic, now = Date.now()) {
  if (!topic?.slot || NON_PROACTIVE_SLOTS.has(topic.slot)) return null;
  let mode = null;
  for (const pref of activeTopicPreferences(st, now)) {
    const keyword = normalizePreferenceKeyword(pref.target.keyword);
    const matches = pref.target.slot === topic.slot || (keyword && topicThemes(topic).some(value =>
      value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').includes(keyword)));
    if (!matches) continue;
    if (pref.mode === 'mute_less') return pref.mode;
    mode = pref.mode;
  }
  return mode;
}

export function noteProactive(st, topic, { channel, peer, at }) {
  if (!topic?.slot || NON_PROACTIVE_SLOTS.has(topic.slot) || !peer || !Number.isFinite(at)) return;
  const themes = topicThemes(topic);
  const theme = themes.find(value => normalizePreferenceKeyword(value)) || themes[0] || '';
  ensure(st).lastProactive = { slot: topic.slot, theme: theme.trim().slice(0, 120),
    ts: at, channel, peer: String(peer) };
}

export function lastProactiveTarget(st, { channel, peer, at }, cfg) {
  const last = st?.feedback?.lastProactive;
  const age = at - last?.ts;
  const hours = Math.min(24, Number(feedbackTiming(cfg).keepHours ?? 24));
  if (!last?.slot || last.channel !== channel || last.peer !== String(peer) || !(age > 0 && age < hours * 3_600_000)) return null;
  const keyword = normalizePreferenceKeyword(last.theme);
  return keyword ? { keyword } : { slot: last.slot };
}

function preferenceExpiry(until, at, tz) {
  if (!until) return null;
  const today = Date.parse(dayKey(at, tz) + 'T00:00:00Z');
  const days = until === '这周' ? 7 - ((new Date(today).getUTCDay() + 6) % 7) : 1;
  const target = today + days * DAY;
  const key = new Date(target).toISOString().slice(0, 10);
  // Find the first instant with the target local date, including DST changes.
  let low = target - DAY;
  let high = target + DAY;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (dayKey(mid, tz) < key) low = mid + 1;
    else high = mid;
  }
  return low;
}

const targetKey = (target) => target.slot ? 'slot:' + target.slot : 'keyword:' + normalizePreferenceKeyword(target.keyword);

export function saveTopicPreference(preference, source, cfg) {
  return updateStatePreferences(st => {
    const { mode, quote, until } = preference;
    const target = preference.target.recent ? lastProactiveTarget(st, source, cfg) : preference.target;
    if (!target) return null;
    const key = targetKey(target);
    const keep = activeTopicPreferences(st, source.at).filter(row => targetKey(row.target) !== key);
    if (mode !== 'reset') keep.push({ mode, target, quote, channel: source.channel, peer: String(source.peer),
      expiresAt: preferenceExpiry(until, source.at, cfg?.timezone) });
    return { preferences: keep, result: { mode, target } };
  });
}

export function emptyFeedback() {
  return { pending: [], slots: {}, streak: 0 };
}

// 阶段 2（0.14）：每类留最近 10 对「我说了什么 → 她回了什么」。
// 只留原文前 80 字，state 体积可控；dryRun 永远不写进来。
const PAIRS_MAX = 10;
const DRAFT_MAX = 80;

function ensure(st) {
  st.feedback ||= emptyFeedback();
  const f = st.feedback;
  f.pending ||= [];
  f.slots ||= {};
  if (!Number.isFinite(Number(f.streak))) f.streak = 0;
  return f;
}

function slotRec(f, slot) {
  return (f.slots[slot] ||= { sent: 0, replied: 0, missed: 0, latencySum: 0, lastSentAt: 0, lastRepliedAt: 0, coldUntil: 0, pairs: [] });
}

/**
 * 这一条的回应窗口什么时候结束：发出后 4 小时，或者当天 23:30，先到者。
 * 深夜发的，窗口可能在发出前就结束了（那天已经没人看着）——调用方按 stray 处理。
 */
export function windowEnd(ts, tz = 'Asia/Shanghai', timing = {}) {
  const m = minutesOfDayOf(ts, tz);
  return Number(ts) + Math.min(Number(timing.windowMin ?? 240), Number(timing.dayEndMin ?? 1410) - m) * MIN;
}

/** 这段窗口是不是完整落在白天（08:30 之后发、19:30 之前发，4 小时全在白天）。 */
function fairWindow(ts, tz, timing) {
  const m = minutesOfDayOf(ts, tz);
  return m >= Number(timing.dayStartMin ?? 510) && m + Number(timing.windowMin ?? 240) <= Number(timing.dayEndMin ?? 1410);
}

/**
 * 判一条 pending：herTs 是她下一句话的时间；没有回应就传 Infinity。
 * 返回 { kind: 'hit'|'late'|'stray'|'miss', latMin }。
 */
export function classify(p, herTs, tz = 'Asia/Shanghai', timing = {}) {
  const ts = Number(herTs);
  if (!Number.isFinite(ts)) {
    return { kind: fairWindow(p.ts, tz, timing) ? 'miss' : 'stray', latMin: null };
  }
  const latMin = Math.max(0, Math.round((ts - p.ts) / MIN));
  if (latMin <= Math.min(Number(timing.hitMin ?? 45), Number(timing.windowMin ?? 240))) return { kind: 'hit', latMin };
  if (ts <= windowEnd(p.ts, tz, timing)) return { kind: 'late', latMin };
  // 她回了、只是隔了很久：算回过（stray）。miss 只在「一句都没回」时才判。
  return { kind: 'stray', latMin };
}

/**
 * 真发出去一条：记待回、记这一类发过。dryRun 不要调这个。
 * opts.expect=false：保留对照记录，但沉默不参与反馈。
 * opts.test：测试期（rules.feedback.testMode）——只留一条「发过」的痕迹用来配对回看，
 * **不进分母、不动 streak、不判没接住**。插件没完工时她的沉默不代表这类话不行。
 */
export function noteSent(st, slot, now, text, opts = {}) {
  if (!slot) return;
  const f = ensure(st);
  const test = opts.test === true;
  const expect = opts.expect !== false && !NO_EXPECT.has(slot);
  if (!test && expect) {
    const s = slotRec(f, slot);
    s.sent += 1;
    s.lastSentAt = now;
  }
  // draft：我发出去的原文前 80 字——配对时才有「我问的是什么」可回看
  f.pending.push({
    slot,
    ...(opts.channel ? { channel: opts.channel } : {}),
    ts: now,
    chars: String(text || '').length,
    draft: String(text || '').slice(0, DRAFT_MAX),
    ...(!test && expect ? { receiptId: randomUUID(), sentAt: opts.sentAt ?? now } : {}),
    ...(expect ? {} : { expect: false }),
    ...(test ? { test: true } : {}),
  });
  f.pending = f.pending.slice(-12);
  if (!test && expect) f.streak = (Number(f.streak) || 0) + 1;
}

function settledReceipts(slot) {
  if (Array.isArray(slot?.receipts)) return slot.receipts;
  if (!slot?.replied || !Array.isArray(slot.pairs)) return [];
  // 旧状态只有配对，回复时间减去当时记录的延迟就是发出时间。
  return slot.pairs.flatMap((pair, index) => {
    if (pair?.expect === false || !Number.isFinite(pair?.ts) || !Number.isFinite(pair.latencyMin)) return [];
    const ts = pair.ts - pair.latencyMin * MIN;
    return [{ id: 'legacy-' + index + '-' + ts, ts, received: true }];
  });
}

function manualReceipts(st, slot) {
  const rows = st.feedback?.receiptOverrides?.[slot];
  return Array.isArray(rows) ? rows : [];
}

function receiptIdentity(p) {
  const ts = p.sentAt ?? p.ts;
  const id = p.receiptId ?? ('pending-' + (p.channel || 'qq') + '-' + ts);
  return { id, ts };
}

function recentDecisionSends(slot, logDir = LOG_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(logDir).filter(name => /^decision-.*\.jsonl$/u.test(name)).sort().reverse();
  } catch {
    return [];
  }
  const seen = new Set();
  const times = [];
  for (const name of files) {
    let text = '';
    try { text = fs.readFileSync(path.join(logDir, name), 'utf8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.delivery?.ok !== true || rec.dry_run === true || rec.dryRun === true ||
          rec.track !== 'proactive' || rec.topic?.slot !== slot || !Number.isFinite(rec.ts)) continue;
      if (seen.has(rec.ts)) continue;
      seen.add(rec.ts);
      times.push(rec.ts);
    }
  }
  return times.sort((a, b) => b - a);
}

export function receiptDetails(st, slot, opts = {}) {
  const tz = opts.tz || 'Asia/Shanghai';
  const timing = feedbackTiming(opts.cfg);
  const logDir = opts.logDir ?? LOG_DIR;
  const stat = st.feedback?.slots?.[slot];
  const settled = settledReceipts(stat);
  const rows = new Map(settled.map(row => [row.id, { ...row, manual: false }]));
  let hasPending = false;
  for (const pending of st.feedback?.pending || []) {
    if (pending.slot !== slot || pending.test === true || pending.expect === false || NO_EXPECT.has(slot)) continue;
    hasPending = true;
    const { id, ts } = receiptIdentity(pending);
    if (Number.isFinite(ts) && !rows.has(id)) rows.set(id, { id, ts, received: null, manual: false, status: 'pending' });
  }
  const manual = manualReceipts(st, slot);
  // 手动标记离开近期列表后仍可撤销，继续保留它的发送时间。
  for (const { id, ts } of manual) rows.set(id, { id, ts, received: true, manual: true });

  const accountedMisses = new Set([
    ...settled.filter(row => row.received === false).map(row => row.id),
    ...manual.map(row => row.id),
  ]);
  let remainingMisses = Math.max(0, (Number(stat?.missed) || 0) - accountedMisses.size);
  const nearExisting = (ts) => {
    for (const row of rows.values()) {
      if (Math.abs(row.ts - ts) <= 120_000) return true;
    }
    return false;
  };
  const last = Number(stat?.lastSentAt);
  const lastReplied = Number(stat?.lastRepliedAt) || 0;

  if (remainingMisses > 0 && !NO_EXPECT.has(slot)) {
    for (const ts of recentDecisionSends(slot, logDir)) {
      if (remainingMisses <= 0) break;
      if (last > 0 && Number.isFinite(last) && ts > last + 120_000) continue;
      if (nearExisting(ts) || !fairWindow(ts, tz, timing)) continue;
      const id = 'log-' + slot + '-' + ts;
      rows.set(id, { id, ts, received: false, manual: false });
      remainingMisses -= 1;
    }
  }

  const details = [...rows.values()];
  if (last > 0 && Number.isFinite(last) && !nearExisting(last) && !details.some(row => row.ts >= last)) {
    const provablyMissed = !hasPending && remainingMisses > 0 && last > lastReplied &&
      (fairWindow(last, tz, timing) || ((Number(stat?.replied) || 0) === 0 && (Number(stat?.missed) || 0) >= (Number(stat?.sent) || 0)));
    details.push(provablyMissed
      ? { id: 'last-' + last, ts: last, received: false, manual: false }
      : { id: 'last-' + last, ts: last, received: null, manual: false, status: 'unknown' });
  }
  return details.sort((a, b) => b.ts - a.ts);
}

export function setFeedbackReceipt(slot, id, received, opts = {}) {
  return updateStateReceiptOverrides(st => {
    const slots = st.feedback?.slots;
    if (!slots || !Object.hasOwn(slots, slot)) return null;
    const edited = manualReceipts(st, slot);
    const row = edited.find(item => item.id === id) ||
      receiptDetails(st, slot, opts).find(item => item.id === id && item.received === false);
    if (!row) return null;
    const next = edited.filter(item => item.id !== id);
    if (received) next.push({ id, ts: row.ts });
    const receiptOverrides = { ...st.feedback.receiptOverrides };
    if (next.length) receiptOverrides[slot] = next;
    else delete receiptOverrides[slot];
    return { receiptOverrides, result: st };
  });
}

/** 把一次判定落到账上。miss 不进 replied；其余都算她回过（只是早晚不同）。 */
function apply(f, p, r, herText, { pair = true } = {}) {
  const s = slotRec(f, p.slot);
  s.receipts = [...settledReceipts(s), { ...receiptIdentity(p), received: r.kind !== 'miss' }]
    .sort((a, b) => a.ts - b.ts).slice(-PAIRS_MAX);
  if (r.kind === 'miss') {
    s.missed = (Number(s.missed) || 0) + 1;
    return;
  }
  s.replied += 1;
  if (Number.isFinite(r.latMin)) {
    s.latencySum += r.latMin * MIN;
    s.lastRepliedAt = p.ts + r.latMin * MIN;
  }
  f.streak = 0;
  // 只有升级后带 draft 的 pending 才配对（旧 state 里的没有原文，配了也是空的）
  if (pair && p.draft) {
    const rec = {
      myDraft: String(p.draft).slice(0, DRAFT_MAX),
      herReply: String(herText || '').slice(0, DRAFT_MAX),
      latencyMin: Number.isFinite(r.latMin) ? r.latMin : null,
      kind: r.kind,
      ts: p.ts + (Number.isFinite(r.latMin) ? r.latMin * MIN : 0),
    };
    s.pairs = [...(Array.isArray(s.pairs) ? s.pairs : []), rec].slice(-PAIRS_MAX);
  }
}


// ---- 随口说话的阶段 4：密度与熔断（只认 chitchat 这一档） -------------------
const CHIT_TRIP = 3;

function chitRec(st) {
  const cur = st.chitchat && typeof st.chitchat === 'object' ? st.chitchat : {};
  st.chitchat = cur;
  if (!cur.days || typeof cur.days !== 'object') cur.days = {};
  return cur;
}

/** 她回了 vs 被晾：接住就清零，连着 3 条晾满 12 小时就停 48 小时。 */
function chitOutcome(st, p, now, missed, timing) {
  if (p?.slot !== 'chitchat') return;
  const c = chitRec(st);
  if (!missed) {
    c.ignored = 0;
    return;
  }
  if (Number(now) - Number(p.ts) < Number(timing.strandHours ?? 12) * 3_600_000) return;
  c.ignored = (Number(c.ignored) || 0) + 1;
  if (c.ignored >= CHIT_TRIP) {
    c.cooldownUntil = Number(now) + Number(timing.pauseHours ?? 48) * 3_600_000;
    c.ignored = 0;
  }
}

/** 记「她接住了」这一天的一笔（密度调解的分子）。 */
function chitReplied(st, ts, tz) {
  const c = chitRec(st);
  const d = dayKey(Number(ts) || Date.now(), tz);
  const row = c.days[d] && typeof c.days[d] === 'object' ? c.days[d] : { sent: 0, replied: 0 };
  c.days[d] = { sent: Number(row.sent) || 0, replied: (Number(row.replied) || 0) + 1 };
}

/**
 * 她说话了：把比这句话更早的 pending 各判一次（一生只判这一次）。
 * 超过一天还没回的直接丢——不是这段对话了。
 * herText：她这一句的原文，配对时一起存下来（阶段 2）；拿不到就留空。
 * opts：{ tz, canJudge=false 时只挂着不判 }
 */
export function settle(st, herTs, now = Date.now(), herText = '', opts = {}) {
  const f = ensure(st);
  const tz = opts.tz || 'Asia/Shanghai';
  const timing = feedbackTiming(opts.cfg);
  const chit = chitTiming(opts.cfg);
  const keepMs = Number(timing.keepHours ?? 24) * 3_600_000;
  const ts = Number(herTs) || 0;
  let replied = 0;
  const rest = [];
  for (const p of f.pending) {
    if (opts.channel && (p.channel || 'qq') !== opts.channel) {
      rest.push(p);
      continue;
    }
    if (p.test === true) {
      // 测试期：她回了就配一对留着看，但不计入任何统计
      if (ts > 0 && p.ts < ts && ts - p.ts <= keepMs) {
        const lat = Math.max(0, Math.round((ts - p.ts) / MIN));
        f.testPairs = [...(Array.isArray(f.testPairs) ? f.testPairs : []), { myDraft: String(p.draft || ''), herReply: String(herText || '').slice(0, DRAFT_MAX), latencyMin: lat, ts: p.ts + lat * MIN }].slice(-PAIRS_MAX);
      }
      continue;
    }
    if (p.expect === false) {
      // 回话/接转发：她后面说了话就配一对（留着回看「我说了什么、她怎么接的」），
      // 但不算接住、不算没接住、也不动 streak。
      if (ts > 0 && p.ts < ts && ts - p.ts <= keepMs && p.draft) {
        const s = slotRec(f, p.slot);
        const r = classify(p, ts, tz, timing);
        const lat = Math.max(0, Math.round((ts - p.ts) / MIN));
        s.pairs = [
          ...(Array.isArray(s.pairs) ? s.pairs : []),
          {
            myDraft: String(p.draft).slice(0, DRAFT_MAX),
            herReply: String(herText || '').slice(0, DRAFT_MAX),
            latencyMin: lat,
            kind: r.kind,
            expect: false,
            ts: p.ts + lat * MIN,
          },
        ].slice(-PAIRS_MAX);
      }
      continue;
    }
    if (ts > 0 && p.ts < ts) {
      // 隔了一天才回的不算这段对话的回应，也不进配对，分母里也去掉
      if (ts - p.ts > keepMs) {
        const s = slotRec(f, p.slot);
        s.sent = Math.max(0, (Number(s.sent) || 0) - 1);
        chitOutcome(st, p, now, true, chit);
        continue;
      }
      const r = classify(p, ts, tz, timing);
      apply(f, p, r, herText);
      // 「被晾」不是「没回」：隔了 12 小时才回也是晾着——熔断只认这一条。
      const latMin = (ts - p.ts) / MIN;
      const stranded = r.kind === 'miss' || latMin >= Number(chit.strandHours ?? 12) * 60;
      chitOutcome(st, p, now, stranded, chit);
      if (r.kind !== 'miss') {
        replied += 1;
        if (p.slot === 'chitchat') chitReplied(st, p.ts, tz);
      }
    } else {
      rest.push(p);
    }
  }
  // 一天以上没人应的：从分母里去掉（不是没接住，是这段对话早结束了）
  f.pending = rest.filter((p) => {
    if (now - p.ts < keepMs) return true;
    if (p.test === true || p.expect === false) return false;
    const s = slotRec(f, p.slot);
    s.sent = Math.max(0, (Number(s.sent) || 0) - 1);
    return false;
  });
  return replied;
}

/**
 * 每拍扫一遍：窗口已经过去、她一句话都没有的，判 miss（白天窗口）或从分母里去掉（夜间/跨夜）。
 * canJudge=false（静默、通道全断、dryRun）时只看不动——盲着的那段不该算她没接。
 * 返回这一次处理掉的条数。
 */
export function sweep(st, now = Date.now(), opts = {}) {
  const f = ensure(st);
  const tz = opts.tz || 'Asia/Shanghai';
  const timing = feedbackTiming(opts.cfg);
  const chit = chitTiming(opts.cfg);
  const keepMs = Number(timing.keepHours ?? 24) * 3_600_000;
  const canJudge = opts.canJudge !== false;
  const keep = [];
  let judged = 0;
  for (const p of f.pending) {
    if (p.test === true) {
      // 测试期的不判、不进分母；挂满一天直接丢
      if (now - p.ts >= keepMs) judged += 1;
      else keep.push(p);
      continue;
    }
    if (p.expect === false) {
      // 回话/接转发本来就不期待她再回：挂着没用，直接丢，不判。
      judged += 1;
      continue;
    }
    if (now - p.ts >= keepMs) {
      const s = slotRec(f, p.slot);
      s.sent = Math.max(0, (Number(s.sent) || 0) - 1);
      judged += 1;
      continue;
    }
    if (now <= windowEnd(p.ts, tz, timing) || !canJudge || (opts.channel && (p.channel || 'qq') !== opts.channel)) {
      keep.push(p);
      continue;
    }
    const r = classify(p, Infinity, tz, timing);
    if (r.kind === 'miss') {
      apply(f, p, r, '');
      chitOutcome(st, p, now, true, chit);
    } else {
      // 夜里发的、窗口本来就不成立：不进分母也不算没接住
      const s = slotRec(f, p.slot);
      s.sent = Math.max(0, (Number(s.sent) || 0) - 1);
    }
    judged += 1;
  }
  f.pending = keep;
  return judged;
}

/**
 * 阶段 2：某一类最近的对白（新→旧），快照用。没配过对就返回空数组。
 * 只读，不改 state。
 */
export function recentPairs(st, slot, n = 2) {
  const f = ensure(st);
  const pairs = Array.isArray(f.slots?.[slot]?.pairs) ? f.slots[slot].pairs : [];
  return pairs.slice(-Math.max(1, n)).reverse();
}

/** 每一类的接住率；样本不足时 rate = null（别拿一次没回就当结论）。 */
export function slotStats(st) {
  const f = ensure(st);
  const out = {};
  for (const [slot, s] of Object.entries(f.slots)) {
    const sent = Number(s.sent) || 0;
    const automatic = Number(s.replied) || 0;
    const manual = manualReceipts(st, slot).length;
    const replied = automatic + manual;
    out[slot] = {
      sent,
      replied,
      missed: Math.max(0, (Number(s.missed) || 0) - manual),
      rate: sent > 0 ? replied / sent : null,
      avgLatMin: automatic > 0 ? Math.round(Number(s.latencySum) || 0) / automatic / MIN : null,
      lastSentAt: Number(s.lastSentAt) || 0,
      coldUntil: Number(s.coldUntil) || 0,
    };
  }
  return out;
}

/**
 * 这一拍该压住的由头。第一次判定为「冷」时写 coldUntil（压几天）；
 * 到期后放它试一次，接不住就再压——不会因为压着而永远没机会翻案。
 */
export function coldSlots(st, cfg, now, tzDay = 0) {
  const r = cfg?.rules?.feedback || {};
  const out = new Set();
  if (r.enabled === false) return out;
  const coldAfter = Math.max(1, Number(r.coldAfter ?? 6));
  const coldRate = Number(r.coldRate ?? 0.25);
  const coldDays = Math.max(1, Number(r.coldDays ?? 3));
  const f = ensure(st);
  for (const [slot, s] of Object.entries(f.slots)) {
    if (topicPreferenceMode(st, { slot }, now) === 'allow_silent') continue;
    const sent = Number(s.sent) || 0;
    const replied = (Number(s.replied) || 0) + manualReceipts(st, slot).length;
    if (sent < coldAfter) continue;
    if (replied / sent >= coldRate) {
      if (Number(s.coldUntil)) s.coldUntil = 0; // 接住率回来了，立刻解冻
      continue;
    }
    if ((Number(s.coldUntil) || 0) > now) {
      out.add(slot);
    } else {
      // 到期：先放一次，同时记下新一轮的观察期（下次判定仍不达标就继续压）
      s.coldUntil = now + coldDays * DAY;
      // 这一拍不拦，让它试
    }
  }
  return out;
}

/** 连续几条没回之后，两条之间要多等几分钟（返回额外分钟数）。 */
export function adaptiveExtraMin(st, cfg) {
  if (cfg?.rules?.adaptiveGap === false) return 0;
  const f = ensure(st);
  const streak = Number(f.streak) || 0;
  if (streak < 2) return 0;
  const base = Math.max(0, Number(cfg?.rules?.minGapMin ?? 240));
  const step = Math.min(Number(cfg?.rules?.gapMaxX ?? 3), 1 + 0.5 * (streak - 1));
  return Math.round(base * (step - 1));
}

/** 给 --why / 设置页看的一句话。 */
export function feedbackSummary(st, cfg, now = Date.now()) {
  const s = slotStats(st);
  const parts = Object.entries(s)
    .filter(([, v]) => v.sent > 0)
    .sort((a, b) => b[1].sent - a[1].sent)
    .map(([slot, v]) => `${slot} ${v.replied}/${v.sent}${v.rate == null ? '' : ` ${Math.round(v.rate * 100)}%`}`);
  const streak = Number(ensure(st).streak) || 0;
  return {
    streak,
    parts,
    text: parts.length ? parts.join('，') : '还没发过',
    extraMin: adaptiveExtraMin(st, cfg),
    preferences: activeTopicPreferences(st, now).map(({ target, mode, expiresAt }) => ({ target, mode, expiresAt })),
  };
}