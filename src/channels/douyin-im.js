import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { CONFIG_PATH, loadConfig } from '../config.js';
import { detectPlugin, douyinPluginPeer, dshHome } from '../detect.js';

export { douyinPluginPeer };

const exec = promisify(execFile);
export const channelFile = (name) => path.join(process.env.PG_CHAT_DATA_DIR || path.join(path.dirname(CONFIG_PATH), 'data'), name + '.json');

export function readChatData(name) {
  try { return JSON.parse(fs.readFileSync(channelFile(name), 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

export function writeChatData(name, data) {
  const file = channelFile(name);
  const temp = file + '.' + process.pid + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(temp, file);
}

export const douyinPeer = (cfg, opts = {}) => {
  const explicit = String(cfg?.channels?.douyin?.peerSecUid || '').trim();
  return explicit || douyinPluginPeer(opts.dshHome).secUid;
};

export const douyinPeerName = (cfg, opts = {}) => {
  const explicit = String(cfg?.channels?.douyin?.peerName || '').trim();
  return explicit || douyinPluginPeer(opts.dshHome).nick;
};
export const readDouyinState = (peer) => readChatData('douyin-im')[peer] || {};
export function updateDouyinState(peer, fn) {
  const data = readChatData('douyin-im');
  const state = fn(data[peer] || {});
  writeChatData('douyin-im', { ...data, [peer]: state });
  return state;
}

export function douyinPrimary(cfg) {
  return cfg.channels?.primary === 'douyin';
}

export function pollDelayMs(config, failures = 0) {
  // 抖音 IM 会检测请求模式，密集探测会返回 "too many requests"。
  const seconds = Math.max(10, Math.min(300, Number(config?.pollSec) || 30));
  return Math.min(300, seconds * 2 ** failures) * 1000;
}

export function collectIncoming(state, conversation, messages) {
  const counts = new Map();
  const window = messages.filter((m) => Date.parse(m.at) > 0).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const rows = window.map((m) => {
    const signature = JSON.stringify([m.at, m.from, m.kind, m.item, m.text]);
    const count = (counts.get(signature) || 0) + 1;
    counts.set(signature, count);
    return { ...m, id: signature + ':' + count, ts: Date.parse(m.at) };
  });
  const newestTs = rows.at(-1)?.ts || 0;
  if (conversation !== state.conversation) {
    const baselineDialogue = !state.sessionSyncedAt
      ? rows.filter((m) => m.text || m.item).slice(-8).map((m) => ({
          who: m.from === 'them' ? 'her' : 'me',
          text: m.item ? `${m.text || '视频卡片'}（卡片 ID ${m.item}）` : m.text,
          ts: m.ts,
          source: 'history',
        }))
      : (state.baselineDialogue || []);
    return { ...state, conversation, seen: rows.map(m => m.id), newestTs, pending: state.pending || [], baselineDialogue, gap: false };
  }
  const seen = new Set(state.seen || []);
  const gap = rows.length > 0 && seen.size > 0 && !rows.some(m => seen.has(m.id)) && newestTs > (state.newestTs || 0);
  const fresh = rows.filter(m => !seen.has(m.id) && m.ts >= (state.newestTs || 0) && m.from === 'them');
  return {
    ...state, pending: [...(state.pending || []), ...fresh], seen: rows.length ? rows.map(m => m.id) : [...seen],
    newestTs: Math.max(state.newestTs || 0, newestTs), gap: state.gap || gap,
  };
}

function parseScriptJson(stdout) {
  const lines = String(stdout || '').trimEnd().split(/\r?\n/u);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines.slice(i).join('\n')); } catch { /* status line before JSON */ }
  }
  return null;
}

export function douyinInstallation(home = dshHome()) {
  const desktop = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-douyin-scroll');
  const plugin = fs.existsSync(path.join(desktop, 'package.json'))
    ? { dir: desktop } : detectPlugin('dsh-douyin-scroll', { dshHome: home });
  const read = plugin.dir && path.join(plugin.dir, 'tools', 'im-http.py');
  const send = plugin.dir && path.join(plugin.dir, 'tools', 'im-send.mjs');
  const data = path.join(home, 'douyin-duty');
  return { ...plugin, read, send, data, ready: !!(read && send && fs.existsSync(read) && fs.existsSync(send)) };
}

function pythonFor(home) {
  const venv = path.join(home, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (fs.existsSync(venv)) return venv;
  const config = path.join(home, 'config.json');
  return (fs.existsSync(config) && JSON.parse(fs.readFileSync(config, 'utf8')).pythonPath) || 'python';
}

async function run(exe, args, home, timeoutSec, signal) {
  let output;
  try {
    output = await exec(exe, args, {
      timeout: timeoutSec * 1000, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, DOUYIN_HOME: home, PYTHONIOENCODING: 'utf-8', ELECTRON_RUN_AS_NODE: '1' },
    });
  } catch (error) {
    output = error;
  }
  const body = parseScriptJson(output.stdout);
  if (body) return body;
  throw new Error(output.killed ? '抖音脚本执行超时' : '抖音脚本没有返回可解析的结果 (' + (output.code || 'unknown') + ')');
}

export function originalWatcherDisabled(home = dshHome()) {
  const dir = path.join(home, 'douyin-duty');
  const readOptional = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      throw error;
    }
  };
  const config = readOptional(path.join(dir, 'config.json'), { chatWatch: false });
  const intent = readOptional(path.join(dir, 'chat-watch-intent.json'), { wantOn: false });
  return config.chatWatch === false && intent.wantOn === false;
}

export async function readDouyinIm(cfg, signal) {
  const scripts = douyinInstallation();
  if (!scripts.ready) throw new Error('缺少 dsh-douyin-scroll 的私信脚本');
  const peer = douyinPeer(cfg);
  const result = await run(pythonFor(scripts.data),
    [scripts.read, '--read', '--peer-sec-uid', peer, '--limit', '60', '--include-nontext'],
    scripts.data, Number(cfg.channels.douyin.readTimeoutSec) || 30, signal);
  if (!result.ok) throw new Error(String(result.status === 'too many requests' ? result.status : result.error || '读取失败').slice(0, 180));
  if (result.matched?.sec_uid !== peer || !result.matched?.conv_id || !Array.isArray(result.matched?.messages)) {
    throw new Error('抖音未找到身份匹配的私聊，请确认 sec_uid 和已建立会话');
  }
  return result.matched;
}

let sends = Promise.resolve();

export function sendDouyinText({ cfg, peer = douyinPeer(cfg), text, source = 'companion', expectedRequestId, getConfig = loadConfig, canDispatch }) {
  const job = sends.then(async () => {
    const current = getConfig();
    if (!douyinPrimary(current) || douyinPeer(current) !== peer || current.enabled === false ||
        !readChatData('external-chat').sessionId || !peer || current.channels.douyin.send === false) {
      return { ok: false, error: '抖音不是当前可发的主通道' };
    }
    if (current.dryRun !== false) return { ok: true, dryRun: true };
    if (current.send?.enabled !== true) return { ok: false, error: '发送总开关已关' };
    if (!originalWatcherDisabled()) return { ok: false, error: '请关闭抖音原聊天盯梢' };
    const scripts = douyinInstallation();
    if (!scripts.ready) return { ok: false, error: '缺少 dsh-douyin-scroll 的私信脚本' };
    if (canDispatch && !canDispatch(0)) return { ok: false, reason: 'TOPIC_PREFERENCE_MUTED', parts: 0 };
    const firstAt = Date.now();
    try {
      const result = await run(process.execPath,
        [scripts.send, '--to', douyinPeerName(current) || '', '--to-id', peer, '--text', text],
        scripts.data, Number(current.channels.douyin.sendTimeoutSec) || 240);
      if (!result.ok || result.sent !== true || result.to_sec_uid !== peer) {
        throw new Error(String(result.error || '发送回执未确认').slice(0, 180));
      }
      const at = Date.now();
      updateDouyinState(peer, (s) => ({
        ...s,
        outgoing: { firstAt, lastAt: at, text, source, count: 1, requestId: expectedRequestId },
        ...(source === 'reply' ? { sessionSyncedAt: Math.max(Number(s.sessionSyncedAt) || 0, at) } : {}),
        dialogue: [...(s.dialogue || []), { who: 'me', text, ts: at, source }].slice(-32),
      }));
      return { ok: true, firstAt, sentAt: at, messageId: 'douyin:' + firstAt, parts: 1 };
    } catch (error) {
      updateDouyinState(peer, (s) => ({ ...s, sendError: error.message }));
      return { ok: false, error: error.message };
    }
  });
  sends = job.catch(() => {});
  return job;
}

export const drainDouyinSends = () => sends;

export function unsyncedDouyinContext(peer, { limit = 8 } = {}) {
  const state = readDouyinState(peer);
  const syncedAt = Number(state.sessionSyncedAt) || 0;
  const items = [];
  if (!syncedAt && Array.isArray(state.baselineDialogue)) {
    for (const m of state.baselineDialogue) {
      if (Number(m?.ts) > 0 && m?.text) items.push(m);
    }
  }
  for (const m of state.dialogue || []) {
    const ts = Number(m?.ts) || 0;
    if (!ts || ts <= syncedAt || m.who !== 'me' || !m.text) continue;
    if (m.source === 'reply') continue;
    if (m.source == null && state.outgoing?.source === 'reply' && ts === state.outgoing?.lastAt) continue;
    items.push(m);
  }
  if (!items.length) return { block: '', maxTs: 0 };
  const deduped = [];
  const seen = new Set();
  for (const m of items.sort((a, b) => a.ts - b.ts)) {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = `${m.who}|${m.ts}|${text.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ ...m, text });
  }
  const picked = deduped.slice(-Math.max(1, limit));
  if (!picked.length) return { block: '', maxTs: 0 };
  const maxTs = picked.at(-1).ts;
  const block = [
    '<external_reply_context>',
    '【近期未同步到本会话的抖音对话（仅作前情参考，不要念出或复述标记）】',
    ...picked.map((m) => `${m.who === 'me' ? '我' : 'TA'}：${m.text}`),
    '</external_reply_context>',
  ].join('\n');
  return { block, maxTs };
}

export function markDouyinSessionSynced(peer, ts) {
  const n = Number(ts) || 0;
  if (!peer) return;
  updateDouyinState(peer, (s) => ({
    ...s,
    sessionSyncedAt: Math.max(Number(s.sessionSyncedAt) || 0, n),
    baselineDialogue: [],
  }));
}
