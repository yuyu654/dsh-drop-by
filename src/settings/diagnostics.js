import fs from 'node:fs';
import path from 'node:path';
import { checkHealth } from '../perception/health.js';
import { detectQq, dshHome } from './detect.js';
import { bridgeInfo } from '../chat/send.js';
import { chatBinding, readyDouyinBinding, chatChanging } from '../channels/chat-switch.js';
import { douyinInstallation, originalWatcherDisabled, readDouyinState } from '../channels/douyin-im.js';
import { activeChatChannel, chatPeer } from '../channels/external.js';
import { loadPersona } from '../decision/persona.js';
import { loadState } from './config.js';
import { inspectEmotionPlugin } from '../decision/emotion-sync.js';
import { mailReady } from '../perception/fishmail.js';
import { phonePauseText, PHONE_SLOTS, PHONE_FIX_HINT, topicLabel } from '../decision/explain.js';
import { chitchatToday, densityTarget } from '../decision/chitchat.js';
import { slotStats, feedbackSummary, receiptDetails } from '../decision/feedback.js';
import { dayKey, hhmm } from './time.js';
import { recentReports } from '../decision/report.js';

const INTERNAL_HINT = '在「主聊天接口与通道开关」选择一个已有 DSH 会话，或点击新建陪伴会话完成绑定。';
const QQ_HINT = '在 DSH 的 QQ 桥完成配对，将目标联系人绑定到一个私聊会话，再在「主聊天接口与通道开关」填同一个 QQ 号。';
const DOUYIN_HINT = '在「主聊天接口与通道开关」核对联系人 sec_uid。检查抖音插件已登录。切到抖音后，陪伴会沿用已有会话或新建一条抖音私信会话。';

function check(key, label, level, detail, actionHint = '') {
  return { key, label, level, detail, actionHint };
}

function qqBoundSessionId(peer, home = dshHome()) {
  if (!peer) return '';
  try {
    const file = path.join(home, 'qq-bridge', 'bindings.json');
    const bindings = JSON.parse(fs.readFileSync(file, 'utf8'));
    const matches = Object.entries(bindings.sessions || {})
      .filter(([, item]) => item && item.enabled !== false && item.peerKind === 'private' && String(item.peerId) === peer)
      .sort(([, a], [, b]) => Number(b.authoritative === true) - Number(a.authoritative === true) || (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    return matches[0]?.[0] || '';
  } catch { return ''; }
}

function qqBound(peer) {
  return Boolean(qqBoundSessionId(peer));
}

/** 轻量只读体检：从 DSH 的 session_projcache 读绑定会话的工具数与上下文占用；读不到就静默返回 null。 */
export function inspectSessionContext(cfg, home = dshHome()) {
  try {
    const primary = activeChatChannel(cfg);
    const peer = chatPeer(cfg).trim();
    const sessionId = primary === 'qq'
      ? (qqBoundSessionId(peer, home) || chatBinding().sessionId || '')
      : (chatBinding().sessionId || '');
    if (!sessionId) return null;
    const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = parsed?.record?.rows;
    if (!rows || typeof rows !== 'object') return null;
    const toolsTokens = Number(rows.contextBreakdown?.val?.breakdown?.toolsTokens);
    const headers = rows.contextHeaders?.val?.headers;
    const tools = Array.isArray(headers) && headers.length ? headers[headers.length - 1]?.tools : null;
    if (!Number.isFinite(toolsTokens) && !Array.isArray(tools)) return null;
    const toolList = Array.isArray(tools) ? tools : [];
    const toolCount = toolList.length;
    const effectiveToolsTokens = Number.isFinite(toolsTokens)
      ? toolsTokens
      : toolList.reduce((sum, item) => sum + (Number(item?.tokens) || 0), 0);
    if (!toolCount && effectiveToolsTokens <= 0) return null;
    const pressure = rows.contextPressure?.val || {};
    const used = Number(pressure.projectedTokens ?? pressure.pressureTokens);
    const limit = Number(pressure.contextWindow);
    const topTools = [...toolList]
      .filter((t) => t?.name && Number(t?.tokens) > 0)
      .sort((a, b) => Number(b.tokens) - Number(a.tokens))
      .slice(0, 5)
      .map((t) => `${t.name}(${t.tokens})`);
    const heavy = effectiveToolsTokens >= 15_000 || toolCount >= 60;
    const toolsK = (effectiveToolsTokens / 1000).toFixed(1);
    const usageText = Number.isFinite(used) && used > 0 && Number.isFinite(limit) && limit > 0
      ? `，当前总占用 ${(used / 1000).toFixed(1)}k / ${Math.round(limit / 1024)}K`
      : '';
    const detail = `当前聊天会话挂载了 ${toolCount} 个工具（约 ${toolsK}k tokens${usageText}）` +
      (heavy && topTools.length ? `；占用最高：${topTools.join('、')}。` : '，体积适中。');
    const hint = heavy
      ? '工具定义过多会明显推高隔夜/间隔较久时的单句成本；可在 DSH 插件管理里关闭闲置或重复插件以减负。'
      : '';
    return check('session_context', '会话上下文体检（只读）', heavy ? 'warn' : 'ok', detail, hint);
  } catch {
    return null;
  }
}

function checkChannel(cfg) {
  const primary = activeChatChannel(cfg);
  const label = primary === 'internal' ? '内部会话主通道' : primary === 'qq' ? 'QQ 主通道' : '抖音私信主通道';
  const hint = primary === 'internal' ? INTERNAL_HINT : primary === 'qq' ? QQ_HINT : DOUYIN_HINT;
  const result = (level, detail, tip = hint) => check('channel', label, level, detail, tip);
  try {
    const peer = chatPeer(cfg).trim();
    if (chatChanging()) return result('warn', '主通道正在切换。');
    if (primary === 'internal') {
      if (!peer) return result('bad', '尚未绑定 DSH 内部会话。');
      if (cfg.channels?.internal?.enabled === false || cfg.channels?.internal?.read === false) {
        return result('warn', `已绑定内部会话 ${peer.slice(0, 8)}，读取开关关着。`, '在「主聊天接口与通道开关」打开「读内部会话」。');
      }
      const title = chatBinding().sessionTitle;
      return result('ok', `已绑定内部会话${title ? `「${title}」` : ''}（${peer.slice(0, 8)}）。`, '');
    }
    if (primary === 'qq') {
      const qq = detectQq();
      if (!qq.installed) return result('bad', '还没检测到 QQ 桥插件。', '在 DSH 安装并启用 dsh-plugin-qq-bridge。');
      if (!qq.paired) return result('bad', 'QQ 桥还没有配对。');
      if (!peer) return result('bad', '还没填写 QQ 联系人。');
      if (!qqBound(peer)) {
        const { sessionId } = chatBinding();
        return result('bad', '该联系人还没有启用的私聊会话绑定。',
          sessionId ? `在 QQ 桥将此联系人手动绑定到原抖音会话 ${sessionId.slice(0, 8)}，即可接着聊。` : QQ_HINT);
      }
      if (cfg.sources?.qq?.enabled === false || cfg.channels?.qq?.enabled === false || cfg.channels?.qq?.read === false) {
        return result('warn', 'QQ 已配对并绑定，读取开关关着。', '在「数据从哪来」打开 QQ，再检查「读 QQ」。');
      }
      if (cfg.channels?.qq?.send !== false && !bridgeInfo().ok) {
        return result('warn', 'QQ 已绑定，桥接发送连接配置不完整。');
      }
      return result('ok', 'QQ 桥已配对，该联系人已绑定到启用的私聊会话。', '');
    }
    if (!douyinInstallation().ready) {
      return result('bad', '还没找到抖音私信的读取和发送脚本。', '安装或更新 dsh-douyin-scroll，并按插件说明完成登录。');
    }
    if (!peer) return result('bad', '未配置抖音联系人 sec_uid。');
    if (!readyDouyinBinding({ readOnly: true })) return result('bad', '抖音私信还没有可用的 DSH 会话。');
    if (!originalWatcherDisabled()) {
      return result('bad', '抖音原聊天盯梢还开着，陪伴无法接管私信。', '在抖音插件中关闭原聊天盯梢，再重新检查。');
    }
    if (cfg.channels?.douyin?.read === false) return result('warn', '私信已绑定，读取开关关着。', '在「主聊天接口与通道开关」打开「读抖音私信」。');
    const state = readDouyinState(peer);
    if (state.pollError || !state.polledAt) {
      return result('warn', state.pollError ? '最近一次私信读取失败。' : '脚本和绑定就绪，正在等待首次私信读取。');
    }
    return result('ok', '私信脚本和会话绑定已就绪，已有成功读取记录。', '');
  } catch {
    return result('bad', '主通道的本地配置或记录读不出来。');
  }
}

export async function connectivity({ cfg, host, st = null, now = Date.now(), secretsPath = undefined }) {
  const phoneOn = cfg.sources?.phone?.enabled !== false;
  const mailOn = cfg.mail?.enabled === true;
  const health = await checkHealth({ cfg, now, only: phoneOn || mailOn ? ['fish', 'memory'] : ['memory'] });
  const items = [checkChannel(cfg)];
  items.push(host.ready
    ? check('llm', '宿主模型', 'ok', `${host.provider} / ${host.model} 已选定，可在安全试跑时验证生成。`)
    : check('llm', '宿主模型', 'bad', host.reason === 'HOST_LLM_OFF' ? '陪伴的宿主模型接入已关闭。' : '当前没有可用的宿主模型。',
      '到 DSH 的模型设置选择可用的默认模型，检查提供商配置。'));
  const persona = loadPersona({ cfg });
  items.push(persona.ok
    ? check('persona', '人设', 'ok', persona.kind === 'plugin' ? '已读取 DSH 人设。' : '已读取本地人设。')
    : check('persona', '人设', 'warn', '当前使用内置口吻。', '可在 DSH 配置角色人设，或填写插件目录里的 persona.md。'));

  if (phoneOn || mailOn) {
    const mail = mailReady({ ...cfg, mail: { ...cfg.mail, enabled: true } }, { secretsPath });
    const ms = (st || loadState())?.mail || {};
    const mailFailed = Boolean(
      mailOn &&
      mail.ok &&
      ms.lastError &&
      (!ms.lastOkAt || Number(ms.failedAt) >= Number(ms.lastOkAt))
    );
    const mailLevel = !mailOn || !mail.ok ? 'warn' : mailFailed ? 'warn' : 'ok';
    const mailDetail = !mail.ok
      ? (mail.reason === 'MAIL_NO_USER' ? '邮箱账号缺失或格式不完整。' : '缺少 IMAP 授权码。')
      : !mailOn
        ? '邮箱账号和 IMAP 授权码已填。读邮箱开关关着。'
        : mailFailed
          ? `邮箱配置已填，但最近一次 IMAP 拉取失败：${String(ms.lastError).slice(0, 120)}`
          : '邮箱账号和 IMAP 授权码已填。';
    items.push(check('mail', '邮箱配置', mailLevel, mailDetail, mailLevel === 'ok' ? '' : PHONE_FIX_HINT));
    const fish = health.items.find(item => item.key === 'fish');
    if (phoneOn && !mailOn && health.phone?.missing) {
      items.push(check('phone', '鱼鱼邮件缓存', 'warn', '未开启读邮箱，暂未使用手机作息数据。',
        '如需使用，可在「数据从哪来」开启读邮箱。'));
    } else {
      const paused = phoneOn && cfg.sources?.phone?.staleGuard !== false ? phonePauseText(health.phone) : '';
      items.push({
        ...check('phone', '鱼鱼邮件缓存', fish.level, paused || fish.detail, fish.level === 'ok' ? '' : PHONE_FIX_HINT),
        ...(paused ? {
          ageHours: health.phone.ageHours == null ? null : Math.round(health.phone.ageHours),
          limitHours: health.phone.limitHours,
          pausedSlots: PHONE_SLOTS,
        } : {}),
      });
    }
  }

  const memory = health.items.find(item => item.key === 'memory');
  items.push(check('memory', '记忆插件（可选）', memory.level === 'ok' ? 'ok' : 'warn',
    memory.level === 'ok' ? memory.detail : cfg.sources?.memory?.enabled === false ? '记忆来源已关闭。' : '还没读到可用记忆。',
    memory.level === 'ok' ? '' : '如需使用，在「数据从哪来」检查记忆插件与记忆来源。'));
  const emotion = inspectEmotionPlugin({ cfg });
  const emotionReady = emotion.ready && !emotion.needsRepair;
  items.push(check('emotion', '情绪插件（可选）', emotionReady ? 'ok' : 'warn',
    emotionReady ? '情绪插件已就绪。' : emotion.installed ? '情绪插件还缺少可用配置。' : '尚未安装情绪插件。',
    emotionReady ? '' : '如需使用，安装 emotion-state-portrait 并查看陪伴里的情绪状态。'));
  const sessionCtx = inspectSessionContext(cfg);
  if (sessionCtx) items.push(sessionCtx);
  return { ok: true, at: now, items, phone: phoneOn ? health.phone : null };
}

export async function diagnostics({ cfg, st, host, now = Date.now() }) {
  const health = await connectivity({ cfg, host, now });
  const items = health.items;
  const channel = items.find(item => item.key === 'channel');
  const alerts = items.filter(item => item.level !== 'ok' &&
    (['channel', 'llm'].includes(item.key) || item.pausedSlots || (item.key === 'mail' && cfg.mail?.enabled === true)));
  const reports = recentReports({ cfg, st, now });
  const hasSent = Boolean(st.lastRealSendAt || st.real?.lastSendAt || st.real?.todaySent ||
    st.feedback?.pending?.length || st.feedback?.testPairs?.length || Object.values(st.feedback?.slots || {}).some(slot => slot?.sent) ||
    reports.some(report => report.sent));
  const density = densityTarget(st, now, cfg.timezone, cfg);
  const casual = cfg.rules?.chitchat?.enabled === true;
  const judge = cfg.rules?.judge?.enabled === true;
  const proactive = cfg.rules?.proactive !== false;
  const chitchat = {
    todayCount: Number(chitchatToday(st, now, cfg.timezone).count) || 0,
    effectivePerDay: casual && judge && proactive ? density.perDay : 0,
    configuredPerDay: density.configuredPerDay,
    why: !casual ? '「没什么事也可以说一句」开关关着。'
      : !proactive ? '「我会主动找你」开关关着。'
      : !judge ? '需要开启「让模型自己决定说不说」。'
        : `${density.why}，同时计入每天的主动消息总上限（${cfg.rules.dailyCap} 条）。`,
  };
  const feedback = feedbackSummary(st, cfg);
  const slots = feedbackSlotsForUi(st, cfg.timezone, cfg);
  return { ok: true, at: now, items, alerts, reports, chitchat, feedback, slots,
    guideRecommended: channel?.level === 'bad' || !chatPeer(cfg).trim() || (cfg.dryRun !== false && !hasSent) };
}

export function feedbackSlotsForUi(st, timezone, cfg = null) {
  return Object.entries(slotStats(st)).filter(([, stats]) => stats.sent > 0)
    .sort(([, a], [, b]) => b.sent - a.sent)
    .map(([slot, stats]) => {
      const details = receiptDetails(st, slot, { tz: timezone, cfg });
      return {
        slot, label: topicLabel(slot), ...stats,
        unlistedMisses: Math.max(0, stats.missed - details.filter(row => row.received === false).length),
        receipts: details.map(({ id, ts, received, manual, status }) => ({
          id, at: dayKey(ts, timezone).slice(5) + '日 ' + hhmm(ts, timezone), received, manual,
          ...(status ? { status } : {}),
        })),
      };
    });
}
