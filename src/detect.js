// detect.js —— 「这条链路到底装没装」。只读文件：不启动插件、不开浏览器、不联网。
//
// 为什么要这一层：三条链路各有各的身外条件——
//   · QQ 要 dsh-plugin-qq-bridge 装在那个 profile 里，还要它已经配对过（qq-bridge/connection.json）
//   · 抖音要 dsh-douyin-scroll，还要它的聊天盯梢真的开着
//   · 手机端不是插件：手机 App 发 FISH 邮件 → 本机 IMAP 取回 → 解析。条件是有邮箱账号 + 授权码
// 条件不满足时，插件不该装作读到了，更不该拿旧数据当新数据。这里只负责「说实话」，
// 具体降级由调用方（channels / topics / settings）决定。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './config.js';
import { SECRETS_PATH, loadSecrets } from './fishmail.js';

/** DSH 家目录；测试用 PG_DSH_HOME 顶掉，别去扫真实的 ~/.dsh。 */
export function dshHome(env = process.env) {
  const custom = String(env.PG_DSH_HOME || '').trim();
  if (custom) return path.resolve(custom);
  return path.join(os.homedir(), '.dsh');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

const cache = new Map(); // name -> { at, value }，按 package.json 的 mtime 失效

/**
 * 插件装了没有：扫所有 profile 的 node_modules、DSH 根 node_modules、npm 全局。
 * 只读 package.json，不执行任何东西。
 * 返回 { installed, version, dir, found:[{version,dir,mtime}] }。
 */
export function detectPlugin(name, opts = {}) {
  const home = opts.dshHome || dshHome(opts.env || process.env);
  const hits = [];

  const tryDir = (dir) => {
    const pkg = path.join(dir, 'package.json');
    let mtime = 0;
    try {
      mtime = fs.statSync(pkg).mtimeMs;
    } catch {
      return;
    }
    const hit = cache.get(pkg);
    let j = null;
    if (hit && hit.mtime === mtime) j = hit.value;
    if (!j) {
      j = readJson(pkg);
      if (j) cache.set(pkg, { mtime, value: j });
    }
    if (!j || j.name !== name) return;
    hits.push({ version: j.version || '0.0.0', dir, mtime });
  };

  const profiles = path.join(home, 'profiles');
  try {
    for (const prof of fs.readdirSync(profiles)) {
      tryDir(path.join(profiles, prof, 'node_modules', name));
    }
  } catch {
    /* 没 profiles 就是没装 */
  }
  tryDir(path.join(home, 'node_modules', name));
  if (opts.env?.APPDATA || process.env.APPDATA) {
    const appdata = opts.env?.APPDATA || process.env.APPDATA;
    tryDir(path.join(appdata, 'npm', 'node_modules', name));
  }

  hits.sort((a, b) => b.mtime - a.mtime); // 最近改过的优先当「主安装」
  return hits.length
    ? { installed: true, version: hits[0].version, dir: hits[0].dir, found: hits }
    : { installed: false, version: '', dir: '', found: [] };
}

/** QQ：插件在不在 + 有没有配对过（配对过才有 connection.json，才能发）。 */
export function detectQq(opts = {}) {
  const home = opts.dshHome || dshHome(opts.env || process.env);
  const plugin = detectPlugin('dsh-plugin-qq-bridge', { ...opts, dshHome: home });
  const connPath = path.join(home, 'qq-bridge', 'connection.json');
  const conn = readJson(connPath);
  const paired = Boolean(conn);
  const note = !plugin.installed
    ? '没装 dsh-plugin-qq-bridge'
    : !paired
      ? '插件在，但还没配对（没有 qq-bridge/connection.json）'
      : '已装、已配对';
  return {
    plugin: 'dsh-plugin-qq-bridge',
    installed: plugin.installed,
    version: plugin.version,
    paired,
    ready: plugin.installed && paired,
    note,
  };
}

/** 抖音：插件在不在 + 聊天盯梢是否真开着（state.on）。 */
export function detectDouyin(opts = {}) {
  const home = opts.dshHome || dshHome(opts.env || process.env);
  const plugin = detectPlugin('dsh-douyin-scroll', { ...opts, dshHome: home });
  const statePath = path.join(home, 'douyin-duty', 'chat-watch-state.json');
  const st = readJson(statePath);
  const listening = st?.on === true;
  const note = !plugin.installed
    ? '没装 dsh-douyin-scroll'
    : !st
      ? '插件在，聊天盯梢没跑过'
      : listening
        ? '已装，盯梢开着'
        : '已装，但盯梢关着';
  return {
    plugin: 'dsh-douyin-scroll',
    installed: plugin.installed,
    version: plugin.version,
    listening,
    ready: plugin.installed && listening,
    note,
  };
}

/**
 * 手机端：不是插件。条件是「有账号 + 有授权码」，能跑起来看「最近一封什么时候」。
 * 返回 ready 只代表配置齐了，不代表数据新——数据新旧另看 ageMin。
 */
export function detectPhone(cfg, opts = {}) {
  const home = opts.dshHome || dshHome(opts.env || process.env);
  const mail = cfg?.mail || {};
  const secretsPath = opts.secretsPath || SECRETS_PATH;
  const authCode = loadSecrets(secretsPath).authCode || '';
  const user = String(mail.user || '');
  const enabled = mail.enabled === true;
  const hasAuth = Boolean(String(authCode || '').trim());
  const ready = enabled && Boolean(user) && hasAuth;

  let ageMin = null;
  let fetchAgeMin = null;
  // 数据文件在本插件自己的 data/ 下（ROOT 可用 PG_CONFIG_PATH 那套顶掉场景另行传入 root）。
  const dataRoot = opts.root ? path.resolve(opts.root) : ROOT;
  const latest = readJson(path.join(dataRoot, 'data', 'fish-latest.json'));
  const toMs = (raw) =>
    typeof raw === 'number' ? (raw < 1e12 ? raw * 1000 : raw) : Date.parse(String(raw || ''));
  // 邮件年龄按邮件自身日期（dateTs）算，与自检口径一致；旧版无 dateTs 时退回 fetchedAt / at。
  const dataTs = toMs(latest?.dateTs ?? latest?.fetchedAt ?? latest?.at);
  if (Number.isFinite(dataTs) && dataTs > 0) ageMin = Math.max(0, Math.round((Date.now() - dataTs) / 60000));
  const fetchedTs = toMs(latest?.fetchedAt);
  if (Number.isFinite(fetchedTs) && fetchedTs > 0) fetchAgeMin = Math.max(0, Math.round((Date.now() - fetchedTs) / 60000));

  const formatAge = (min) => (min >= 180 ? `${Math.round(min / 60)} 小时前` : `${min} 分钟前`);
  const ageText = ageMin == null
    ? ''
    : `，最近一封 ${formatAge(ageMin)}${fetchAgeMin != null && Math.abs(ageMin - fetchAgeMin) >= 15 ? `（${formatAge(fetchAgeMin)}检查过邮箱）` : ''}`;
  const note = !enabled
    ? '邮箱没开'
    : !user
      ? '没填邮箱账号'
      : !hasAuth
        ? '没填 IMAP 授权码'
        : `配置齐了${ageText}`;
  return { kind: 'mail', enabled, ready, user: user ? user.replace(/^([^@]{1,2})[^@]*(@.*)$/, '$1***$2') : '', ageMin, fetchAgeMin, note };
}

/** 情绪插件：emotion-state-portrait 在不在，入口 qq-emotion.mjs 能不能找到。 */
export function detectEmotionPortrait(opts = {}) {
  const home = opts.dshHome || dshHome(opts.env || process.env);
  const plugin = detectPlugin('emotion-state-portrait', { ...opts, dshHome: home });
  const entry = plugin.installed && exists(path.join(plugin.dir, 'qq-emotion.mjs'));
  const note = !plugin.installed
    ? '没装 emotion-state-portrait'
    : !entry
      ? '插件在，但缺 qq-emotion.mjs'
      : '已装 emotion-state-portrait';
  return {
    plugin: 'emotion-state-portrait',
    installed: plugin.installed,
    version: plugin.version,
    entry,
    ready: plugin.installed && entry,
    note,
  };
}

export function douyinPluginPeer(home = dshHome()) {
  const cfg = readJson(path.join(home, 'douyin-duty', 'config.json'));
  const peers = Array.isArray(cfg?.dmPeers) ? cfg.dmPeers : [];
  const firstWithId = peers.find((p) => String(p?.sec_uid || '').trim());
  const secUid = String(cfg?.dmToId || firstWithId?.sec_uid || '').trim();
  const matched = secUid ? peers.find((p) => String(p?.sec_uid || '').trim() === secUid) : null;
  const nick = String((secUid && cfg?.dmToId === secUid ? cfg?.dmTo : '') || matched?.nick || cfg?.dmTo || firstWithId?.nick || '').trim();
  return { secUid, nick };
}

function detectDouyinTakeover(cfg, opts) {
  const home = opts.dshHome || dshHome(opts.env);
  const detected = detectPlugin('dsh-douyin-scroll', opts);
  const desktop = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-douyin-scroll');
  const plugin = detected.found.find(p => p.dir === desktop) || detected;
  const scripts = ['im-http.py', 'im-send.mjs'].every(name => plugin.dir && exists(path.join(plugin.dir, 'tools', name)));
  const peer = !!(String(cfg.channels.douyin?.peerSecUid || '').trim() || douyinPluginPeer(home).secUid);
  return { installed: detected.installed, version: plugin.version, ready: scripts && peer,
    note: !detected.installed ? '缺少 dsh-douyin-scroll' : !scripts ? '插件缺少私信脚本'
      : !peer ? '请配置私信对象 sec_uid' : '私信脚本已就绪，由陪伴接管' };
}

/** 三条链路一次问清。设置页、状态接口、tick 的降级都用这一份。 */
export function detectSources(cfg, opts = {}) {
  const primary = cfg?.channels?.primary;
  const off = { installed: false, ready: false, note: '当前未选为主聊天接口' };
  const qq = primary === 'douyin' ? off : detectQq(opts);
  const douyin = primary === 'qq' ? off : primary === 'douyin'
    ? detectDouyinTakeover(cfg, opts) : detectDouyin(opts);
  const phone = detectPhone(cfg, opts);
  return { qq, douyin, phone };
}