import { loadConfig, loadState, saveState } from '../settings/config.js';
import { probe } from '../perception/probe.js';
import { checkTierGap } from '../decision/decide.js';
import { append } from '../settings/logger.js';
import { recordDay } from '../settings/retention.js';
import { inQuiet, inWindows } from '../perception/schedule.js';
import {
  agreementMessage,
  agreementReminderPrompt,
  agreementStillClaimed,
  claimAgreement,
  dueAgreement,
  markAgreementSent,
  releaseAgreement,
} from './agreements.js';
import { busyNow } from '../perception/holidays.js';
import { activeChatChannel, canReadChat, chatPeer, externalInFlight, sendChatRound } from '../channels/external.js';
import { chatChanging } from '../channels/chat-switch.js';
import { agreementTopic } from '../decision/topics.js';
import { characterRestAt } from '../decision/character-rest.js';
import { outboundFor } from './outbound.js';
import { adaptiveExtraMin, noteProactive, topicPreferenceMode } from '../decision/feedback.js';
import { clean, guard } from '../decision/compose.js';
import { loadPersona } from '../decision/persona.js';

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

function isScreenLocked(sys) {
  if (sys?.locked === true) return true;
  return Array.isArray(sys?.procs) && sys.procs.some((p) => String(p).toLowerCase() === 'logonui');
}

/** Fast path for a known due item; never starts the regular probe/model cycle. */
export async function tickDueAgreement({ active = () => true, send = sendChatRound, probeSystem = probe, generate = null } = {}) {
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
    if (sys?.ok === false || !Number.isFinite(idle) || idle < 0 || idle / 1000 > (Number(cfg.idle?.awaySec) || 600) || isScreenLocked(sys)) return null;
  }
  const guardCtx = { dialogueTurns: [{ who: 'her', text: item.title }] };
  let text = '';
  let via = 'template';
  if (typeof generate === 'function' && cfg.content?.mode !== 'template') {
    try {
      const persona = loadPersona({ cfg });
      const prompt = agreementReminderPrompt(item, { persona, cfg, now });
      const timeoutMs = Math.min(10000, Math.max(5000, Number(cfg.agreements?.extractTimeoutMs) || 5000));
      const answer = await generate({ prompt, timeoutMs, minOutputTokens: 128, reasoningEffort: 'off', tag: 'agreement-remind' });
      const candidate = answer?.ok ? clean(answer.text) : '';
      if (candidate && guard(candidate, cfg, guardCtx).ok) {
        text = candidate;
        via = 'llm';
      }
    } catch { /* Fall back to the deterministic template below. */ }
  }
  if (!text) text = agreementMessage(item);
  const checked = guard(text, cfg, guardCtx);
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
    const errTxt = String(result?.error || result?.reason || '');
    const uncertain = Boolean(result?.parts > 0 || /timeout|timed out|abort/i.test(errTxt));
    if (uncertain) markAgreementSent(item.id, cfg, Date.now());
    else releaseAgreement(item.id, cfg, Date.now());
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
    topic: { slot: topic.slot, label: topic.label }, content: { slot: topic.slot, source: 'agreement', via, chars: text.length },
    delivery: { attempted: true, ok: true } }, at, tz, cfg);
  return { ok: true };
}
