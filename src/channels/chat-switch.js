import { performance } from 'node:perf_hooks';
import { detectQq } from '../settings/detect.js';
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
      const error = new Error(json?.error || `${route} 返回 HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return json;
  };
}

const QQ_API = '/dsh-qq-bridge';

async function qqBindings(call) {
  if (!detectQq().ready) return null;
  let state;
  try {
    state = await call(QQ_API + '/state');
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
  const ids = state.sessions || [];
  return (await Promise.all(ids.map(async (id) =>
    (await call(QQ_API + '/state?sessionId=' + encodeURIComponent(id))).binding))).filter(Boolean);
}

const isPrivatePeer = (b, peerId) => b.peerKind === 'private' && String(b.peerId) === peerId;

function setQqEnabled(call, sessionId, enabled) {
  return call(QQ_API + '/options', { sessionId, enabled });
}

async function restoreQqBindings(call, disabled) {
  for (const b of disabled) await setQqEnabled(call, b.sessionId, true).catch(() => {});
}

export async function switchToQq(binding, call, { cfg, openSession, commit = () => {} } = {}) {
  let { sessionId, qqBinding } = binding;
  const savedPeer = String(qqBinding?.peerId || '');
  const configuredPeer = String(cfg?.channels?.qq?.peerId || '').trim();
  if (sessionId && savedPeer && configuredPeer && savedPeer !== configuredPeer) {
    throw new Error('已保存的 QQ 绑定与当前 QQ 联系人不同，请先核对联系人');
  }

  const peerId = configuredPeer || savedPeer;
  const bindings = peerId && cfg ? await qqBindings(call) : null;
  let createdForQq = false;
  if (!sessionId) {
    if (bindings && peerId) {
      const active = bindings.filter(b => b.enabled !== false);
      const matching = active.filter(b => isPrivatePeer(b, peerId));
      if (matching.length > 1 || (matching.length === 1 && !matching[0].authoritative)) {
        throw new Error('请为配置的 QQ 联系人保留一条启用的权威私聊绑定');
      }
      if (matching.length === 1) {
        await commit({ ...binding, sessionId: matching[0].sessionId, qqBinding: matching[0], preparedSessionId: '' });
        return [`已切到 QQ，并沿用现有会话 ${matching[0].sessionId.slice(0, 8)}。`];
      }
      if (typeof openSession === 'function') {
        sessionId = await openSession(undefined, 'qq');
        createdForQq = true;
      }
    }
    if (!sessionId) {
      await commit();
      return ['请配好 QQ 桥并填写 QQ 联系人，绑定会话后即可使用。'];
    }
  }

  if (!savedPeer && !bindings) {
    await commit();
    return [`请配好 QQ 桥并填写 QQ 联系人，再手动绑定到共用会话 ${sessionId.slice(0, 8)}。`];
  }

  const previous = bindings?.find(b => b.sessionId === sessionId);
  if (previous && !isPrivatePeer(previous, peerId)) {
    throw new Error('共用会话已有另一位 QQ 联系人的绑定，请先在 QQ 桥整理该会话的绑定');
  }
  const conflicts = (bindings || []).filter(b => b.sessionId !== sessionId && b.enabled !== false && isPrivatePeer(b, peerId));
  const disabled = [];
  const target = savedPeer && !createdForQq
    ? { ...qqBinding, sessionId }
    : { sessionId, peerKind: 'private', peerId, authoritative: true };
  let bindAttempted = false;
  try {
    for (const b of conflicts) {
      disabled.push(b);
      await setQqEnabled(call, b.sessionId, false);
    }
    bindAttempted = true;
    const result = await call(QQ_API + '/bind', target);
    const nextBinding = {
      ...binding,
      sessionId,
      qqBinding: result?.binding || target,
      ...(createdForQq ? { preparedSessionId: '' } : {}),
    };
    await commit(savedPeer && !createdForQq ? undefined : nextBinding);
    if (createdForQq) return [`已自动新建共用会话 ${sessionId.slice(0, 8)} 并绑定到 QQ。`];
    return savedPeer ? [] : [`已将 QQ 自动绑定到共用会话 ${sessionId.slice(0, 8)}。`];
  } catch (error) {
    // The bridge may apply a mutation even if the response never arrives.
    if (bindAttempted) {
      if (previous) {
        await call(QQ_API + '/bind', previous).catch(() => {});
        if (previous.enabled === false) await setQqEnabled(call, sessionId, false).catch(() => {});
      } else if (bindings) {
        await call(QQ_API + '/unbind', { sessionId }).catch(() => {});
      } else {
        await setQqEnabled(call, sessionId, false).catch(() => {});
      }
    }
    await restoreQqBindings(call, disabled);
    throw error;
  }
}

export function bindSharedSession(sessionId, { title = '' } = {}) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('缺少会话 ID');
  const prior = chatBinding();
  const keepQq = prior.qqBinding?.sessionId === id ? prior.qqBinding : null;
  const next = {
    ...prior,
    sessionId: id,
    qqBinding: keepQq,
    preparedSessionId: '',
    ...(title ? { sessionTitle: String(title).trim() } : (prior.sessionId === id ? {} : { sessionTitle: '' })),
  };
  writeChatData('external-chat', next);
  return next;
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

export function readyDouyinBinding({ readOnly = false } = {}) {
  if (changing) return null;
  const state = readOnly ? switchState() : adoptAfterRestart();
  if (state.restartBoot === boot) return null;
  const binding = chatBinding();
  // Read-only callers see the same session that adoption would select.
  if (readOnly && (state.restartBoot || (state.boot && state.boot !== boot)) && binding.preparedSessionId) {
    return { ...binding, sessionId: binding.preparedSessionId, preparedSessionId: '' };
  }
  return binding.sessionId ? binding : null;
}

export function markChatBoot() {
  const state = adoptAfterRestart();
  if (state.boot !== boot) writeChatData('chat-switch', { ...state, boot });
}

async function commitPrimary(binding, state, save) {
  const oldBinding = binding && chatBinding();
  const oldState = switchState();
  if (binding) writeChatData('external-chat', binding);
  try {
    writeChatData('chat-switch', state);
    await save();
  } catch (error) {
    if (oldBinding) writeChatData('external-chat', oldBinding);
    writeChatData('chat-switch', oldState);
    throw error;
  }
}

export async function changePrimaryChannel({ from, to, cfg, call, save, drain, canSwitchWithoutRestart, openDouyinSession, openSession }) {
  if (changing) throw new Error('正在切换主聊天接口');
  changing = true;
  try {
    if (from === to) return { restartRequired: to === 'douyin' && !!switchState().restartBoot };
    if (to === 'internal') {
      if (from === 'douyin') {
        await drain();
        await drainDouyinSends();
      }
      const prior = chatBinding();
      const peerId = String(cfg?.channels?.qq?.peerId || '').trim();
      const bindings = from === 'qq' && (peerId || prior.sessionId) ? await qqBindings(call) : null;
      const active = (bindings || []).filter(b => b.enabled !== false);
      const matching = peerId ? active.filter(b => isPrivatePeer(b, peerId)) : [];
      if (matching.length > 1 || (matching.length === 1 && !matching[0].authoritative)) {
        throw new Error('请为配置的 QQ 联系人保留一条启用的权威私聊绑定');
      }
      const disabled = [];
      try {
        if (matching[0]) {
          disabled.push(matching[0]);
          await setQqEnabled(call, matching[0].sessionId, false);
        }
        const qqOwnsOther = id => active.some(b => b.sessionId === id && b.sessionId !== matching[0]?.sessionId);
        const sessionId = matching[0]?.sessionId || (prior.sessionId && !qqOwnsOther(prior.sessionId) ? prior.sessionId : '');
        const keepQq = matching[0] || (sessionId && prior.qqBinding?.sessionId === sessionId ? prior.qqBinding : null);
        const binding = { ...prior, sessionId, qqBinding: keepQq, preparedSessionId: '' };
        await commitPrimary(binding, { boot }, save);
        const notes = sessionId
          ? [`已切到内部会话，沿用共用会话 ${sessionId.slice(0, 8)}。`]
          : ['已切到内部会话，请在下方选择一个已有会话或新建陪伴会话。'];
        return { restartRequired: false, notes };
      } catch (error) {
        await restoreQqBindings(call, disabled);
        throw error;
      }
    }
    if (to === 'qq') {
      if (from === 'douyin') {
        await drain();
        await drainDouyinSends();
      }
      const notes = await switchToQq(chatBinding(), call, {
        cfg,
        openSession: openSession || openDouyinSession,
        commit: binding => commitPrimary(binding, { boot }, save),
      });
      return { restartRequired: false, notes };
    }

    if (!douyinPeer(cfg)) throw new Error('请先填写抖音联系人 sec_uid');
    if (!douyinInstallation().ready) throw new Error('缺少 dsh-douyin-scroll 私信脚本');
    const cfgResult = await call('/api/douyin-duty/config');
    const peerId = String(cfg.channels?.qq?.peerId || '').trim();
    const prior = chatBinding();
    const bindings = peerId || prior.sessionId ? await qqBindings(call) : null;
    const active = (bindings || []).filter(b => b.enabled !== false);
    const matching = active.filter(b => isPrivatePeer(b, peerId));
    if (matching.length > 1 || (matching.length === 1 && !matching[0].authoritative)) {
      throw new Error('请为配置的 QQ 联系人保留一条启用的权威私聊绑定');
    }

    const qqBinding = matching[0] || null;
    const watcherWasOn = cfgResult.config?.chatWatch === true;
    const disabled = [];
    try {
      await call('/api/douyin-duty/config', { chatWatch: false });
      const saved = await call('/api/douyin-duty/config');
      if (saved.config?.chatWatch !== false || !originalWatcherDisabled()) throw new Error('抖音原聊天盯梢还未关闭');
      if (qqBinding) {
        disabled.push(qqBinding);
        await setQqEnabled(call, qqBinding.sessionId, false);
      }
      const qqOwns = id => active.some(b => b.sessionId === id);
      const reuse = qqOwns(prior.sessionId) ? undefined : prior.sessionId;
      const sessionId = qqBinding?.sessionId || await openDouyinSession(reuse);
      const restartRequired = watcherWasOn || !(await canSwitchWithoutRestart(sessionId, qqBinding));
      const keptQqBinding = qqBinding || (
        sessionId === prior.sessionId && prior.qqBinding?.sessionId === sessionId &&
        (!peerId || String(prior.qqBinding.peerId) === peerId)
          ? prior.qqBinding : null
      );
      const binding = { sessionId, qqBinding: keptQqBinding };
      if (!qqBinding && sessionId === reuse && prior.preparedSessionId && !qqOwns(prior.preparedSessionId)) {
        binding.preparedSessionId = prior.preparedSessionId;
      }
      await commitPrimary(binding, { boot, restartBoot: restartRequired ? boot : 0 }, save);
      return { restartRequired };
    } catch (error) {
      await restoreQqBindings(call, disabled);
      if (watcherWasOn) await call('/api/douyin-duty/config', { chatWatch: true }).catch(() => {});
      throw error;
    }
  } finally {
    changing = false;
  }
}
