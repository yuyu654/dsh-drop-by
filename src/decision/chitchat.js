// chitchat.js —— 「没什么事，就是想跟她说一句」。
//
// 为什么要有这条：插件原来把「没由头」当成不许说话的理由（NO_TOPIC）。
// 人对亲近的人恰恰相反——「在吗」本身就可能是内容。这条不是平行开一台机器，
// 而是和 15 类由头同台竞争的**最低优先级候选**：别的由头挑不出来时，它才上。
//
// 设计纪律（照任务书）：
//   · 约束留代码（上限、时段、窗口），「这一拍要不要说」交 judge；
//   · 关着的时候，NO_TOPIC 的行为一个字节都不变；
//   · 生成失败/被 guard 退回 → 这一拍不发，**绝不拿模板兜底**（废话比沉默差）。
import { minutesOfDayOf, dayKey } from '../settings/time.js';
import { inQuiet } from '../perception/schedule.js';
import { topicPreferenceMode } from './feedback.js';
import { SLOTS } from './topics.js';
import { FALLBACK_REST, inRest, clockOf } from './bedtime.js';

export function chitchatCfg(cfg) {
  return cfg?.rules?.chitchat || {};
}

function toMin(v, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(1439, Math.round(v)));
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v).trim());
  if (!m) return dflt;
  return Math.max(0, Math.min(1439, Number(m[1]) * 60 + Number(m[2])));
}

const hmOf = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** 今天的随口说话计数（不改 state；engine 真要发时再落）。 */
export function chitchatToday(st, now, tz) {
  const day = dayKey(now, tz);
  const cur = st?.chitchat;
  if (cur && cur.day === day) return cur;
  // 跨天：计数归零、裸招呼次数清零，但「最近用过的种子」和熔断要带过去——
  // 否则零点一过，同一条记忆又能被拿来当素材。
  return {
    day,
    count: 0,
    bareCount: 0,
    recentSeeds: Array.isArray(cur?.recentSeeds) ? cur.recentSeeds.slice(-3) : [],
    ...(cur?.days && typeof cur.days === 'object' ? { days: cur.days } : {}),
    ...(Number(cur?.ignored) > 0 ? { ignored: cur.ignored } : {}),
    ...(Number(cur?.cooldownUntil) > now ? { cooldownUntil: cur.cooldownUntil } : {}),
  };
}

/**
 * 按最近接住率分档，最多放到用户配置的上限。
 * 样本不足 5 条就按基线走，不拿两三条猜她的脾气。
 * 返回 { perDay, configuredPerDay, rate, sent, why }。
 */
export function densityTarget(st, now = Date.now(), tz = 'Asia/Shanghai', cfg) {
  const days = st?.chitchat?.days && typeof st.chitchat.days === 'object' ? st.chitchat.days : {};
  const cutoff = dayKey(now - (Number(cfg?.rules?.chitchat?.densityDays ?? 7) - 1) * 86_400_000, tz);
  let sent = 0;
  let replied = 0;
  for (const [d, v] of Object.entries(days)) {
    if (d < cutoff || !v || typeof v !== 'object') continue;
    sent += Number(v.sent) || 0;
    replied += Number(v.replied) || 0;
  }
  const value = Number(chitchatCfg(cfg).perDay ?? 3);
  const configuredPerDay = Math.max(0, Math.min(10, Math.trunc(Number.isNaN(value) ? 3 : value)));
  const rate = sent >= 5 ? replied / sent : null;
  let perDay = configuredPerDay;
  if (rate == null || rate < 0.3) perDay = Math.min(configuredPerDay, 1);
  else if (rate <= 0.7) perDay = Math.min(configuredPerDay, 2);
  const basis = rate == null ? `只有 ${sent} 条样本` : `最近 ${sent} 条接住了 ${replied} 条（${Math.round(rate * 100)}%）`;
  return { perDay, configuredPerDay, rate, sent, why: `${basis}，每天生效上限 ${perDay} 条` };
}

/**
 * mood 占位：阶段 4 只留恒等 1.0 的位置。
 * 以后 mood（warmth/miss/worry/energy）只准影响概率、长度和间隔的 ±30%，
 * 不许绕开 guard、不许补模板、不许改「她睡着就不说」这类硬约束。
 */
export function moodFactor() {
  return 1;
}

/**
 * 这一拍能不能产出「随口说话」候选。
 * 返回 { ok:true, state } 或者 { ok:false, reason, why, silent? }。
 * silent=true 表示「开关本来就没开」——不往 --why 里写噪音。
 */
export function chitchatGate({ cfg, now = Date.now(), st = {}, ctx = {}, tz = 'Asia/Shanghai', rest = null }) {
  const c = chitchatCfg(cfg);
  if (c.enabled !== true) return { ok: false, reason: 'CHITCHAT_OFF', why: '随口说话没开', silent: true };
  // 没有 judge 就没有「说不说」的判断层——不许规则裸奔（和 presenceSignal 同一条纪律）。
  if (cfg?.rules?.judge?.enabled !== true) {
    return { ok: false, reason: 'CHITCHAT_NO_JUDGE', why: '随口说话要 judge 一起开（没有软决策层就不放开）' };
  }
  const sc = chitchatToday(st, now, tz);
  // 全局静默压在最上面：静默里什么都不读不发，随口话跟它走（不是另划一段 00:00–07:00）。
  if (inQuiet(now, cfg?.quietHours, tz)) {
    return { ok: false, reason: 'NO_CHITCHAT_WINDOW', why: '全局静默时段，随口话也不说' };
  }
  const dens = densityTarget(st, now, tz, cfg);
  const perDay = dens.perDay;
  if ((Number(sc.count) || 0) >= perDay) {
    return { ok: false, reason: 'NO_CHITCHAT_BUDGET', why: `今天随口说过 ${sc.count} 条，上限 ${perDay}（${dens.why}）` };
  }
  const mins = minutesOfDayOf(now, tz);
  const start = toMin(c.dayStart, 480);
  const end = toMin(c.dayEnd, 1410);
  // 她睡着的那段绝对不说（鱼鱼 7 天中位数推出来的；不够 3 天就退回 23:00–07:00）。
  // 深夜「没睡」的关心走既有的深夜没睡 slot，随口说话不抢。
  const rw = rest || FALLBACK_REST;
  if (inRest(mins, rw)) {
    return {
      ok: false,
      reason: 'NO_CHITCHAT_WINDOW',
      why: `她在睡（${clockOf(rw.startMin)}–${clockOf(rw.endMin)}，${rw.from === 'history' ? `${rw.nights} 天中位数` : '默认'}），不说`,
    };
  }
  if (mins < start || mins > end) {
    return { ok: false, reason: 'NO_CHITCHAT_WINDOW', why: `不在随口说话的时段（${hmOf(start)}–${hmOf(end)}）` };
  }
  // 她刚说完、回复轨道正等着的时候不抢答。
  const waitMin = Math.max(0, Number(cfg?.rules?.replyCooldownMin ?? 5));
  const herTs = Number(ctx?.her?.lastTs) || 0;
  if (herTs && now - herTs < waitMin * 60_000) {
    return { ok: false, reason: 'CHITCHAT_REPLY_PENDING', why: '她刚说完，还在回复等待窗口里' };
  }
  const until = Number(sc.cooldownUntil) || 0;
  if (until > now && topicPreferenceMode(st, { slot: 'chitchat' }, now) !== 'allow_silent') {
    return { ok: false, reason: 'NO_CHITCHAT_COOLDOWN', why: '连着几条都被晾，先停一阵' };
  }
  return { ok: true, state: sc };
}

/** 这一拍有真由头、随口话让位——纯记账，判定一律不动。 */
export function chitchatYield(slot) {
  return { reason: 'CHITCHAT_LOW_PRIORITY', why: `这一拍有由头（${slot}），随口话让位` };
}

/** 模型对随口话说了「不说」。 */
export function chitchatJudgeNo(why) {
  return { reason: 'CHITCHAT_JUDGE_NO', why: why || '模型说这一拍不说' };
}

/** 造一条候选。seeds 由阶段 2 填；现在只有形态约束。 */
export function chitchatTopic(cfg, extra = {}) {
  const c = chitchatCfg(cfg);
  return {
    slot: 'chitchat',
    label: SLOTS.chitchat.label,
    why: SLOTS.chitchat.why,
    brief: '没有什么事，就是想跟她说一句',
    evidence: {
      kind: 'chitchat',
      allowBare: false,
      barePerDay: bareLimit(cfg),
      maxChars: Math.max(10, Math.min(80, Number(c.maxChars) || 40)),
      ...extra,
    },
  };
}

const BARE = /^(在吗|在么|在不在|睡了吗|睡着了没|人呢)[？?。！!~～\s]*$/;

/** 轻招呼每天最多放行几次（默认 1，可设 0–10）。 */
export function bareLimit(cfg) {
  const raw = cfg?.rules?.chitchat?.barePerDay;
  const n = raw == null || raw === '' ? 1 : Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n))) : 1;
}

/** 今天还剩几次轻招呼额度。 */
export function bareRemainingToday(st, now, tz, cfg) {
  const day = dayKey(now, tz);
  const sc = chitchatToday(st, now, tz);
  const used = Number(sc.bareCount) || (sc.bareDay === day ? 1 : 0);
  return Math.max(0, bareLimit(cfg) - used);
}

/** 这一拍允不允许写裸「在吗」：当天还没用到上限才给。 */
export function allowBareToday(st, now, tz, cfg) {
  return bareRemainingToday(st, now, tz, cfg) > 0;
}

/** 真发出去一条才记数（dryRun / 被 guard 拦下都不算）。 */
export function noteChitchatSent(st, now, tz, text = '', seedId = '', opts = {}) {
  const day = dayKey(now, tz);
  const sc = chitchatToday(st, now, tz);
  const prevBare = Number(sc.bareCount) || (sc.bareDay === day ? 1 : 0);
  st.chitchat = { ...sc, day, count: (Number(sc.count) || 0) + 1, ...(prevBare > 0 ? { bareCount: prevBare } : {}) };
  if (BARE.test(String(text || '').trim())) {
    st.chitchat.bareDay = day;
    st.chitchat.bareCount = prevBare + 1;
  }
  const id = String(seedId || '').trim();
  if (id) st.chitchat.recentSeeds = [...(Array.isArray(sc.recentSeeds) ? sc.recentSeeds : []), id].slice(-3);
  // 测试期（feedback.testMode）的发送不进密度样本：她没回不算没接住，也就不能算「接不住」。
  if (opts.test === true || opts.expect === false) return st.chitchat;
  const days = { ...(sc.days && typeof sc.days === 'object' ? sc.days : {}) };
  const row = days[day] && typeof days[day] === 'object' ? days[day] : { sent: 0, replied: 0 };
  days[day] = { sent: (Number(row.sent) || 0) + 1, replied: Number(row.replied) || 0 };
  st.chitchat.days = days;
  return st.chitchat;
}