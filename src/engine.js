// engine.js —— 一拍的全部流程（判定 → 由头 → 生成 → 发送 → 落账）。
//
// 为什么单独一个文件：同一套流程有两个入口——
//   1) 命令行  node src/run.js --once / --loop
//   2) dsh 插件  src/plugin.js（宿主里按 tickMinutes 定时跑，不用另开进程）
// 早先这段写在 run.js 里，插件只能靠 spawn 一个 node 进程来复用，等于把「独立进程」
// 原样搬进宿主，纯属自欺。现在两边 import 同一个 tick()。
//
// 与命令行版本的唯一区别是**注入点**：
//   · generate —— 生成一句话用的实现。命令行走 spawn dsh CLI（llm.js）；
//                 插件走宿主自己的 ctx.llm（hostllm.js），省掉一次 Electron 冷启动。
//   · llmReady —— 由调用方告诉 compose「这套环境能不能用 llm」，省得它自己探测。
import { loadConfig, loadState, saveState } from "./config.js";
import { probe, classifyActivity, anticheatRunning } from "./probe.js";
import { readChannels } from "./channels/index.js";
import { decide, presenceOf, checkTierGap, REASONS } from "./decide.js";
import { append, appendOnce } from "./logger.js";
import { pruneOldRecords, recordDay } from "./retention.js";
import { hhmm, agoSec, healthDay, dayKey } from "./time.js";
import { inQuiet, inWindows } from "./schedule.js";
import { agreementMessage, agreementStillClaimed, dueAgreement, claimAgreement, markAgreementSent, releaseAgreement } from "./agreements.js";
import { rememberExplorationShare } from "./exploration-feedback.js";
import { busyNow } from "./holidays.js";
import { activeChatChannel, canReadChat, chatDialogue, chatPeer, emotionPeer, externalInFlight, sendChatRound } from './channels/external.js';
import { douyinPrimary } from './channels/douyin-im.js';
import { chatChanging, readyDouyinBinding } from './channels/chat-switch.js';
import { recordActionOutbound } from './action-proposal.js';
import { appendEmotionInbox } from './emotion-sync.js';
import { buildContext, selfMtime, lastHerMessage } from "./context.js";
import { topicCandidates, withForwardContent, fishStale, tierOfSlot, answerableOn, agreementTopic } from "./topics.js";
import { chitchatGate, chitchatTopic, noteChitchatSent, bareRemainingToday, chitchatYield, chitchatJudgeNo } from "./chitchat.js";
import { restFor } from "./bedtime.js";
import { characterRestAt, WIND_DOWN_HINT, WOKEN_HINT } from "./character-rest.js";
import { closingCooldownActive, isHotChat } from "./chat-rhythm.js";
import { pickSeed, conversationLine } from "./seeds.js";
import { detectTriggers } from "./triggers.js";
import { summarizeVideo, readCache as readVideoCache } from "./videosum.js";
import { outboundFor, answeredAlready, recentOutbound, recentTurns, douyinLastInbound } from "./outbound.js";
import { settle, sweep, noteSent, noteProactive, topicPreferenceMode, adaptiveExtraMin } from "./feedback.js";
import { generate as llmGenerate } from "./llm.js";
import { compose, composeDraft, guard } from "./compose.js";
import { loadPersona, qqContinuationTone } from "./persona.js";
import { buildSnapshot } from "./snapshot.js";
import { shadowEligible, shadowRate, runShadow } from "./shadow.js";
import { maybeWriteYesterdayReport } from "./report.js";
import { judgeDecision } from "./judge.js";
import { l3Screen, screenHints, screenFacts } from "./perception.js";
import { pollFishMail } from "./fishmail.js";
import { explainRun } from './explain.js';
import { pickNoReply, judgeAway } from "./noreply.js";
import { readSignals, signalFacts, needL3 } from "./signals.js";
import { readMemory } from "./memorysource.js";
import { runQqContinuation } from "./qq-continuation.js";
import { explorationMood, loadExploration, styleApprovedDraft, toneOf } from "./explore.js";
import { portraitMood } from "./emotion-portrait.js";
import { readPortraitMoodMap } from "./emotion-sync.js";
import { resolveCombinedMood, notifyExternalMoodMessage, shouldUseBuiltinEmotion } from "./extensions.js";
import { isBridgeManagedMessage } from './qq-debounce.js';
import { isHandledActionMessage, prepareActionProposal, RETRY_QUESTION } from './action-proposal.js';
import { publicExplorationUrl } from "./explore-media.js";
import { projectQuestion, recordProjectQuestion, captureProjectAnswer, projectMemory, proactiveProjectBlock, writeProjectQuestion } from "./project-chat.js";

const CHITCHAT_MISSES = {
  NO_CHITCHAT_BUDGET: 'chitchat_budget',
  NO_CHITCHAT_WINDOW: 'chitchat_window',
  NO_CHITCHAT_COOLDOWN: 'chitchat_cooldown',
  CHITCHAT_NO_JUDGE: 'chitchat_no_judge',
  CHITCHAT_REPLY_PENDING: 'chitchat_reply_pending',
};

function freshDayState(st, day) {
  if (!st.day || st.day !== day) {
    st.day = day;
    st.real = { todaySent: 0, lastSendAt: 0 };
    st.sim = { todaySent: 0, lastSendAt: 0, lastTrack: null };
  }
  st.real ||= { todaySent: 0, lastSendAt: 0 };
  st.sim ||= { todaySent: 0, lastSendAt: 0 };
  return st;
}

function previewState(st) {
  if (!st.content || (!st.sim?.lastSendAt && st.pending?.dryRun !== true)) return st;
  // Older rehearsals also wrote into the shared topic history. Keep the
  // markers that only successful delivery can update. Real timing and
  // feedback still come from st.real, channel history, and st.feedback.
  const realOnly = [
    'lastAgendaNight', 'lastAgendaSoon', 'lastExamSoon', 'lastExamReview',
    'lastNoReplyFor', 'lastRetryProposalAt', 'sharedExplorationIds', 'explorationLoginNotices',
  ];
  const content = Object.fromEntries(realOnly.filter(key => Object.hasOwn(st.content, key)).map(key => [key, st.content[key]]));
  return { ...st, content };
}

export function qqContinuationEnabled(cfg) {
  return cfg.enabled !== false && cfg.rules?.proactive !== false && cfg.rules?.qqContinuation === true &&
    cfg.content?.enabled !== false && cfg.content?.mode !== 'fixed' &&
    canReadChat(cfg) && cfg.channels?.[activeChatChannel(cfg)]?.send !== false &&
    Boolean(chatPeer(cfg)) && (cfg.dryRun !== false || cfg.send?.enabled === true);
}

function resolveMoodState({ cfg, persona, now }) {
  const explored = cfg.exploration?.mood === true ? explorationMood(loadExploration(), persona, now, cfg.exploration) : null;
  const portraitShort = portraitMood(cfg, persona, now);
  const portraitFull = cfg.exploration?.portrait === true
    ? readPortraitMoodMap({ peer: emotionPeer(cfg), now })
    : '';
  const basePortrait = portraitFull
    ? (portraitShort && !portraitFull.includes(portraitShort) ? `${portraitFull}；即时心情：${portraitShort}` : portraitFull)
    : portraitShort;
  const portrait = resolveCombinedMood({ basePortrait, peer: emotionPeer(cfg), now, cfg });
  return { explored, portrait };
}

export async function tickQqContinuation({ candidate, read, generate, active }) {
  const to = candidate.incoming.peer;
  const cfg = loadConfig();
  const channel = activeChatChannel(cfg);
  const dryRun = cfg.dryRun !== false;
  const bucketName = dryRun ? 'sim' : 'real';
  const allowed = () => {
    const fresh = loadConfig();
    const now = Date.now();
    if (!active() || now > candidate.expiresAt || !qqContinuationEnabled(fresh) ||
        (fresh.dryRun !== false) !== dryRun || activeChatChannel(fresh) !== channel || chatPeer(fresh) !== to ||
        !isHotChat(candidate.turns, fresh) ||
        inQuiet(now, fresh.quietHours, fresh.timezone) || busyNow(now, fresh) || characterRestAt(fresh, now).asleep) return false;
    const st = freshDayState(loadState(), recordDay(now, fresh.timezone, fresh));
    const bucket = st[bucketName];
    return topicPreferenceMode(st, { slot: 'qqContinuation' }, now) !== 'mute_less' &&
      (Number(bucket.lastSendAt) || 0) < candidate.outgoing.firstAt &&
      (Number(bucket.todaySent) || 0) < (Number(fresh.rules.dailyCap) || 0);
  };
  if (!allowed()) return;
  const persona = loadPersona({ cfg });
  const { explored, portrait } = resolveMoodState({ cfg, persona, now: Date.now() });
  const moodBits = [portrait, toneOf(explored?.text)].filter(Boolean).join('；');
  const baseTone = qqContinuationTone(persona);
  const { windDown } = characterRestAt(cfg);
  const tone = [baseTone, moodBits && `当前心情参考（只调语气，不直念）：${moodBits}`, windDown && WIND_DOWN_HINT].filter(Boolean).join('；');
  const r = await runQqContinuation({
    candidate, read, allowed, generate, cfg, tone, characterWindDown: windDown,
    async deliver(text) {
      const sent = dryRun ? null : await sendChatRound({
        cfg, to, text, dryRun: false, split: { enabled: false }, source: 'continuation', timeoutMs: cfg.send?.timeoutMs,
        canDispatch: () => !characterRestAt(loadConfig()).asleep && topicPreferenceMode(loadState(), { slot: 'qqContinuation' }) !== 'mute_less',
      });
      const reason = dryRun ? 'DRY_RUN' : sent.dryRun ? 'SEND_DISABLED' : sent.reason || (sent.ok ? 'SEND' : 'SEND_FAILED');
      return { text, sent, reason };
    },
  });
  const now = Date.now();
  const { reason, sent, text } = r;
  const delivered = sent?.ok && !sent.dryRun;
  if (text && (dryRun || delivered)) {
    const latest = loadConfig();
    const st = freshDayState(loadState(), recordDay(now, latest.timezone, latest));
    const bucket = st[bucketName];
    bucket.todaySent = (Number(bucket.todaySent) || 0) + 1;
    bucket.lastSendAt = now;
    bucket.lastTrack = 'proactive';
    if (delivered) {
      st.lastRealSendAt = now;
      noteProactive(st, { slot: 'qqContinuation' }, { channel, peer: to, at: sent.sentAt || now });
    }
    st.content ||= {};
    st.content.recentSends = [...(st.content.recentSends || []), text].slice(-6);
    saveState(st);
  }
  append({
    ts: now, decision: text && (dryRun || delivered) ? 'send' : 'skip',
    track: 'proactive', reason, topic: { slot: 'qqContinuation', label: '热聊补一句' },
    content: text ? { text, chars: text.length } : null,
    delivery: sent && !sent.dryRun && sent.reason !== 'TOPIC_PREFERENCE_MUTED'
      ? { attempted: true, ok: delivered, to, messageId: sent.messageId, error: sent.error } : { attempted: false, reason },
  }, now, cfg.timezone, cfg);
}

/** 回填：上一条 SEND 之后，她有没有在窗口内真的说话。 */
/**
 * 电脑侧的存在记录：连续坐了多久、刚才离开过又回来没有。
 * 不接手机 App 时这是仅有的「她在不在 / 在干什么」信号，所以每拍都算一遍，
 * 但它只当由头素材，不参与「发不发」的判定。
 */
function isScreenLocked(sys) {
  if (sys?.locked === true) return true;
  return Array.isArray(sys?.procs) && sys.procs.some((p) => String(p).toLowerCase() === 'logonui');
}

export function trackPcPresence(st, sys, now, cfg) {
  const locked = isScreenLocked(sys);
  const idleSec =
    typeof sys?.idle_ms === 'number' && sys.idle_ms >= 0 ? Math.round(sys.idle_ms / 1000) : null;
  if (idleSec == null && !locked) return null; // 探针没读到：不猜，保持上一次的记录
  const awaySec = Number(cfg?.idle?.awaySec) || 600; // 不设隐藏下限：她在设置页里改成多少就是多少
  // 「这一晚」按 4 点起算：凌晨还醒着不该在 0 点被清零重新计时
  const day = healthDay(now, cfg.timezone, 4);
  const pc =
    st.pc && st.pc.day === day
      ? st.pc
      : { day, activeSince: 0, awaySince: 0, lastReturnAt: 0, lastAwayMs: 0, locked: false };
  let event = null;

  if (locked) {
    // 系统锁屏（例如 UU 远控退出后自动锁屏）：不累计 awaySince，也不保持 activeSince；
    // 解锁后自然不会伪造「出去很久刚回电脑前」的 return 事件。
    pc.locked = true;
    pc.awaySince = 0;
    pc.activeSince = 0;
  } else {
    pc.locked = false;
    if (idleSec <= awaySec) {
      // 人在：从「离开」切回「在」——记下这次离开了多久
      if (!pc.activeSince) pc.activeSince = now;
      if (pc.awaySince) {
        pc.lastAwayMs = now - pc.awaySince;
        pc.lastReturnAt = now;
        pc.awaySince = 0;
        event = 'return';
      }
    } else {
      if (!pc.awaySince) pc.awaySince = now;
      pc.activeSince = 0; // 走开了就不再算「连续坐着」
    }
  }

  st.pc = pc;
  return event;
}

function settleBackfill(st, cfg, now, lastUserTs) {
  if (cfg.rules?.backfill === false) return null;
  const p = st.pending;
  if (!p) return null;
  const winMs = Math.max(1, Number(cfg.rules?.backfillWindowMin) || 30) * 60_000;
  const within = now - p.at <= winMs;

  if (within && lastUserTs && lastUserTs > p.at) {
    st.pending = null;
    return { hit: true, waitedSec: Math.round((lastUserTs - p.at) / 1000), track: p.track, at: p.at };
  }
  if (!within) {
    st.pending = null;
    return { hit: false, waitedSec: null, track: p.track, at: p.at };
  }
  return null;
}

export async function tick({
  persist = true, preview = false, generate: gen = null, llmReady = null, random = null,
  watchVideo = summarizeVideo, probeSystem = probe,
} = {}) {
  const cfg = loadConfig();
  if (preview) llmReady = typeof gen === 'function' && llmReady !== false;
  const now = Date.now();
  const tz = cfg.timezone;
  // 「一天」= 记录日：07:00 起算（logging.dayStartHour），不是自然日。
  // 配额清零、日志切分、归档清理都用这一个定义，免得 0 点和 7 点各切一次。
  const day = recordDay(now, tz, cfg);

  const storedState = loadState();
  const st = freshDayState(preview ? previewState(storedState) : storedState, day);

  // 先生成能还原的日报，再裁剪原始日志。
  if (persist && !preview) {
    try { maybeWriteYesterdayReport({ cfg, now, tz, st }); }
    catch { /* 归档失败不影响本拍。 */ }
  }
  // 记录只留最近 keepDays 天（默认 2 = 今天 + 昨天）：
  // 幂等，跑多少遍结果一样，删的是整文件，不会把正在写的那个删掉（它属于今天）。
  const pruned = preview ? null : pruneOldRecords(cfg, now, { tz });

  const sys = await probeSystem(false, cfg, { readOnly: preview });
  const idleSec = typeof sys.idle_ms === 'number' && sys.idle_ms >= 0 ? Math.round(sys.idle_ms / 1000) : -1;
  const quiet = inQuiet(now, cfg.quietHours, tz);
  // 忙碌时段：只压「我先开口」，不压回复（她先说话就该回）
  const busy = busyNow(now, cfg);
  const characterRest = characterRestAt(cfg, now);

  // 电脑侧的存在记录要在挑由头之前更新，否则「刚回来」永远是上一拍的状态
  const pcEvent = trackPcPresence(st, sys, now, cfg);

  const ch = readChannels(cfg, now, { quiet, readOnly: preview });
  const channel = activeChatChannel(cfg);

  // —— 阶段 3：自然触发时刻。L2 归类要提前算一遍（纯函数、0 成本），
  //    「一段活干完 / 刚下课 / self.md 刚写一条」本身就是可以开口的时刻。
  //    它只多给一个「这一拍有事件」的信号：静默、忙碌、离开、每日上限全在前面拦，
  //    间隔让不让路由 rules.naturalTriggers.takeGap 决定（默认不让）。
  //    默认 enabled=false 时 detectTriggers 立刻返回，连 st 都不碰。
  const activityNow = cfg.perception?.l2?.enabled !== false ? classifyActivity(sys, cfg.perception?.l2 || {}) : null;
  const triggers = detectTriggers({ cfg, now, tz, st, activity: activityNow, selfMtimeMs: selfMtime() });

  // 邮箱：独立通道，自己管开关和间隔；读不到只记原因，绝不影响这一拍的判定
  let mail = null;
  const phoneOn = cfg.sources?.phone?.enabled !== false;
  if (preview) {
    mail = { state: 'off', reason: 'PREVIEW_CACHE_ONLY' };
  } else if (!phoneOn) {
    // 手机端总闸关着：连邮箱都不碰（不联网），睡眠/压力/屏幕也就没有数据来源。
    mail = { state: 'off', reason: 'PHONE_SOURCE_OFF', note: '手机端数据总闸关着' };
  } else if (cfg.mail?.enabled === true) {
    try {
      mail = await pollFishMail({ cfg, state: st, now });
    } catch (e) {
      mail = { state: 'error', reason: 'MAIL_ERROR', note: String(e?.message || e).slice(0, 200) };
    }
  } else {
    mail = { state: 'off', reason: 'MAIL_DISABLED' };
  }

  // 回填要在判定之前做：用的是「这一拍读到的她最后一条消息」
  const backfill = settleBackfill(st, cfg, now, ch.lastUserTs);

  // 她回没回：比这句话更早发出去的 pending 都算「接住了」（QQ 与抖音并成一条时间线）
  // 阶段 2：顺手把她这一句的原文带上，配对时一起存（读不到就留空，不编）。
  const herLine = ch.lastUserTs ? lastHerMessage(cfg) : null;
  const herSayTs = Number(herLine?.ts) || 0;
  const herSay = herSayTs && Math.abs(herSayTs - (Number(ch.lastUserTs) || 0)) <= Number(cfg.rules?.feedback?.replyMatchSec ?? 60) * 1000 ? herLine.text : '';
  const repliedCount = settle(st, ch.lastUserTs, now, herSay, { tz, cfg, channel: cfg.channels?.primary });

  const useSim = preview || cfg.dryRun !== false;
  if (!quiet && !useSim && cfg.rules?.askProjectOnce === true && canReadChat(cfg)) {
    captureProjectAnswer(cfg, st, chatDialogue(cfg).incoming, now);
  }
  // 窗口已过、她一句话都没有的：每拍补判一次。盲着的时段（静默/全断）不判，dryRun 不写。
  if (!useSim) sweep(st, now, { tz, cfg, channel: cfg.channels?.primary, canJudge: !quiet && !ch.allDown });
  // 预览用真实发送历史判断时机，之前的演练次数和间隔不影响预览。
  const bucket = useSim && !preview ? st.sim : st.real;
  const todaySent = Number(bucket.todaySent) || 0;
  const lastSendTs = Math.max(Number(bucket.lastSendAt) || 0, Number(ch.lastSendTs) || 0) || null;
  // 阶段 1.1：同档最近一条的发出时间（旧 state 没有就按空处理，不迁移）
  const lastSendByTier = bucket.lastSendByTier && typeof bucket.lastSendByTier === 'object' ? bucket.lastSendByTier : {};

  // 连着几条她都没接，就把间隔拉长一点，别在没人应的时候一直敲。
  const extraGapMin = adaptiveExtraMin(st, cfg);
  const closing = !quiet && canReadChat(cfg) ? closingCooldownActive(recentTurns({ limit: 4, cfg }), cfg, now) : { active: false };
  const d = decide({
    cfg,
    now,
    idleSec,
    locked: isScreenLocked(sys),
    quiet,
    busy,
    characterAsleep: characterRest.asleep,
    userWindingDown: closing.active,
    lastUserTs: ch.lastUserTs,
    lastUserChannel: ch.lastUserChannel,
    lastSendTs,
    todaySent,
    allDown: ch.allDown,
    triggered: triggers.fired.length > 0,
    extraGapMin,
  });

  const peer = chatPeer(cfg);
  const bridgeReplyWindow = Number(cfg.rules?.qqTiming?.inFlightSec ?? 180) * 1000;
  const bridgeOwnsReply = (at) => channel === 'douyin' || channel === 'internal'
    ? Boolean(at) : isHandledActionMessage(peer, at) || isBridgeManagedMessage(peer, at, Date.now(), bridgeReplyWindow);
  if (d.track === 'reply' && ch.lastUserChannel === channel && bridgeOwnsReply(ch.lastUserTs)) {
    d.decision = 'skip';
    d.reason = 'REPLY_ALREADY_ANSWERED';
  }

  // —— 内容这一步：先问「有没有由头」，再问「写不写得出来」。
  //    任何一步失败都退回 skip，并且**不消耗当日配额**（见下面计数那块）。
  let ctx = null;
  let topic = null;
  let candidates = [];
  let content = null;
  let persona = null;
  let activity = null;
  let screen = null;
  let signals = null;
  let memory = null;
  let verdict = null;
  let actionProposal = null;
  const topicMisses = new Map();
  let phone = null;

  if (d.decision === 'send') {
    const mode = String(cfg.content?.mode || 'auto');
    if (cfg.content?.enabled === false) {
      d.decision = 'skip';
      d.reason = 'CONTENT_DISABLED';
    } else if (mode === 'fixed') {
      // 测试通道：不看由头、不叫模型，判到 send 就发这句固定的。
      // 用来单独验证「判定 → 发送」这一段，不掺内容生成的变量。
      const text = String(cfg.content.fixedText ?? '1');
      content = { ok: true, text, source: 'fixed', slot: 'fixed', chars: text.length, violations: [] };
    } else {
      ctx = buildContext({ cfg, now, st, ch, sys, tz });
      ctx.characterWindDown = d.track === 'proactive' && characterRest.windDown;
      ctx.characterWoken = d.track === 'reply' && ch.lastUserChannel === channel && ch.lastUserTs > 0 &&
        characterRestAt(cfg, ch.lastUserTs).asleep;
      ctx.projectMemory = projectMemory(cfg, st, now);
      ctx.clock = hhmm(now, tz);
      // 别的记忆插件里记着的事：只读，读不到还是照常写；有它句子才有「以前」。
      ctx.memory = readMemory({ cfg, now });
      memory = ctx.memory;
      // 我最近真发出去的那几条（跨通道），给 compose 防「连着几天一个开头」。
      ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
      // 阶段 3：这一拍是哪种自然事件挑起的（没有就是 null），给由头/快照当素材。
      ctx.trigger = triggers.fired[0] || null;
      // 数据断供提醒：超过阈值只记一条日志，且一天只记一次——不写 state（dryRun 也不碰）。
      const stale = fishStale(ctx.fish, cfg, now);
      if (phoneOn && cfg.sources?.phone?.staleGuard !== false && (stale.stale || !ctx.fish.ok)) {
        phone = { ...stale, missing: !ctx.fish.ok };
      }
      if (!preview && phoneOn && stale.stale) {
        appendOnce(
          { kind: 'fish_stale', ageHours: Math.round(stale.ageHours), limitHours: stale.limitHours, lastDate: ctx.fish.date || '' },
          now,
          tz,
          cfg,
        );
      }
      // 等待型候选只在有用户约定时入选。判断按原消息缓存，后续来信会让旧候选失效。
      ctx.noReply = null;
      const rejectedTopics = [];
      d.rejectedTopics = rejectedTopics;
      if (cfg.content?.topics?.noReply !== false && !busy) {
        // 通道侧的 lastUserTs 有时读不到（比如只在 QQ 上说过、这一拍抖音优先），
        // 用 ctx.her（对话解析出的「她最后一句」）兜底，否则会拿一条她其实已经应过的旧消息去追问。
        const herTs = Math.max(Number(ch.lastUserTs) || 0, Number(ctx.her?.lastTs) || 0) || null;
        // 抖音那条时间线要单独算：她在抖音回过、QQ 又早没说话，不能当成「没回」。
        const herOnDouyin = Number(douyinLastInbound({ cfg })?.ts) || 0;
        const cand = pickNoReply({ st, cfg, now, herTs, herOnDouyin });
        if (cand && st.content?.lastNoReplyFor !== cand.key) {
          let verdict = st.noReply && st.noReply.key === cand.key ? st.noReply.verdict || null : null;
          if ((!verdict || (verdict.judge === 'llm' && verdict.followUp == null)) && cfg.content?.topics?.noReplyJudge !== false) {
            const afterHerMin = Math.max(0, Number(cfg.content?.topics?.noReplyAfterHerMin ?? 120));
            const herOk = !herTs || now - herTs >= afterHerMin * 60000;
            if (herOk) {
              verdict = await judgeAway({ cand, ctx, cfg, now, tz, generate: gen || llmGenerate, llmReady });
              st.noReply = { key: cand.key, verdict };
            }
          }
          if (verdict?.followUp === true && cfg.content?.topics?.noReplyJudge !== false) {
            ctx.noReply = { ...cand, verdict };
          } else {
            rejectedTopics.push({ slot: 'noReply', reason: verdict?.followUp === false ? 'NO_FOLLOWUP_AGREEMENT' : 'FOLLOWUP_UNCONFIRMED' });
          }
        }
      }
      // —— L2/L3/结构化信号必须在 compose 之前算：否则模型写的这句话里永远没有「她这会儿在干什么」。
      //   L2 是纯函数，0 成本；L3 要截屏 + OCR（约 0.5–12 秒），所以受 everyMin 节流，
      //   而且它只当「给模型一点具体物件」用，不参与发不发。
      //   signals 是不截屏那一路：窗口标题 + 浏览器标签页 + 编辑器文件，几毫秒，默认开。
      activity = activityNow;
      // 反作弊保护：WeGame/腾讯系游戏在跑时，窗口标题、浏览器标签、截屏一律不读，
      // 免得在带反作弊的进程旁边被当成外挂行为（2026-11-08 她提的）。键鼠空闲照读——那不含进程信息。
      const antiProc = anticheatRunning(sys, cfg);
      if (antiProc) {
        activity = null;
        signals = { ok: false, reason: 'ANTICHEAT', proc: antiProc };
        screen = { ok: false, reason: 'ANTICHEAT' };
      } else if (cfg.perception?.signals?.enabled !== false) {
        signals = await readSignals({ cfg, sys, now });
      }
      // 结构化信号已经能说清「在干什么」时就不截屏了——OCR 那一路更慢、中文也更差。
      if (!preview && !antiProc && needL3(cfg, sys, signals)) {
        const everyMin = Math.max(1, Number(cfg.perception.l3.everyMin) || 30);
        const lastAt = Number(st.perception?.lastL3At) || 0;
        if (!lastAt || now - lastAt >= everyMin * 60000) {
          const o = await l3Screen(cfg);
          st.perception ||= {};
          st.perception.lastL3At = now;
          screen = o.ok
            ? { ok: true, chars: Number(o.chars) || 0, ms: o.ms ?? null, hints: screenFacts(screenHints(o.text || '')) }
            : { ok: false, reason: o.reason || 'L3_FAIL' };
        } else {
          screen = { ok: false, reason: 'L3_TOO_SOON' };
        }
      }
      if (activity) ctx.activity = activity;
      if (screen) ctx.screen = screen;
      if (signals) ctx.signals = signals;
      persona = loadPersona({ cfg });
      const offers = topicCandidates(ctx, cfg, now, st,
        (slot) => rejectedTopics.push({ slot, reason: 'TOPIC_REPEATED' }), topicMisses);
      let compare = d.track === 'proactive' && cfg.rules?.judge?.enabled === true;
      const gapFor = (item) => checkTierGap({
        cfg, now,
        tier: tierOfSlot(item.slot),
        lastByTier: lastSendByTier, lastSendTs, extraMin: extraGapMin,
        triggered: triggers.fired.length > 0,
      });
      for (const item of offers) {
        const responding = item.slot === 'reply' || item.slot === 'forward';
        if (responding) compare = false;
        const gap = gapFor(item);
        if (!gap.ok) {
          rejectedTopics.push({ slot: item.slot, reason: 'GAP_TOO_SHORT' });
          d.gap ??= gap;
          // 回复必须先过本档限制。
          if (responding || d.track === 'reply') break;
          continue;
        }
        candidates.push(item);
        if (!compare || candidates.length === 3) break;
      }
      topic = candidates[0] || null;
      if (!topic && d.track === 'proactive' && cfg.dryRun === false && cfg.send?.enabled === true &&
          ch.list?.some((c) => c.channel === channel && c.ok && c.lastUserTs > 0)) {
        const project = projectQuestion(cfg, st);
        if (project && topicPreferenceMode(st, project, now) === 'mute_less') topicMisses.set(project.slot, 'preference_muted');
        else if (project && gapFor(project).ok) topic = project;
      }
      // —— 哪来哪回：只有 QQ 这一条发送路。她在抖音/主会话说的话只当信号，
      //    「回她」的由头不能拿到 QQ 上发——她会以为我在答非所问。
      //    通道为空的旧记录照常放行（见 topics.answerableOn）。
      if (topic && !answerableOn(topic.slot, ctx?.her?.lastChannel, channel)) {
        d.channel = { slot: topic.slot, from: ctx?.her?.lastChannel || '' };
        d.decision = 'skip';
        d.reason = 'REPLY_ON_OTHER_CHANNEL';
        topic = null;
      }
      // 普通闲聊使用自己的设置和额度。只有主动轨道可以把它加入候选。
      let casual = null;
      let casualMeta = null;
      if (cfg.rules?.chitchat?.enabled !== true) topicMisses.set('chitchat', 'disabled');
      if (cfg.rules?.chitchat?.enabled === true && d.track === 'proactive' && d.decision === 'send' && (!topic || (compare && !['projectCheckIn', 'examSoon'].includes(topic.slot)))) {
        // 睡着时段先用鱼鱼邮件推（7 天中位数，不够 3 天退回 23:00–07:00），一天只推一次。
        const rest = restFor({ cfg, now, tz, st });
        const g = chitchatGate({ cfg, now, st, ctx, tz, rest });
        if (g.ok) {
          // 阶段 2：起点。记忆池 + 角色自身人设日常池（最近 3 次用过的跳过），挑不到就只用「最近聊到哪」。
          const pk = pickSeed({ cfg, persona, now, st, tz });
          const seed = pk.seed;
          const bareLeft = bareRemainingToday(st, now, tz, cfg);
          casual = chitchatTopic(cfg, {
            allowBare: bareLeft > 0,
            bareLeft,
            seed: seed?.text || '',
            seedId: seed?.id || '',
            seedKind: seed?.kind || '',
            seedEntities: Array.isArray(seed?.entities) ? seed.entities : [],
            conversation: conversationLine(ctx),
          });
          st.chitchat = g.state;
          casualMeta = {
            produced: true,
            seed: seed ? { kind: seed.kind, day: seed.day, id: seed.id } : null,
            seedWhy: pk.why,
            rest: { from: rest.from, startMin: rest.startMin, endMin: rest.endMin },
          };
        } else if (!g.silent) {
          d.chitchat = { reason: g.reason, why: g.why };
          topicMisses.set('chitchat', CHITCHAT_MISSES[g.reason] || 'no_data');
        }
      }
      if (casual && topicPreferenceMode(st, casual, now) === 'mute_less') {
        topicMisses.set(casual.slot, 'preference_muted');
        casual = null;
      }
      if (casual) {
        const gap = gapFor(casual);
        if (gap.ok) {
          candidates.push(casual);
          topic ||= casual;
        } else {
          rejectedTopics.push({ slot: casual.slot, reason: 'GAP_TOO_SHORT' });
          d.gap ??= gap;
        }
      }
      if (topic && topic.slot !== 'chitchat' && cfg.rules?.chitchat?.enabled === true) {
        d.chitchat = chitchatYield(topic.slot);
      }
      if (topic?.slot === 'chitchat') d.chitchat = casualMeta;
      // —— 防重复（第一道）：reply/forward 的前提是「她那条还没人应」。
      //    但那是这一拍**开头**读到的快照；插件可能在这几秒里已经回过了
      //    （driver 是「生成 → sendQQ → 写 qq-history」，history 那步失败还只是静默 catch）。
      //    生成之前先翻一次最新落盘记录，已经应过就放弃这一拍——不花模型、不吃配额。
      if ((topic?.slot === 'reply' || topic?.slot === 'forward') && cfg.rules?.replyGuard !== false) {
        const flight = externalInFlight(cfg, now);
        if (flight) {
          d.decision = 'skip';
          d.reason = 'REPLY_IN_FLIGHT';
          d.guard = { channel, src: flight.src || 'qq-bridge', at: flight.firstAt, count: flight.count, herTs: Number(ctx.her?.lastTs) || 0 };
          topic = null;
        }
        const ob = topic ? outboundFor(ctx?.her?.lastChannel, { cfg }) : null;
        if (ob && answeredAlready({ herTs: ctx?.her?.lastTs, out: ob })) {
          d.decision = 'skip';
          d.reason = 'REPLY_ALREADY_ANSWERED';
          d.guard = { channel: ob.channel, src: ob.src || '', at: ob.ts, herTs: Number(ctx.her?.lastTs) || 0 };
          topic = null;
        }
      }
      // —— 她转来的是视频：现在手里有 itemId 了，先真看一遍（下载 → 转写 → 两三行摘要）。
      //    看不了就不拿这条当由头（换别的，或者这一拍不发）——绝不拿标题装懂。
      //    摘要按 aweme_id 缓存，同一条只看一次；失败也缓存（短 TTL），不会每拍重跑。
      if (topic?.slot === 'forward' && !topic.evidence?.hasContent) {
        const item = topic.evidence?.item || null;
        let viewed = null;
        if (!item) {
          viewed = { ok: false, reason: 'NO_ITEM_ID' };
        } else if (preview && cfg.content?.forward?.enabled !== false) {
          viewed = readVideoCache(item, { cfg, now }) || { ok: false, reason: 'PREVIEW_CACHE_ONLY' };
        } else if (cfg.content?.forward?.enabled !== false) {
          try {
            viewed = await watchVideo(item, {
              cfg,
              now,
              llm: (args) => (gen || llmGenerate)(args),
            });
          } catch (e) {
            viewed = { ok: false, reason: 'VIDEO_ERROR', note: String(e?.message || e).slice(0, 160) };
          }
        } else {
          viewed = { ok: false, reason: 'FORWARD_DISABLED' };
        }
        ctx.forward = viewed;
        if (viewed?.ok) {
          topic = withForwardContent(topic, viewed);
        } else {
          const fallback = { ...st, skipSlots: [...(st.skipSlots || []), 'forward'] };
          topic = topicCandidates(ctx, cfg, now, fallback, undefined, topicMisses).next().value ?? null;
          topicMisses.set('forward', 'forward_unavailable');
          candidates = topic ? [topic] : [];
          if (topic) {
            const gap = gapFor(topic);
            if (!gap.ok) {
              d.decision = 'skip';
              d.reason = 'GAP_TOO_SHORT';
              d.gap = gap;
            }
          }
        }
      }

      if (!topic && d.decision === 'send') {
        d.decision = 'skip';
        d.reason = d.gap?.ok === false ? 'GAP_TOO_SHORT' : 'NO_TOPIC';
        for (const { slot, reason } of rejectedTopics) {
          const miss = { NO_FOLLOWUP_AGREEMENT: 'no_agreement', FOLLOWUP_UNCONFIRMED: 'followup_unconfirmed', TOPIC_REPEATED: 'repeated' }[reason];
          if (miss) topicMisses.set(slot, miss);
        }
      }
      const moodFor = (item) => d.track === 'proactive' &&
        !['projectCheckIn', 'noReply', 'examSoon', 'examReview', 'agenda'].includes(item?.slot);
      const mood = candidates.some(moodFor) ? resolveMoodState({ cfg, persona, now }) : {};
      const comparing = compare && topic?.slot !== 'projectCheckIn';
      if (cfg.rules?.judge?.enabled === true && d.decision === 'send' && topic?.slot !== 'projectCheckIn') {
        const cards = comparing ? candidates.map((item) => ({
          id: item.slot,
          label: item.label,
          facts: item.brief,
          ...(item.slot === 'chitchat' ? {
            seed: item.evidence.seed,
            seedKind: item.evidence.seedKind,
            conversation: item.evidence.conversation,
            allowBare: item.evidence.allowBare,
          } : {}),
        })) : [];
        const snapshot = buildSnapshot({ ctx, topic: cards.length > 1 ? null : topic, cfg, st, now, tz,
          coarseDesktop: d.track === 'proactive', showTopic: !comparing });
        const judgeInput = [snapshot, ctx.characterWindDown && WIND_DOWN_HINT, ctx.characterWoken && WOKEN_HINT,
          mood.portrait && `当前心情底色（仅作语气参考，不得当作单独开口由头或直接念出）：${mood.portrait}`].filter(Boolean).join('\n');
        verdict = await judgeDecision({ snapshot: judgeInput, persona, candidates: cards, cfg, generate: gen || llmGenerate, llmReady });
        if (verdict.ok && verdict.say && comparing) {
          topic = candidates.find((item) => item.slot === verdict.candidateId);
          if (topic.slot === 'chitchat') d.chitchat = casualMeta;
          else if (cfg.rules?.chitchat?.enabled === true) d.chitchat = chitchatYield(topic.slot);
        }
        // state 只存结论，不存快照（快照几百字，state 每拍落盘）
        st.judge = {
          at: now,
          say: verdict.ok ? verdict.say : null,
          angle: verdict.angle || '',
          why: verdict.why || '',
          fallback: !verdict.ok && verdict.reason !== 'JUDGE_INVALID_CANDIDATE' && topic?.slot !== 'chitchat',
          reason: verdict.ok ? '' : verdict.reason || '',
          note: verdict.ok ? '' : String(verdict.note || ''),
          slot: topic?.slot || null,
          ms: verdict.ms ?? null,
        };
        if (verdict.reason === 'JUDGE_INVALID_CANDIDATE' || (!verdict.ok && topic?.slot === 'chitchat')) {
          d.decision = 'skip';
          d.reason = verdict.reason === 'JUDGE_INVALID_CANDIDATE' ? verdict.reason : 'CHITCHAT_NO_MODEL';
        } else if (verdict.ok && verdict.say === false) {
          d.decision = 'skip';
          // 随口话被模型否掉，单独记一个码：它的被拦分布要跟「真没由头」分开算。
          if (topic?.slot === 'chitchat') {
            d.reason = 'CHITCHAT_JUDGE_NO';
            d.chitchat = chitchatJudgeNo(verdict.why);
            topicMisses.set('chitchat', 'chitchat_judge_no');
          } else {
            d.reason = 'JUDGE_NO_SEND';
          }
          topic = null;
        }
      }
      // 被防重复拦下时 topic 已经置空、判定改成 skip，这里就不要再叫模型了。
      if (d.decision === 'send') {
        const gap = gapFor(topic);
        if (gap.enabled) {
          d.tier = gap.tier;
          d.gap = gap;
        }
        const moodEligible = moodFor(topic);
        const { explored, portrait } = moodEligible ? mood : {};
        const mediaShare = topic?.slot === 'share' ? topic.evidence?.source : null;
        // 画像心情（已由情绪插件脱敏）与探索原话（需过 toneOf 去术语）分开传，避免 Lv1 等被误删
        const toneCtx = (explored?.text || portrait)
          ? {
              ...ctx,
              ...(explored?.text ? { explorationMood: explored } : {}),
              ...(portrait ? { portraitMood: portrait } : {}),
            }
          : ctx;
        // judge 说「说」→ 用它写好的草稿，只过 clean + guard；说不了或不发就退规则链。
        const proposalDraft = topic?.evidence?.actionRetry && verdict?.ok && verdict.say
          ? composeDraft({ ctx, draft: verdict.draft, cfg, topic }) : null;
        content =
          topic?.evidence?.actionRetry
            ? proposalDraft?.ok ? proposalDraft : composeDraft({ ctx, draft: RETRY_QUESTION, cfg, topic })
            : topic?.slot === 'projectCheckIn'
            ? await writeProjectQuestion({ ctx, cfg, topic, persona, generate: gen })
            : verdict?.ok && verdict.say === true
            ? composeDraft({ ctx, draft: verdict.draft, cfg, topic })
            : await compose({ ctx: d.track === 'proactive' ? { ...toneCtx, signals: null, screen: null } : ctx, topic, persona, cfg, now, st, generate: gen, llmReady });
        if (topic && content.violations?.some((v) => v.code === 'FALSE_ATTRIBUTION') && verdict?.ok && verdict.say) {
          content = await compose({ ctx, topic, persona, cfg, now, st, generate: gen, llmReady });
        }
        if (moodEligible && !topic?.evidence?.actionRetry && verdict?.ok && verdict.say === true) {
          content = await styleApprovedDraft({ draft: content, ctx: toneCtx, persona, generate: gen, timing: cfg.exploration,
            validate: (draft) => composeDraft({ ctx, draft, cfg, topic }) });
        }
        if (!content.ok) {
          d.decision = 'skip';
          d.reason = content.reason || 'NO_CONTENT';
        } else if (d.track === 'proactive' && topic?.slot !== 'projectCheckIn') {
          const blocked = proactiveProjectBlock(content.text, ctx, now, cfg);
          if (blocked) {
            d.decision = 'skip';
            d.reason = blocked;
          }
        }
        if (d.decision === 'send' && topic?.evidence?.actionRetry) {
          actionProposal = mediaShare ? prepareActionProposal({ peer, text: content.text, cfg,
            source: mediaShare.url, roundAt: topic.evidence?.at }) : null;
          if (!actionProposal) {
            d.decision = 'skip';
            d.reason = 'NO_CONTENT';
          }
        }
        if (d.decision === 'send' && mediaShare && !actionProposal) {
          const url = publicExplorationUrl(mediaShare.url);
          if (!url || /https?:\/\//i.test(content.text) ||
              (topic.evidence?.loginSite && /密码|验证码|cookie|口令|账号/i.test(content.text))) {
            d.decision = 'skip';
            d.reason = 'GUARD_REJECTED';
          } else {
            content.text += '\n' + url.href;
          }
        }
      }
    }
  }

  // —— 防重复（第二道）：compose 那几十秒里插件也可能刚回完。
  //    这里只拦真要发的那一刻，命中就记 skip，配额一律不动。
  //    桥正发到一半（last-out.json firstAt 有、lastAt=0）也算「正在应」，别插进去。
  let guardHit = null;
  if (d.decision === 'send' && (topic?.slot === 'reply' || topic?.slot === 'forward') &&
      ctx?.her?.lastChannel === channel && bridgeOwnsReply(ctx.her.lastTs)) {
    d.decision = 'skip';
    d.reason = 'REPLY_ALREADY_ANSWERED';
  }
  if (d.decision === 'send' && (topic?.slot === 'reply' || topic?.slot === 'forward') && cfg.rules?.replyGuard !== false) {
    const flight = externalInFlight(cfg, now);
    if (flight) {
      guardHit = { channel, src: flight.src || 'qq-bridge', ts: flight.firstAt, inFlight: true, count: flight.count };
    } else {
      const ob = outboundFor(ctx?.her?.lastChannel, { cfg });
      if (answeredAlready({ herTs: ctx?.her?.lastTs, out: ob })) guardHit = ob;
    }
  }

  if (d.decision === 'send' && topic?.slot === 'noReply' &&
      (Number(lastHerMessage(cfg)?.ts) || 0) > Number(topic.evidence.at)) {
    d.decision = 'skip';
    d.reason = 'FOLLOWUP_CONTEXT_CHANGED';
  }

  let delivery = null;
  if (d.decision === 'send' && d.track === 'proactive' && characterRestAt(loadConfig()).asleep) {
    d.decision = 'skip';
    d.reason = 'CHARACTER_ASLEEP';
  }
  // Recheck after asynchronous drafting in case the user changed the preference meanwhile.
  let preference = d.decision === 'send' && d.track === 'proactive' && topic
    ? topicPreferenceMode(useSim ? st : loadState(), topic, Date.now()) : null;
  if (preference === 'mute_less') {
    d.decision = 'skip';
    d.reason = 'TOPIC_PREFERENCE_MUTED';
  }
  if (guardHit) {
    const code = guardHit.inFlight ? 'REPLY_IN_FLIGHT' : 'REPLY_ALREADY_ANSWERED';
    delivery = { attempted: false, reason: code, channel: guardHit.channel, src: guardHit.src || '' };
    d.decision = 'skip';
    d.reason = code;
    d.guard = { channel: guardHit.channel, src: guardHit.src || '', at: guardHit.ts, herTs: Number(ctx?.her?.lastTs) || 0 };
  } else if (d.decision === 'send') {
    if (chatChanging() || (channel === 'douyin' && !readyDouyinBinding({ readOnly: preview }))) {
      delivery = { attempted: false, reason: 'CHANNEL_SWITCH_PENDING' };
      d.decision = 'skip';
      d.reason = 'CHANNEL_SWITCH_PENDING';
    } else if (useSim) {
      delivery = { attempted: false, reason: preview ? 'PREVIEW' : 'DRY_RUN', preview: content?.text || '' };
    } else if (cfg.send?.enabled !== true) {
      delivery = { attempted: false, reason: 'SEND_DISABLED' };
    } else if (!content?.ok || !content.text) {
      delivery = { attempted: false, reason: 'NO_CONTENT' };
    } else {
      const to = peer;
      let stoppedForRest = false;
      const canDispatch = d.track === 'proactive' ? (sentParts) => {
        stoppedForRest = characterRestAt(loadConfig()).asleep;
        if (stoppedForRest) return false;
        if (!topic) return true;
        const current = topicPreferenceMode(loadState(), topic);
        if (current === 'mute_less') return false;
        if (sentParts === 0) preference = current;
        return true;
      } : undefined;
      // 该拆的拆成几条发（空行分段），首条按她的字数晚几秒，条间留空隙；
      // 一轮只记一次「开口」，不算几条。
      const r = await sendChatRound({
        cfg, to,
        text: content.text,
        dryRun: false,
        now,
        herAt: Number(ctx?.her?.lastTs) || 0,
        herChars: String(ctx?.her?.lastText || '').length,
        split: cfg.send?.split ?? {},
        timeoutMs: cfg.send?.timeoutMs,
        actionProposal,
        canDispatch,
      });
      const delivered = r.ok && !r.dryRun;
      const stoppedByPreference = r.reason === 'TOPIC_PREFERENCE_MUTED' && !stoppedForRest;
      const deliveryReason = stoppedForRest ? 'CHARACTER_ASLEEP' : r.reason;
      delivery = r.dryRun || ((stoppedByPreference || stoppedForRest) && !r.parts)
        ? { attempted: false, reason: r.dryRun ? 'SEND_DISABLED' : deliveryReason }
        : { attempted: true, ok: Boolean(delivered), to, chars: content.text.length, parts: r.parts ?? 1,
            messageId: r.messageId ?? null, reason: deliveryReason, error: r.ok ? undefined : r.error };
      // 发失败不能算「今天已经找过她」，否则一次网络抖动就白吃一个配额
      if (!delivered) {
        d.decision = 'skip';
        d.reason = r.dryRun ? 'SEND_DISABLED' : deliveryReason || 'SEND_FAILED';
      }
      if (delivered) {
        st.lastRealSendAt = now;
        notifyExternalMoodMessage({ peer: emotionPeer(cfg), role: 'ai', text: content.text, at: r.sentAt || now, channel, cfg });
      }
      if (!r.dryRun && (delivered || r.parts > 0) && d.track === 'proactive') {
        noteProactive(st, topic, { channel, peer: to, at: r.sentAt || Date.now() });
      }
      if (delivered && topic?.slot === 'share' && ctx?.self?.exploration && !ctx.self.actionRetry && !ctx.self.loginSite) {
        try { rememberExplorationShare({ cfg, peer: to, channel, id: topic.evidence?.discoveryId,
          topic: topic.evidence?.section, at: r.sentAt || Date.now() }); } catch { /* Delivery already succeeded. */ }
      }
      if (delivered && (channel === 'douyin' || channel === 'internal')) {
        recordActionOutbound({ peer, proposal: actionProposal, firstAt: r.firstAt, sentAt: r.sentAt, cfg });
        if (shouldUseBuiltinEmotion(cfg, r.sentAt || now)) appendEmotionInbox({ user: emotionPeer(cfg), role: 'ai', text: content.text, t: r.sentAt });
      }
      // 真发出去了才记待回：dryRun 与失败都不算，否则反馈会被假数据污染
      if (delivered && topic?.slot === 'projectCheckIn') recordProjectQuestion(cfg, st, Date.now());
      if (delivered && topic?.slot && topic.slot !== 'projectCheckIn') {
        // 测试期（rules.feedback.testMode）：记一条「发过」，但**不计入接住率**——
        // 插件没完工之前她的沉默不是「没接住」，是还没改好。
        const options = { test: cfg.rules?.feedback?.testMode === true, channel,
          sentAt: r.sentAt || Date.now(), expect: preference !== 'allow_silent' && !stoppedByPreference };
        noteSent(st, topic.slot, now, content.text, options);
        if (topic.slot === 'chitchat') noteChitchatSent(st, now, tz, content.text, topic.evidence?.seedId, options);
        st.content ||= {};
        if (topic.slot === 'agenda') {
          if (topic.evidence?.kind === 'early') st.content.lastAgendaNight = topic.evidence.nightKey;
          if (topic.evidence?.kind === 'soon') st.content.lastAgendaSoon = topic.evidence.key;
        }
        // 考试按场去重：同一场只提一次（改了时间/科目就是新的一场）
        if (topic.slot === 'examSoon') st.content.lastExamSoon = topic.evidence?.key;
        if (topic.slot === 'examReview') st.content.lastExamReview = topic.evidence?.key;
        // 追问：同一条（同一条消息 / 同一个视频）只问一次
        if (topic.slot === 'noReply') st.content.lastNoReplyFor = topic.evidence?.key;
        // 外部扩展由头：按 dedupKey 去重
        if (topic.evidence?.external && topic.evidence?.dedupKey) {
          st.content.extTopicDedup = { ...(st.content.extTopicDedup || {}), [topic.slot]: topic.evidence.dedupKey };
        }
      }
    }
  }

  // —— 阶段 4：judge 预演。护栏拦下的拍子按比例再问模型一次，只记不发。
  //    不进 feedback：她没真收到，记进接住率就是假的。dryRun 不跑（本来就不发，还烧调用）。
  if (
    d.decision === 'skip' &&
    !useSim &&
    shadowEligible(cfg, d.reason) &&
    (typeof random === 'function' ? random() : Math.random()) < shadowRate(cfg)
  ) {
    try {
      if (!ctx) {
        ctx = buildContext({ cfg, now, st, ch, sys, tz });
        ctx.clock = hhmm(now, tz);
        ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
        ctx.trigger = triggers.fired[0] || null;
      }
      d.shadow = await runShadow({
        cfg,
        now,
        tz,
        st,
        ctx,
        persona: persona || loadPersona({ cfg }),
        generate: gen || llmGenerate,
        llmReady,
        blockedBy: d.reason,
        topic,
      });
    } catch (e) {
      d.shadow = { error: String(e?.message || e).slice(0, 160) };
    }
  }

  const record = {
    ts: now,
    tsLocal: hhmm(now, tz),
    idle_sec: idleSec,
    presence: presenceOf(idleSec, cfg),
    fg_title: sys.fg_title || '',
    audio_peak: typeof sys.audio_peak === 'number' ? sys.audio_peak : null,
    in_quiet: quiet,
    in_busy: busy,
    last_user_ago_sec: agoSec(now, ch.lastUserTs),
    last_user_channel: d.lastUserChannel,
    last_send_ago_min: lastSendTs ? Math.round((now - lastSendTs) / 60000) : null,
    gap_tier: d.tier || null,
    gap: d.gap || null,
    ...(candidates.length ? { candidateSlots: candidates.map((item) => item.slot) } : {}),
    ...(d.rejectedTopics?.length ? { rejectedTopics: d.rejectedTopics } : {}),
    presence_signal: Boolean(d.presenceSignal),
    today_sent_real: Number(st.real.todaySent) || 0,
    today_sent_sim: Number(st.sim.todaySent) || 0,
    track: d.track,
    decision: d.decision,
    channel: d.channel || null,
    reason: d.reason,
    reason_text: REASONS[d.reason] || '',
    ...(d.reason === 'NO_TOPIC' || d.reason === 'CHITCHAT_JUDGE_NO'
      ? { topicMisses: [...topicMisses].map(([slot, reason]) => ({ slot, reason })) } : {}),
    ...(phone ? { phone } : {}),
    dry_run: useSim,
    delivery,
    content_ok: Boolean(content?.ok),
    activity: activity
      ? { kind: activity.kind, speaking: activity.speaking, fg: activity.fgTitle, fg_name: activity.fgName }
      : null,
    screen,
    signals: signals ? { ok: signals.ok, reason: signals.reason, window: signals.window?.kind, tab: signals.tab?.site || null } : null,
    memory: memory ? { ok: memory.ok, reason: memory.reason, n: memory.items.length, files: memory.files } : null,
    locked: ['lockapp', 'logonui'].includes(String(sys.fg_name || '').toLowerCase()),
    channels: Object.fromEntries(
      ch.list.map((c) => [c.channel, c.state ? c.state : c.ok ? 'ok' : c.reason || 'fail'])
    ),
    douyin: (() => {
      const c = ch.list.find((x) => x.channel === 'douyin');
      if (!c) return null;
      return {
        state: c.state ? c.state : c.ok ? 'ok' : c.reason,
        plugin_version: c.plugin?.version || null,
        data_age_sec: c.ok && c.state?.lastCheckAt ? agoSec(now, c.state.lastCheckAt) : null,
      };
    })(),
    backfill: backfill || undefined,
    mail,
    video: ctx?.forward
      ? {
          ok: ctx.forward.ok,
          source: ctx.forward.source,
          reason: ctx.forward.reason,
          visionReason: ctx.forward.visionReason,
        }
      : undefined,
    // 内容：由头 + 写出来的句子。dryRun 时把全文记下来，方便回看口吻
    topic: topic
      ? { slot: topic.slot, label: topic.label, why: topic.why, evidence: topic.evidence }
      : null,
    // 阶段 2：这一拍模型自己怎么判的（judge 关着 / 没走到这一步时是 null）
    judge: verdict
      ? {
          say: verdict.ok ? verdict.say : null,
          fallback: st.judge?.fallback ?? false,
          reason: verdict.ok ? '' : verdict.reason || '',
          note: verdict.ok ? '' : String(verdict.note || ''),
          why: verdict.why || '',
          angle: verdict.angle || '',
          slot: verdict.slot || st.judge?.slot || null,
          ms: verdict.ms ?? null,
        }
      : null,
    // 阶段 4：预演结果（没采样/关着时是 undefined）
    shadow: d.shadow || undefined,
    // 随口话这一拍的去向（没开/没走到时是 undefined）：产没产、种子从哪来、被哪个码拦下
    chitchat: d.chitchat || undefined,
    // 阶段 3：这一拍有没有自然事件（关着时恒为 null）；gap_bypassed = 事件有没有真的让间隔让路
    trigger: triggers.fired.length
      ? {
          kinds: triggers.fired.map((t) => t.kind),
          labels: triggers.fired.map((t) => t.label),
          gap_bypassed: Boolean(d.triggered) && cfg.rules?.naturalTriggers?.takeGap === true,
        }
      : null,
    content: content
      ? {
          ok: content.ok,
          source: content.source || null,
          slot: content.slot || null,
          chars: content.text ? content.text.length : 0,
          text: content.text || '',
          reason: content.reason || null,
          violations: content.violations?.map((v) => v.code) || undefined,
          note: content.note || undefined,
          meta: content.meta || undefined,
        }
      : null,
    persona: persona
      ? { kind: persona.kind, chars: persona.chars, sources: persona.sources.map((x) => x.kind) }
      : null,
    ctx: ctx
      ? {
          her_ago_min: ctx.her.lastAgoSec == null ? null : Math.round(ctx.her.lastAgoSec / 60),
          me_ago_min: ctx.me.lastAgoSec == null ? null : Math.round(ctx.me.lastAgoSec / 60),
          fish_ok: ctx.fish.ok,
          fish_age_min: ctx.fish.ageMin ?? null,
          self_ok: Boolean(ctx.self),
          dialogue: ctx.recent.length,
        }
      : null,
    probe_ok: Boolean(sys.ok),
    pc: st.pc
      ? {
          activeSince: st.pc.activeSince || null,
          awayMs: st.pc.awaySince ? now - st.pc.awaySince : null,
          lastReturnAt: st.pc.lastReturnAt || null,
          lastAwayMs: st.pc.lastAwayMs || null,
          event: pcEvent,
        }
      : null,
  };

  // 影子/真实计数只在「真的判到 SEND 且内容写出来了」时推进
  // （DRY_RUN 也推进 sim，否则限流永远测不出来；没内容不算一次，否则配额被空转吃光）
  if (!preview && d.decision === 'send') {
    st.content ||= {};
    if (topic?.slot === 'sleep') st.content.lastSleepFor = topic.evidence?.day || healthDay(now, cfg.timezone);
    if (topic?.slot === 'stress') {
      // 计数按健康日（默认 7 点起算）清零，跟睡眠同一套「一天」的定义
      const sday = topic.evidence?.day || healthDay(now, cfg.timezone);
      const same = st.content.stressDay === sday;
      st.content.stressDay = sday;
      st.content.stressCount = (same ? Number(st.content.stressCount) || 0 : 0) + 1;
      st.content.lastStressAt = now;
      st.content.lastStressValue = Number(topic.evidence?.stress) || 0;
    }
    if (['steps', 'screen', 'longSit'].includes(topic?.slot)) st.content.lastWellnessAt = now;
    if (topic?.slot === 'screen') st.content.lastScreenFor = `${ctx?.fish?.date || ''}:${day}`;
    if (topic?.slot === 'steps') st.content.lastStepsFor = topic.evidence?.day || healthDay(now, cfg.timezone);
    if (topic?.slot === 'lateUp') st.content.lastLateUpFor = topic.evidence?.nightKey || dayKey(now, tz);
    if (topic?.slot === 'characterRest') {
      if (topic.evidence?.kind === 'bed') st.content.lastCharacterBedFor = topic.evidence.key;
      if (topic.evidence?.kind === 'wake') st.content.lastCharacterWakeFor = topic.evidence.key;
    }
    if (topic?.slot === 'longSit') st.content.lastLongSitFor = topic.evidence?.day || dayKey(now, tz);
    if (topic?.slot === 'backHome') {
      st.content.lastBackAt = topic.evidence?.returnAt || now;
      st.content.lastBackSendAt = now;
    }
    if (topic?.slot === 'share') {
      st.content.lastShareAt = now;
      const shareHead = String(ctx?.self?.line || '').slice(0, 80);
      st.content.lastShareLine = shareHead;
      if (shareHead) {
        st.content.recentShareLines = [...new Set([...(st.content.recentShareLines || []), shareHead])].slice(-24);
      }
      if (!useSim && ctx?.self?.section && !topic.evidence?.actionRetry && !topic.evidence?.loginSite) {
        st.content.recentShareTopics = [
          ...(st.content.recentShareTopics || []).filter((x) => x?.topic && x.topic !== ctx.self.section),
          { topic: ctx.self.section, at: now },
        ].slice(-16);
      }
      if (!useSim && delivery?.ok && actionProposal) st.content.lastRetryProposalAt = topic.evidence?.at;
      if (!useSim && delivery?.ok && topic.evidence?.discoveryId) {
        st.content.sharedExplorationIds = [...new Set([
          ...(st.content.sharedExplorationIds || []), topic.evidence.discoveryId,
        ])].slice(-50);
      }
      if (!useSim && delivery?.ok && topic.evidence?.loginSite) {
        st.content.explorationLoginNotices = [...new Set([
          ...(st.content.explorationLoginNotices || []), topic.evidence.loginSite,
        ])].slice(-50);
      }
    }
    if (content?.ok && content.text) {
      const prev = Array.isArray(st.content.recentSends) ? st.content.recentSends : [];
      st.content.recentSends = [...prev, String(content.text).slice(0, 90)].slice(-6);
      const prevSlots = Array.isArray(st.content.recentSlots) ? st.content.recentSlots : [];
      st.content.recentSlots = [...prevSlots, topic?.slot || null].slice(-6);
    }
    bucket.todaySent = todaySent + 1;
    bucket.lastSendAt = now;
    // 阶段 1.1：同档时间戳要一直维护——开关一开就立刻有据可依，不用空跑一天
    const sentTier = d.tier || (topic ? tierOfSlot(topic.slot) : null);
    if (sentTier) bucket.lastSendByTier = { ...(bucket.lastSendByTier || {}), [sentTier]: now };
    bucket.lastTrack = d.track;
    if (topic?.slot !== 'projectCheckIn') st.pending = { at: now, track: d.track, dryRun: useSim };
  }

  if (persist && !preview) {
    append(record, now, tz, cfg);
    saveState(st);
  }
  return { record, cfg, ch, sys, st, delivery, pruned, explanation: explainRun({ record, cfg, preview }) };
}

/** Fast path for a known due item; never starts the regular probe/model cycle. */
export async function tickDueAgreement({ active = () => true, send = sendChatRound, probeSystem = probe } = {}) {
  const cfg = loadConfig();
  const channel = activeChatChannel(cfg);
  const peer = chatPeer(cfg);
  const now = Date.now();
  if (!peer || cfg.agreements?.enabled !== true) return null;
  const source = { channel, peer };
  const item = dueAgreement(cfg, now, source);
  if (!item) return null;
  const topic = agreementTopic(item);
  const urgent = item.explicit && item.short;
  let observedBeforeSend = 0;
  const permits = (config, at, state, ownStart = 0) => {
    if (!active() || config.enabled === false || config.agreements?.enabled !== true ||
        config.dryRun !== false || config.rules?.proactive === false || config.content?.enabled === false ||
        config.send?.enabled !== true || activeChatChannel(config) !== channel || chatPeer(config) !== peer ||
        config.channels?.[channel]?.enabled === false || config.channels?.[channel]?.send === false ||
        !canReadChat(config) || chatChanging() ||
        !inWindows(at, config.channels?.[channel]?.activeHours, config.timezone) ||
        inQuiet(at, config.quietHours, config.timezone) || busyNow(at, config) || characterRestAt(config, at).asleep ||
        topicPreferenceMode(state, topic, at) === 'mute_less') return false;
    const flight = externalInFlight(config, at);
    // The QQ sender writes its own in-flight marker immediately before canDispatch.
    if (flight && !(channel === 'qq' && ownStart > 0 && flight.firstAt === ownStart)) return false;
    const day = recordDay(at, config.timezone, config);
    const bucket = state.day === day ? state.real : null;
    if ((Number(bucket?.todaySent) || 0) >= (Number(config.rules?.dailyCap) || 0)) return false;
    if (urgent) return true;
    const observed = Number(outboundFor(channel, { cfg: config })?.ts) || 0;
    if (!ownStart) observedBeforeSend = observed;
    const channelLast = channel === 'qq' && ownStart > 0 && observed === ownStart ? observedBeforeSend : observed;
    const lastSendTs = Math.max(Number(bucket?.lastSendAt) || 0, channelLast);
    const extraMin = adaptiveExtraMin(state, config);
    const gap = checkTierGap({ cfg: config, now: at, tier: 'event', lastByTier: bucket?.lastSendByTier, lastSendTs, extraMin });
    return gap.enabled ? gap.ok : !lastSendTs || at - lastSendTs >=
      ((Number(config.rules?.minGapMin) || 0) + extraMin) * 60_000;
  };
  if (!permits(cfg, now, loadState())) return null;
  if (cfg.rules?.requirePcOnline === true) {
    const sys = await probeSystem(false, cfg);
    const idle = Number(sys?.idle_ms);
    if (!Number.isFinite(idle) || idle / 1000 > (Number(cfg.idle?.awaySec) || 600) || isScreenLocked(sys)) return null;
  }
  const text = agreementMessage(item);
  const checked = guard(text, cfg, { dialogueTurns: [{ who: 'her', text: item.title }] });
  const startedAt = Date.now();
  if (!checked.ok || !permits(cfg, startedAt, loadState()) || !claimAgreement(item.id, cfg, startedAt, source)) return null;
  let dispatchStarted = false;
  const result = await send({ cfg, to: peer, text, source: 'companion', dryRun: false, now: startedAt, split: { enabled: false },
    timeoutMs: cfg.send?.timeoutMs, canDispatch() {
      const fresh = loadConfig();
      const at = Date.now();
      dispatchStarted = agreementStillClaimed(item.id, fresh, at, source) && permits(fresh, at, loadState(), startedAt);
      return dispatchStarted;
    } });
  // Reopen only when the transport never started. An unknown send result must not become a duplicate.
  if (!dispatchStarted || result?.dryRun) {
    releaseAgreement(item.id, cfg, Date.now());
    return null;
  }
  if (!result?.ok) {
    markAgreementSent(item.id, cfg, Date.now());
    return { ok: false, reason: 'SEND_FAILED' };
  }
  const at = result.sentAt || Date.now();
  markAgreementSent(item.id, cfg, at);
  const tz = cfg.timezone;
  const st = freshDayState(loadState(), recordDay(at, tz, cfg));
  st.real.todaySent = (Number(st.real.todaySent) || 0) + 1;
  st.real.lastSendAt = at;
  st.real.lastTrack = 'proactive';
  st.real.lastSendByTier = { ...st.real.lastSendByTier, event: at };
  st.lastRealSendAt = at;
  noteProactive(st, topic, { channel, peer, at });
  saveState(st);
  append({ ts: at, decision: 'send', reason: 'SEND', track: 'proactive', channel, content_ok: true,
    topic: { slot: topic.slot, label: topic.label }, content: { slot: topic.slot, source: 'agreement', chars: text.length },
    delivery: { attempted: true, ok: true } }, at, tz, cfg);
  return { ok: true };
}
