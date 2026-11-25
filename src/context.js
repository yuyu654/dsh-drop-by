// context.js —— 把散在各处的数据汇成一份「现在能知道什么」。
//
// 只读，不写；读不到就如实标 null / ok:false，绝不编。内容生成和「有没有由头」
// 都只看这一份，免得每个模块各读一遍文件、各用一套时区。
import fs from 'node:fs';
import path from 'node:path';
import { LATEST_PATH } from './fishmail.js';
import { dshHome } from './detect.js';
import { bridgeLastIn, bridgeLastOut, recentTurns } from './outbound.js';
import { chatPeer } from './channels/external.js';
import { douyinPrimary, douyinPeer, readDouyinState } from './channels/douyin-im.js';
import { internalPrimary, internalSessionId, readInternalState } from './channels/internal.js';
import { agoSec, dayKey } from './time.js';
import { loadPersona } from './persona.js';
import { actionProposalCandidate } from './action-proposal.js';
import { explorationProgress, explorationShare, explorationStatus, loadExploration } from './explore.js';
import { explorationFeedbackHints, topicInExplorationFeedback } from './exploration-feedback.js';
// 解析逻辑搬到 fishparse.js：fishmail.js 归档时也要用它，放这里会和 LATEST_PATH 形成循环依赖
export { minsOf, parseFishSummary } from './fishparse.js';
import { parseFishSummary } from './fishparse.js';

// 家目录走 detect 的同一套解析（PG_DSH_HOME 可顶掉），测试才能造假私信/假 QQ 记录。
const DSH = dshHome();
const DOUYIN_MEMORY = path.join(DSH, 'douyin-duty', 'memory');
const SELF_MD = path.join(DOUYIN_MEMORY, 'self.md');

/** self.md 的写入时间（阶段 3 的「刚写下一条判断」只用得到这个，不重读文件）。读不到返回 0。 */
export function selfMtime() {
  try {
    return fs.statSync(SELF_MD).mtimeMs;
  } catch {
    return 0;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 抖⾳私信：她说的 + 我说的，都取最近几条（文案可能是视频标题，一样有用）。 */
function readDouyinDialogue(limit = 6) {
  let files = [];
  try {
    files = fs.readdirSync(DOUYIN_MEMORY).filter((f) => f.startsWith('dm-') && f.endsWith('.json'));
  } catch {
    return null;
  }
  if (!files.length) return null;

  const all = [];
  for (const f of files) {
    const j = readJson(path.join(DOUYIN_MEMORY, f), null);
    for (const m of Array.isArray(j?.messages) ? j.messages : []) {
      const ts = Date.parse(m?.at || '');
      if (!Number.isFinite(ts) || !m?.text) continue;
      // item 是抖音卡片的 aweme_id：只有它能让我们真的去看那条视频（旧版记忆里没有这个字段）。
      const item = /^\d{6,30}$/.test(String(m?.item || '')) ? String(m.item) : null;
      all.push({
        ts,
        from: m.from === 'them' ? 'her' : 'me',
        text: String(m.text).slice(0, 300),
        kind: m.kind || 'text',
        item,
        channel: 'douyin',
      });
    }
  }
  all.sort((a, b) => a.ts - b.ts);
  return all.length ? all : null;
}

/** QQ：autonomy/qq-history.json 的 turns[{user, reply, at}]，并合并 qq-bridge/last-in.json & last-out.json。 */
function readQqDialogue(limit = 6, peer = '') {
  const j = readJson(path.join(DSH, 'autonomy', 'qq-history.json'), null);
  const turns = Array.isArray(j?.turns) ? j.turns : [];
  const all = [];
  for (const t of turns) {
    const ts = Number(t?.at) || 0;
    if (!ts) continue;
    // channel 只用来回答「她这条是在哪个渠道说的」——防重复时只看同一个渠道的出站记录，
    // 免得抖音值班回了别人私信、把 QQ 上这条还没回的消息也算成「已经应过」。
    if (t.user) all.push({ ts, from: 'her', text: String(t.user).slice(0, 300), kind: 'text', channel: 'qq' });
    if (t.reply) all.push({ ts: ts + 1, from: 'me', text: String(t.reply).slice(0, 300), kind: 'text', channel: 'qq' });
  }
  const bi = bridgeLastIn({ dsh: DSH, peer });
  if (bi.ts && !all.some((m) => m.from === 'her' && Math.abs(m.ts - bi.ts) <= 2000)) {
    all.push({ ts: bi.ts, from: 'her', text: bi.text, kind: 'text', channel: 'qq' });
  }
  const bo = bridgeLastOut({ dsh: DSH, peer });
  if (bo.ts && !all.some((m) => m.from === 'me' && Math.abs(m.ts - bo.ts) <= 2000)) {
    all.push({ ts: bo.ts, from: 'me', text: bo.text, kind: 'text', channel: 'qq' });
  }
  all.sort((a, b) => a.ts - b.ts);
  return all.length ? all.slice(-limit) : null;
}

/**
 * 阶段 2：她最后说的一句（QQ + 抖音合并）。
 * settle 在 buildContext 之前跑，所以要一个不建整份上下文的轻量入口。
 */
function primaryDialogue(cfg) {
  if (internalPrimary(cfg)) {
    const state = readInternalState(internalSessionId());
    const rows = cfg.channels?.internal?.read === false ? [] : (state.dialogue || []);
    return rows.map(item => ({ ...item, from: item.who, channel: 'internal' }));
  }
  if (douyinPrimary(cfg)) {
    const state = readDouyinState(douyinPeer(cfg));
    const rows = cfg.channels.douyin.read === false ? [] : [
      ...(state.dialogue || []), ...(state.pending || []).filter(m => !(state.flight?.ids || []).includes(m.id))
        .map(m => ({ who: 'her', ts: m.ts, text: m.text, kind: m.kind, item: m.item })),
    ];
    return rows.map(item => ({ ...item, from: item.who, channel: 'douyin' }));
  }
  const qqPeer = String(cfg?.channels?.qq?.peerId || '').trim();
  return [...(readQqDialogue(6, qqPeer) || []), ...(cfg?.channels?.primary === 'qq' ? [] : readDouyinDialogue() || [])];
}

export function lastHerMessage(cfg) {
  const all = primaryDialogue(cfg).filter((m) => m.from === 'her');
  all.sort((a, b) => a.ts - b.ts);
  return all[all.length - 1] || null;
}

/**
 * 我自己记下的判断（douyin-duty/memory/self.md）。
 *
 * 两个坑：
 *   1) 文件几百 KB，只读尾部 20 KB，所以不能从尾部倒扫 `## `（会漏掉更靠前的标题），
 *      要正向扫一遍自己跟踪当前章节，再取最后几条；
 *   2) 有些条目自己写着「这条不给对方看」「太贴」——那是内部判断，**绝不能拿去当素材**，
 *      打上 private 标记，选素材时跳过。
 *
 * 判断在 private.js（那里也解释了为什么正则不写死名字）。
 */
import { PRIVATE_MARK } from './private.js';

function isRecentSelfEntry(mmdd, now = Date.now(), tz = 'Asia/Shanghai', maxDays = 3) {
  if (!/^\d{2}-\d{2}$/.test(String(mmdd || ''))) return false;
  for (let d = 0; d <= maxDays; d += 1) {
    if (dayKey(now - d * 86_400_000, tz).slice(5) === mmdd) return true;
  }
  return false;
}

function readSelfMemory(tz, limit = 8, now = Date.now(), maxDays = 3) {
  let raw = '';
  try {
    const size = fs.statSync(SELF_MD).size;
    const start = Math.max(0, size - 40000);
    const fd = fs.openSync(SELF_MD, 'r');
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch {
    return null;
  }

  const items = [];
  let section = '';
  for (const rawLine of raw.split('\n')) {
    const t = rawLine.trim();
    if (t.startsWith('## ')) {
      section = t.slice(3).trim();
      continue;
    }
    const m = /^-\s*\[(\d{2}-\d{2})\]\s*(.+)$/.exec(t);
    if (!m) continue;
    if (!isRecentSelfEntry(m[1], now, tz, maxDays)) continue;
    const line = m[2].replace(/（来源：[^）]*）\s*$/, '').trim();
    if (line.length < 12) continue;
    items.push({
      at: m[1],
      section,
      line,
      chars: line.length,
      private: PRIVATE_MARK.test(line),
    });
  }
  if (!items.length) return null;
  // 最新的在最后（文件是追加写），倒过来给出
  const recent = items.slice(-limit).reverse();
  return { path: SELF_MD, items: recent };
}

/**
 * 她最后那条，有没有在**它自己的那个通道**里被我回过。
 * 只认同一个通道：QQ 说过话不算在抖音回过她。
 * 2026-11-09 20:43 她在抖音发动画、值班鱼在抖音答过，presence-gate 又把同一句答到 QQ，
 * 她收到两遍——这条就是用来挡住「同一个问题答两次」的。
 */
export function hasAnsweredOnOwnChannel(lastHer, meMsgs = []) {
  if (!lastHer?.channel || !lastHer?.ts) return false;
  return (meMsgs || []).some((m) => m && m.channel === lastHer.channel && Number(m.ts) > Number(lastHer.ts));
}

/**
 * 汇总当前上下文。
 * ch: readChannels 的返回；sys: probe 的返回。
 */
export function buildContext({ cfg, now, st, ch, sys, tz }) {
  const merged = primaryDialogue(cfg).sort((a, b) => a.ts - b.ts);
  const recent = merged.slice(-6);

  const herMsgs = merged.filter((m) => m.from === 'her');
  const meMsgs = merged.filter((m) => m.from === 'me');
  const lastHer = herMsgs[herMsgs.length - 1] || null;
  const lastMe = meMsgs[meMsgs.length - 1] || null;

  const fishRaw = readJson(LATEST_PATH, null);
  const fish = fishRaw
    ? {
        ok: true,
        subject: fishRaw.subject || '',
        date: fishRaw.date || '',
        dateTs: Number(fishRaw.dateTs) || null,
        fetchedAt: Number(fishRaw.fetchedAt) || 0,
        // 「数据有多旧」按邮件自己的日期算。按抓取时间算的话，每次轮询都把旧邮件当新邮件，
        // 昨天那份睡眠数据会永远显示成「刚采到」（2026-11-10 就是这么把 11.2h 问出去的）。
        ageMin: (() => {
          const ts = Number(fishRaw.dateTs) || Number(fishRaw.fetchedAt) || 0;
          return ts ? Math.round((now - ts) / 60000) : null;
        })(),
        summary: String(fishRaw.summary || '').slice(0, 1200),
        ...parseFishSummary(fishRaw.summary),
      }
    : { ok: false };

  // 她最后那条是不是已经在它自己的通道里被我回过了。
  // 2026-11-09 20:43：她在抖音发了动画视频，值班鱼在抖音答过（「注意力就是各查各的」），
  // presence-gate 又把同一句答到了 QQ 上——她收到两遍。只认同一个通道：
  // 我在 QQ 里说过话，不代表我在抖音里回过她。
  const answeredOnOwnChannel = hasAnsweredOnOwnChannel(lastHer, meMsgs);

  const exploration = loadExploration();
  const persona = exploration ? loadPersona({ cfg }) : null;
  const lastSendTs = Math.max(Number(st?.real?.lastSendAt) || 0, Number(st?.sim?.lastSendAt) || 0) || null;

  return {
    now,
    tz,
    presence: {
      idleSec: typeof sys?.idle_ms === 'number' && sys.idle_ms >= 0 ? Math.round(sys.idle_ms / 1000) : -1,
      locked: Boolean(
        sys?.locked === true ||
        (Array.isArray(sys?.procs) && sys.procs.some((p) => String(p).toLowerCase() === 'logonui')) ||
        st?.pc?.locked
      ),
      fgTitle: sys?.fg_title || '',
      fgName: sys?.fg_name || '',
      audioPeak: typeof sys?.audio_peak === 'number' ? sys.audio_peak : null,
    },
    her: {
      lastTs: lastHer?.ts || null,
      lastText: lastHer?.text || '',
      lastAgoSec: lastHer ? agoSec(now, lastHer.ts) : null,
      lastChannel: lastHer?.channel || null,
      // 她最后那条有没有在同一个通道里被我回过（抖音值班鱼回过的，QQ 这边不许再答一遍）。
      answeredOnOwnChannel,
      lastItem: lastHer?.item || null,
      // 她最近一条带视频的转发（不限「最后一条消息」）：给她发完文字、视频卡片还留在这儿时也能看。
      forwardItem: [...herMsgs].reverse().find((m) => m.item)?.item || null,
      forwardText: [...herMsgs].reverse().find((m) => m.item)?.text || '',
      count: herMsgs.length,
    },
    me: {
      lastTs: lastMe?.ts || null,
      lastText: lastMe?.text || '',
      lastAgoSec: lastMe ? agoSec(now, lastMe.ts) : null,
      count: meMsgs.length,
    },
    recent,
    // 阶段 3：最近 6 轮对话（双方原文，旧的在前）——模型得知道「我们刚才聊到哪」
    dialogueTurns: recentTurns({ limit: 6, cfg }),
    fish,
    myExploration: explorationProgress(exploration, persona, now, cfg?.exploration),
    ...(() => {
      const mem = readSelfMemory(tz, 8, now);
      const avoid = explorationFeedbackHints(cfg, explorationStatus(exploration, persona), now).avoid;
      const recentShareLines = new Set([
        ...(st?.content?.lastShareLine ? [st.content.lastShareLine] : []),
        ...(Array.isArray(st?.content?.recentShareLines) ? st.content.recentShareLines : []),
      ].filter(Boolean));
      const recentTopicCooldown = (section) => {
        if (!section || !Array.isArray(st?.content?.recentShareTopics)) return false;
        return st.content.recentShareTopics.some(
          (entry) => entry?.topic === section && Number.isFinite(entry.at) && now >= entry.at && now - entry.at < 6 * 3_600_000,
        );
      };
      let selfMiss = null;
      const inspectCandidate = (candidate) => {
        if (!candidate) return null;
        const loginSent = candidate.loginSite && st?.content?.explorationLoginNotices?.includes(candidate.loginSite);
        const discoverySent = candidate.discoveryId && st?.content?.sharedExplorationIds?.includes(candidate.discoveryId);
        const avoided = !candidate.actionRetry && !candidate.loginSite && topicInExplorationFeedback(candidate.section, avoid);
        const topicCool = !candidate.actionRetry && !candidate.loginSite && !candidate.discoveryId && recentTopicCooldown(candidate.section);
        const head = String(candidate.line || '').slice(0, 80);
        const usedAlready = candidate.actionRetry
          ? candidate.at === st?.content?.lastRetryProposalAt
          : recentShareLines.has(head);
        if (avoided) { selfMiss ||= 'share_avoided'; return null; }
        if (topicCool) { selfMiss ||= 'share_topic_cooldown'; return null; }
        if (loginSent || discoverySent || usedAlready) { selfMiss ||= 'already_used'; return null; }
        const linkAlreadySent = Boolean(
          candidate.continuation &&
          !candidate.loginSite &&
          topicInExplorationFeedback(candidate.section, st?.content?.sharedLinkTopics || []),
        );
        return { ...candidate, exploration: true, ...(linkAlreadySent ? { linkAlreadySent: true } : {}) };
      };
      const usableMemItem = mem?.items.find((x) => !x.private && !recentShareLines.has(String(x.line || '').slice(0, 80))) || null;
      const rawExploreShare = explorationShare(exploration, persona, now, cfg?.exploration);
      if (cfg?.exploration?.offerShare !== true && rawExploreShare) selfMiss = 'share_offer_off';
      const usable = cfg?.exploration?.offerShare === true
        ? inspectCandidate(actionProposalCandidate({ cfg, peer: chatPeer(cfg), now, state: exploration, persona })) ||
          inspectCandidate(rawExploreShare) ||
          usableMemItem
        : usableMemItem;
      return {
        self: usable,
        ...(usable ? {} : selfMiss ? { selfMiss } : {}),
        selfItems: mem?.items || [],
        selfPath: mem?.path || null,
      };
    })(),
    send: { lastTs: lastSendTs, lastAgoSec: lastSendTs ? agoSec(now, lastSendTs) : null },
    // 最近真发出去的那几句：给 compose 做「别重复同一个句式」用
    recentSends: Array.isArray(st?.content?.recentSends) ? st.content.recentSends.slice(-6) : [],
    channels: ch?.list || [],
    allDown: Boolean(ch?.allDown),
  };
}
