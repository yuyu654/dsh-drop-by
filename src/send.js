// send.js —— 借 qq-bridge 发 QQ 私信（OneBot HTTP API）。
//
// 只做一件事：给一个 peerId 和一段文本，发出去。
// 是否允许发由调用方决定（dryRun / send.enabled / requireConfirm），本模块不猜。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitOutgoing, firstDelayMs, partGapMs } from './split.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));

/** DSH 家目录；和 detect.js 同一套规则（PG_DSH_HOME 可顶掉），测试与多份部署才不会串。 */
function dshDir() {
  const custom = String(process.env.PG_DSH_HOME || process.env.DSH_HOME || '').trim();
  return custom ? path.resolve(custom) : path.join(os.homedir(), '.dsh');
}
const connPath = () => path.join(dshDir(), 'qq-bridge', 'connection.json');

export function bridgeInfo() {
  try {
    const c = JSON.parse(fs.readFileSync(connPath(), 'utf8'));
    return {
      ok: Boolean(c.httpApiUrl && c.httpToken),
      api: c.httpApiUrl || '',
      ws: c.wsUrl || '',
      selfId: c.selfId || '',
    };
  } catch {
    return { ok: false, api: '', ws: '', selfId: '' };
  }
}

/**
 * 发一条纯文本私信。
 * dryRun=true 时只回 payload，不联网——默认就应该走这条路。
 */
export async function sendQQPrivate({ to, text, dryRun = true, timeoutMs = 8000 }) {
  const info = bridgeInfo();
  const payload = { user_id: Number(to), message: String(text) };

  if (dryRun) {
    return { ok: true, dryRun: true, payload, api: info.api, note: 'dryRun：没有真的发出去' };
  }
  if (!info.ok) {
    return { ok: false, dryRun: false, error: 'qq-bridge 连接配置缺失（connection.json）' };
  }
  if (!to) {
    return { ok: false, dryRun: false, error: '没有收件人 peerId' };
  }

  const token = JSON.parse(fs.readFileSync(connPath(), 'utf8')).httpToken;
  const url = `${info.api.replace(/\/+$/, '')}/send_private_msg?access_token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.status !== 'ok') {
      return { ok: false, dryRun: false, error: `发送失败 HTTP ${res.status} ${JSON.stringify(j).slice(0, 160)}` };
    }
    return { ok: true, dryRun: false, messageId: j?.data?.message_id ?? null };
  } catch (e) {
    return { ok: false, dryRun: false, error: String(e?.message || e).slice(0, 160) };
  }
}

/** `~/.dsh/qq-bridge/last-out.json`：桥与插件都写它，presence-gate 靠它看见「刚回过」。 */
function writeLastOut(round) {
  const file = path.join(dshDir(), 'qq-bridge', 'last-out.json');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(round));
  } catch {
    /* 写不进去不影响发送本身 */
  }
}

/**
 * 发一轮 QQ 回复：该拆的拆成几条，首条别秒回，条间留一点空隙。
 * 返回 { ok, parts, messageId, error? }；中途失败就停在失败那条，前面的已经发出去了。
 *
 * split.enabled=false 时退化成 sendQQPrivate（一次发完）。
 */
export async function sendQQRound({
  to,
  text,
  dryRun = true,
  now = Date.now(),
  herAt = 0,
  herChars = 0,
  split = {},
} = {}) {
  const cfg = {
    enabled: split.enabled !== false,
    maxParts: Math.max(1, Math.min(4, Number(split.maxParts) || 4)),
    minFirstMs: Number(split.firstDelayMs) || 6000,
    minGapMs: Number(split.minGapMs) || 1200,
    maxRoundMs: Number(split.maxRoundMs) || 90000,
  };
  const raw = String(text ?? '');
  const parts = cfg.enabled ? splitOutgoing(raw, { maxParts: cfg.maxParts }) : [raw];
  if (parts.length === 0) return { ok: false, dryRun, parts: 0, error: '没有可发的正文' };
  if (dryRun) return sendQQPrivate({ to, text: parts.join('\n'), dryRun: true });

  // 先写「这一轮开始发了」：firstAt 有、lastAt=0 → 别的地方看见就知道我在回。
  const round = {
    peer: String(to),
    source: 'presence-gate',
    firstAt: now,
    lastAt: 0,
    count: parts.length,
    text: raw.replace(/\s+/g, ' ').trim().slice(0, 80),
  };
  writeLastOut(round);

  const startedAt = Date.now();
  let sent = 0;
  let messageId = null;
  try {
    await sleep(firstDelayMs({ herAt, herChars, now: round.firstAt, minMs: cfg.minFirstMs }));
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) {
        const gap = partGapMs(parts[i].length, { minGapMs: cfg.minGapMs });
        if (Date.now() - startedAt + gap > cfg.maxRoundMs) {
          const rest = parts.slice(i).join(' ');
          const r = await sendQQPrivate({ to, text: rest, dryRun: false });
          if (!r.ok) throw new Error(r.error || '发送失败');
          messageId = messageId ?? r.messageId ?? null;
          sent = parts.length;
          break;
        }
        await sleep(gap);
      }
      const r = await sendQQPrivate({ to, text: parts[i], dryRun: false });
      if (!r.ok) throw new Error(r.error || '发送失败');
      messageId = messageId ?? r.messageId ?? null;
      sent += 1;
    }
    return { ok: true, dryRun: false, parts: sent, messageId };
  } catch (e) {
    return { ok: false, dryRun: false, parts: sent, messageId, error: String(e?.message || e).slice(0, 160) };
  } finally {
    round.lastAt = Date.now();
    round.count = sent;
    writeLastOut(round);
  }
}
