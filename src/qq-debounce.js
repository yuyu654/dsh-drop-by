import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, readBridgeDialogue } from './outbound.js';

const PREFIX = '[dsh-drop-by QQ merge ';
const peerBatches = new Map();
const slots = new Map();
const installed = new WeakMap();
const recent = new Map();
let controllerCount = 0;

export function qqMergeAvailable(peer) {
  if (!controllerCount) return false;
  // The bridge invokes this hook once per binding, but has not passed sessionId yet.
  // Preserve independent delivery for a peer intentionally bound to multiple sessions.
  try {
    const bindings = JSON.parse(fs.readFileSync(path.join(dshHome(), 'qq-bridge', 'bindings.json'), 'utf8'));
    return Object.values(bindings.sessions || {}).filter((item) =>
      item.enabled !== false && item.peerKind === 'private' && String(item.peerId) === String(peer)).length <= 1;
  } catch {
    return true;
  }
}

export function isBridgeManagedMessage(peer, at, now, maxMs, mergedOnly = false) {
  const entry = recent.get(String(peer))?.get(at);
  return !!entry && now - entry.receivedAt < maxMs && (!mergedOnly || entry.merged);
}

export function fullQqIncomingText(incoming) {
  const entry = recent.get(String(incoming?.peer))?.get(incoming?.ts);
  return entry?.observedAt && entry.observedAt === incoming.observedAt &&
    entry.text.slice(0, 80).trim() === incoming.text ? entry.text : '';
}

function marker(entry) {
  const id = randomUUID();
  slots.set(id, entry);
  return PREFIX + id + ']';
}

/** Wake the previous hook immediately; only the final hook gets to build context. */
export function waitForQqBurst({ peer, text, at, debounceMs }) {
  const key = String(peer);
  const batch = peerBatches.get(key) || { entries: [] };
  peerBatches.set(key, batch);
  const last = batch.entries.at(-1);
  if (last) {
    clearTimeout(batch.timer);
    last.release({ superseded: true, marker: marker({ batch, entry: last, superseded: true }) });
  }
  return new Promise((release) => {
    let receive;
    const parts = new Promise((resolve) => { receive = resolve; });
    const entries = recent.get(key) || new Map();
    recent.set(key, entries);
    text = String(text || '');
    const latest = readBridgeDialogue().incoming;
    const observedAt = latest.peer === key && latest.ts === at && latest.text === text.slice(0, 80).trim()
      ? latest.observedAt : 0;
    const managed = { receivedAt: Date.now(), merged: false, text, observedAt };
    entries.delete(at);
    entries.set(at, managed);
    if (entries.size > 64) entries.delete(entries.keys().next().value);
    const entry = { text, at, managed, release, receive, parts };
    batch.entries.push(entry);
    batch.timer = setTimeout(() => {
      peerBatches.delete(key);
      if (batch.entries.length > 1) entry.managed.merged = true;
      release({
        superseded: false,
        messages: batch.entries.map(({ text, at }) => ({ text, at })),
        finish: (context, timezone) => marker({ batch, entry, context, timezone }),
      });
    }, debounceMs);
  });
}

function unpackText(value) {
  const text = String(value || '').replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  if (split < 0 || !/^\[QQ (?:私聊|群聊)\] /u.test(text) ||
      !text.slice(0, split).includes('\n以下内容来自外部即时通讯工具')) return { header: '', body: text };
  return { header: text.slice(0, split), body: text.slice(split + 2) };
}

function withAbort(work, signal) {
  if (!signal) return work;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Only process one-time markers produced by the companion's actual bridge hook. */
export function installQqPromptMerge(controller, aroundPrompt) {
  if (typeof controller?.prompt !== 'function') return () => {};
  const prior = installed.get(controller);
  const install = (entry) => {
    const handle = { aroundPrompt };
    entry.handles.add(handle);
    return () => {
      if (!entry.handles.delete(handle) || entry.handles.size) return;
      if (controller.prompt === entry.wrapped) controller.prompt = entry.original;
      installed.delete(controller);
      controllerCount--;
    };
  };
  if (prior) return install(prior);
  const original = controller.prompt;
  const handles = new Set();
  async function prompt(...args) {
    const [payload, signal] = args;
    const dispatch = (nextPayload) => {
      const next = (value) => { args[0] = value; return original.apply(this, args); };
      const handler = [...handles].find((entry) => entry.aroundPrompt)?.aroundPrompt;
      return handler ? handler(nextPayload, signal, next) : next(nextPayload);
    };
    const text = payload?.content?.[0]?.text;
    if (typeof text !== 'string' || !text.startsWith(PREFIX)) {
      return dispatch(payload);
    }
    const end = text.indexOf('\n\n');
    const tag = end < 0 ? '' : text.slice(0, end);
    const id = tag.endsWith(']') ? tag.slice(PREFIX.length, -1) : '';
    const slot = slots.get(id);
    if (!slot) return dispatch(payload);
    slots.delete(id);
    const { entry, batch, context, superseded, timezone } = slot;
    const content = payload.content;
    const body = text.slice(end + 2);
    entry.receive({ ...unpackText(body), attachments: content.slice(1), sessionId: payload.sessionId });
    if (superseded) throw new Error('MERGED_INTO_NEWER_QQ_MESSAGE');

    let mergedBody = body;
    let attachments = content.slice(1);
    if (batch.entries.length > 1) {
      const parts = await withAbort(Promise.all(batch.entries.map((item) => item.parts)), signal);
      const indexes = batch.entries.map((_, i) => i).sort((a, b) => batch.entries[a].at - batch.entries[b].at);
      const stamp = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, timeStyle: 'medium' });
      const lines = indexes.map((i) => '[' + stamp.format(batch.entries[i].at) + '] ' + parts[i].body);
      const header = unpackText(body).header;
      mergedBody = [header, lines.join('\n')].filter(Boolean).join('\n\n');
      attachments = indexes.flatMap((i) => parts[i].sessionId === payload.sessionId ? parts[i].attachments : []);
    }
    const merged = [context, mergedBody].filter(Boolean).join('\n\n');
    return dispatch({ ...payload, content: [{ ...content[0], text: merged }, ...attachments] });
  }
  const installation = { original, wrapped: prompt, handles };
  controller.prompt = prompt;
  installed.set(controller, installation);
  controllerCount++;
  return install(installation);
}
