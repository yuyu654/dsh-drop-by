import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config.js';
import { dshHome } from '../detect.js';
import { readChatData, writeChatData } from './douyin-im.js';

function stripQqHeader(text) {
  if (!/^\[QQ (?:私聊|群聊)\] /u.test(text)) return text;
  const end = text.indexOf('\n\n');
  if (end < 0) return text;
  const body = text.slice(end + 2).replace(/^\[\d{2}:\d{2}:\d{2}\] /gmu, '');
  return body.split('\n\n附件：\n', 1)[0];
}

export const PROACTIVE_OPEN_TAG = '<dsh_drop_by_proactive>';
export const PROACTIVE_CLOSE_TAG = '</dsh_drop_by_proactive>';

let dispatcher = null;

export function bindInternalDispatcher(fn) {
  dispatcher = fn;
  return () => { if (dispatcher === fn) dispatcher = null; };
}

export function internalPrimary(cfg) {
  return cfg?.channels?.primary === 'internal';
}

export function sharedSessionId() {
  return String(readChatData('external-chat').sessionId || '').trim();
}

export function internalSessionId() {
  return sharedSessionId();
}

export function readInternalState(sessionId = internalSessionId()) {
  const id = String(sessionId || '').trim();
  if (!id) return {};
  return readChatData('internal-chat')[id] || {};
}

export function updateInternalState(sessionId, fn) {
  const id = String(sessionId || '').trim();
  if (!id) return {};
  const data = readChatData('internal-chat');
  const next = fn(data[id] || {});
  writeChatData('internal-chat', { ...data, [id]: next });
  return next;
}

export function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

export function isProactiveInternalText(text) {
  const s = String(text || '').trimStart();
  return s.startsWith(PROACTIVE_OPEN_TAG) || s.startsWith('[dsh-drop-by 主动消息');
}

export function isProactiveInternalEvent(event) {
  if (!event || event.type !== 'user/message') return false;
  const src = event.data?.source || event.data?.message?.source;
  if (src?.plugin === 'dsh-drop-by' || src?.proactive === true) return true;
  const raw = textFromContent(event.data?.content ?? event.data?.message?.content);
  return isProactiveInternalText(raw);
}

const ENVELOPE_TAGS = [
  ['<qq_reply_context>', '</qq_reply_context>'],
  ['<external_reply_context>', '</external_reply_context>'],
  [PROACTIVE_OPEN_TAG, PROACTIVE_CLOSE_TAG],
];

const INJECTED_HEADS = [
  '【上一会话近期对话前情（已切换新会话，仅作语境参考）】',
  '【dsh-drop-by 角色背景】',
  '【来源归属铁律】',
  '【陪伴动作',
  '【陪伴任务',
];

export function stripInternalEnvelope(raw) {
  let text = String(raw || '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';
  if (isProactiveInternalText(text)) return '';
  while (true) {
    let stripped = false;
    for (const [open, close] of ENVELOPE_TAGS) {
      if (text.startsWith(open)) {
        const end = text.indexOf(close);
        if (end < 0) return '';
        text = text.slice(end + close.length).trimStart();
        stripped = true;
        break;
      }
    }
    if (stripped) continue;
    if (INJECTED_HEADS.some((head) => text.startsWith(head))) {
      const end = text.indexOf('\n\n');
      if (end < 0) return '';
      text = text.slice(end + 2).trimStart();
      continue;
    }
    break;
  }
  text = text.replace(/^【抖音私信原文】\s*/u, '');
  return stripQqHeader(text).trim();
}

export function wrapProactivePrompt(text) {
  return [
    PROACTIVE_OPEN_TAG,
    '[dsh-drop-by 主动消息投递]',
    '请直接向用户自然说出下面这句话，保持原意与口吻，不要调用任何工具，不要解释消息来源，不要复述本标签：',
    String(text || '').trim(),
    PROACTIVE_CLOSE_TAG,
  ].join('\n');
}

function eventTimestamp(event, fallback) {
  const candidates = [
    event?.timestamp,
    event?.ts,
    event?.at,
    event?.data?.timestamp,
    event?.data?.message?.timestamp,
  ];
  for (const v of candidates) {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    if (typeof v === 'string' && v) {
      const parsed = Date.parse(v);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  }
  return fallback;
}

export function observeInternalEvent(session, event, cfg = loadConfig(), now = Date.now()) {
  const sid = String(session?.id || '').trim();
  if (!sid || sid !== internalSessionId()) return null;
  if (cfg?.channels?.internal?.enabled === false || cfg?.channels?.internal?.read === false) return null;
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'session/title') {
    const title = String(event.data?.title || '').trim();
    if (!title) return null;
    const binding = readChatData('external-chat');
    if (binding.sessionId === sid && binding.sessionTitle !== title) {
      writeChatData('external-chat', { ...binding, sessionTitle: title });
    }
    return updateInternalState(sid, (s) => ({ ...s, sessionId: sid, title }));
  }

  if (event.type === 'turn/start') {
    return updateInternalState(sid, (s) => ({
      ...s,
      sessionId: sid,
      flight: { startedAt: now, turn: event.data?.turn ?? null },
    }));
  }

  if (event.type === 'user/message') {
    if (isProactiveInternalEvent(event)) {
      return updateInternalState(sid, (s) => ({
        ...s,
        sessionId: sid,
        proactiveTurn: { at: now, turn: event.data?.turn ?? null },
      }));
    }
    const raw = textFromContent(event.data?.content ?? event.data?.message?.content);
    const cleaned = stripInternalEnvelope(raw);
    if (!cleaned) return null;
    const ts = eventTimestamp(event, now);
    const text = cleaned.slice(0, 300);
    return updateInternalState(sid, (s) => ({
      ...s,
      sessionId: sid,
      proactiveTurn: null,
      incoming: { peer: sid, kind: 'private', ts, observedAt: now, text },
      dialogue: [...(s.dialogue || []), { who: 'her', text, ts }].slice(-32),
    }));
  }

  if (event.type === 'assistant/message') {
    const raw = textFromContent(event.data?.message?.content ?? event.data?.content);
    const text = String(raw || '').trim().slice(0, 300);
    if (!text) return null;
    const ts = eventTimestamp(event, now);
    return updateInternalState(sid, (s) => {
      const proactive = Boolean(
        s.proactiveTurn && (
          (s.proactiveTurn.turn != null && event.data?.turn != null && s.proactiveTurn.turn === event.data.turn) ||
          now - Number(s.proactiveTurn.at || 0) <= 120_000
        )
      ) || Boolean(s.lastProactiveDispatchAt && now - s.lastProactiveDispatchAt <= 120_000 &&
        (!s.incoming?.ts || s.lastProactiveDispatchAt >= s.incoming.ts));
      const source = proactive ? (s.outgoing?.source || 'companion') : 'reply';
      const dialogue = [...(s.dialogue || [])];
      const last = dialogue.at(-1);
      if (proactive && last?.who === 'me' && last.source !== 'reply' && Math.abs(ts - Number(last.ts || 0)) <= 120_000) {
        dialogue[dialogue.length - 1] = { who: 'me', text, ts, source };
      } else {
        dialogue.push({ who: 'me', text, ts, source });
      }
      return {
        ...s,
        sessionId: sid,
        outgoing: {
          peer: sid,
          firstAt: Number(s.flight?.startedAt) || ts,
          lastAt: ts,
          count: proactive ? 0 : 1,
          text,
          source,
        },
        dialogue: dialogue.slice(-32),
      };
    });
  }

  if (event.type === 'turn/end') {
    return updateInternalState(sid, (s) => ({
      ...s,
      sessionId: sid,
      flight: null,
      proactiveTurn: null,
    }));
  }

  return null;
}

export function internalInFlight(sessionId = internalSessionId(), { now = Date.now(), maxMs = 180_000 } = {}) {
  const s = readInternalState(sessionId);
  const startedAt = Number(s.flight?.startedAt) || 0;
  if (!startedAt || now - startedAt > maxMs) return null;
  return { firstAt: startedAt, count: 1, src: 'internal-session' };
}

export function extractDialogueFromEvents(events, sessionId) {
  const dialogue = [];
  let title = '';
  let incoming = null;
  let outgoing = null;
  let nextIsProactive = false;
  let fallbackTs = Date.now() - (Array.isArray(events) ? events.length : 0) * 1000;

  for (const event of Array.isArray(events) ? events : []) {
    fallbackTs += 1000;
    if (event?.type === 'session/title') {
      const t = String(event.data?.title || '').trim();
      if (t) title = t;
      continue;
    }
    if (event?.type === 'user/message') {
      if (isProactiveInternalEvent(event)) {
        nextIsProactive = true;
        continue;
      }
      const cleaned = stripInternalEnvelope(textFromContent(event.data?.content ?? event.data?.message?.content));
      if (!cleaned) continue;
      nextIsProactive = false;
      const ts = eventTimestamp(event, fallbackTs);
      const text = cleaned.slice(0, 300);
      incoming = { peer: sessionId, kind: 'private', ts, observedAt: ts, text };
      dialogue.push({ who: 'her', text, ts });
      continue;
    }
    if (event?.type === 'assistant/message') {
      const text = textFromContent(event.data?.message?.content ?? event.data?.content).trim().slice(0, 300);
      if (!text) continue;
      const ts = eventTimestamp(event, fallbackTs);
      const source = nextIsProactive ? 'companion' : 'reply';
      outgoing = { peer: sessionId, firstAt: ts, lastAt: ts, count: nextIsProactive ? 0 : 1, text, source };
      dialogue.push({ who: 'me', text, ts, source });
      nextIsProactive = false;
    }
  }
  return { title, incoming, outgoing, dialogue: dialogue.slice(-32) };
}

async function readSessionEvents({ sessionId, sessions, controller, persistence, timeoutMs = 5000 }) {
  try {
    const live = sessions?.get?.(sessionId);
    const snap = live?.snapshotEvents?.();
    if (Array.isArray(snap) && snap.length) return { events: snap, title: live?.header?.title || '' };
  } catch { /* fall through */ }

  if (typeof controller?.inspect === 'function') {
    try {
      const info = await controller.inspect(sessionId, AbortSignal.timeout(timeoutMs));
      if (Array.isArray(info?.events)) return { events: info.events, title: info?.meta?.title || '' };
    } catch { /* fall through */ }
  }

  if (typeof persistence?.open === 'function') {
    let handle = null;
    try {
      handle = await persistence.open(sessionId, 'read');
      if (handle && typeof handle.read === 'function') {
        const res = await handle.read(0, 500);
        const events = Array.isArray(res) ? res : Array.isArray(res?.events) ? res.events : [];
        if (events.length) return { events, title: '' };
      }
    } catch { /* ignore */ } finally {
      try { await handle?.close?.(); } catch { /* ignore */ }
    }
  }
  return { events: [], title: '' };
}

export function extractSessionModelFromEvents(events) {
  let pending = null;
  let lastUsed = null;
  for (const event of Array.isArray(events) ? events : []) {
    const data = event?.data && typeof event.data === 'object' ? event.data : event;
    if (event?.type === 'model/selection') {
      const provider = String(data?.provider || '').trim();
      const model = String(data?.model || '').trim();
      if (provider && model) pending = { provider, model };
      continue;
    }
    if (event?.type === 'request/header') {
      const config = data?.header?.config ?? data?.config;
      const provider = String(config?.provider || '').trim();
      const model = String(config?.model || '').trim();
      if (provider && model) {
        lastUsed = { provider, model };
        if (pending && pending.provider === provider && pending.model === model) pending = null;
      }
    }
  }
  return pending || lastUsed || null;
}

export function observeBoundSessionModel(session, event) {
  const sid = String(session?.id || '').trim();
  if (!sid || sid !== sharedSessionId()) return null;
  if (event?.type !== 'model/selection' && event?.type !== 'request/header') return null;
  const picked = extractSessionModelFromEvents([event]);
  if (!picked) return null;
  const binding = readChatData('external-chat');
  const nextModel = { sessionId: sid, provider: picked.provider, model: picked.model };
  if (binding.sessionModel?.sessionId !== sid ||
      binding.sessionModel?.provider !== nextModel.provider ||
      binding.sessionModel?.model !== nextModel.model) {
    writeChatData('external-chat', { ...binding, sessionModel: nextModel });
  }
  return nextModel;
}

export async function syncBoundSessionModel({ sessionId = sharedSessionId(), sessions, controller, persistence, timeoutMs = 3000 } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const { events } = await readSessionEvents({ sessionId: sid, sessions, controller, persistence, timeoutMs });
  const picked = extractSessionModelFromEvents(events);
  if (!picked) return null;
  const nextModel = { sessionId: sid, provider: picked.provider, model: picked.model };
  const binding = readChatData('external-chat');
  if (binding.sessionId === sid && (
    binding.sessionModel?.sessionId !== sid ||
    binding.sessionModel?.provider !== nextModel.provider ||
    binding.sessionModel?.model !== nextModel.model
  )) {
    writeChatData('external-chat', { ...binding, sessionModel: nextModel });
  }
  return nextModel;
}

export async function syncInternalHistory({ sessionId = internalSessionId(), sessions, controller, persistence, timeoutMs = 5000 } = {}) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const { events, title: metaTitle } = await readSessionEvents({ sessionId: sid, sessions, controller, persistence, timeoutMs });
  const parsed = extractDialogueFromEvents(events, sid);
  const sessionModel = extractSessionModelFromEvents(events);
  const title = parsed.title || metaTitle || '';
  const now = Date.now();
  const state = updateInternalState(sid, (s) => {
    const keepExisting = (s.dialogue?.length || 0) > 0 && !parsed.dialogue.length;
    const incoming = parsed.incoming && (!s.incoming?.ts || parsed.incoming.ts >= s.incoming.ts)
      ? parsed.incoming : (s.incoming || null);
    const outgoing = parsed.outgoing && (!s.outgoing?.lastAt || parsed.outgoing.lastAt >= s.outgoing.lastAt)
      ? parsed.outgoing : (s.outgoing || null);
    return {
      ...s,
      sessionId: sid,
      title: title || s.title || '',
      syncedAt: now,
      ...(incoming ? { incoming } : {}),
      ...(outgoing ? { outgoing } : {}),
      dialogue: keepExisting ? s.dialogue : (parsed.dialogue.length ? parsed.dialogue : (s.dialogue || [])),
    };
  });
  if (title || sessionModel) {
    const binding = readChatData('external-chat');
    if (binding.sessionId === sid) {
      const nextModel = sessionModel ? { sessionId: sid, provider: sessionModel.provider, model: sessionModel.model } : binding.sessionModel;
      const titleChanged = Boolean(title && binding.sessionTitle !== title);
      const modelChanged = Boolean(sessionModel && (
        binding.sessionModel?.sessionId !== sid ||
        binding.sessionModel?.provider !== sessionModel.provider ||
        binding.sessionModel?.model !== sessionModel.model
      ));
      if (titleChanged || modelChanged) {
        writeChatData('external-chat', {
          ...binding,
          ...(title ? { sessionTitle: title } : {}),
          ...(nextModel ? { sessionModel: nextModel } : {}),
        });
      }
    }
  }
  return state;
}

function normalizeHeader(entry) {
  const h = entry?.header || entry;
  const id = String(h?.id || h?.sessionId || entry?.id || '').trim();
  if (!id) return null;
  const rawUpdated = h?.updatedAt ?? h?.lastActiveAt ?? h?.modifiedAt ?? h?.createdAt ?? 0;
  const updatedAt = typeof rawUpdated === 'number'
    ? rawUpdated
    : (typeof rawUpdated === 'string' && rawUpdated ? Date.parse(rawUpdated) || 0 : 0);
  return {
    id,
    title: String(h?.title || '').trim(),
    cwd: String(h?.cwd || '').trim(),
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
  };
}

function readProjCacheMeta(sessionId, home = dshHome()) {
  if (!sessionId || !home) return null;
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
  try {
    const stat = fs.statSync(file);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = parsed?.record?.rows || {};
    const rawTitle = String(rows?.title?.val || '').trim();
    const firstRaw = String(rows?.titleInput?.val?.first?.text || '').trim();
    const fallbackFirst = firstRaw
      && !/^【上一会话|^\[QQ |^<qq_reply_context>|^Current runtime context\./u.test(firstRaw)
      ? firstRaw.split(/\r?\n/, 1)[0].trim().slice(0, 40)
      : '';
    const title = rawTitle || fallbackFirst;
    const cwd = String(parsed?.record?.identity?.cwd || '').trim();
    const createdAt = Number(parsed?.record?.identity?.createdAt) || 0;
    const updatedAt = Math.max(Number(stat?.mtimeMs) || 0, createdAt);
    return { title, cwd, updatedAt };
  } catch {
    return null;
  }
}

export async function listHostSessions({ sessions, persistence, workspaceRegistry, projections, home = dshHome(), limit = 80 } = {}) {
  const archived = new Set(Array.isArray(workspaceRegistry?.archivedSessionIds) ? workspaceRegistry.archivedSessionIds : []);
  const map = new Map();
  const add = (item) => {
    const norm = normalizeHeader(item);
    if (!norm || archived.has(norm.id)) return;
    const prev = map.get(norm.id);
    if (!prev) {
      map.set(norm.id, norm);
    } else {
      map.set(norm.id, {
        id: norm.id,
        title: norm.title || prev.title,
        cwd: norm.cwd || prev.cwd,
        updatedAt: Math.max(norm.updatedAt, prev.updatedAt),
      });
    }
  };

  try {
    const live = await Promise.resolve(sessions?.list?.());
    if (Array.isArray(live)) live.forEach(add);
  } catch { /* optional */ }

  try {
    const persisted = await Promise.resolve(persistence?.list?.());
    if (Array.isArray(persisted)) persisted.forEach(add);
  } catch { /* optional */ }

  try {
    const headers = workspaceRegistry?.headers;
    if (headers && typeof headers.values === 'function') {
      for (const h of headers.values()) add(h);
    } else if (headers && typeof headers === 'object') {
      for (const h of Object.values(headers)) add(h);
    }
  } catch { /* optional */ }

  try {
    const workspaces = workspaceRegistry?.list?.();
    if (Array.isArray(workspaces)) {
      for (const ws of workspaces) {
        for (const sid of Array.isArray(ws?.sessionIds) ? ws.sessionIds : []) {
          add({ id: sid, cwd: ws?.path || '', updatedAt: 0 });
        }
      }
    }
  } catch { /* optional */ }

  // 补齐真实标题与更新时间：优先实时 projections，其次读 DSH 的 session_projcache
  for (const [sid, entry] of map.entries()) {
    let title = entry.title;
    let cwd = entry.cwd;
    let updatedAt = entry.updatedAt;
    if (!title && typeof projections?.snapshot === 'function' && typeof sessions?.get === 'function') {
      try {
        const live = sessions.get(sid);
        const projTitle = live ? String(projections.snapshot(live)?.values?.title || '').trim() : '';
        if (projTitle) title = projTitle;
      } catch { /* optional */ }
    }
    if (!title || !updatedAt || !cwd) {
      const cached = readProjCacheMeta(sid, home);
      if (cached) {
        if (!title && cached.title) title = cached.title;
        if (!cwd && cached.cwd) cwd = cached.cwd;
        if (cached.updatedAt > updatedAt) updatedAt = cached.updatedAt;
      }
    }
    if (title !== entry.title || cwd !== entry.cwd || updatedAt !== entry.updatedAt) {
      map.set(sid, { id: sid, title, cwd, updatedAt });
    }
  }

  return [...map.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, limit));
}

export async function dispatchToHostSession({ sessionId, wrapped, cfg, controller, sessions, timeoutMs = 15000 }) {
  const now = Date.now();
  if (typeof controller?.resolveAgent === 'function') {
    try {
      const resolved = await controller.resolveAgent(sessionId);
      const agent = resolved?.agent;
      if (agent && typeof agent.followup === 'function') {
        agent.followup({
          role: 'user',
          content: [{ type: 'text', text: wrapped }],
          timestamp: now,
          source: { kind: 'plugin', plugin: 'dsh-drop-by', proactive: true },
        });
        if (typeof sessions?.flush === 'function' && agent.session) {
          await sessions.flush(agent.session);
        }
        return { ok: true, via: 'followup' };
      }
    } catch { /* fallback to controller.prompt */ }
  }
  if (typeof controller?.prompt === 'function') {
    await controller.prompt({
      requestId: `dsh-drop-by:${randomUUID()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: wrapped }],
      clientTimeZone: cfg?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
    }, AbortSignal.timeout(timeoutMs));
    return { ok: true, via: 'prompt' };
  }
  return { ok: false, error: 'DSH 会话控制器尚未就绪，无法投递到内部会话' };
}

export async function sendInternalMessage({
  cfg = loadConfig(),
  sessionId = internalSessionId(),
  text,
  source = 'companion',
  dryRun = false,
  timeoutMs,
  canDispatch,
  dispatch = dispatcher,
} = {}) {
  const current = loadConfig();
  const activeCfg = cfg?.channels ? cfg : current;
  const sid = String(sessionId || internalSessionId()).trim();
  if (!internalPrimary(activeCfg) || !sid || activeCfg.channels?.internal?.enabled === false || activeCfg.channels?.internal?.send === false) {
    return { ok: false, error: '内部会话不是当前可发的主通道或尚未绑定会话' };
  }
  if (dryRun || activeCfg.dryRun !== false) return { ok: true, dryRun: true };
  if (activeCfg.send?.enabled !== true) return { ok: false, error: '发送总开关已关' };
  const cleanText = String(text || '').trim();
  if (!cleanText) return { ok: false, error: '消息内容为空' };
  if (typeof canDispatch === 'function' && !canDispatch(0)) {
    return { ok: false, reason: 'TOPIC_PREFERENCE_MUTED', parts: 0 };
  }
  if (typeof dispatch !== 'function') {
    return { ok: false, error: '内部会话发送需要在 DSH 宿主中运行' };
  }

  const firstAt = Date.now();
  const wrapped = wrapProactivePrompt(cleanText);
  try {
    const res = await dispatch({
      sessionId: sid,
      text: cleanText,
      wrapped,
      source,
      cfg: activeCfg,
      timeoutMs: Number(timeoutMs || activeCfg.send?.timeoutMs) || 15000,
    });
    if (!res?.ok) throw new Error(String(res?.error || '投递到内部会话失败').slice(0, 180));
    const at = Date.now();
    updateInternalState(sid, (s) => ({
      ...s,
      sessionId: sid,
      lastProactiveDispatchAt: at,
      outgoing: { peer: sid, firstAt, lastAt: at, count: 0, text: cleanText.slice(0, 300), source },
      dialogue: [...(s.dialogue || []), { who: 'me', text: cleanText.slice(0, 300), ts: at, source }].slice(-32),
    }));
    return { ok: true, firstAt, sentAt: at, messageId: 'internal:' + firstAt, parts: 1 };
  } catch (error) {
    return { ok: false, error: String(error?.message || error).slice(0, 180) };
  }
}
