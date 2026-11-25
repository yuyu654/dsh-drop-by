import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH, loadConfig } from '../settings/config.js';
import { explorationStatus, loadExploration } from '../explore/explore.js';
import { loadPersona } from '../decision/persona.js';
import { inQuiet } from '../perception/schedule.js';
import { busyNow } from '../perception/holidays.js';
import { publicExplorationUrl } from '../explore/explore-media.js';
import { dshHome } from './outbound.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer } from '../channels/external.js';
import { chatChanging } from '../channels/chat-switch.js';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const FILE = path.join(path.dirname(CONFIG_PATH), 'data', 'action-consent.json');
let executor = null;
let lastExplorationStop = null;

/** The active DSH instance owns exploration, including its single-round lock. */
export function bindActionExecutor(handler) {
  executor = handler;
  lastExplorationStop = null;
  return () => { if (executor === handler) executor = null; };
}

function callbackTransportReady(cfg) {
  const ch = activeChatChannel(cfg);
  if (ch === 'internal') return canReadChat(cfg) && cfg.channels?.internal?.send !== false;
  if (ch === 'douyin') return canReadChat(cfg) && cfg.channels.douyin.send !== false;
  try {
    const conn = JSON.parse(fs.readFileSync(path.join(dshHome(), 'qq-bridge', 'connection.json'), 'utf8'));
    return Boolean(conn.httpApiUrl && conn.httpToken);
  } catch { return false; }
}

function eligible(cfg, peer, now) {
  return qqTaskPeerEnabled(cfg, peer) && cfg.rules?.actionGate?.enabled === true && cfg.exploration?.web === true &&
    !inQuiet(now, cfg.quietHours, cfg.timezone) && !busyNow(now, cfg);
}

export function qqTaskPeerEnabled(cfg, peer) {
  return cfg.enabled !== false &&
    canReadChat(cfg) && cfg.channels?.[activeChatChannel(cfg)]?.send !== false &&
    !!peer && chatPeer(cfg) === String(peer) &&
    cfg.send?.enabled === true && cfg.dryRun === false;
}

export function retryPlan(state, persona) {
  const { lastAt, lastRun } = explorationStatus(state, persona);
  const { mode, kind, query, sources } = lastRun || {};
  // Only replay a previously issued public search, with evidence that its pages lacked a body.
  if (!lastAt || lastRun?.alternateSourceRetry || mode !== 'research' || kind !== 'web' || !query || typeof query !== 'string' || query.length > 120 ||
      /https?:|[\\/]|@|[\u0000-\u001f]|\d{7,}/iu.test(query) || !Array.isArray(sources) ||
      !sources.length || sources.some((source) => source.evidence === '网页正文')) return null;
  const urls = sources.map((source) => publicExplorationUrl(source.url)).filter(Boolean);
  const excluded = urls.map((url) => url.hostname.replace(/^www\./, ''));
  if (!excluded.length) return null;
  return { target: 'explore', params: { forceAltSource: true, mode: 'research', query, excluded, excludedUrls: urls.map((url) => url.href), roundAt: lastAt, personaKey: state.personaKey } };
}

function availablePlan(cfg, peer, now, state = loadExploration(), persona = loadPersona({ cfg })) {
  if (!executor || !eligible(cfg, peer, now) || !callbackTransportReady(cfg)) return null;
  const plan = retryPlan(state, persona);
  const age = now - Number(plan?.params.roundAt);
  return plan && age >= 0 && age < Number(cfg.exploration?.recentDays ?? 3) * 86_400_000 ? plan : null;
}

export const RETRY_QUESTION = '要不要我换个源去找正文？';

export function actionProposalCandidate({ cfg, peer, now, state, persona }) {
  const plan = availablePlan(cfg, peer, now, state, persona);
  if (!plan) return null;
  return {
    at: plan.params.roundAt, section: state.thread?.topic || '研究资料',
    source: state.lastRun.sources.find((entry) => publicExplorationUrl(entry.url)),
    line: RETRY_QUESTION, chars: RETRY_QUESTION.length, exploration: true, actionRetry: true,
  };
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state) + '\n', 'utf8');
  fs.renameSync(tmp, FILE);
}

const proposalQuestion = (text) => String(text || '').trim();

/** Prepare before delivery; commit only after the exact message is delivered. */
export function prepareActionProposal({ peer, text, cfg = loadConfig(), now = Date.now(), source, roundAt }) {
  const prompt = proposalQuestion(text);
  if (!prompt) return null;
  const action = availablePlan(cfg, peer, now);
  if (!action || (source && (!action.params.excluded.includes(publicExplorationUrl(source)?.hostname.replace(/^www\./, '')) || roundAt !== action.params.roundAt))) return null;
  return { type: 'explore_retry', prompt, action };
}

export function recordActionOutbound({ peer, proposal, firstAt, sentAt, cfg = loadConfig() }) {
  if (!peer || chatPeer(cfg) !== String(peer)) return;
  if (proposal && (!eligible(cfg, peer, sentAt) || !callbackTransportReady(cfg))) proposal = null;
  const state = read();
  const content = state.content ||= {};
  // Outbound can arrive from both the bridge and the companion.
  if (Number(content.lastOutboundAt || 0) > firstAt) return;
  if (!proposal && !content.pendingAction) return;
  content.lastOutboundAt = sentAt;
  content.pendingAction = proposal ? {
    ...proposal, id: 'explore_retry:' + sentAt, channel: activeChatChannel(cfg), peer: String(peer), firstAt, createdAt: sentAt,
    expiresAt: sentAt + Math.max(1, Math.min(15, Number(cfg.rules?.actionGate?.expiresMinutes) || 15)) * 60_000,
  } : null;
  save(state);
}

function proposalWindow({ pending, peer, kind, at, now, outgoing }) {
  if (!pending || kind !== 'private' || String(peer) !== pending.peer) return 'ignore';
  if (now >= pending.expiresAt || !Number.isFinite(pending.expiresAt)) return 'cancel';
  if (!Number.isFinite(at) || at < Math.floor(pending.createdAt / 1000) * 1000 || at > now) return 'ignore';
  // OneBot timestamps are in seconds. A message in the delivery second cannot prove it came after delivery.
  if (at <= pending.createdAt) return 'cancel';
  if (!outgoing || outgoing.peer !== pending.peer || outgoing.firstAt !== pending.firstAt ||
      outgoing.lastAt !== pending.createdAt || !outgoing.lastAt) return 'cancel';
  return 'ready';
}

export function isHandledActionMessage(peer, at, channel = 'qq') {
  return !!at && (read().content?.handled || []).some((item) => (item.channel || 'qq') === channel && item.peer === String(peer) && item.at === Number(at));
}

async function waitForOrdinaryReply({ peer, consumedAt, cfg, handler }) {
  const limit = consumedAt + Number(cfg.rules?.actionGate?.ackWaitSec ?? 30) * 1000;
  const interval = Math.max(1, Number(cfg.rules?.qqTiming?.pollSec ?? 2)) * 1000;
  while (executor === handler && activeChatChannel(loadConfig()) === activeChatChannel(cfg)) {
    const { outgoing } = chatDialogue(cfg);
    if (outgoing.peer === String(peer) && outgoing.firstAt >= consumedAt && outgoing.lastAt >= outgoing.firstAt && outgoing.count > 0) return;
    const remaining = limit - Date.now();
    if (remaining <= 0) return;
    await sleep(Math.min(interval, remaining));
  }
}

export function incomingMatches({ peer, kind, text, bridgeText = text, at, incoming, cfg, internalSession }) {
  const value = (activeChatChannel(cfg) === 'qq' ? String(bridgeText || '').slice(0, 80) : String(bridgeText || '')).trim();
  if (activeChatChannel(cfg) === 'internal') {
    return kind === 'private' && Boolean(peer) && internalSession === String(peer) && Boolean(value);
  }
  return incoming.peer === String(peer) && incoming.kind === kind &&
    incoming.ts === at && Boolean(incoming.observedAt) && String(incoming.text || '').trim() === value;
}

export function tryStopExplorationCommand({ peer, kind, text, bridgeText = text, at, cfg, internalSession, now = Date.now() }) {
  if (!/^(?:(?:中止|停止)(?:自主探索|本轮探索))[。！!]?$/.test(String(bridgeText || '').trim())) return '';
  if (!executor?.stopExploration || kind !== 'private' || !peer || String(peer) !== chatPeer(cfg) ||
      cfg.enabled === false || !canReadChat(cfg) || chatChanging()) return '';
  const { incoming } = chatDialogue(cfg);
  const age = now - Number(at);
  if (!(age >= 0 && age <= Number(cfg.rules?.qqCommands?.freshSec ?? 120) * 1000) ||
      !incomingMatches({ peer, kind, text, bridgeText, at, incoming, cfg, internalSession })) return '';
  const channel = activeChatChannel(cfg);
  if (lastExplorationStop?.channel === channel && lastExplorationStop.peer === peer && lastExplorationStop.at === at) {
    return lastExplorationStop.context;
  }
  const result = executor.stopExploration();
  const context = result.ok
    ? '<qq_reply_context>中止指令已执行。自然告诉用户，本轮自主探索已中止。</qq_reply_context>'
    : '<qq_reply_context>目前没有正在运行的自主探索。自然告诉用户当前状态。</qq_reply_context>';
  lastExplorationStop = { channel, peer, at, context };
  return context;
}

function readPendingForMessage({ peer, kind, text, bridgeText, at, cfg, internalSession, now }) {
  const state = read();
  const pending = state.content?.pendingAction;
  if (!pending || (pending.channel || 'qq') !== activeChatChannel(cfg) || pending.peer !== String(peer) || kind !== 'private') return null;
  const { incoming, outgoing } = chatDialogue(cfg);
  if (!incomingMatches({ peer, kind, text, bridgeText, at, incoming, cfg, internalSession })) return null;
  const window = proposalWindow({ pending, peer, kind, at, now, outgoing });
  if (window === 'ignore') return null;
  if (window === 'cancel' || !executor || !eligible(cfg, peer, now) || !callbackTransportReady(cfg)) {
    state.content.pendingAction = null;
    save(state);
    return null;
  }
  return { state, pending };
}

export function pendingQqProposal(input) {
  const entry = readPendingForMessage({ now: Date.now(), ...input });
  return entry ? { id: entry.pending.id, actionType: entry.pending.type, prompt: entry.pending.prompt } : null;
}

/** Refresh the marker and proposal after the model call. Claim before starting any work. */
export function consumeQqAction({ peer, kind, text, bridgeText, at, cfg = loadConfig(), internalSession, now = Date.now(), proposalId, route }) {
  if (!proposalId) return null;
  const entry = readPendingForMessage({ peer, kind, text, bridgeText, at, cfg, internalSession, now });
  if (!entry || entry.pending.id !== proposalId) return null;
  const { state, pending } = entry;
  const content = state.content;
  content.pendingAction = null;
  const decision = route.actionType === pending.type ? route.intent : null;
  if (decision === 'accept_proposal' || decision === 'decline_proposal') {
    content.handled = [...(content.handled || []), { peer: String(peer), at, channel: activeChatChannel(cfg) }].slice(-50);
  }
  save(state);
  if (decision === 'decline_proposal') return 'decline';
  if (decision !== 'accept_proposal') return null;

  const current = availablePlan(cfg, peer, now);
  if (!current || JSON.stringify(current) !== JSON.stringify(pending.action)) return 'stale';
  const handler = executor;
  const action = { ...current, params: { ...current.params, userGuidance: route.userGuidance || '' } };
  startQqTask({ peer, cfg, now, handler,
    run: (report) => handler.run(action, report),
    canReport: (fresh) => qqTaskPeerEnabled(fresh, peer),
  });
  return 'accepted';
}

function startQqTask({ peer, cfg, now, handler, run, canReport, command = false }) {
  let reported = false;
  let timer;
  const reportOnce = (result) => {
    if (reported) return;
    reported = true;
    clearTimeout(timer);
    if (result?.reason === 'CANCELLED') return;
    void (async () => {
      await waitForOrdinaryReply({ peer, consumedAt: now, cfg, handler });
      const fresh = loadConfig();
      if (executor !== handler) return;
      const channel = activeChatChannel(cfg);
      if (channel !== activeChatChannel(fresh)) {
        await handler.deferReport?.({ peer, result, channel, command });
      } else if (callbackTransportReady(fresh) && canReport(fresh)) {
        await handler.report({ peer, result, cfg: fresh, command });
      }
    })().catch(() => {});
  };
  if (command) {
    timer = setTimeout(() => reportOnce({ text: '这件事到时限还没跑完，先跟你说一声。' }),
      Number(cfg.rules?.qqCommands?.timeoutSec ?? 90) * 1000);
    timer.unref?.();
  }
  void Promise.resolve().then(() => run(reportOnce))
    .then(reportOnce, () => reportOnce(null));
}

let runningCommand = false;

/** Recheck after model classification as a newer QQ message may have replaced the marker. */
export function qqCommandPreflight({ peer, kind, text, bridgeText, at, cfg, internalSession, now = Date.now() }) {
  if (cfg.rules?.qqCommands?.enabled !== true || kind !== 'private' || !qqTaskPeerEnabled(cfg, peer)) return 'disabled';
  if (!executor?.command || !callbackTransportReady(cfg)) return 'unavailable';
  const { incoming } = chatDialogue(cfg);
  const age = now - Number(at);
  if (!incomingMatches({ peer, kind, text, bridgeText, at, incoming, cfg, internalSession }) ||
      !(age >= 0 && age <= Number(cfg.rules?.qqCommands?.freshSec ?? 120) * 1000)) return 'unverified';
  const value = String(text || '').trim();
  const key = createHash('sha256').update(value).digest('hex');
  if ((read().content?.handled || []).some((entry) => (entry.channel || 'qq') === activeChatChannel(cfg) && entry.peer === String(peer) && entry.at === at && entry.commandKey === key)) return 'duplicate';
  return 'ready';
}

/** The bridge provides a timestamp but no message id. Claim the same text and timestamp once on disk. */
export function queueQqCommand({ cmd, peer, kind, text, bridgeText, at, cfg, internalSession, now = Date.now() }) {
  const status = qqCommandPreflight({ peer, kind, text, bridgeText, at, cfg, internalSession, now });
  if (status !== 'ready') return status;
  const handler = executor;
  const state = read();
  const content = state.content ||= {};
  const key = createHash('sha256').update(String(text || '').trim()).digest('hex');
  const handled = content.handled || [];
  if (runningCommand) return 'busy';
  if ((cmd.type === 'explore_query' || cmd.type === 'browse_url') && cfg.exploration?.web !== true) return 'webDisabled';
  content.handled = [...handled, { peer: String(peer), at, channel: activeChatChannel(cfg), commandKey: key }].slice(-50);
  save(state);
  runningCommand = true;
  startQqTask({ peer, cfg, now, handler, command: true,
    canReport: (fresh) => fresh.rules?.qqCommands?.enabled === true && qqTaskPeerEnabled(fresh, peer),
    async run() {
      try { return await handler.command(cmd, cfg); }
      finally { runningCommand = false; }
    },
  });
  return 'accepted';
}
