// brushoff-mood.js —— 敷衍与无理由不回引发的「闷闷 → 生气 → 补理由/道歉消气」轻量情绪状态机。
// 规则：
// - 衰减窗口可配（默认 6 小时滑动衰减：每次记录各自到期，进入生气态满窗口自动恢复正常）。
// - 计入条件（两者共用 3 次门槛）：
//   1) 敷衍（调法 A）：她上一句非随口话（chitchat）、非约定/召唤/嘱咐、非极短单字（>= 8 字），
//      用户在非上课/非忙碌/非明确告别时只回敷衍词；
//   2) 不回：她主动发出的非纯提醒消息（含随口话、分享、关心等）超过 noReplyMin（默认 90 分钟）
//      仍未回复，且不在静默/上课/忙碌免责范围内。
// - 同一段聊天（距上次认真回复 30 分钟内）不再重复计入；认真回复一次可直接抵消之前攒的闷闷次数（+0 且清零未进生气的累计）。
// - 答应约定（如「等我 / 我到了，出来吧」回「嗯嗯 / 好的 / 收到」）与随口话的敷衍均不计入。
// - 第 1 次：有点闷，自然收住、不追问；第 2 次：更失落；第 3 次：进入生气（首次明确说原因，
//   暂停主动分享，普通闲聊带情绪，回复延迟可配默认 25–50 秒）。同一次生气只主动解释一遍，被问起可再说。
// - 补说理由或道歉：当轮立刻消气，恢复正常回复速度和主动分享。
import fs from 'node:fs';
import path from 'node:path';
import { BRUSHOFF_MOOD_DEFAULTS, CONFIG_PATH } from '../settings/config.js';
import { detectBusySpeech, windowOverlapsBusyOrClass } from '../decision/receptivity.js';
import { inQuiet } from '../perception/schedule.js';
import { isExpectedAckForPrompt, isExplicitClose, isMinimalReply } from './chat-rhythm.js';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;
export const BRUSHOFF_DECAY_MS = BRUSHOFF_MOOD_DEFAULTS.decayHours * HOUR_MS;
export const SAME_CHAT_WINDOW_MS = 30 * MIN_MS;
export const ANGRY_THRESHOLD = 3;
export const ANGRY_DELAY_MIN_MS = BRUSHOFF_MOOD_DEFAULTS.angryDelayMinSec * 1000;
export const ANGRY_DELAY_MAX_MS = BRUSHOFF_MOOD_DEFAULTS.angryDelayMaxSec * 1000;

const EXEMPT_PROACTIVE_SLOTS = new Set(['reply', 'forward', 'noReply', 'agreement', 'agenda', 'examSoon', 'examReview']);

function decayHoursOf(cfg) {
  const raw = cfg?.rules?.brushoffMood?.decayHours ?? BRUSHOFF_MOOD_DEFAULTS.decayHours;
  const hours = Number(raw);
  return Number.isFinite(hours) ? Math.max(1, Math.min(168, hours)) : BRUSHOFF_MOOD_DEFAULTS.decayHours;
}

function noReplyMinOf(cfg) {
  const raw = cfg?.rules?.brushoffMood?.noReplyMin ?? BRUSHOFF_MOOD_DEFAULTS.noReplyMin;
  const min = Number(raw);
  return Number.isFinite(min) ? Math.max(15, Math.min(360, min)) : BRUSHOFF_MOOD_DEFAULTS.noReplyMin;
}

const EXCUSE_RE = /(?:(?:刚才|刚刚|刚|那会儿|这会儿|一直|前面).{0,10}(?:忙|上课|开会|干活|学习|开车|实习|实验|写作业|没顾上|没来得及|没看清|没看到|不方便|静音|接电话|有人|在外面|在路上)|(?:我|先|要|得|马上|准备)去(?:忙|上课|开个?会|干活|写作业|上班|考试))/u;
const NEGATED_BUSY_RE = /(?:没在|没有在|没去|没|并非|不是|不算|才没|也没在|也没|并不|不太|不)\s*(?:忙|上课|开会|干活|学习|开车|实习|实验|写作业|加班)/u;
const APOLOGY_RE = /(?:对不起|抱歉|sorry|我错了|错啦|错了错了|别生气|别气了|别气啦|别不开心|别闷了|消消气|原谅我|刚才太敷衍|不该敷衍|是我敷衍|我好好看|我认真看|重新认真看|哄哄|赔罪|是我不好)/iu;
const ASK_ANGRY_RE = /(?:怎么了|怎么啦|咋了|咋啦|生气了|生气啦|不开心|闷闷|生我气|气啥|为什么不理|干嘛不理|闹别扭)/u;

function storePath() {
  return path.join(path.dirname(CONFIG_PATH), 'data', 'brushoff-mood.json');
}

function contentLen(text) {
  return String(text || '').normalize('NFKC').replace(/\[[^\]]{1,12}\]/gu, '').replace(/[\p{P}\p{S}\s]+/gu, '').length;
}

function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

export function brushoffMoodEnabled(cfg) {
  return cfg?.rules?.brushoffMood?.enabled === true;
}

export function isBusyExcuse(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  const clauses = s.split(/[，,。；;！!?？\n]+/u).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    if (NEGATED_BUSY_RE.test(clause)) continue;
    if (detectBusySpeech(clause) || EXCUSE_RE.test(clause)) return true;
  }
  return false;
}

export function isApologyText(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return APOLOGY_RE.test(s);
}

export function isAskingWhyAngry(text) {
  return ASK_ANGRY_RE.test(String(text || '').trim());
}

/** 调法 A：不卡大段字数，排除约定/召唤/极短单字与上课/忙碌免责。 */
export function isBrushoffMessage({ prevMeText = '', userText = '', cfg = {}, now = Date.now() } = {}) {
  const prev = String(prevMeText || '').trim();
  const reply = String(userText || '').trim();
  if (!prev || !reply) return false;
  if (contentLen(prev) < 8) return false;
  if (isExplicitClose(reply) || isBusyExcuse(reply) || isApologyText(reply)) return false;
  if (isExpectedAckForPrompt(prev, reply)) return false;
  if (!isMinimalReply(reply)) return false;
  const tz = cfg?.timezone || 'Asia/Shanghai';
  if (windowOverlapsBusyOrClass(now - 60_000, now, cfg, tz)) return false;
  return true;
}

function decayRecord(rec, now, decayMs) {
  const base = rec && typeof rec === 'object' ? { ...rec } : {};
  let events = Array.isArray(base.events)
    ? base.events.filter((e) => Number.isFinite(e?.at) && now >= e.at && now - e.at < decayMs)
    : [];
  let angryAt = Number(base.angryAt) || 0;
  let explained = Boolean(base.explained);
  let lastBrushoffAt = Number(base.lastBrushoffAt) || 0;
  if (angryAt > 0 && (now < angryAt || now - angryAt >= decayMs)) {
    // 生气满 6 小时自然衰减恢复正常
    angryAt = 0;
    explained = false;
    events = [];
  }
  if (lastBrushoffAt > 0 && now - lastBrushoffAt >= decayMs) {
    lastBrushoffAt = 0;
  }
  const seenMsgAts = Array.isArray(base.seenMsgAts)
    ? base.seenMsgAts.filter((t) => Number.isFinite(t) && t > 0).slice(-50)
    : (Number(base.lastProcessedAt) > 0 ? [Number(base.lastProcessedAt)] : []);
  const pendingProactive = base.pendingProactive && Number.isFinite(base.pendingProactive.at)
    ? base.pendingProactive : null;
  const level = angryAt > 0 ? 'angry' : events.length > 0 ? 'sulking' : 'normal';
  return {
    events,
    angryAt,
    explained,
    pendingExplanation: angryAt && !explained ? base.pendingExplanation : null,
    lastBrushoffAt,
    lastProcessedAt: Number(base.lastProcessedAt) || 0,
    lastSubstantiveReplyAt: Number(base.lastSubstantiveReplyAt) || 0,
    pendingProactive,
    seenMsgAts,
    level,
    count: events.length,
  };
}

export function getBrushoffMoodState({ cfg, peer, now = Date.now() } = {}) {
  if (!brushoffMoodEnabled(cfg) || !peer) {
    return { enabled: false, level: 'normal', count: 0, angryAt: 0, explained: false, lastBrushoffAt: 0, events: [] };
  }
  const all = readAll();
  const state = decayRecord(all[String(peer)], now, decayHoursOf(cfg) * HOUR_MS);
  return { enabled: true, ...state };
}

function randomAngryDelayMs(cfg, rand = Math.random) {
  const min = Number(cfg?.rules?.brushoffMood?.angryDelayMinSec ?? BRUSHOFF_MOOD_DEFAULTS.angryDelayMinSec);
  const max = Number(cfg?.rules?.brushoffMood?.angryDelayMaxSec ?? BRUSHOFF_MOOD_DEFAULTS.angryDelayMaxSec);
  const minSec = Math.max(0, Number.isFinite(min) ? min : BRUSHOFF_MOOD_DEFAULTS.angryDelayMinSec);
  const maxSec = Math.max(minSec, Number.isFinite(max) ? max : BRUSHOFF_MOOD_DEFAULTS.angryDelayMaxSec);
  return Math.round((minSec + rand() * (maxSec - minSec)) * 1000);
}

/**
 * 在私聊回复前评估本条消息对敷衍情绪状态机的影响。
 * 返回：{ level, count, hint, delayMs, recovered, triggered, suppressFollowUp }
 */
export function evaluateBrushoffTurn({ cfg, peer, channel = '', outgoing, prevMeText = '', userText = '', at = Date.now(), now = Date.now(), rand = Math.random, recoveryKind = null } = {}) {
  if (!brushoffMoodEnabled(cfg) || !peer) {
    return { level: 'normal', count: 0, hint: '', delayMs: 0, recovered: null, triggered: false, suppressFollowUp: false };
  }
  const key = String(peer);
  const all = readAll();
  const decayHours = decayHoursOf(cfg);
  const cur = decayRecord(all[key], now, decayHours * HOUR_MS);

  // 用近期已处理时间戳集合去重，避免 A -> B -> 重试 A 重复累计
  const msgAt = Number(at) || now;
  const alreadyProcessed = cur.seenMsgAts.includes(msgAt);
  const nextSeen = alreadyProcessed ? cur.seenMsgAts : [...cur.seenMsgAts, msgAt].slice(-50);

  // 1) 处于闷闷或生气态时：优先检查「补说理由」或「道歉」→ 当轮立刻消气
  const resolvedRecovery = recoveryKind !== null
    ? recoveryKind
    : (isBusyExcuse(userText) ? 'excuse' : isApologyText(userText) ? 'apology' : 'other');
  if (cur.level !== 'normal' && resolvedRecovery === 'excuse') {
    all[key] = {
      events: [], angryAt: 0, explained: false, lastBrushoffAt: 0,
      lastProcessedAt: msgAt, lastSubstantiveReplyAt: now, pendingProactive: null, seenMsgAts: nextSeen,
    };
    writeAll(all);
    return {
      level: 'normal',
      count: 0,
      hint: '【心情恢复】对方补说了原因（刚才确实在忙或上课没来得及细看），心里的别扭散了、气也消了。当轮恢复正常语气和热情，可以顺口接一句类似「早说你在忙嘛」，自然给台阶下。',
      delayMs: 0,
      recovered: 'excuse',
      triggered: false,
      suppressFollowUp: false,
    };
  }
  if (cur.level !== 'normal' && resolvedRecovery === 'apology') {
    all[key] = {
      events: [], angryAt: 0, explained: false, lastBrushoffAt: 0,
      lastProcessedAt: msgAt, lastSubstantiveReplyAt: now, pendingProactive: null, seenMsgAts: nextSeen,
    };
    writeAll(all);
    return {
      level: 'normal',
      count: 0,
      hint: '【心情恢复】对方认真道歉/哄你了，气消得差不多了。按人设顺势下台阶、恢复正常语气（可以保留一点点傲娇收尾），别再继续冷淡。',
      delayMs: 0,
      recovered: 'apology',
      triggered: false,
      suppressFollowUp: false,
    };
  }

  // 2) 检查本条是否构成认真回复（抵消之前攒的闷闷次数）或一次新的无理由敷衍
  let next = cur;
  let triggered = false;
  let lastSubstantiveReplyAt = cur.lastSubstantiveReplyAt;
  const inSameChat = lastSubstantiveReplyAt > 0 && now >= lastSubstantiveReplyAt && now - lastSubstantiveReplyAt < SAME_CHAT_WINDOW_MS;
  const isChitchatPrev = Boolean(
    cur.pendingProactive?.slot === 'chitchat' &&
    (!prevMeText || !cur.pendingProactive.text ||
      String(prevMeText).includes(cur.pendingProactive.text.slice(0, 16)) ||
      cur.pendingProactive.text.includes(String(prevMeText).slice(0, 16)))
  );
  const isSubstantive = Boolean(
    String(userText || '').trim() &&
    !isMinimalReply(userText) &&
    !isExplicitClose(userText) &&
    !isExpectedAckForPrompt(prevMeText, userText)
  );

  if (!alreadyProcessed && isSubstantive) {
    lastSubstantiveReplyAt = now;
    if (cur.level === 'sulking') {
      // 认真回过一次：抵消之前攒的闷闷次数（未进生气时直接清零）
      next = { ...cur, events: [], count: 0, level: 'normal', lastBrushoffAt: 0, lastProcessedAt: msgAt };
    } else {
      next = { ...cur, lastProcessedAt: msgAt };
    }
  } else if (!alreadyProcessed && !inSameChat && !isChitchatPrev && isBrushoffMessage({ prevMeText, userText, cfg, now })) {
    triggered = true;
    const events = [...cur.events, { at: now, kind: 'brushoff', excerpt: String(prevMeText || '').slice(0, 40) }].slice(-6);
    const enterAngry = cur.angryAt > 0 || events.length >= ANGRY_THRESHOLD;
    const angryAt = cur.angryAt > 0 ? cur.angryAt : (enterAngry ? now : 0);
    next = {
      events,
      angryAt,
      explained: cur.angryAt > 0 ? cur.explained : false,
      lastBrushoffAt: now,
      lastProcessedAt: msgAt,
      level: angryAt > 0 ? 'angry' : 'sulking',
      count: events.length,
    };
  } else if (!alreadyProcessed) {
    next = { ...cur, lastProcessedAt: msgAt };
  }

  // 3) 生成对应阶段的提示与回复延迟
  let hint = '';
  let delayMs = 0;
  const previousPrompt = cur.pendingExplanation;
  // Delivery evidence comes from the active channel's completed ordinary reply.
  const explained = next.explained || Boolean(previousPrompt && previousPrompt.channel === channel &&
    outgoing?.peer === key && outgoing.count > 0 && outgoing.text &&
    outgoing.firstAt >= previousPrompt.msgAt && outgoing.lastAt >= previousPrompt.promptedAt &&
    outgoing.lastAt >= outgoing.firstAt && outgoing.lastAt <= now &&
    (msgAt === previousPrompt.msgAt || outgoing.firstAt < msgAt));
  let pendingExplanation = null;

  if (next.level === 'angry') {
    delayMs = randomAngryDelayMs(cfg, rand);
    if (!explained) {
      pendingExplanation = previousPrompt?.msgAt === msgAt && previousPrompt.channel === channel
        ? previousPrompt : { channel, msgAt, promptedAt: now };
      hint = '【心情变化：生气了】' + decayHours + ' 小时内已经有 3 次认真说话被敷衍或晾着没回。按人设在这一轮明确说清楚为什么不开心（比如连着几次找你说话都只回一两个字或干脆没理，有点委屈/先不想分享了），语气短一点、带点小脾气，不追问。';
    } else if (isAskingWhyAngry(userText)) {
      hint = '【当前情绪：仍在生气】对方在问你怎么了。按人设简短再说一遍原因（连着几次找你说话都被敷衍或没回），语气保持简短冷淡，不主动抛新话题。';
    } else {
      hint = '【当前情绪：仍在生气】你还在气头上，不太想理人。语气短一些、冷淡一点，收起撒娇与热情，不主动抛话题、不分享探索，也不要反复控诉原因。';
    }
  } else if (next.level === 'sulking' && triggered) {
    if (next.count === 1) {
      hint = '【心情变化：有点闷】刚才你认真说了一段话，对方只敷衍回了一两个字（没说在忙或上课）。心里有点闷闷的，自然收住话题即可，不要追问、不要硬继续展开。';
    } else {
      hint = '【心情变化：更失落了】' + decayHours + ' 小时内已经是第二次被敷衍或晾着没回。语气更失落一点，自然收住话题、不追问，也不要直接发火。';
    }
  }

  all[key] = {
    events: next.events,
    angryAt: next.angryAt,
    explained,
    pendingExplanation,
    lastBrushoffAt: next.lastBrushoffAt,
    lastProcessedAt: next.lastProcessedAt,
    lastSubstantiveReplyAt,
    pendingProactive: null,
    seenMsgAts: nextSeen,
  };
  writeAll(all);

  return {
    level: next.level,
    count: next.count,
    hint,
    delayMs,
    recovered: null,
    triggered,
    suppressFollowUp: triggered || next.level === 'angry',
  };
}

/**
 * 轻量模型增强版：仅当当前已处于闷闷/生气态且有可用 generate 时，调轻量模型判别是否真正在解释忙碌或道歉，
 * 避免「我刚才没在上课」这类否定句误消气；平时 normal 态零调用，模型失败时自动退回本地规则。
 */
export async function evaluateBrushoffTurnWithLlm(input) {
  const { cfg, peer, userText = '', now = Date.now(), generate = null } = input || {};
  if (!brushoffMoodEnabled(cfg) || !peer) return evaluateBrushoffTurn(input);
  const st = getBrushoffMoodState({ cfg, peer, now });
  let recoveryKind = null;
  if (st.level !== 'normal' && typeof generate === 'function' && String(userText || '').trim()) {
    try {
      const prompt = [
        '角色因为之前被敷衍正处于不开心/生气状态。判断用户这条回复是否属于：',
        '- "excuse"：对方明确解释了自己刚才确实在忙、上课、开会、没顾上看等客观原因（注意：若对方说「我没在忙」「我刚才没在上课」这类否定，必须判为 "other"）；',
        '- "apology"：对方在真诚道歉、认错或哄人；',
        '- "other"：其他普通聊天、敷衍或否认在忙。',
        '只输出严格 JSON {"kind":"excuse"|"apology"|"other"}，不要解释。',
        JSON.stringify({ 消息: String(userText).trim().slice(0, 200) }),
      ].join('\n');
      const res = await generate({ prompt, timeoutMs: 4000, minOutputTokens: 128, reasoningEffort: 'off', tag: 'brushoff-recovery' });
      const raw = String(res?.text || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
      const m = /\{[\s\S]*\}/.exec(raw);
      if (res?.ok && m) {
        const parsed = JSON.parse(m[0]);
        if (['excuse', 'apology', 'other'].includes(parsed?.kind)) {
          recoveryKind = parsed.kind;
        }
      }
    } catch { /* 模型不可用时退回本地规则 */ }
  }
  return evaluateBrushoffTurn({ ...input, recoveryKind });
}

/** 记录一条已发出的主动消息（供「随口话敷衍豁免」与「90 分钟无理由不回计入」使用）。 */
export function noteProactiveForBrushoff({ cfg, peer, slot = '', text = '', at = Date.now() } = {}) {
  if (!brushoffMoodEnabled(cfg) || !peer) return;
  const s = String(slot || '');
  if (!s || EXEMPT_PROACTIVE_SLOTS.has(s)) return;
  const key = String(peer);
  const all = readAll();
  const cur = decayRecord(all[key], at, decayHoursOf(cfg) * HOUR_MS);
  all[key] = {
    events: cur.events,
    angryAt: cur.angryAt,
    explained: cur.explained,
    pendingExplanation: cur.pendingExplanation,
    lastBrushoffAt: cur.lastBrushoffAt,
    lastProcessedAt: cur.lastProcessedAt,
    lastSubstantiveReplyAt: cur.lastSubstantiveReplyAt,
    pendingProactive: { at: Number(at) || Date.now(), slot: s, text: String(text || '').slice(0, 80) },
    seenMsgAts: cur.seenMsgAts,
  };
  writeAll(all);
}

/** 定期检查是否有超过 noReplyMin（默认 90 分钟）仍未回复的主动消息（含随口话），满足非免责条件则计 1 次。 */
export function evaluateBrushoffNoReply({ cfg, peer, now = Date.now(), lastHerTs = 0, lastHerText = '' } = {}) {
  if (!brushoffMoodEnabled(cfg) || !peer) {
    return { triggered: false, level: 'normal', count: 0 };
  }
  const key = String(peer);
  const all = readAll();
  const cur = decayRecord(all[key], now, decayHoursOf(cfg) * HOUR_MS);
  const pending = cur.pendingProactive;
  if (!pending) return { triggered: false, level: cur.level, count: cur.count };

  const saveRec = (patch) => {
    all[key] = {
      events: cur.events,
      angryAt: cur.angryAt,
      explained: cur.explained,
      pendingExplanation: cur.pendingExplanation,
      lastBrushoffAt: cur.lastBrushoffAt,
      lastProcessedAt: cur.lastProcessedAt,
      lastSubstantiveReplyAt: cur.lastSubstantiveReplyAt,
      pendingProactive: cur.pendingProactive,
      seenMsgAts: cur.seenMsgAts,
      ...patch,
    };
    writeAll(all);
  };

  // 用户在主动消息之后已经回复过 → 清除待回
  if (Number(lastHerTs) >= pending.at) {
    saveRec({ pendingProactive: null });
    return { triggered: false, level: cur.level, count: cur.count };
  }
  // 同一段聊天（距上次认真回复 30 分钟内）发出的后续消息不计入不回
  if (cur.lastSubstantiveReplyAt > 0 && pending.at >= cur.lastSubstantiveReplyAt && pending.at - cur.lastSubstantiveReplyAt < SAME_CHAT_WINDOW_MS) {
    saveRec({ pendingProactive: null });
    return { triggered: false, level: cur.level, count: cur.count };
  }
  const thresholdMs = noReplyMinOf(cfg) * MIN_MS;
  if (now - pending.at < thresholdMs) {
    return { triggered: false, level: cur.level, count: cur.count };
  }

  // 免责：静默、课表/忙碌时段、或用户此前已说明在忙/告别
  const tz = cfg?.timezone || 'Asia/Shanghai';
  const exempt = inQuiet(pending.at, cfg.quietHours, tz) ||
    inQuiet(now, cfg.quietHours, tz) ||
    windowOverlapsBusyOrClass(pending.at, now, cfg, tz) ||
    isBusyExcuse(lastHerText) ||
    isExplicitClose(lastHerText);
  if (exempt) {
    saveRec({ pendingProactive: null });
    return { triggered: false, level: cur.level, count: cur.count };
  }

  const events = [...cur.events, { at: now, kind: 'no_reply', slot: pending.slot, excerpt: pending.text.slice(0, 40) }].slice(-6);
  const enterAngry = cur.angryAt > 0 || events.length >= ANGRY_THRESHOLD;
  const angryAt = cur.angryAt > 0 ? cur.angryAt : (enterAngry ? now : 0);
  const level = angryAt > 0 ? 'angry' : 'sulking';
  saveRec({
    events,
    angryAt,
    explained: cur.angryAt > 0 ? cur.explained : false,
    pendingExplanation: cur.angryAt > 0 ? cur.pendingExplanation : null,
    lastBrushoffAt: now,
    pendingProactive: null,
  });
  return { triggered: true, level, count: events.length };
}

/** 生气期间暂停主动探索分享（share 槽位）。 */
export function isSharePausedByMood(cfg, peer, now = Date.now()) {
  const st = getBrushoffMoodState({ cfg, peer, now });
  return st.enabled && st.level === 'angry';
}

/** 近期被敷衍后抑制对那条消息的 noReply 追问。 */
export function isBrushoffFollowUpSuppressed(cfg, peer, now = Date.now()) {
  const st = getBrushoffMoodState({ cfg, peer, now });
  return st.enabled && (st.level === 'angry' || st.lastBrushoffAt > 0);
}

/** 主动闲聊（chitchat）在生气期间照常发，但带上简短冷淡的情绪底色。 */
export function proactiveBrushoffHint(cfg, peer, now = Date.now()) {
  const st = getBrushoffMoodState({ cfg, peer, now });
  if (!st.enabled || st.level !== 'angry') return '';
  return '【当前情绪：还在生气】之前连着被敷衍了几次，这会儿还有点不开心、不太热情。这条普通闲聊写得短一些、冷淡或别扭一点，收起撒娇，不要主动安利或分享探索内容。';
}
