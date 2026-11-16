import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { inWindows } from '../schedule.js';
import { readyDouyinBinding } from './chat-switch.js';
import { collectIncoming, douyinPeer, douyinPrimary, markDouyinSessionSynced, pollDelayMs, readDouyinIm, readDouyinState, originalWatcherDisabled, sendDouyinText, unsyncedDouyinContext, updateDouyinState } from './douyin-im.js';

export function cleanExternalReply(text) {
  const body = String(text || '').replace(/<(qq_reply_context|external_reply_context)>[\s\S]*?<\/\1>/giu, '').trim();
  return /<\/?(?:qq_reply_context|external_reply_context)|【(?:dsh-drop-by|陪伴任务|陪伴动作|上一会话|抖音私信原文|来源归属)|\[dsh-drop-by|Current runtime context/iu.test(body)
    ? '' : body;
}

export function createOwnedReplies() {
  const requests = new Map();
  const active = new Map();
  return {
    expect(sessionId, requestId) { requests.set(sessionId, requestId); },
    forget(sessionId) { requests.delete(sessionId); active.delete(sessionId); },
    observe(sessionId, event) {
      if (!requests.has(sessionId)) return;
      const data = event.data || {};
      if (event.type === 'turn/start') active.set(sessionId, { turn: data.turn });
      const round = active.get(sessionId);
      if (!round) return;
      if (event.type === 'user/message' && data.source?.kind === 'user') {
        if (requests.get(sessionId) === data.source.rpcId) round.requestId = data.source.rpcId;
        else round.otherInput = true;
      }
      if (event.type === 'assistant/message' && data.turn === round.turn && round.requestId) {
        const text = data.message?.content?.filter(part => part.type === 'text').map(part => part.text).join('').trim();
        if (text) round.text = text;
      }
      if (event.type === 'turn/end' && data.turn === round.turn) {
        active.delete(sessionId);
        if (!round.requestId) return;
        requests.delete(sessionId);
        return { requestId: round.requestId, text: round.otherInput ? '' : cleanExternalReply(round.text) };
      }
    },
  };
}

export function createDouyinSession({ getConfig, controller, prepare, log, onSent,
  read = readDouyinIm, send = sendDouyinText, watcherDisabled = originalWatcherDisabled }) {
  const capture = createOwnedReplies();
  let timer, running, controllerAbort, stopped = false, failures = 0;
  const peersByRequest = new Map();

  function schedule(delay) {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(() => {
      running = poll().finally(() => { running = null; });
    }, delay);
    timer.unref?.();
  }

  async function finish(peer, reply) {
    const cfg = getConfig();
    const current = readDouyinState(peer);
    if (current.flight?.requestId !== reply.requestId) return;
    let result;
    try {
      if (reply.text) {
        updateDouyinState(peer, s => ({ ...s, flight: { ...s.flight, sending: true } }));
        result = await send({ cfg, peer, text: reply.text, source: 'reply', expectedRequestId: reply.requestId, getConfig });
      }
      if (result?.ok && !result.dryRun) onSent?.({ cfg, peer, text: reply.text, at: result.sentAt });
    } finally {
      updateDouyinState(peer, s => ({ ...s, flight: null, pending: (s.pending || []).filter(m => !current.flight.ids.includes(m.id)),
        replyError: !reply.text ? (current.flight.sending ? '上次发送回执未确认，请在抖音核对' : '这一轮没有可发正文') : !result?.ok ? result?.error || '发送失败' : '' }));
    }
  }

  async function poll() {
    const cfg = getConfig();
    const settings = cfg.channels?.douyin || {};
    try {
      if (!douyinPrimary(cfg) || cfg.enabled === false || !readyDouyinBinding() || settings.read === false) return;
      if (!inWindows(Date.now(), settings.activeHours, cfg.timezone)) return;
      const peer = douyinPeer(cfg);
      if (!peer) return;
      if (!watcherDisabled()) throw new Error('抖音原聊天盯梢还在开启，请在抖音插件中关闭');
      controllerAbort = new AbortController();
      const incoming = await read(cfg, controllerAbort.signal);
      if (stopped || !douyinPrimary(getConfig()) || douyinPeer(getConfig()) !== peer) return;
      const now = Date.now();
      const state = updateDouyinState(peer, prior => {
        const next = collectIncoming(prior, incoming.conv_id, incoming.messages);
        const last = next.pending.at(-1);
        return { ...next, polledAt: now, pollError: '', retryAt: null, incoming: last
          ? { peer, kind: 'private', ts: last.ts, observedAt: prior.incoming?.ts === last.ts ? prior.incoming.observedAt : now, text: last.text, item: last.item }
          : prior.incoming };
      });
      failures = 0;
      const sessionId = state.flight?.sessionId || readyDouyinBinding()?.sessionId;
      if (!sessionId || !state.pending.length) return;
      const host = controller();
      if (!host) return;
      const waitMs = Math.min(15000, Math.max(3000, Number(cfg.rules?.qqTiming?.debounceMs) || 3500));
      if (state.flight) {
        const { requestId, sessionId: previousSession, sending } = state.flight;
        if (peersByRequest.has(requestId)) return;
        if (sending) {
          // A previously started send may have reached the other side before the host exited.
          await finish(peer, { requestId, text: '' });
          return;
        }
        const info = await host.inspect(previousSession, AbortSignal.timeout(cfg.send.timeoutMs));
        const events = info?.events || [];
        const index = events.findIndex(e => e.type === 'user/message' && e.data?.source?.rpcId === requestId);
        if (index >= 0) {
          const start = events.findLastIndex((e, i) => i <= index && e.type === 'turn/start');
          if (start < 0) throw new Error('找不到已投递抖音私信的会话轮次');
          const end = events.findIndex((e, i) => i > index && e.type === 'turn/end' && e.data?.turn === events[start].data?.turn);
          capture.expect(previousSession, requestId);
          for (const e of events.slice(start, end < 0 ? undefined : end + 1)) {
            const reply = capture.observe(previousSession, e);
            if (reply) {
              await finish(peer, reply);
              return;
            }
          }
          peersByRequest.set(requestId, peer);
          return;
        }
      }
      if (now - state.pending.at(-1).ts < waitMs) return;
      const requestId = state.flight?.requestId || randomUUID();
      const group = state.flight ? state.pending.filter(m => state.flight.ids.includes(m.id)) : state.pending;
      const first = group[0];
      const last = group.at(-1);
      if (!first) return;
      const text = group.map(m => m.kind === 'unsupported' ? '（收到一条当前脚本无法读取的附件）'
        : m.item ? `${m.text || '视频卡片'}（卡片 ID ${m.item}）` : m.text).filter(Boolean).join('\n');
      const prepared = await prepare({ cfg, peer, text, at: last.ts, items: group });
      const boundNow = readyDouyinBinding();
      if (stopped || !douyinPrimary(getConfig()) || !boundNow || (!state.flight && sessionId !== boundNow.sessionId)) return;
      capture.expect(sessionId, requestId);
      peersByRequest.set(requestId, peer);
      updateDouyinState(peer, s => ({ ...s, flight: { sessionId, requestId, ids: group.map(m => m.id) },
        dialogue: state.flight ? s.dialogue : [...(s.dialogue || []), ...group.map(m => (
          { who: 'her', text: m.text, ts: m.ts, item: m.item, kind: m.kind }))].slice(-32) }));
      const { block: extraContext, maxTs: syncedMaxTs } = unsyncedDouyinContext(peer);
      try {
        await host.prompt({ requestId, sessionId, mode: 'queue', clientTimeZone: cfg.timezone,
          content: [{ type: 'text', text: [prepared, extraContext, '【抖音私信原文】\n' + text].filter(Boolean).join('\n\n') }] },
          AbortSignal.timeout(cfg.send.timeoutMs));
        markDouyinSessionSynced(peer, Math.max(syncedMaxTs, Number(last.ts) || 0));
      } catch (error) {
        capture.forget(sessionId);
        peersByRequest.delete(requestId);
        throw error;
      }
    } catch (error) {
      const peer = douyinPeer(cfg);
      if (peer && !stopped) {
        failures++;
        const issue = String(error.message).slice(0, 180);
        updateDouyinState(peer, s => ({ ...s, pollError: issue, retryAt: Date.now() + pollDelayMs(settings, failures) }));
        log?.warn('抖音收信：' + issue);
      }
    } finally {
      controllerAbort = null;
      schedule(pollDelayMs(settings, failures));
    }
  }

  let replyWork = Promise.resolve();
  return {
    start(delay) { if (!running) schedule(delay); },
    pollNow: poll,
    observe(session, event) {
      const reply = capture.observe(session.id, event);
      if (reply) {
        const peer = peersByRequest.get(reply.requestId);
        peersByRequest.delete(reply.requestId);
        if (!peer) return;
        replyWork = finish(peer, reply).catch(error => log?.warn('抖音回信：' + error.message));
      }
    },
    async drain() {
      controllerAbort?.abort();
      await running;
      const cfg = getConfig();
      const limit = Date.now() + Number(cfg.rules?.qqTiming?.inFlightSec ?? 180) * 1000;
      const period = Number(cfg.rules?.qqTiming?.pollSec ?? 2) * 1000;
      while (peersByRequest.size) {
        const remaining = limit - Date.now();
        if (remaining <= 0) throw new Error('抖音回复仍在处理中，暂未切到 QQ');
        await sleep(Math.min(period, remaining));
      }
      await replyWork;
    },
    stop() { stopped = true; clearTimeout(timer); controllerAbort?.abort(); },
  };
}
