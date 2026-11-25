// decide.js —— 纯函数：只决定「要不要主动找她」，本版到 SEND 为止，不管发什么。
//
// 两条轨道，别用一套规则管两件事：
//   REPLY      她说过话、我们还没回 → 等她说完 replyCooldownMin
//   PROACTIVE  我们主动找她 → 离开/间隔/配额 三道闸
//
// 全局静默（quietHours）**压在所有轨道之上**：静默里什么都不读、不发，
// 回复轨道也不例外（人都不在，发出去也没意义，还容易吵到）。
//
// 返回值里 content 恒为 null：内容生成是下一步的事，这里只给判定和理由。

import { dayKey } from '../settings/time.js';

const WELLNESS_SLOTS = ['steps', 'screen', 'longSit'];

// 三类共用冷却。只有旧日期时，按本地日历保守处理。
export function wellnessCooldown(st, now, tz, cfg) {
  const hours = Math.max(0, Number(cfg?.content?.topics?.wellnessCooldownHours ?? 96));
  if (!hours) return false;
  const saved = st?.content || {};
  const lastDays = [saved.lastStepsFor, String(saved.lastScreenFor || '').split(':').at(-1), saved.lastLongSitFor];
  const cutoffDay = dayKey(now - Math.max(0, hours - 24) * 3_600_000, tz);
  const recentDay = lastDays.some((day) => /^\d{4}-\d{2}-\d{2}$/.test(day || '') && day >= cutoffDay);
  const latest = Math.max(
    Number(saved.lastWellnessAt) || 0,
    ...WELLNESS_SLOTS.map((slot) => Number(st?.feedback?.slots?.[slot]?.lastSentAt) || 0),
    ...(Array.isArray(st?.feedback?.pending) ? st.feedback.pending : [])
      .filter((p) => WELLNESS_SLOTS.includes(p?.slot)).map((p) => Number(p.ts) || 0),
  );
  return latest ? now - latest < hours * 3_600_000 : recentDay;
}

export const REASONS = {
  SEND: '该发了',
  PLUGIN_DISABLED: '插件总开关关着',
  DATA_UNAVAILABLE: '所有通道都读不到数据',
  GLOBAL_QUIET: '全局静默时段，所有功能暂停',
  BUSY_HOURS: '她这个点通常在忙，不主动开口（她先说话照常回）',
  CHARACTER_ASLEEP: '角色现在在休息，暂缓主动开口',
  USER_WINDING_DOWN: '她刚才在收尾或要去忙，先不主动打扰（她先说话照常回）',
  PROACTIVE_OFF: '「我主动找你」关着，这一拍只回她的话',
  QUIET_HOURS: '安静时段（旧版叫法，等价于全局静默）',
  AWAY: '人不在',
  REPLY_WAIT: '她刚说完，再等一会',
  REPLY_ALREADY_ANSWERED: '她那条已经有人应了（插件那边先回了），这一拍不重复',
  REPLY_ON_OTHER_CHANNEL: '她那条是别的通道（抖音/主会话）说的，这边只有 QQ，回过去答非所问，这一拍不发',
  GAP_TOO_SHORT: '距上次主动太近',
  CHANNEL_SWITCH_PENDING: '主通道切换待完成（请先重启 DSH 完成接管）',
  DAILY_CAP: '今日主动次数已满',
  FOLLOWUP_CONTEXT_CHANGED: '生成期间收到新消息，放弃旧追问',
  JUDGE_NO_SEND: '有候选由头，模型判断此刻不发',
  JUDGE_INVALID_CANDIDATE: '模型没有选中有效由头',
  RECEPTIVITY_LOW: '本地小算盘评估此刻打扰得分偏低，暂不开口',
  NO_TOPIC: '时机到了，但这次没有由头（不硬凑）',
  PROJECT_HELP_WITHOUT_REQUEST: '用户没有近期亲口说需要排查或有新进展',
  PROJECT_QUESTION_OUTSIDE_SLOT: '项目近况只由一次性问候发起',
  // 随口说话（rules.chitchat）：没由头时的最低优先级候选，以及它被拦下的原因
  CHITCHAT_NO_JUDGE: '随口说话要 judge 一起开（没有软决策层就不放开）',
  CHITCHAT_LOW_PRIORITY: '这一拍有真由头，随口话让位',
  CHITCHAT_JUDGE_NO: '模型看了这一拍，说不用开口',
  NO_CHITCHAT_BUDGET: '今天随口话的额度用完了',
  NO_CHITCHAT_WINDOW: '不在随口说话的时段（凌晨一律不说）',
  CHITCHAT_REPLY_PENDING: '她刚说完，还在等回复，不抢答',
  NO_CHITCHAT_COOLDOWN: '连着几条被晾，随口话先停一阵',
  CHITCHAT_NO_MODEL: '随口话只走模型，模型不可用——这一拍不发',
  CHITCHAT_GUARD_REJECTED: '随口话过不了护栏（空招呼/太长），不发',
  CHITCHAT_NO_OUTPUT: '模型没写出随口话，不发',
  NO_CONTENT: '没有可发的内容',
  TEMPLATE_CANT_WRITE: '模板模式写不出这类回复（需要 content.mode=llm）',
  GUARD_REJECTED: '写出来的话过不了红线',
  TOPIC_PREFERENCE_MUTED: '用户偏好暂停主动提起这个话题',
  CONTENT_DISABLED: '内容生成关着（content.enabled=false）',
  SEND_DISABLED: '发送期间已切到演练或关闭发送',
  SEND_FAILED: '发出去了但失败了（不占配额，下一拍会重试）',
};

// 阶段 1：三档间隔。由头 → 档的映射在 topics.js 的 SLOTS 里（显式常量）。
// 这里只管「某一档现在够不够久」——由头是 decide 之后才挑的，所以这步在 engine 里
// pickTopic 之后调用（见 checkTierGap），decide 只兜全局地板（replyMin）。
export const TIER_MIN = { reply: 'replyMin', event: 'eventMin', chat: 'chatMin' };

/** 某一档的间隔（毫秒）。gapByTier 关着时退回单一 minGapMin。 */
export function tierGapMs(cfg, tier) {
  const gt = cfg?.rules?.gapByTier || {};
  if (gt.enabled !== true) return Math.max(0, Number(cfg?.rules?.minGapMin) || 0) * 60_000;
  const key = TIER_MIN[tier] || 'chatMin';
  const def = key === 'replyMin' ? 5 : key === 'eventMin' ? 60 : 240;
  return Math.max(60_000, (Number(gt[key] ?? def) || def) * 60_000);
}

/**
 * 挑完由头之后核一次档位间隔。
 * 同档看「上次同档发出」；跨档只兜全局地板 replyMin——
 * 否则 chat 的 240 分钟会一直压着 event，分档就白分了。
 * extraMin 是连败自适应拉长的额外分钟（照旧加在本档需求上）。
 */
export function checkTierGap({ cfg, now, tier, lastByTier = {}, lastSendTs = 0, extraMin = 0, triggered = false }) {
  const gt = cfg?.rules?.gapByTier || {};
  if (gt.enabled !== true) return { ok: true, enabled: false, tier, needMin: null, sinceMin: null, sinceAnyMin: null };
  const extraMs = Math.max(0, Number(extraMin) || 0) * 60_000;
  const floorMs = tierGapMs(cfg, 'reply');
  let needMs = tierGapMs(cfg, tier) + extraMs;
  const byTrigger = Boolean(triggered) && cfg?.rules?.naturalTriggers?.takeGap === true;
  if (byTrigger) {
    const fm = Math.max(1, Number(cfg?.rules?.naturalTriggers?.floorMin ?? 20) || 20) * 60_000;
    needMs = Math.min(needMs, fm + extraMs);
  }
  const lastTierTs = Number(lastByTier?.[tier]) || 0;
  const sinceTier = lastTierTs > 0 ? now - lastTierTs : Infinity;
  const sinceAny = Number(lastSendTs) > 0 ? now - Number(lastSendTs) : Infinity;
  const ok = sinceTier >= needMs && sinceAny >= floorMs + extraMs;
  return {
    ok,
    enabled: true,
    tier,
    needMin: Math.round(needMs / 60_000),
    sinceMin: Number.isFinite(sinceTier) ? Math.round(sinceTier / 60_000) : null,
    sinceAnyMin: Number.isFinite(sinceAny) ? Math.round(sinceAny / 60_000) : null,
    bypassed: byTrigger && !ok ? false : Boolean(byTrigger),
  };
}

export function decide({ cfg, now, idleSec, locked = false, quiet, busy, characterAsleep = false, userWindingDown = false, lastUserTs, lastUserChannel, lastSendTs, todaySent, allDown, triggered = false, extraGapMin = 0 }) {
  const rules = cfg.rules || {};
  const idle = cfg.idle || {};
  const gt = rules.gapByTier || {};
  const cooldownMs = Math.max(0, Number(rules.replyCooldownMin) || 0) * 60_000;
  // gapByTier 开着时，单一 minGapMin 由分档接管：decide 只兜 replyMin 这道全局地板
  // （+ 连败自适应），档位本身的间隔在 checkTierGap 里判。
  const baseGapMin = gt.enabled === true
    ? (Number(gt.replyMin ?? 5) || 5) + Math.max(0, Number(extraGapMin) || 0)
    : (Number(rules.minGapMin) || 0) + Math.max(0, Number(extraGapMin) || 0);
  const minGapMs = Math.max(0, baseGapMin) * 60_000;
  const cap = Math.max(0, Number(rules.dailyCap) || 0);
  const awaySec = Number(idle.awaySec) || 600;

  // 阶段 3：自然触发拍能不能给间隔让路。
  // 默认不能——事件只是把「该开口了」提前到发生的那一秒，间隔地板照旧；
  // takeGap=true 时才允许越过去，但仍受一个更短的地板（floorMin）和每日上限约束。
  const nt = rules.naturalTriggers || {};
  const byTrigger = Boolean(triggered) && nt.takeGap === true;
  const floorMs = Math.max(60_000, (Number(nt.floorMin ?? 20) || 20) * 60_000);

  // 多端默认：不在电脑前或锁屏不代表人在手机旁也找不到；只有显式开启 requirePcOnline 才把离开电脑当硬闸。
  const away = (idleSec >= 0 && idleSec > awaySec) || Boolean(locked);
  const requirePcOnline = rules.requirePcOnline === true;
  const presenceSignalOn = rules.presenceSignal?.enabled === true && rules.judge?.enabled === true;

  const base = {
    decision: 'skip',
    track: null,
    reason: '',
    content: null,
    lastUserChannel: lastUserChannel || null,
    triggered: Boolean(triggered),
    away,
    presenceSignal: presenceSignalOn && away,
  };

  if (cfg.enabled === false) {
    return { ...base, reason: 'PLUGIN_DISABLED' };
  }
  // 静默最先判：这一拍连通道都没读，track 无从谈起
  if (quiet) {
    return { ...base, reason: 'GLOBAL_QUIET' };
  }
  if (allDown) {
    return { ...base, reason: 'DATA_UNAVAILABLE' };
  }

  // 她说过话但我们还没回 → REPLY；否则 PROACTIVE。
  // autoReply=false（「她说话我自动回」关着）时她的话不走进 reply 轨道，
  // 也就是说这一拍只按主动轨道的间隔/配额来，不会因为她刚开口就插一句。
  const autoReply = rules.autoReply !== false;
  const unanswered = autoReply && Boolean(lastUserTs) && (!lastSendTs || lastUserTs > lastSendTs);
  const track = unanswered ? 'reply' : 'proactive';

  if (track === 'reply') {
    // 回话不看电脑空不空：她可能是拿手机发来的（QQ/抖音），电脑那头空着很正常。
    // 之前这里有一条「空闲超过 awaySec 就 AWAY」，等于人一离开桌子就不回手机消息。
    if (lastUserTs && now - lastUserTs < cooldownMs) {
      return { ...base, track, reason: 'REPLY_WAIT' };
    }
    return { ...base, track, decision: 'send', reason: 'SEND' };
  }

  // PROACTIVE
  if (rules.proactive === false) {
    return { ...base, track, reason: 'PROACTIVE_OFF' };
  }
  // 忙碌时段只压「我先开口」：她先说了话，reply 轨道照常走（上面已经分流走了）。
  if (busy) {
    return { ...base, track, reason: 'BUSY_HOURS' };
  }
  if (characterAsleep) {
    return { ...base, track, reason: 'CHARACTER_ASLEEP' };
  }
  if (userWindingDown) {
    return { ...base, track, reason: 'USER_WINDING_DOWN' };
  }
  // 仅当用户显式开启 requirePcOnline 时才在「人不在电脑前」硬拦（除非 presenceSignal + judge 接管）。
  if (requirePcOnline && away && !presenceSignalOn) {
    return { ...base, track, reason: 'AWAY' };
  }
  if (lastSendTs && now - lastSendTs < minGapMs && !(byTrigger && now - lastSendTs >= floorMs)) {
    return { ...base, track, reason: 'GAP_TOO_SHORT' };
  }
  if (todaySent >= cap) {
    return { ...base, track, reason: 'DAILY_CAP' };
  }
  return { ...base, track, decision: 'send', reason: 'SEND' };
}

/** 在线/离开/灰区：只看空闲秒数，前台标题不参与。 */
export function presenceOf(idleSec, cfg) {
  if (idleSec < 0) return 'unknown';
  if (idleSec <= Number(cfg.idle?.onlineSec ?? 30)) return 'online';
  if (idleSec > Number(cfg.idle?.awaySec ?? 600)) return 'away';
  return 'gray';
}
