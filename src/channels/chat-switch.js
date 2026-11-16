import { performance } from 'node:perf_hooks';
import { readChatData, writeChatData, douyinInstallation, douyinPeer, drainDouyinSends, originalWatcherDisabled } from './douyin-im.js';

const boot = performance.timeOrigin;
export const chatBinding = () => readChatData('external-chat');
export const switchState = () => readChatData('chat-switch');
let changing = false;
export const chatChanging = () => changing;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parseLocalUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && LOCAL_HOSTS.has(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

export function localApiOrigin(headers = {}) {
  const host = String(headers.host || '').trim();
  const rawOrigin = String(headers.origin || '').trim();
  if (rawOrigin && rawOrigin !== 'null') {
    const origin = parseLocalUrl(rawOrigin);
    if (!origin || origin.host !== host) throw new Error('请从本机 DSH 面板切换主聊天接口');
    return origin.origin;
  }
  const hostUrl = host ? parseLocalUrl(`http://${host}`) : null;
  if (!hostUrl) throw new Error('请从本机 DSH 面板切换主聊天接口');
  const rawReferer = String(headers.referer || '').trim();
  if (rawReferer) {
    const referer = parseLocalUrl(rawReferer);
    if (!referer || referer.host !== hostUrl.host) throw new Error('请从本机 DSH 面板切换主聊天接口');
    return referer.origin;
  }
  return hostUrl.origin;
}

export function localChatApi(origin, { timeoutMs, headers = {} }) {
  const forwarded = {};
  if (headers.cookie) forwarded.cookie = String(headers.cookie);
  if (headers.authorization) forwarded.authorization = String(headers.authorization);
  return async (route, body) => {
    const reqHeaders = { ...forwarded, ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }) };
    const response = await fetch(origin + route, {
      method: body === undefined ? 'GET' : 'POST',
      ...(Object.keys(reqHeaders).length ? { headers: reqHeaders } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    const raw = await response.text();
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error body */ }
    if (!response.ok || !json || json.ok === false) {
      throw new Error(json?.error || `${route} 返回 HTTP ${response.status}`);
    }
    return json;
  };
}

export async function switchToQq(binding, call) {
  const { sessionId, qqBinding } = binding;
  if (!sessionId || !qqBinding?.peerId) throw new Error('缺少原 QQ 绑定，请在 QQ 桥绑定后重新选择');
  await call('/dsh-qq-bridge/bind', { ...qqBinding, sessionId });
}

function adoptAfterRestart() {
  const state = switchState();
  if (state.restartBoot && state.restartBoot !== boot) {
    const binding = chatBinding();
    if (binding.preparedSessionId) {
      writeChatData('external-chat', { ...binding, sessionId: binding.preparedSessionId, preparedSessionId: '' });
    }
    writeChatData('chat-switch', { ...state, restartBoot: 0 });
  } else if (state.boot && state.boot !== boot && !state.restartBoot) {
    const binding = chatBinding();
    if (binding.preparedSessionId) {
      writeChatData('external-chat', { ...binding, sessionId: binding.preparedSessionId, preparedSessionId: '' });
    }
  }
  return switchState();
}

export function readyDouyinBinding() {
  if (changing || adoptAfterRestart().restartBoot) return null;
  const binding = chatBinding();
  return binding.sessionId ? binding : null;
}

export function markChatBoot() {
  const state = adoptAfterRestart();
  if (state.boot !== boot) writeChatData('chat-switch', { ...state, boot });
}

export async function changePrimaryChannel({ from, to, cfg, call, save, drain, canSwitchWithoutRestart }) {
  if (changing) throw new Error('正在切换主聊天接口');
  changing = true;
  try {
    if (from === to) return { restartRequired: !!switchState().restartBoot };
    if (to === 'qq') {
      await drain();
      await drainDouyinSends();
      await switchToQq(chatBinding(), call);
      await save();
      writeChatData('chat-switch', { boot });
      return { restartRequired: false };
    }

    if (!douyinPeer(cfg)) throw new Error('请先填写抖音联系人 sec_uid');
    if (!douyinInstallation().ready) throw new Error('缺少 dsh-douyin-scroll 私信脚本');
    const cfgResult = await call('/api/douyin-duty/config');
    const prefix = '/dsh-qq-bridge';
    const { sessions = [] } = await call(prefix + '/state');
    const bindings = (await Promise.all(sessions.map(async (id) =>
      (await call(prefix + '/state?sessionId=' + encodeURIComponent(id))).binding)))
      .filter(item => item && item.enabled);
    const matching = bindings.filter(b => b.peerKind === 'private' && b.authoritative && b.peerId === String(cfg.channels.qq.peerId));
    if (matching.length !== 1) throw new Error('请为配置的 QQ 联系人保留一条启用的权威私聊绑定');
    const qqBinding = matching[0];
    const pause = bindings.filter(b => b.sessionId === qqBinding.sessionId || b.peerKind === 'private' && b.peerId === qqBinding.peerId);
    const disabled = [];
    try {
      await call('/api/douyin-duty/config', { chatWatch: false });
      const saved = await call('/api/douyin-duty/config');
      if (saved.config?.chatWatch !== false || !originalWatcherDisabled()) throw new Error('抖音原聊天盯梢还未关闭');
      for (const b of pause) {
        await call(prefix + '/options', { sessionId: b.sessionId, enabled: false });
        disabled.push(b);
      }
      const restartRequired = cfgResult.config?.chatWatch === true || pause.length > 1 ||
        !(await canSwitchWithoutRestart(qqBinding.sessionId));
      writeChatData('external-chat', { sessionId: qqBinding.sessionId, qqBinding });
      writeChatData('chat-switch', { boot, restartBoot: restartRequired ? boot : 0 });
      await save();
      return { restartRequired };
    } catch (error) {
      for (const b of disabled) {
        await call(prefix + '/options', { sessionId: b.sessionId, enabled: true }).catch(() => {});
      }
      throw error;
    }
  } finally {
    changing = false;
  }
}
