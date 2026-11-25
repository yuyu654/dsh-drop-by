// channels/qq.js —— QQ 私信信号。只读 ~/.dsh/autonomy 下已有的三个 json，
// 外加 qq-bridge 自己写的 last-out.json（driver 关着时，那是唯一能看见「桥刚回过」的地方）。
import fs from 'node:fs';
import path from 'node:path';
import { dayKey } from '../time.js';
import { bridgeLastIn, bridgeLastOut, dshHome } from '../outbound.js';

const dir = () => path.join(dshHome(), 'autonomy');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), file), 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * qq-history.json：{ turns: [{ user, reply, at(ms) }] }
 * 一轮对话就是她说一句 + 我们回一句，所以：
 *   - 最后一轮的 at ≈ 她最后说话的时间
 *   - 最后一轮带 reply 的 at ≈ 我们最后发消息的时间
 * 这个文件由 autonomy/driver.mjs 写，本插件只读。
 */
export function readQq(cfg, now, timezone) {
  const peerId = String(cfg?.peerId || '');
  const hist = readJson('qq-history.json', { turns: [] });
  const turns = Array.isArray(hist.turns) ? hist.turns : [];

  let lastUserTs = null;
  let lastReplyTs = null;
  for (const t of turns) {
    const at = Number(t?.at) || 0;
    if (!at) continue;
    if (t?.user && (!lastUserTs || at > lastUserTs)) lastUserTs = at;
    if (t?.reply && (!lastReplyTs || at > lastReplyTs)) lastReplyTs = at;
  }

  // 桥自己发的那一轮也要算进「我最后一次开口」：不然 reply 轨道的冷却
  // 只有 1 分钟、tick 是 10 分钟，桥回完插件还会补一句完全不同的话。
  // 多段发送中途（lastAt = 0）用 firstAt 顶上——发着的那一轮也算开口了。
  const br = bridgeLastOut({ peer: peerId });
  if (br.ts > (lastReplyTs || 0)) lastReplyTs = br.ts;

  // 她最后一条也以桥的落盘为准：qq-history 是空的（driver 的 qqReply 关着），
  // 只看 history 会以为她一天没说话——2026-11-10 的「那条」就是这么追出来的。
  const bi = bridgeLastIn({ peer: peerId });
  if (bi.ts > (lastUserTs || 0)) lastUserTs = bi.ts;

  // qq-rate.json：{ "<peerId>": { date: "YYYY-MM-DD", count: n } }
  const rate = readJson('qq-rate.json', {});
  const mine = peerId ? rate[peerId] : null;
  const rateToday = mine && mine.date === dayKey(now, timezone) ? Number(mine.count) || 0 : 0;

  return {
    channel: 'qq',
    ok: true,
    lastUserTs,
    lastSendTs: lastReplyTs,
    dutyToday: rateToday, // duty 侧今天回过几条，仅供日志参考，不参与我们的配额
    note: turns.length === 0 ? 'qq-history 为空' : '',
  };
}
