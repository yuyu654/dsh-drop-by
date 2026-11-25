import { readBridgeDialogue, bridgeInFlight } from '../chat/outbound.js';
import { douyinPrimary, douyinPeer, readDouyinState, sendDouyinText } from './douyin-im.js';
import { internalPrimary, internalSessionId, internalInFlight, readInternalState, sendInternalMessage } from './internal.js';
import { chatBinding, chatChanging, readyDouyinBinding } from './chat-switch.js';
import { sendQQRound } from '../chat/send.js';

export const activeChatChannel = cfg => internalPrimary(cfg) ? 'internal' : douyinPrimary(cfg) ? 'douyin' : 'qq';
export const chatPeer = cfg => internalPrimary(cfg)
  ? internalSessionId()
  : douyinPrimary(cfg) ? douyinPeer(cfg) : String(cfg.channels?.qq?.peerId || '');
export const emotionPeer = cfg => internalPrimary(cfg)
  ? chatBinding().qqBinding?.peerId || String(cfg.channels?.qq?.peerId || '').trim() || internalSessionId()
  : douyinPrimary(cfg) ? chatBinding().qqBinding?.peerId || douyinPeer(cfg) : chatPeer(cfg);

export function canReadChat(cfg) {
  if (internalPrimary(cfg)) {
    return cfg.channels?.internal?.enabled !== false && cfg.channels?.internal?.read !== false && !!internalSessionId();
  }
  if (douyinPrimary(cfg)) return cfg.channels.douyin?.read !== false && !!chatPeer(cfg) && !!readyDouyinBinding({ readOnly: true });
  return cfg.sources?.qq?.enabled !== false && cfg.channels?.qq?.enabled !== false && cfg.channels?.qq?.read !== false;
}

export function chatDialogue(cfg, { readQq = readBridgeDialogue, readDouyin = readDouyinState, readInternal = readInternalState } = {}) {
  if (internalPrimary(cfg)) {
    const peer = internalSessionId();
    const { incoming, outgoing } = readInternal(peer);
    return {
      incoming: incoming || {},
      outgoing: outgoing ? { ...outgoing, peer, count: outgoing.source === 'reply' ? 1 : 0 } : {},
    };
  }
  if (!douyinPrimary(cfg)) return readQq();
  const peer = chatPeer(cfg);
  const { incoming, outgoing } = readDouyin(peer);
  return { incoming: incoming || {},
    outgoing: outgoing ? { ...outgoing, peer, count: outgoing.source === 'reply' ? 1 : 0 } : {} };
}

export function externalInFlight(cfg, now) {
  const maxMs = Number(cfg.rules?.qqTiming?.inFlightSec ?? 180) * 1000;
  if (internalPrimary(cfg)) return internalInFlight(internalSessionId(), { now, maxMs });
  if (!douyinPrimary(cfg)) return bridgeInFlight({ now, maxMs });
  const s = readDouyinState(chatPeer(cfg));
  return (s.flight || s.pending?.length) && s.incoming
    ? { firstAt: s.incoming.observedAt, count: 1, src: 'douyin-im' } : null;
}

export function sendChatRound({ cfg, to, ...opts }) {
  if (chatChanging()) return Promise.resolve({ ok: false, error: '正在切换主聊天接口' });
  if (internalPrimary(cfg)) {
    return sendInternalMessage({
      cfg,
      sessionId: to,
      text: opts.text,
      source: opts.source,
      dryRun: opts.dryRun,
      timeoutMs: opts.timeoutMs,
      canDispatch: opts.canDispatch,
    });
  }
  return douyinPrimary(cfg)
    ? sendDouyinText({ cfg, peer: to, text: opts.text, source: opts.source, canDispatch: opts.canDispatch })
    : sendQQRound({ to, ...opts });
}
