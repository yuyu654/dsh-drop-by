// channels/douyin.js —— 抖音私信信号。
//
// 前置条件：本机装了 dsh-douyin-scroll，并且它的「聊天盯梢」是开着的，
// 否则读到的是旧数据（她三小时前说过话，会被误当成刚说）。
//
// 关闭 channels.douyin.enabled 时，本模块压根不会被调用（索引层直接跳过）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const DSH = path.join(HOME, '.dsh');
const DATA_DIR = path.join(DSH, 'douyin-duty');
const PLUGIN = 'dsh-douyin-scroll';

let pluginCache = null; // { at, value }

/**
 * 插件是否装了：扫所有 profile 的 node_modules，比对 package.json 的 name。
 * 只读文件，不执行它的 CLI（那会启动无头浏览器，代价远大于收益）。
 * 结果缓存 10 分钟，按 package.json 的 mtime 失效。
 */
export function detectPlugin() {
  const now = Date.now();
  if (pluginCache && now - pluginCache.at < 10 * 60_000) return pluginCache.value;

  const hits = [];
  const tryDir = (dir) => {
    const pkg = path.join(dir, 'package.json');
    try {
      const j = JSON.parse(fs.readFileSync(pkg, 'utf8'));
      if (j.name !== PLUGIN) return;
      hits.push({
        version: j.version || '0.0.0',
        dir,
        mtime: fs.statSync(pkg).mtimeMs,
      });
    } catch {}
  };

  const profiles = path.join(DSH, 'profiles');
  try {
    for (const prof of fs.readdirSync(profiles)) {
      tryDir(path.join(profiles, prof, 'node_modules', PLUGIN));
    }
  } catch {}
  tryDir(path.join(DSH, 'node_modules', PLUGIN));
  if (process.env.APPDATA) {
    tryDir(path.join(process.env.APPDATA, 'npm', 'node_modules', PLUGIN));
  }

  const value = hits.length
    ? { installed: true, version: hits[0].version, dir: hits[0].dir, found: hits }
    : { installed: false, version: '', dir: '', found: [] };

  pluginCache = { at: now, value };
  return value;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** lastCheckAt 有的版本是毫秒、有的是秒，按量级归一。 */
function toMs(v) {
  const n = Number(v) || 0;
  if (!n) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/** 从 dm-<sec_uid>.json 里取她最后说话 / 我们最后发消息的时间。 */
function readDmMemory() {
  const dir = path.join(DATA_DIR, 'memory');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('dm-') && f.endsWith('.json'));
  } catch {
    return { lastUserTs: null, lastSendTs: null, peers: 0, note: 'memory 目录不存在' };
  }

  let lastUserTs = null;
  let lastSendTs = null;
  for (const f of files) {
    const j = readJson(path.join(dir, f), null);
    const msgs = Array.isArray(j?.messages) ? j.messages : [];
    for (const m of msgs) {
      const ts = Date.parse(m?.at || '');
      if (!Number.isFinite(ts)) continue;
      if (m?.from === 'them' && (!lastUserTs || ts > lastUserTs)) lastUserTs = ts;
      if (m?.from === 'me' && (!lastSendTs || ts > lastSendTs)) lastSendTs = ts;
    }
  }
  return { lastUserTs, lastSendTs, peers: files.length, note: '' };
}

/**
 * 读抖音通道。返回统一结构：
 *   { channel:'douyin', ok, reason?, lastUserTs, lastSendTs, plugin, state }
 * ok=false 时 reason 就是降级原因，调用方据此决定「跳过这一项」而不是「整轮失败」。
 */
export function readDouyin(now, staleMin) {
  const state = path.join(DATA_DIR, 'chat-watch-state.json');
  if (!fs.existsSync(DATA_DIR)) {
    return { channel: 'douyin', ok: false, reason: 'DOUYIN_NO_DATA', lastUserTs: null, lastSendTs: null };
  }

  const st = readJson(state, null);
  if (!st) {
    return { channel: 'douyin', ok: false, reason: 'DOUYIN_NO_DATA', lastUserTs: null, lastSendTs: null };
  }

  const plugin = detectPlugin();
  if (!plugin.installed) {
    return {
      channel: 'douyin',
      ok: false,
      reason: 'DOUYIN_PLUGIN_MISSING',
      lastUserTs: null,
      lastSendTs: null,
      plugin,
    };
  }

  if (st.on !== true) {
    return {
      channel: 'douyin',
      ok: false,
      reason: 'DOUYIN_NOT_LISTENING',
      note: '盯梢关着',
      lastUserTs: null,
      lastSendTs: null,
      plugin,
    };
  }

  const lastCheck = toMs(st.lastCheckAt);
  const staleMs = Math.max(1, Number(staleMin) || 10) * 60_000;
  if (!lastCheck || now - lastCheck > staleMs) {
    return {
      channel: 'douyin',
      ok: false,
      reason: 'DOUYIN_NOT_LISTENING',
      note: lastCheck ? `状态已 ${Math.round((now - lastCheck) / 60000)} 分钟没更新` : '没有 lastCheckAt',
      lastUserTs: null,
      lastSendTs: null,
      plugin,
    };
  }

  const dm = readDmMemory();
  return {
    channel: 'douyin',
    ok: true,
    lastUserTs: dm.lastUserTs,
    lastSendTs: dm.lastSendTs,
    peers: dm.peers,
    plugin,
    state: { on: true, lastResult: st.lastResult, lastCheckAt: lastCheck, sec: st.sec },
  };
}
