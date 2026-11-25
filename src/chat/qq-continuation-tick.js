import { loadConfig, loadState, saveState } from '../settings/config.js';
import { append } from '../settings/logger.js';
import { recordDay } from '../settings/retention.js';
import { inQuiet } from '../perception/schedule.js';
import { busyNow } from '../perception/holidays.js';
import { activeChatChannel, canReadChat, chatPeer, emotionPeer, sendChatRound } from '../channels/external.js';
import { characterRestAt, WIND_DOWN_HINT } from '../decision/character-rest.js';
import { isHotChat } from './chat-rhythm.js';
import { noteProactive, topicPreferenceMode } from '../decision/feedback.js';
import { loadPersona, qqContinuationTone } from '../decision/persona.js';
import { runQqContinuation } from './qq-continuation.js';
import { explorationMood, loadExploration, toneOf } from '../explore/explore.js';
import { portraitMood } from '../decision/emotion-portrait.js';
import { readPortraitMoodMap } from '../decision/emotion-sync.js';
import { resolveCombinedMood } from '../settings/extensions.js';

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

export function qqContinuationEnabled(cfg) {
  return cfg.enabled !== false && cfg.rules?.proactive !== false && cfg.rules?.qqContinuation === true &&
    cfg.content?.enabled !== false && cfg.content?.mode !== 'fixed' &&
    canReadChat(cfg) && cfg.channels?.[activeChatChannel(cfg)]?.send !== false &&
    Boolean(chatPeer(cfg)) && (cfg.dryRun !== false || cfg.send?.enabled === true);
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
