import { readBridgeDialogue, bridgeInFlight } from '../outbound.js';
import { douyinPrimary, douyinPeer, readDouyinState, sendDouyinText } from './douyin-im.js';
import { chatBinding, chatChanging, readyDouyinBinding } from './chat-switch.js';
import { sendQQRound } from '../send.js';

export const activeChatChannel = cfg => douyinPrimary(cfg) ? 'douyin' : 'qq';
export const chatPeer = cfg => douyinPrimary(cfg) ? douyinPeer(cfg) : String(cfg.channels?.qq?.peerId || '');
export const emotionPeer = cfg => douyinPrimary(cfg) ? chatBinding().qqBinding?.peerId || douyinPeer(cfg) : chatPeer(cfg);

export function canReadChat(cfg) {
  if (douyinPrimary(cfg)) return cfg.channels.douyin?.read !== false && !!chatPeer(cfg) && !!readyDouyinBinding();
  return cfg.sources?.qq?.enabled !== false && cfg.channels?.qq?.enabled !== false && cfg.channels?.qq?.read !== false;
}

export function chatDialogue(cfg, { readQq = readBridgeDialogue, readDouyin = readDouyinState } = {}) {
  if (!douyinPrimary(cfg)) return readQq();
  const peer = chatPeer(cfg);
  const { incoming, outgoing } = readDouyin(peer);
  return { incoming: incoming || {},
    outgoing: outgoing ? { ...outgoing, peer, count: outgoing.source === 'reply' ? 1 : 0 } : {} };
}

export function externalInFlight(cfg, now) {
  if (!douyinPrimary(cfg)) return bridgeInFlight({ now, maxMs: Number(cfg.rules?.qqTiming?.inFlightSec ?? 180) * 1000 });
  const s = readDouyinState(chatPeer(cfg));
  return (s.flight || s.pending?.length) && s.incoming
    ? { firstAt: s.incoming.observedAt, count: 1, src: 'douyin-im' } : null;
}

export function sendChatRound({ cfg, to, ...opts }) {
  if (chatChanging()) return Promise.resolve({ ok: false, error: '正在切换主聊天接口' });
  return douyinPrimary(cfg)
    ? sendDouyinText({ cfg, peer: to, text: opts.text, source: opts.source })
    : sendQQRound({ to, ...opts });
}
