// outbound.js —— 「我最后一次开口是什么时候」，按通道分别查一遍落盘记录。
//
// 为什么需要它：decide 里判「她说了话、我还没回」用的是这一拍**开头**读到的快照。
// 从读到真正开口之间隔着几秒到几分钟，这期间 autonomy/抖音值班可能已经回过了
// （driver 是「生成 → sendQQ → 写 qq-history」，history 写失败也只是静默 catch）。
// 于是同一句话会被回两遍。这里在生成之前、发送之前各核一次最新落盘记录，
// 只要发现「出站时间已经晚于她那条消息」，就直接放弃这一拍。
//
// 只读文件，不联网，不发任何东西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** DSH 家目录；测试用 PG_DSH_HOME 顶掉，别去读真实的 ~/.dsh。 */
export function dshHome(env = process.env) {
  // PG_DSH_HOME 是测试/换家目录用的；DSH_HOME 是宿主自己那个（qq-bridge 按它写 last-out.json）。
  const custom = String(env.PG_DSH_HOME || env.DSH_HOME || '').trim();
  if (custom) return custom;
  return path.join(os.homedir(), '.dsh');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * QQ 桥（qq-bridge）最后一次出站。
 * 桥自己会写 `<home>/qq-bridge/last-out.json`：
 *   { peer, firstAt(ms), lastAt(ms, 0 = 正在发), count, text }
 * 之前这个洞很大：driver 的 qqReply 关着，qq-history 永远是空的，
 * 桥在 QQ 上回过什么本插件完全看不见——于是它刚回完，插件十秒后又补一句。
 * 多段发送中途（firstAt 有、lastAt 还是 0）也算「已经在应了」。
 */
export function bridgeLastOut({ env = process.env, dsh = null } = {}) {
  const home = dsh || dshHome(env);
  const j = readJson(path.join(home, 'qq-bridge', 'last-out.json'));
  const firstAt = Number(j?.firstAt) || 0;
  const lastAt = Number(j?.lastAt) || 0;
  const count = Number(j?.count) || 0;
  if (!firstAt) return { ts: 0, firstAt: 0, lastAt: 0, count: 0, text: '', channel: 'qq', src: '' };
  return {
    ts: lastAt || firstAt,
    firstAt,
    lastAt,
    count,
    text: String(j?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    channel: 'qq',
    src: 'qq-bridge',
  };
}

/** 桥正在发（第一段还没发出去，或者正发到一半）。超过 3 分钟还挂着就是桥那边崩了，当没在发。 */
export function bridgeInFlight({ now = Date.now(), maxMs = 180_000, ...opts } = {}) {
  const b = bridgeLastOut(opts);
  if (!b.firstAt || b.lastAt) return null;
  if (now - b.firstAt > maxMs) return null;
  return b;
}

/**
 * 她最后一条 QQ 消息（桥写 `<home>/qq-bridge/last-in.json`：{ peer, peerKind, at, text }）。
 * 补的是另一个洞：`autonomy/qq-history.json` 一直是空的（driver 的 qqReply 关着），
 * 插件根本看不到她在 QQ 上说过话——2026-11-10 她明明在 QQ 回过了，插件以为
 * 「158 分钟没动静」，追着问了一句「那条」。读不到就是 ts:0，不猜。
 */
export function bridgeLastIn({ env = process.env, dsh = null } = {}) {
  const home = dsh || dshHome(env);
  const j = readJson(path.join(home, 'qq-bridge', 'last-in.json'));
  const ts = Number(j?.at) || 0;
  if (!ts) return { ts: 0, text: '', peer: '', channel: 'qq', src: '' };
  return {
    ts,
    text: String(j?.text || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    peer: String(j?.peer || ''),
    channel: 'qq',
    src: 'qq-bridge',
  };
}

/**
 * QQ 侧最后一次出站。
 * 三个来源取较晚的那个：
 *   · autonomy/qq-history.json 的 turns[].at（driver 发完立刻写，正常路径）
 *   · douyin-duty/qq-reply.out.txt 的 mtime（模型写出回复原文的时刻，
 *     比 history 早一步——history 写失败时只剩它能证明「确实回过了」）
 *   · qq-bridge/last-out.json（桥自己发的每一轮；driver 关掉时这是唯一的来源）
 */
export function qqLastOutbound({ env = process.env, dsh = null } = {}) {
  const home = dsh || dshHome(env);
  let ts = 0;
  let src = '';
  const hist = readJson(path.join(home, 'autonomy', 'qq-history.json'));
  const turns = Array.isArray(hist?.turns) ? hist.turns : [];
  for (const t of turns) {
    const at = Number(t?.at) || 0;
    if (at > ts && t?.reply) {
      ts = at;
      src = 'qq-history';
    }
  }
  const outAt = mtimeOf(path.join(home, 'douyin-duty', 'qq-reply.out.txt'));
  if (outAt > ts) {
    ts = outAt;
    src = 'qq-out';
  }
  const br = bridgeLastOut({ env, dsh });
  if (br.ts > ts) {
    ts = br.ts;
    src = 'qq-bridge';
  }
  return { ts, channel: 'qq', src };
}

/**
 * 抖音侧最后一次出站：dm 记忆里 from === 'me' 的最新一条。
 * 抖音通道关着的时候这些文件是陈的（没人盯梢更新），不能拿来当证据。
 */
export function douyinLastOutbound({ env = process.env, dsh = null, cfg = {} } = {}) {
  if (cfg?.channels?.douyin?.enabled === false) return { ts: 0, channel: 'douyin', src: '' };
  const home = dsh || dshHome(env);
  const dir = path.join(home, 'douyin-duty', 'memory');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('dm-') && f.endsWith('.json'));
  } catch {
    return { ts: 0, channel: 'douyin', src: '' };
  }
  // 时间之外还要带上「最后一条是什么」：分享视频的话，追问时得说得出标题，
  // 不然写出来就是「那条视频」——她不知道是哪条（2026-11-07）。
  const last = dmMemoryLast(dir, files, 'me');
  return { ts: last.ts, text: last.text, item: last.item, kind: last.kind, channel: 'douyin', src: last.ts ? 'dm-memory' : '' };
}

/**
 * 抖音侧她最后一次说话（同一个 dm 记忆，from === 'them'）。
 * 为什么单独要这一个：QQ 那边她最后一句可能很早，「抖音分享有没有被接住」必须拿抖音自己的时间线判，
 * 不然她在抖音回过、却被 QQ 的旧时间戳当成没回（2026-11-07 她收到的那句追问就是这么来的）。
 */
export function douyinLastInbound({ env = process.env, dsh = null, cfg = {} } = {}) {
  if (cfg?.channels?.douyin?.enabled === false) return { ts: 0, channel: 'douyin', src: '' };
  const home = dsh || dshHome(env);
  const dir = path.join(home, 'douyin-duty', 'memory');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('dm-') && f.endsWith('.json'));
  } catch {
    return { ts: 0, channel: 'douyin', src: '' };
  }
  const ts = dmMemoryLastTs(dir, files, 'them');
  return { ts, channel: 'douyin', src: ts ? 'dm-memory' : '' };
}

/** dm 记忆里 `from` 这一方最新的一条消息（时间 + 文本 + 卡片的 item） */
function dmMemoryLast(dir, files, from) {
  let best = { ts: 0, text: '', item: null, kind: null };
  for (const f of files) {
    const j = readJson(path.join(dir, f));
    for (const m of Array.isArray(j?.messages) ? j.messages : []) {
      if (m?.from !== from) continue;
      const at = Date.parse(m?.at || '');
      if (Number.isFinite(at) && at > best.ts) {
        best = {
          ts: at,
          text: String(m?.text || '').replace(/\s+/g, ' ').trim().slice(0, 120),
          item: m?.item ? String(m.item) : null,
          kind: m?.kind || null,
        };
      }
    }
  }
  return best;
}

/** dm 记忆里 `from` 这一方最新的一条时间戳 */
function dmMemoryLastTs(dir, files, from) {
  return dmMemoryLast(dir, files, from).ts;
}

/** 所有通道里最晚的一次出站（哪个通道无所谓：她已经听见了）。 */
export function lastOutbound({ env = process.env, dsh = null, cfg = {} } = {}) {
  const a = qqLastOutbound({ env, dsh });
  const b = douyinLastOutbound({ env, dsh, cfg });
  return b.ts > a.ts ? b : a;
}

/**
 * 只看她最后说话的那个通道。
 * 跨通道比对会误伤：她在 QQ 上问了一句，抖音值班那边刚回完别人的私信，
 * 「最晚出站」就比她那句新了——可 QQ 上这句其实还悬着。
 * 不知道渠道时才退回「所有通道取最晚」。
 */
export function outboundFor(channel, opts = {}) {
  if (channel === 'qq') return qqLastOutbound(opts);
  if (channel === 'douyin') return douyinLastOutbound(opts);
  return lastOutbound(opts);
}

/**
 * 她那条已经被应过了吗。
 * 只有两边都有时间才判（读不到就是不知道，宁可照常走流程也不乱吞掉一拍）。
 */
export function answeredAlready({ herTs, out } = {}) {
  const h = Number(herTs) || 0;
  const o = Number(out?.ts) || 0;
  return Boolean(h && o && o > h);
}

/**
 * 阶段 3（0.14）：最近的对话轮次（旧的在前），给快照拼「最近聊到哪」。
 * 取 qq-history 的 turns[]，一轮里她说的话在前、我的回复在后；各截 80 字。
 * 读不到就返回空数组，快照整段省略。
 */
export function recentTurns({ limit = 6, env = process.env, dsh = null } = {}) {
  const home = dsh || dshHome(env);
  const hist = readJson(path.join(home, 'autonomy', 'qq-history.json'));
  const turns = Array.isArray(hist?.turns) ? hist.turns : [];
  const n = Math.max(1, Math.min(20, Number(limit) || 6));
  const out = [];
  for (const t of turns.slice(-n)) {
    const ts = Number(t?.at) || 0;
    if (t?.user) out.push({ who: 'her', text: String(t.user).replace(/\s+/g, ' ').trim().slice(0, 80), ts });
    if (t?.reply) out.push({ who: 'me', text: String(t.reply).replace(/\s+/g, ' ').trim().slice(0, 80), ts });
  }
  return out;
}

/**
 * 我最近真发出去的几条（跨通道，新的在前）。
 * 为什么要它：连续几天用同一种句式开头，比说错话更伤——模型得先看见自己说过什么。
 * 只读文件；两个来源都读不到就返回空数组（compose 那边整段省略，不留空标题）。
 */
export function recentOutbound({ limit = 5, env = process.env, dsh = null, cfg = {} } = {}) {
  const home = dsh || dshHome(env);
  const rows = [];
  // 视频标题/回复里常有换行，带进 prompt 会把一条挤成好几行——压成一行再截断。
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  const hist = readJson(path.join(home, 'autonomy', 'qq-history.json'));
  for (const t of Array.isArray(hist?.turns) ? hist.turns : []) {
    const ts = Number(t?.at) || 0;
    const text = flat(t?.reply);
    if (ts && text) rows.push({ ts, channel: 'qq', text });
  }

  // 抖音通道关着时 dm 记忆是陈的（没人盯梢更新），别拿旧话冒充「我最近说的」。
  if (cfg?.channels?.douyin?.enabled !== false) {
    const dir = path.join(home, 'douyin-duty', 'memory');
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith('dm-') && f.endsWith('.json'));
    } catch {
      files = [];
    }
    for (const f of files) {
      const j = readJson(path.join(dir, f));
      for (const m of Array.isArray(j?.messages) ? j.messages : []) {
        if (m?.from !== 'me') continue;
        const ts = Date.parse(m?.at || '');
        const text = flat(m?.text);
        if (Number.isFinite(ts) && text) rows.push({ ts, channel: 'douyin', text });
      }
    }
  }

  const n = Math.max(1, Math.min(20, Number(limit) || 5));
  return rows.sort((a, b) => b.ts - a.ts).slice(0, n);
}