// receptivity.js —— 本地轻量“看眼色”小算盘（零 Token、删失感知上下文打分器 + 在忙/上课口语识别）。
//
// 职责：
//   1. 识别用户口头说明的“在忙 / 在上课 / 开会呢 / 晚点回”（含简单结束时间解析），
//      用于触发临时免打扰，并在反馈结算时免除扣分；
//   2. 判定一条未回复的主动消息是「真没空（右删失，跳过扣分）」还是「人在活跃但没接（轻扣分）」；
//   3. 维护按 话题大类 × 时段 × 桌面状态 分层的轻量后验打分，在 shadow 模式下只记分观察，
//      在 gate 模式且样本足够时，于调用 LLM judge 前直接拦截低分拍子，省 Token 且少打扰。

import { dayKey, minutesOfDayOf } from '../settings/time.js';
import { busyNow } from '../perception/holidays.js';
import { parseAgenda, currentWeek, courseApplies, courseEnabled, weekdayOf } from '../perception/agenda.js';

const MIN = 60_000;
const DAY_MIN = 1440;

export const RECEPTIVITY_DEFAULTS = Object.freeze({
  mode: 'shadow', // 'off' | 'shadow' | 'gate'
  threshold: 0.28,
  minSamples: 12,
});

const URGENT_SLOTS = new Set(['reply', 'forward', 'agreement', 'examSoon']);
const NO_EXPECT_SLOTS = new Set(['reply', 'forward', 'characterRest']);

const SLOT_BUCKET = {
  reply: 'followup',
  forward: 'followup',
  noReply: 'followup',
  sleep: 'wellness',
  stress: 'wellness',
  steps: 'wellness',
  screen: 'wellness',
  lateUp: 'wellness',
  longSit: 'wellness',
  agenda: 'event',
  examSoon: 'event',
  examReview: 'event',
  backHome: 'event',
  agreement: 'event',
  characterRest: 'event',
  chitchat: 'casual',
  share: 'casual',
  catchup: 'casual',
  projectCheckIn: 'casual',
};

const norm = (text) => String(text || '').normalize('NFKC').trim();
const hasQuestion = (text) => /[?？]/u.test(String(text || ''));
const THIRD_PERSON_RE = /(?:他|她|别人|同学|朋友|老师|老板|同事|室友).{0,6}(?:在|去|正|说|很|挺|太)/u;

// 进行时/临时在忙表达（补足 chat-rhythm.js 的 EXPLICIT_CLOSE_RE）
const BUSY_SPEECH_RE = /(?:^|[，,。！!~\s]|我(?:现在|这会儿?|刚|还在|正在|正)?)(?:在忙|很忙|忙着呢?|忙死了|有点忙|太忙了|在上课|正在上课|上课中|上课呢|在开会|正在开会|开会中|开会呢|在上班|上班中|在干活|在写作业|在赶作业|在考试|没空|抽不开身|走不开|腾不出手|回头回你|晚点回你?|稍后回你?|等会儿?回你?|忙完(?:再聊|回你?)|下课(?:再聊|回你?)|开完会(?:再聊|回你?))(?:[了啦呀啊哈哦嘛呢吧~！!。.\s]*$|[，,。！!~]|(?:到|至)\s*(?:上午|中午|下午|傍晚|晚上|今晚)?\s*(?:\d{1,2}|[一二两三四五六七八九十]+))/iu;
// 带明确截止时间点的当前忙碌（如「我开会到晚上十点」「忙到16:30」「上课到十一点半」）
const BUSY_UNTIL_RE = /(?:^|[，,。！!~\s]|我(?:今天|今晚|现在|这会儿?|一直|要|得)?)(?:忙|开会|上课|上班|加班|考试|干活|写作业|赶作业)(?:到|至)\s*(?:上午|中午|下午|傍晚|晚上|今晚)?\s*(?:\d{1,2}(?:[：:]\d{2})?|(?:[一二两三四五六七八九十]+|\d{1,2})点半?)(?:左右|前后)?(?:[了啦呀啊哈哦嘛呢吧~！!。.\s]*$|[，,。！!~])/iu;
// 「<时间>前都在忙/开会/上课」（如「我晚上十点前都在开会」「下午五点前都没空」）
const BUSY_BEFORE_RE = /(?:^|[，,。！!~\s]|我(?:今天|今晚|现在|这会儿?)?)(?:上午|中午|下午|傍晚|晚上|今晚)?\s*(?:\d{1,2}[：:]\d{2}|(?:\d{1,2}|[一二两三四五六七八九十]+)点半?)\s*(?:之?前|以前)(?:都|一直)?(?:在忙|很忙|在开会|开会|在上课|上课|在上班|上班|在加班|加班|在考试|没空|抽不开身|走不开)(?:[了啦呀啊哈哦嘛呢吧~！!。.\s]*$|[，,。！!~])/iu;

const CN_DIGITS = '零一二三四五六七八九';
function parseCnInt(raw) {
  const s = String(raw || '').trim().replace(/两/g, '二');
  if (!s) return NaN;
  if (/^\d+$/.test(s)) return Number(s);
  if (s.includes('十')) {
    const [l, r] = s.split('十');
    const tens = l ? CN_DIGITS.indexOf(l) : 1;
    const ones = r ? CN_DIGITS.indexOf(r) : 0;
    return tens >= 0 && ones >= 0 ? tens * 10 + ones : NaN;
  }
  const v = CN_DIGITS.indexOf(s);
  return v >= 0 ? v : NaN;
}

/** 识别用户是否亲口说自己在忙/上课/开会/晚点回。 */
export function detectBusySpeech(text) {
  const raw = norm(text);
  if (!raw || raw.length > 40 || hasQuestion(raw) || THIRD_PERSON_RE.test(raw)) return false;
  return BUSY_SPEECH_RE.test(raw) || BUSY_UNTIL_RE.test(raw) || BUSY_BEFORE_RE.test(raw);
}

/**
 * 从忙碌说明里提取可选的结束时间（如「开会到四点」「忙到16:30」「晚上十点前都在开会」「半小时后有空」）。
 * 提取不到返回 0；提取到则钳制在 [10 分钟, 6 小时]。
 */
export function extractBusyUntilMs(text, now = Date.now(), tz = 'Asia/Shanghai') {
  const raw = norm(text);
  if (!raw) return 0;
  const relHalf = /半(?:个)?小时(?:以?后|过后)?/.exec(raw);
  if (relHalf) return now + 30 * MIN;
  const relMin = /(\d+|[一二两三四五六七八九十]+)\s*(?:分钟|分)(?:以?后|过后)?/.exec(raw);
  if (relMin) {
    const m = parseCnInt(relMin[1]);
    if (Number.isFinite(m) && m >= 10 && m <= 360) return now + m * MIN;
  }
  const relHour = /(\d+|[一二两三四五六])\s*个?(?:小时|钟头)(?:以?后|过后)?/.exec(raw);
  if (relHour) {
    const h = parseCnInt(relHour[1]);
    if (Number.isFinite(h) && h >= 1 && h <= 6) return now + h * 60 * MIN;
  }
  const clockMatch =
    /(?:到|至)\s*(上午|中午|下午|傍晚|晚上|今晚)?\s*(?:(\d{1,2})[：:](\d{2})|(\d{1,2}|[一二两三四五六七八九十]+)点(半)?)/.exec(raw) ||
    /(上午|中午|下午|傍晚|晚上|今晚)?\s*(?:(\d{1,2})[：:](\d{2})|(\d{1,2}|[一二两三四五六七八九十]+)点(半)?)\s*(?:之?前|以前)(?:都|一直)?(?:在|很|忙|开会|上课|上班|加班|考试|没空|抽不开身|走不开)/.exec(raw);
  if (clockMatch) {
    const [, period, hh, mm, cnH, half] = clockMatch;
    let h = parseCnInt(hh || cnH);
    const m = mm != null ? Number(mm) : half ? 30 : 0;
    if (Number.isFinite(h) && h >= 0 && h < 24 && m >= 0 && m < 60) {
      const nowMin = minutesOfDayOf(now, tz);
      if (/下午|傍晚|晚上|今晚/.test(period || '') && h < 12) h += 12;
      else if (!period && h <= 11 && h * 60 + m <= nowMin && (h + 12) * 60 + m > nowMin) h += 12;
      let diffMin = h * 60 + m - nowMin;
      if (diffMin < 0) diffMin += DAY_MIN;
      if (diffMin >= 10 && diffMin <= 360) return now + diffMin * MIN;
    }
  }
  return 0;
}

/** 将话题 slot 归并到 4 个粗粒度桶，避免样本稀疏。 */
export function bucketOfSlot(slot) {
  return SLOT_BUCKET[slot] || 'casual';
}

export function periodOfTime(ts, tz = 'Asia/Shanghai') {
  const h = Math.floor(minutesOfDayOf(ts, tz) / 60);
  if (h < 11) return 'morning';
  if (h < 14) return 'midday';
  if (h < 19) return 'afternoon';
  return 'evening';
}

export function activityKeyOf({ activity, idleSec = -1, locked = false, pc = null, cfg = {} } = {}) {
  const awaySec = Number(cfg?.idle?.awaySec) || 600;
  if (locked || (idleSec >= 0 && idleSec > awaySec)) return 'away';
  if (pc?.event === 'return') return 'return';
  if (activity?.kind === 'coding') return 'focus';
  return 'active';
}

export function contextFeatures({ slot, now = Date.now(), tz = 'Asia/Shanghai', activity = null, idleSec = -1, locked = false, pc = null, cfg = {} } = {}) {
  return {
    bucket: bucketOfSlot(slot),
    period: periodOfTime(now, tz),
    activity: activityKeyOf({ activity, idleSec, locked, pc, cfg }),
  };
}

/** 检查某一时刻是否正处于用户配置的课表上课时段（没配课表直接返回 false）。 */
function isInClassAt(ts, cfg, tz) {
  const text = String(cfg?.content?.agenda?.text || '').trim();
  if (!text) return false;
  try {
    const courses = parseAgenda(text, { periods: cfg?.content?.agenda?.periods || '' });
    if (!courses.length) return false;
    const off = Array.isArray(cfg?.content?.agenda?.off) ? cfg.content.agenda.off : [];
    const wd = weekdayOf(ts, tz);
    const week = currentWeek(ts, tz, cfg?.content?.agenda?.termStart || '');
    const m = minutesOfDayOf(ts, tz);
    return courses.some((c) => {
      if (c.weekday !== wd) return false;
      if (!courseEnabled(c, off)) return false;
      if (!courseApplies(c, week)) return false;
      return m >= c.fromMin && m < c.toMin;
    });
  } catch {
    return false;
  }
}

/** 观察窗 [startTs, endTs] 内是否覆盖了非节假日忙碌时段或已配置课表的上课时间。 */
export function windowOverlapsBusyOrClass(startTs, endTs, cfg, tz = 'Asia/Shanghai') {
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs <= startTs) return false;
  const hasBusy = Array.isArray(cfg?.busyHours) && cfg.busyHours.length > 0;
  const hasAgenda = Boolean(String(cfg?.content?.agenda?.text || '').trim());
  if (!hasBusy && !hasAgenda) return false;
  const step = 15 * MIN;
  let count = 0;
  for (let t = startTs; t <= endTs && count < 20; t += step, count += 1) {
    if (hasBusy && busyNow(t, cfg)) return true;
    if (hasAgenda && isInClassAt(t, cfg, tz)) return true;
  }
  return false;
}

/**
 * 判定一条未回复的主动消息是否属于「右删失（真没空，跳过扣分）」。
 * 返回 { censored: boolean, reason: string }。
 */
export function classifyMissCensor({
  pending,
  now = Date.now(),
  tz = 'Asia/Shanghai',
  cfg = {},
  fair = true,
  idleSec = -1,
  locked = false,
  userBusySpeech = false,
  windowEndTs = 0,
} = {}) {
  if (!pending || pending.expect === false || NO_EXPECT_SLOTS.has(pending.slot)) {
    return { censored: true, reason: 'no_expect_slot' };
  }
  if (!fair) {
    return { censored: true, reason: 'outside_fair_window' };
  }
  if (userBusySpeech) {
    return { censored: true, reason: 'user_busy_speech' };
  }
  const endTs = Number(windowEndTs) > Number(pending.ts) ? Number(windowEndTs) : now;
  if (windowOverlapsBusyOrClass(Number(pending.ts), endTs, cfg, tz)) {
    return { censored: true, reason: 'busy_or_class_window' };
  }
  const awaySec = Number(cfg?.idle?.awaySec) || 600;
  const nowAway = Boolean(locked) || (idleSec >= 0 && idleSec > awaySec);
  const sentAway = pending.ctx?.activity === 'away';
  if (sentAway && nowAway) {
    return { censored: true, reason: 'away_or_locked' };
  }
  return { censored: false, reason: 'active_ignore' };
}

function ensureRec(st) {
  const cur = st.receptivity && typeof st.receptivity === 'object' ? st.receptivity : {};
  st.receptivity = cur;
  cur.buckets ||= {};
  cur.periods ||= {};
  cur.activities ||= {};
  cur.pairs ||= {};
  cur.censorReasons ||= {};
  cur.samples = Number(cur.samples) || 0;
  cur.censoredCount = Number(cur.censoredCount) || 0;
  return cur;
}

// Beta(2, 1) 先验：初始均值 0.67，保证冷启动友好、不轻易误拦截
const PRIOR_A = 2;
const PRIOR_B = 1;
const MAX_WEIGHT = 30;
const DECAY = 0.96;

function cellMean(map, key) {
  const row = map?.[key];
  const a = Number(row?.a) || PRIOR_A;
  const b = Number(row?.b) || PRIOR_B;
  return a / (a + b);
}

function bumpCell(map, key, da, db) {
  if (!key) return;
  const cur = map[key] && typeof map[key] === 'object' ? map[key] : { a: PRIOR_A, b: PRIOR_B };
  let a = (Number(cur.a) || PRIOR_A) + da;
  let b = (Number(cur.b) || PRIOR_B) + db;
  if (a + b > MAX_WEIGHT) {
    a = Math.max(PRIOR_A * 0.5, a * DECAY);
    b = Math.max(PRIOR_B * 0.5, b * DECAY);
  }
  map[key] = { a: Number(a.toFixed(3)), b: Number(b.toFixed(3)) };
}

/**
 * 反馈结算时更新小算盘权重。
 * outcome: 'hit' | 'late' | 'stray' | 'miss' | 'busy_reply'
 */
export function updateReceptivity(st, pending, outcome, { censored = false, censorReason = '', now = Date.now(), tz = 'Asia/Shanghai' } = {}) {
  if (!st || !pending || pending.test === true || pending.expect === false || NO_EXPECT_SLOTS.has(pending.slot)) {
    return { updated: false, censored: false };
  }
  const rec = ensureRec(st);
  if (outcome === 'busy_reply' || (outcome === 'miss' && censored)) {
    rec.censoredCount += 1;
    const reasonKey = outcome === 'busy_reply' ? 'user_busy_speech' : (censorReason || 'censored');
    rec.censorReasons[reasonKey] = (Number(rec.censorReasons[reasonKey]) || 0) + 1;
    rec.updatedAt = now;
    return { updated: false, censored: true, reason: reasonKey };
  }
  const ctx = pending.ctx || {
    bucket: bucketOfSlot(pending.slot),
    period: periodOfTime(pending.ts || now, tz),
    activity: 'active',
  };
  let da = 0;
  let db = 0;
  if (outcome === 'hit') da = 1.0;
  else if (outcome === 'late' || outcome === 'stray') da = 0.6;
  else if (outcome === 'miss') db = 0.7;
  else return { updated: false, censored: false };

  const pairKey = `${ctx.bucket}:${ctx.period}`;
  bumpCell(rec.buckets, ctx.bucket, da, db);
  bumpCell(rec.periods, ctx.period, da, db);
  bumpCell(rec.activities, ctx.activity, da, db);
  bumpCell(rec.pairs, pairKey, da, db);
  rec.samples += 1;
  rec.updatedAt = now;
  return { updated: true, censored: false, outcome, ctx };
}

export function receptivityConfig(cfg) {
  const raw = cfg?.rules?.receptivity || {};
  const mode = ['off', 'shadow', 'gate'].includes(raw.mode) ? raw.mode : RECEPTIVITY_DEFAULTS.mode;
  const rawThr = Number(raw.threshold);
  const threshold = Number.isFinite(rawThr) ? Math.min(0.7, Math.max(0.05, rawThr)) : RECEPTIVITY_DEFAULTS.threshold;
  const rawMin = Number(raw.minSamples);
  const minSamples = Number.isFinite(rawMin) ? Math.min(100, Math.max(1, Math.trunc(rawMin))) : RECEPTIVITY_DEFAULTS.minSamples;
  return { mode, threshold, minSamples };
}

/**
 * 评估此刻对某候选由头的接受度得分（0~1）。纯读，不改 state。
 */
export function scoreReceptivity({ st = {}, slot, now = Date.now(), tz = 'Asia/Shanghai', cfg = {}, activity = null, idleSec = -1, locked = false, pc = null } = {}) {
  const opts = receptivityConfig(cfg);
  const feat = contextFeatures({ slot, now, tz, activity, idleSec, locked, pc, cfg });
  if (opts.mode === 'off') {
    return { mode: 'off', score: null, threshold: opts.threshold, minSamples: opts.minSamples, samples: 0, ready: false, exempt: URGENT_SLOTS.has(slot), wouldBlock: false, ...feat };
  }
  const rec = st?.receptivity || {};
  const samples = Number(rec.samples) || 0;
  const censoredCount = Number(rec.censoredCount) || 0;
  const bScore = cellMean(rec.buckets, feat.bucket);
  const pScore = cellMean(rec.periods, feat.period);
  const aScore = cellMean(rec.activities, feat.activity);
  const pairScore = cellMean(rec.pairs, `${feat.bucket}:${feat.period}`);

  let score = 0.35 * bScore + 0.25 * pScore + 0.20 * aScore + 0.20 * pairScore;
  const streak = Math.max(0, Number(st?.feedback?.streak) || 0);
  if (streak >= 2) {
    score *= Math.max(0.55, 1 - 0.1 * (streak - 1));
  }
  score = Number(Math.max(0, Math.min(1, score)).toFixed(3));
  const exempt = URGENT_SLOTS.has(slot);
  const ready = samples >= opts.minSamples;
  const wouldBlock = !exempt && ready && score < opts.threshold;
  return {
    mode: opts.mode,
    score,
    threshold: opts.threshold,
    minSamples: opts.minSamples,
    samples,
    censoredCount,
    ready,
    exempt,
    wouldBlock,
    ...feat,
  };
}
