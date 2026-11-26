import { loadConfig, ROLEPLAY_FOLLOWUP_DEFAULTS } from '../settings/config.js';
import { readChatData, writeChatData } from '../channels/douyin-im.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer, externalInFlight, sendChatRound } from '../channels/external.js';
import { chatChanging } from '../channels/chat-switch.js';
import { isHandledActionMessage } from './action-proposal.js';
import { inQuiet, inWindows } from '../perception/schedule.js';

const STORE = 'roleplay-followup';
const MINUTE = 60_000;
const SCENE_OPEN = /^(?:【剧情】|\[剧情\]|[（(]剧情[）)]|(?:在)?剧情(?:里|中|内)?[，,：:\s]|(?:我们|咱们)(?:来|继续)?角色扮演|角色扮演[，,：:\s])/u;
const SCENE_PROMISE = /(?:^|[。！？!?；;\n])\s*(?:[（(]剧情[）)]\s*)?我(?:先|得|想)?(?:去|出去)[^。！？!?\n]{1,42}[，,。；;\s]+(?:等(?:一|会|下)|一会|过会|待会|稍后)[^。！？!?，,\n]{0,16}(?:回来|回去找你)/u;
const REAL_WORK = /查(?:资料|文献|文档|网页|链接|信息|一下)|找(?:资料|文献|原文|链接|官网|来源|文件)|搜(?:一下|索|资料|网页)|打开(?:网页|链接|浏览器)|跑(?:脚本|测试)|下载|上传|登录|验证码|调用工具/u;
const WAITING = /^(?:好[，, ]*)?(?:我)?(?:等你(?:回来)?|回来(?:了)?告诉我|继续(?:这段)?剧情)[。！! ]*$/u;
const ALREADY_RETURNED = /我回来(?:了|啦)?|我回来了|已经回来/u;

export function requestsRoleplay(text) {
  return SCENE_OPEN.test(String(text || '').trim()) && !REAL_WORK.test(String(text || ''));
}

function permits(cfg, channel, peer) {
  return cfg.enabled !== false && cfg.rules?.proactive !== false &&
    cfg.rules?.roleplayFollowup?.enabled === true && cfg.dryRun === false && cfg.send?.enabled === true &&
    !chatChanging() && !!peer && canReadChat(cfg) && cfg.channels?.[channel]?.send !== false;
}

function validReply({ incoming, outgoing }, peer, now, startedAt) {
  return incoming.kind === 'private' && incoming.peer === peer && outgoing.peer === peer && outgoing.count > 0 &&
    incoming.ts > 0 && incoming.observedAt > 0 && incoming.ts <= outgoing.firstAt && incoming.observedAt <= outgoing.firstAt &&
    outgoing.firstAt > 0 && outgoing.lastAt >= outgoing.firstAt && outgoing.lastAt <= now && outgoing.lastAt >= startedAt;
}

function sceneStillPending(row, { incoming, outgoing }) {
  if (incoming.peer === row.peer && (incoming.observedAt > row.inAt || incoming.ts > row.inTs) &&
      !WAITING.test(String(incoming.text || '').trim())) return false;
  return !(outgoing.peer === row.peer && outgoing.count > 0 && outgoing.lastAt > row.replyAt &&
    ALREADY_RETURNED.test(String(outgoing.text || '')));
}

function dueAfter(replyAt, cfg, random) {
  const settings = { ...ROLEPLAY_FOLLOWUP_DEFAULTS, ...cfg.rules?.roleplayFollowup };
  const min = Math.max(1, Math.min(120, Number(settings.minMinutes) || ROLEPLAY_FOLLOWUP_DEFAULTS.minMinutes));
  const max = Math.max(min, Math.min(120, Number(settings.maxMinutes) || ROLEPLAY_FOLLOWUP_DEFAULTS.maxMinutes));
  return replyAt + Math.round((min + (max - min) * random()) * MINUTE);
}

function observeSceneReply(roleplay, channel, peer, dialogue, now, startedAt, cfg, random) {
  if (!validReply(dialogue, peer, now, startedAt)) return roleplay;
  const { incoming, outgoing } = dialogue;
  const seen = roleplay.seen?.[channel];
  if (seen?.peer === peer && seen.at >= outgoing.lastAt) return roleplay;
  if (!requestsRoleplay(incoming.text) || !SCENE_PROMISE.test(String(outgoing.text || '')) ||
      REAL_WORK.test(outgoing.text) || ALREADY_RETURNED.test(outgoing.text) ||
      isHandledActionMessage(peer, incoming.ts, channel)) return roleplay;
  const row = { channel, peer, inAt: incoming.observedAt, inTs: incoming.ts, replyAt: outgoing.lastAt,
    dueAt: dueAfter(outgoing.lastAt, cfg, random) };
  return { ...roleplay, seen: { ...roleplay.seen, [channel]: { peer, at: outgoing.lastAt } }, pending: row };
}

/** Observe a delivered reply and handle at most one return message outside the ordinary cadence. */
export async function tickRoleplayFollowup({
  cfg = loadConfig(), active = () => true, canSend = () => true, now = Date.now, startedAt = now(), random = Math.random, send = sendChatRound,
} = {}) {
  if (!active()) return false;
  const channel = activeChatChannel(cfg);
  const peer = chatPeer(cfg);
  if (cfg.rules?.roleplayFollowup?.enabled !== true) return false;
  const before = readChatData(STORE);
  const at = now();
  const quiet = inQuiet(at, cfg.quietHours, cfg.timezone);
  const dialogue = quiet ? null : chatDialogue(cfg);
  let next = permits(cfg, channel, peer) && dialogue
    ? observeSceneReply(before, channel, peer, dialogue, at, startedAt, cfg, random)
    : before;
  let row = next.pending;
  if (row) {
    const configuredHours = Number(cfg.agreements?.expireHours) || 24;
    const expiry = row.dueAt + Math.max(1, Math.min(168, configuredHours)) * 60 * MINUTE;
    if (at >= expiry || (row.channel === channel && row.peer === peer && dialogue && !sceneStillPending(row, dialogue))) {
      next = { ...next };
      delete next.pending;
      row = null;
    } else if (!row.completedAt && at >= row.dueAt) {
      row = { ...row, completedAt: row.dueAt };
      next = { ...next, pending: row };
    }
  }
  if (next !== before) writeChatData(STORE, next);

  const permittedNow = (fresh, time) => active() && activeChatChannel(fresh) === channel && chatPeer(fresh) === peer &&
    permits(fresh, channel, peer) && !inQuiet(time, fresh.quietHours, fresh.timezone) &&
    inWindows(time, fresh.channels?.[channel]?.activeHours, fresh.timezone);
  if (!row?.completedAt || row.channel !== channel || row.peer !== peer || !canSend() ||
      !permittedNow(cfg, at) || externalInFlight(cfg, at) || dialogue?.incoming?.peer !== peer) return false;

  // Claim before dispatch. An ambiguous transport failure must never replay an already delivered scene.
  const claimed = { ...next };
  delete claimed.pending;
  writeChatData(STORE, claimed);
  const result = await send({ cfg, to: peer, text: '（剧情）我回来啦。', source: 'roleplay', dryRun: false,
    now: at, split: { enabled: false }, timeoutMs: cfg.send?.timeoutMs,
    canDispatch() {
      const fresh = loadConfig();
      const time = now();
      if (!permittedNow(fresh, time)) return false;
      const flight = externalInFlight(fresh, time);
      const latest = chatDialogue(fresh);
      return latest.incoming.peer === peer && (!flight || (channel === 'qq' && flight.firstAt === at)) &&
        sceneStillPending(row, latest);
    },
  });
  if (result?.reason === 'TOPIC_PREFERENCE_MUTED' && !result.parts) writeChatData(STORE, next);
  return result?.ok === true && result.dryRun !== true;
}

