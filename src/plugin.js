// plugin.js —— dsh-drop-by 的 dsh 插件壳（宿主半侧）。
//
// 它做的事和 `node src/run.js --loop` 一模一样，只是**不再另开进程**：
//   · 定时器在宿主里每 tickMinutes 敲一拍，调 engine.tick()（和命令行共用同一份判定/生成/发送逻辑）；
//   · 生成走宿主自己的 ctx.llm（hostllm.js），不再 spawn 一个 Electron 跑 headless CLI；
//   · 发送还是走 qq-bridge 的 OneBot HTTP 口（send.js），这条路本来就不依赖进程边界。
//
// 为什么值得搬进来：命令行版本每次生成都要冷启动一次 Electron（12~17s，重写一次 60s），
// 而且得靠 Windows 计划任务 / 开机脚本保证「它一直活着」。住在宿主里这两件事都没了。
//
// 设计上的几条硬规矩：
//   1. **一条 inject 都不声明**。声明即硬依赖——宿主少一个服务，整条插件就不激活。
//      所有服务一律 ctx.get() 取，取不到就降级（没有 llm 就退回 spawn，没有 webServer 就没有状态接口）。
//      ⚠️ 2026-11-04 补：`apply()` 跑的那一刻服务往往**还没 provide**（webServer 由 web-app 稍后提供），
//      这时候 ctx.get() 只能拿到 undefined，而且之后不会有人再来问一次——老写法就是这样把
//      状态接口和 presence_status 全丢掉的（设置页 HTTP 404 的根因）。需要「晚点再挂」的东西
//      一律用 whenService()（内部是 cordis 的 ctx.inject），别在 apply 里取一次就完事。
//   2. **绝不把宿主带崩**。定时器用 setTimeout 链（不是 setInterval），上一拍没跑完不会叠上去；
//      每一拍整体包 try/catch，出错只记一行日志。
//   3. **配置只有一份**。还是仓库里的 config.json，`node src/run.js --set/--live/--stress-set`
//      改的就是它，插件下一拍自动生效（每拍重新读盘，不做缓存）。
//   4. 默认不改行为：dryRun=true 时只记日志、不发消息。

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { abortable } from './exploration-abort.js';
import { loadConfig, saveConfig, loadState, CONFIG_PATH, LOG_DIR } from './config.js';
import { tick, tickDueAgreement, tickQqContinuation, qqContinuationEnabled } from './engine.js';
import { listAgreements, dueAgreement, dismissAgreement, flushAgreementIntake, pruneAgreements } from './agreements.js';
import { applyExplorationFeedback, explorationFeedbackForUi, explorationFeedbackHints, consumeExplorationFeedback, topicInExplorationFeedback } from './exploration-feedback.js';
import { createQqContinuation } from './qq-continuation.js';
import { createCompactChatTools } from './compact-chat-tools.js';
import { characterRestAt } from './character-rest.js';
import { minutesOfDayOf } from './time.js';
import { inQuiet } from './schedule.js';
import { busyNow, builtinYears, deepseekPeakStatus, offPeakNow } from './holidays.js';
import { calendarStatus, refreshCalendar } from './calendar.js';
import { loadPersona } from './persona.js';
import { exploreRound, explorationStatus, explorationMood, loadExploration, saveExploration } from './explore.js';
import { makeHostLlm, setHostLlmContext, setHostLlmTrace, refreshHostModelCatalog } from './hostllm.js';
import { listForUi, explorationItemsForUi, channelItemsForUi, hiddenItemsForSearch, SEARCH_TAGS, applyChange, saveSecret } from './settings.js';
import { detectSources, detectEmotionPortrait } from './detect.js';
import { inspectEmotionPlugin, repairEmotionConfig, appendEmotionInbox, recordExplorationEmotion } from './emotion-sync.js';
import { inspectMemory, mergeMemorySessions, restoreMemoryBackup } from './memorysource.js';
import { updatePortraitMood } from './emotion-portrait.js';
import { watchVideo } from './video-host.js';
import { bindActionExecutor, isHandledActionMessage, tryStopExplorationCommand } from './action-proposal.js';
import { sendQqText } from './qq-send.js';
import { sendQQPrivate } from './send.js';
import { createSessionRollover, pendingRollovers, dismissRollover } from './session-rollover.js';
import { qqRolloverAdapter } from './qq-rollover-adapter.js';
import { installQqPromptMerge, isBridgeManagedMessage } from './qq-debounce.js';
import { executeQqCommand } from './qq-command.js';
import { createExplorationMedia, pickInterestItem, publicExplorationUrl, splitInterestItems } from './explore-media.js';
import { classifyExplorationTarget, resolveExplorationTarget, setExplorationWorkSource, TRUSTED_WORK_CATALOGS } from './exploration-target.js';
import { syncBuiltinExploreFeeds } from './explore-feeds.js';
import { applyPresetToConfig, updatePresetOverride, resetPresetOverride, presetsForUi } from './presets.js';
import {
  registerExploreSource, registerMoodSource, registerMemorySource, registerTopicProvider,
  listExtensions, listExploreSources, notifyExternalMoodMessage, shouldUseBuiltinEmotion, inspectActiveMood,
} from './extensions.js';
import { bridgeLastIn, bridgeLastOut } from './outbound.js';
import { chatBinding, chatChanging, changePrimaryChannel, bindSharedSession, localApiOrigin, localChatApi, markChatBoot, readyDouyinBinding, switchState, switchToQq } from './channels/chat-switch.js';
import { douyinPeer, douyinPeerName, douyinPrimary, pollDelayMs, readDouyinState, sendDouyinText, writeChatData } from './channels/douyin-im.js';
import {
  bindInternalDispatcher, dispatchToHostSession, internalPrimary, internalSessionId,
  isProactiveInternalText, listHostSessions, observeBoundSessionModel, observeInternalEvent, readInternalState,
  sendInternalMessage, sharedSessionId, syncBoundSessionModel, syncInternalHistory, textFromContent,
} from './channels/internal.js';
import { createDouyinSession } from './channels/douyin-session.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer, emotionPeer } from './channels/external.js';
import { agreementLlm, buildReplyContext, observePrivateMessage } from './qq-reply.js';
import { readChatData } from './channels/douyin-im.js';
import { connectivity, diagnostics, feedbackSlotsForUi } from './diagnostics.js';
import { setFeedbackReceipt } from './feedback.js';
import { explainRun, topicLabel } from './explain.js';

export const name = 'dsh-drop-by';

/** 不声明任何必需服务（见文件头第 1 条）。 */
export const inject = [];

/** 状态接口前缀（浏览器/curl 都能看）。 */
const API_PREFIX = '/api/dsh-drop-by';

const DEFAULTS = {
  enabled: true,
  // 宿主刚起来那会儿会话/模型都还没热，先让一拍
  startupDelaySec: 60,
  // 每拍随机抖 0~jitterSec 秒：避免每次开机都在整点同一秒打模型
  jitterSec: 30,
  // 用宿主自己的模型；关掉就退回 llm.js（spawn dsh CLI）
  hostLlm: true,
  // 给模型一个 presence_status 工具
  tool: true,
  // 注册 /api/dsh-drop-by/state
  statusApi: true,
};

/** 取可选服务（cordis 的 ctx 没有对应 inject 时属性访问会抛，必须走 get + try）。 */
function serviceOf(ctx, key) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch {
    /* 没 inject，往下走 */
  }
  try {
    return ctx[key] ?? null;
  } catch {
    return null;
  }
}

const LOOPBACK_HOST_RE = /^(?:localhost|\[::1\]|127(?:\.\d{1,3}){3})$/i;

function firstHeader(headers, name) {
  const v = headers?.[name];
  return String(Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

function connectionOf(c, ctx) {
  const isConn = (v) => Boolean(v && (typeof v.requestRejection === 'function' || typeof v.admit === 'function'));
  const candidates = [
    () => serviceOf(c, 'connection'),
    () => serviceOf(ctx, 'connection'),
    () => (c && typeof c === 'object' ? Reflect.get(c, 'connection') : null),
    () => (ctx && typeof ctx === 'object' ? Reflect.get(ctx, 'connection') : null),
    () => c?.root?.connection,
    () => ctx?.root?.connection,
  ];
  for (const probe of candidates) {
    try {
      const v = probe();
      if (isConn(v)) return v;
    } catch {
      /* 忽略未注入或无权限访问，继续下一路 */
    }
  }
  return null;
}

function localOriginRejection(req) {
  const headers = req?.headers || {};
  const rawHost = firstHeader(headers, 'host');
  const rawOrigin = firstHeader(headers, 'origin');
  const secFetch = firstHeader(headers, 'sec-fetch-site').toLowerCase();
  if (!rawHost && !rawOrigin && !secFetch) return null;

  if (secFetch === 'cross-site') return 403;
  let parsedHost = null;
  if (rawHost) {
    try {
      parsedHost = new URL(`http://${rawHost}`);
    } catch {
      return 403;
    }
    if (!LOOPBACK_HOST_RE.test(parsedHost.hostname)) return 403;
  }
  if (rawOrigin && rawOrigin !== 'null') {
    try {
      const originUrl = new URL(rawOrigin);
      if (parsedHost ? originUrl.host !== parsedHost.host : !LOOPBACK_HOST_RE.test(originUrl.hostname)) return 403;
    } catch {
      return 403;
    }
  } else if (rawOrigin === 'null') {
    return 403;
  }
  return null;
}

/**
 * 入口访问检查：优先交由宿主 ctx.connection.requestRejection(req) / admit(req) 判定；
 * 若宿主未提供 connection 服务（如老宿主或裸测），对带浏览器来源头的请求做回环同源兜底。
 */
function rejectIfUntrusted(req, c, ctx, json) {
  const conn = connectionOf(c, ctx);
  if (conn) {
    try {
      const reqArg = req && typeof req === 'object' ? (req.headers ? req : { ...req, headers: {} }) : { headers: {} };
      if (typeof conn.requestRejection === 'function') {
        const rej = conn.requestRejection(reqArg);
        if (rej !== undefined && rej !== null && rej !== false) {
          const code = typeof rej === 'number' && rej > 0 ? rej : (Number(rej?.status ?? rej?.statusCode) || 403);
          json(code, { ok: false, error: code === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' });
          return true;
        }
        return false;
      }
      if (typeof conn.admit === 'function') {
        const admission = conn.admit(reqArg);
        if (admission && typeof admission === 'object' && 'rejection' in admission && admission.rejection !== undefined) {
          const code = Number(admission.rejection) || 403;
          json(code, { ok: false, error: code === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN' });
          return true;
        }
        const kind = admission?.peer?.principal?.kind;
        if (kind !== undefined && kind !== 'owner') {
          json(403, { ok: false, error: 'FORBIDDEN' });
          return true;
        }
        return false;
      }
    } catch {
      json(403, { ok: false, error: 'FORBIDDEN' });
      return true;
    }
  }

  const fallbackCode = localOriginRejection(req);
  if (fallbackCode) {
    json(fallbackCode, { ok: false, error: 'FORBIDDEN' });
    return true;
  }
  return false;
}

/**
 * 等一个服务就绪再干活（cordis 的延迟注入）。
 *
 * ⚠️ 为什么必须有这个：`apply()` 是在插件**装载那一刻**跑的，而 `webServer` / `tools`
 * 这些服务由别的插件稍后 provide。那时 `ctx.get('webServer')` 还是 undefined，
 * 老写法（apply 里直接取一次，取不到就算了）就永远挂不上 —— 表现是设置页
 * `GET /api/dsh-drop-by/state` 落到宿主鉴权层，浏览器只看到 HTTP 404。
 * `ctx.inject(deps, cb)` 是 cordis 官方的解法：服务一提供，cb 自己会被调起来。
 *
 * 没有 `ctx.inject`（老宿主 / 裸调用）就退回「当场试一次」，行为跟以前一样。
 */
function whenService(ctx, name, cb, log) {
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject([name], (c) => cb(c || ctx));
      return;
    } catch (e) {
      log?.warn?.(`${name} 延迟注入失败：${String(e?.message || e).slice(0, 120)}`);
    }
  }
  cb(ctx);
}

/** 往 logs/plugin.log 记一行（宿主 console 拿不到，只能自己留痕）。 */
function noteMount(msg) {
  try {
    const envLog = String(process.env.PG_LOG_DIR || '').trim();
    const envCfg = String(process.env.PG_CONFIG_PATH || '').trim();
    const dir = envLog
      ? path.resolve(envLog)
      : (envCfg ? path.join(path.dirname(path.resolve(envCfg)), 'logs') : LOG_DIR);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'plugin.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* 日志不该影响主流程 */
  }
}

/** 打日志：宿主有 logger 就用它，没有就退 console（headless 调试时看得见）；warn/error 同步落盘。 */
function makeLog(ctx) {
  const logger = serviceOf(ctx, 'logger');
  const tag = '[dsh-drop-by]';
  const emit = (level, msg) => {
    if (level === 'warn' || level === 'error') noteMount(`${level}: ${msg}`);
    try {
      if (logger && typeof logger[level] === 'function') return logger[level](msg);
      if (logger && typeof logger === 'function') return logger(msg);
    } catch {
      /* 日志永远不该影响主流程 */
    }
    const line = `${tag} ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

const hhmmss = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 读请求体（设置页最多几十字节；给 64KB 上限，别让人拿它当上传口）。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        try {
          req.destroy?.();
        } catch {
          /* 已经断了 */
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 一拍的人话摘要（写日志用）。 */
function summaryLine(r, ms) {
  const rec = r?.record || {};
  const bits = [hhmmss(rec.ts), rec.decision || '?', rec.reason || ''];
  const slot = rec.topic?.slot;
  if (slot) bits.push(`由头 ${slot}`);
  const text = rec.content?.text || '';
  if (text) bits.push(`${rec.content.chars} 字「${text.slice(0, 40)}」`);
  const dl = rec.delivery;
  if (dl) bits.push(dl.attempted ? (dl.ok ? '已发' : `发送失败 ${dl.error || ''}`) : `未发 ${dl.reason || ''}`);
  bits.push(`${Math.round(ms / 100) / 10}s`);
  return bits.filter(Boolean).join(' · ');
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 来自 cordis.patch.yml 的 `config:`（全部可选）
 */
export function apply(ctx, config = {}) {
  const opt = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  setHostLlmContext(ctx);
  const log = makeLog(ctx);
  setHostLlmTrace((msg) => { noteMount(msg); log.info(msg); });
  syncBuiltinExploreFeeds(loadConfig);
  let controllerService, projectionsService, registryService, sessionsService, persistenceService;
  const sessionController = () => controllerService || serviceOf(ctx, 'sessionController');
  const workspaceRegistry = () => registryService || serviceOf(ctx, 'workspaceRegistry');
  const sessionsHost = () => sessionsService || serviceOf(ctx, 'sessions');
  const sessionPersistence = () => persistenceService || serviceOf(ctx, 'sessionPersistence');
  const sessionProjections = () => projectionsService || serviceOf(ctx, 'sessionProjections');

  let disposed = false;
  let running = false;
  let previewRunning = false;
  let timer = null;
  let continuationTimer = null;
  let explorationRun = null;
  let explorationRunNotice = null;
  let explorationTopicIssue = null;
  let explorationToolsCtx = null;
  let explorationWebCtx = null;
  let lastExploreAttempt = 0;
  const continuation = createQqContinuation();
  const rolloverFile = path.join(path.dirname(CONFIG_PATH), 'data', 'session-handoff.json');
  const qqAdapter = qqRolloverAdapter();
  const douyinBindingMeta = (b, cfg) => ({
    ...b.qqBinding,
    peerId: b.qqBinding?.peerId || douyinPeer(cfg),
    peerKind: 'private',
    peerName: b.qqBinding?.peerName || douyinPeerName(cfg),
    enabled: true,
  });
  const rolloverAdapter = {
    stripSourceHeader: qqAdapter.stripSourceHeader,
    bindingFor(id) {
      const cfg = loadConfig();
      if (internalPrimary(cfg)) {
        const sid = internalSessionId();
        return sid && sid === id ? { peerId: sid, peerKind: 'private' } : null;
      }
      if (!douyinPrimary(cfg)) return qqAdapter.bindingFor(id);
      const b = readyDouyinBinding();
      if (!b || b.sessionId !== id) return null;
      const { peerId, peerKind } = douyinBindingMeta(b, cfg);
      return peerId ? { peerId, peerKind } : null;
    },
    bindingMeta(id) {
      const cfg = loadConfig();
      if (internalPrimary(cfg)) {
        const b = chatBinding();
        return b.sessionId === id || b.preparedSessionId === id
          ? { ...b.qqBinding, peerId: id, peerKind: 'private', peerName: b.sessionTitle || '内部会话', enabled: true }
          : null;
      }
      if (!douyinPrimary(cfg)) return qqAdapter.bindingMeta(id);
      const b = chatBinding();
      return b.sessionId === id || b.preparedSessionId === id ? douyinBindingMeta(b, cfg) : null;
    },
    prepareBinding(handoff) {
      const cfg = loadConfig();
      if (!douyinPrimary(cfg) && !internalPrimary(cfg)) return qqAdapter.prepareBinding(handoff);
      const b = chatBinding();
      if (b.sessionId !== handoff.oldSessionId) return false;
      writeChatData('external-chat', { ...b, preparedSessionId: handoff.newSessionId });
      return true;
    },
  };
  const douyin = createDouyinSession({
    getConfig: loadConfig, controller: sessionController, log,
    onIncoming({ cfg, peer, text, ts, item, title }) {
      if (disposed || opt.enabled === false) return;
      tryStopExplorationCommand({ cfg, peer, kind: 'private', text, at: ts });
      observePrivateMessage(ctx, { cfg, peer, text, at: ts, item, title });
    },
    async prepare({ cfg, peer, text, at, items }) {
      const context = await buildReplyContext(ctx, { cfg, peer, kind: 'private', text, at, bridgeText: items.at(-1)?.text,
        messageTimes: items.map(item => item.ts), directionTurns: items.slice(0, -1), observed: true });
      const clip = items.findLast(item => item.item);
      let video = '';
      if (clip && cfg.content?.forward?.enabled !== false) {
        const host = llmNow(cfg);
        if (host.ready) {
          try {
            const v = await watchVideo(clip.item, { cfg, host, llm: host.generate, ctx });
            if (v?.ok && v.summary) video = '视频观察资料，仅按实际证据回应：' + v.summary;
          } catch (error) { log.warn('抖音视频观察：' + error.message); }
        }
      }
      return ['<external_reply_context>', context, video,
        '只回复本次抖音私信正文。直接输出给联系人的正文，发送由宿主完成。不要调用外部聊天发送工具。没有视频证据时不要声称看过。',
        '</external_reply_context>'].filter(Boolean).join('\n');
    },
    onSent: ({ cfg, peer, text, at }) => {
      if (shouldUseBuiltinEmotion(cfg, at)) appendEmotionInbox({ user: emotionPeer(cfg), role: 'ai', text, t: at });
      notifyExternalMoodMessage({ peer: emotionPeer(cfg), role: 'ai', text, at, channel: 'douyin', cfg });
    },
  });
  let ticks = 0;
  let lastAt = 0;
  let nextAt = 0;
  let lastError = null;
  let lastRun = null;

  const tickMinutes = () => {
    return Math.max(1, Number(loadConfig().tickMinutes) || 10);
  };

  /** 现在的生成器：优先宿主模型，不可用就返回 null（让 compose 走 llm.js 那条老路）。 */
  function llmNow(cfg, { quiet = false, forExploration = false } = {}) {
    if (opt.hostLlm === false) return { ready: false, reason: 'HOST_LLM_OFF' };
    const h = makeHostLlm(ctx, { cfg, log: quiet ? undefined : log.warn, forExploration });
    if (!h.ready) return h;
    return h;
  }

  /** 跑一拍。绝不抛。 */
  async function runOnce(reason = 'timer', { preview = false } = {}) {
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (running || (preview && previewRunning)) return { ok: false, skipped: 'busy' };

    if (preview) previewRunning = true;
    else running = true;
    const t0 = Date.now();
    try {
      const cfg = loadConfig();
      if (opt.enabled === false || cfg.enabled === false) {
        if (!preview) return { ok: false, skipped: 'disabled' };
        const record = { decision: 'skip', reason: 'PLUGIN_DISABLED' };
        return { ok: true, preview, run: { decision: record.decision, why: record.reason, explanation: explainRun({ record, cfg, preview }) } };
      }

      const host = llmNow(cfg, { quiet: preview });
      if (!preview && !host.ready) log.info(`宿主模型不可用（${host.reason || '?'}），这一拍退回命令行生成器`);

      const r = await tick({
        preview,
        generate: host.ready ? host.generate : null,
        llmReady: host.ready ? true : null,
        watchVideo: (id, options) => watchVideo(id, { ...options, host, ctx }),
      });

      const at = Date.now();
      const slot = r.record?.topic?.slot || r.record?.content?.slot || null;
      const source = r.record?.content?.source || '';
      const generated = /^(?:llm|llm-retry|judge|project-check-in)$/.test(source);
      const llm = host.ready ? { via: 'host', provider: host.provider, model: host.model } : { via: 'cli' };
      let explanation = r.explanation;
      if (preview && ['DATA_UNAVAILABLE', 'CHITCHAT_NO_MODEL', 'LLM_NOT_READY'].includes(r.record?.reason)) {
        const health = await connectivity({ cfg: r.cfg, host, now: at });
        explanation = explainRun({ record: r.record, cfg: r.cfg, health, preview });
      }
      const run = {
        at,
        reason,
        decision: r?.record?.decision || null,
        why: r?.record?.reason || null,
        slot: preview ? slot : r.record?.topic?.slot || null,
        ...(preview && slot ? { topicLabel: topicLabel(slot) } : {}),
        topicMisses: r.record?.topicMisses || [],
        explanation,
        chars: r?.record?.content?.chars || 0,
        text: preview && r.record?.decision !== 'send' ? '' : r.record?.content?.text || '',
        delivery: r?.record?.delivery || null,
        mail: r?.record?.mail || null,
        llm: preview ? (generated && host.ready ? llm : null) : llm,
        ms: at - t0,
      };
      if (preview) return { ok: true, preview, run };

      ticks += 1;
      lastAt = at;
      lastRun = run;
      lastError = null;
      log.info(summaryLine(r, lastAt - t0));
      return { ok: true, run: lastRun };
    } catch (e) {
      if (preview) return { ok: false, preview, error: '安全试跑未能完成。请先运行连通测试，再试一次。' };
      lastError = String(e?.message || e).slice(0, 300);
      log.error(`这一拍出错（已兜住）：${lastError}`);
      return { ok: false, error: lastError };
    } finally {
      if (preview) previewRunning = false;
      else running = false;
    }
  }

  function intervalMs() {
    const base = tickMinutes() * 60_000;
    const jitter = Math.max(0, Number(loadConfig().tickJitterSec ?? opt.jitterSec) || 0) * 1000;
    return base + (jitter ? Math.floor(Math.random() * jitter) : 0);
  }

  function stopExploration(runId, reason = 'CANCELLED') {
    const run = explorationRun;
    if (!run) return { ok: false, reason: 'NOT_RUNNING' };
    if (runId && run.id !== runId) return { ok: false, reason: 'STALE_RUN' };
    explorationRun = null;
    explorationRunNotice = reason;
    clearTimeout(run.timer);
    run.controller.abort(new Error(reason));
    return { ok: true, reason };
  }

  function stopDisabledAutoExploration(cfg) {
    if (cfg.exploration.auto !== true && explorationRun && !explorationRun.manual) stopExploration();
  }

  async function runExploration(manual = false, retry = null, onRetryEvidence, requestedResearch, manualTopic = '') {
    if (disposed || opt.enabled === false || explorationRun) return { ok: false, reason: 'UNAVAILABLE' };
    const cfg = loadConfig();
    const now = Date.now();
    if (cfg.enabled === false || (!manual && cfg.exploration.auto !== true)) return { ok: false, reason: 'DISABLED' };
    if (!manual && characterRestAt(cfg, now).asleep) return { ok: false, reason: 'CHARACTER_ASLEEP' };
    if (!requestedResearch && (inQuiet(now, cfg.quietHours, cfg.timezone) || ((!manual || retry) && busyNow(now, cfg)))) {
      return { ok: false, reason: 'QUIET_OR_BUSY' };
    }
    if (!manual && !retry && !requestedResearch && cfg.exploration?.offPeakOnly === true && !offPeakNow(now, cfg)) {
      return { ok: false, reason: 'PEAK_HOURS' };
    }
    const persona = loadPersona({ cfg });
    if (!persona.ok) return { ok: false, reason: 'NO_PERSONA' };
    const previous = loadExploration();
    const status = explorationStatus(previous, persona);
    if (retry && (previous?.personaKey !== retry.personaKey || status.lastAt !== retry.roundAt ||
        cfg.rules?.actionGate?.enabled !== true || cfg.exploration.web !== true)) return { ok: false, reason: 'STALE_RETRY' };
    const interval = Math.max(30, Number(cfg.exploration.intervalMinutes) || 180) * 60_000;
    if (!manual && now - Math.max(lastExploreAttempt, status.lastAt || 0) < interval) return { ok: false, reason: 'NOT_DUE' };
    const host = llmNow(cfg, { forExploration: true });
    if (!host.ready) return { ok: false, reason: host.reason || 'HOST_LLM_MISSING' };
    const explicitTopic = String(manualTopic || '').trim();
    const configuredTopic = String(cfg.exploration?.nextTopic || '').trim();
    const focusTopic = requestedResearch ? '' : (explicitTopic || (!retry ? configuredTopic : ''));
    const initialFeedback = retry || requestedResearch ? null : explorationFeedbackHints(cfg, status, now);
    const feedback = focusTopic ? null : initialFeedback;
    const job = { id: randomUUID(), manual, controller: new AbortController() };
    const { signal } = job.controller;
    const budget = Math.max(10_000, Math.min(1_800_000, Number(cfg.exploration.roundBudgetMs) || 300_000));
    job.timer = setTimeout(() => stopExploration(job.id, 'EXPLORATION_TIMEOUT'), budget);
    explorationRun = job;
    explorationRunNotice = null;
    lastExploreAttempt = now;
    const generate = (args) => abortable(() => host.generate({ ...args, signal }), signal);
    try {
      const media = createExplorationMedia({ timing: cfg.exploration, signal,
        tools: serviceOf(explorationToolsCtx || ctx, 'tools'),
        webService: serviceOf(explorationWebCtx || explorationToolsCtx || ctx, 'web'),
        web: cfg.exploration.web === true, video: cfg.exploration.video === true,
        extraTools: cfg.exploration.extraTools || '',
        exploreSources: listExploreSources(),
        observeVideo: host.observeVideo && ((args) => abortable(() => host.observeVideo({ ...args, signal }), signal)),
        saveImage: host.saveImage && ((args) => abortable(() => host.saveImage(args), signal)),
        browseMode: cfg.exploration?.browseMode || 'vision_light',
        browseMaxSteps: cfg.exploration?.browseMaxSteps ?? 40,
        edgePort: cfg.content?.forward?.edgePort ?? 9223,
        edgeAutostart: cfg.content?.forward?.edgeAutostart !== false,
        edgeScript: cfg.content?.forward?.edgeScript || '',
        watchDouyin: (id) => watchVideo(id, { cfg, host, llm: generate, ctx: explorationToolsCtx || ctx, signal }),
      });
      const sourceUrl = publicExplorationUrl(requestedResearch?.sourceUrl || '');
      const issues = [];
      let workTarget = sourceUrl ? { title: requestedResearch.topic || sourceUrl.hostname,
        hosts: [sourceUrl.hostname], url: sourceUrl.href, useBrowser: requestedResearch.resumedAfterLogin === true } : null;
      if (retry && previous?.lastRun?.workScope) {
        workTarget = previous.lastRun.workScope;
      }
      let selectedFocus = focusTopic;
      let selectedInterest = cfg.exploration.interest;
      if (!retry && !requestedResearch) {
        const items = splitInterestItems(selectedInterest);
        const first = items.length === 1 ? items[0] : pickInterestItem(selectedInterest, { roundCount: previous?.roundCount,
          recentTopics: [status.thread?.topic, status.leisure?.topic, status.light?.topic] });
        const field = focusTopic ? (explicitTopic ? '' : 'nextTopic') : 'interest';
        const inputs = focusTopic ? [focusTopic] : [...new Set([first, ...items])].filter(item => item.trim());
        for (const input of inputs) {
          const target = await abortable(() => resolveExplorationTarget(input, { workSources: cfg.exploration.workSources,
            lookup: media?.lookupWork && ((title) => media.lookupWork(title, TRUSTED_WORK_CATALOGS)), signal }), signal);
          signal.throwIfAborted();
          if (target.reason || (target.kind === 'work' && !media?.workWeb)) {
            issues.push({ input, title: target.title, field, reason: target.reason || 'WORK_SOURCE_UNAVAILABLE',
              candidates: target.candidates || [] });
            continue;
          }
          if (focusTopic) selectedFocus = target.title;
          else selectedInterest = target.title;
          if (target.kind === 'work') workTarget = { ...target, field };
          break;
        }
        const current = loadConfig().exploration;
        if (current.interest !== cfg.exploration.interest || current.nextTopic !== cfg.exploration.nextTopic ||
            current.workSources !== cfg.exploration.workSources) return { ok: false, reason: 'CANCELLED' };
        explorationTopicIssue = issues[0] || null;
        if (inputs.length && issues.length === inputs.length) return { ok: false, reason: issues[0].reason };
      }
      const minuteNow = minutesOfDayOf(now, cfg.timezone);
      const nightShare = characterRestAt(cfg, now).windDown || minuteNow >= 21 * 60 + 30 || minuteNow < 6 * 60;
      const roundMedia = workTarget || media?.web || media?.video || media?.extSources.length ? media : null;
      const r = await abortable(() => exploreRound({ persona, previous, interest: selectedInterest, focusTopic: selectedFocus, workTarget, now, generate,
        includeMood: cfg.exploration.mood === true, media: roundMedia, bias: cfg.exploration.bias, leisureEvery: cfg.exploration.leisureEvery,
        timing: cfg.exploration, retry, requestedResearch, topicFeedback: feedback, night: nightShare }), signal);
      signal.throwIfAborted();
      const fresh = loadConfig();
      if (disposed || fresh.enabled === false || (!manual && fresh.exploration.auto !== true) ||
          (retry && (fresh.rules?.actionGate?.enabled !== true || fresh.exploration.web !== true)) ||
          (requestedResearch && fresh.rules?.qqCommands?.enabled !== true) ||
          loadPersona({ cfg: fresh }).text !== persona.text) return { ok: false, reason: 'CANCELLED' };
      if (workTarget?.field !== undefined && (fresh.exploration.workSources !== cfg.exploration.workSources ||
          fresh.exploration[workTarget.field] !== cfg.exploration[workTarget.field])) return { ok: false, reason: 'CANCELLED' };
      if (!r.ok) {
        if (r.reason === 'WORK_SOURCE_UNAVAILABLE' && workTarget?.input) {
          explorationTopicIssue = { input: workTarget.input, title: workTarget.title, field: workTarget.field,
            reason: r.reason, candidates: [] };
        }
        log.warn(`自主探索未完成：${r.reason || 'UNKNOWN'}${r.note ? `（${r.note}）` : ''}`);
        return r;
      }
      const freshTopic = String(fresh.exploration?.nextTopic || '').trim();
      if (focusTopic && !explicitTopic && freshTopic !== configuredTopic) return { ok: false, reason: 'CANCELLED' };
      if (initialFeedback && r.action !== 'skip') {
        const completed = [r.state.thread, r.state.leisure, r.state.light].find(entry => entry?.at === now);
        if (completed && !topicInExplorationFeedback(completed.topic, initialFeedback.avoid) &&
            topicInExplorationFeedback(completed.topic, explorationFeedbackHints(fresh, status).avoid)) {
          return { ok: false, reason: 'CANCELLED' };
        }
      }
      saveExploration(r.state);
      if (r.action !== 'skip') consumeExplorationFeedback(fresh, feedback);
      // 仅在「近一轮探索主题」确实在本轮产生非跳过结果后自动消费清空，避免用户误卡死未来探索。
      const resumedTopic = sourceUrl && classifyExplorationTarget(freshTopic, fresh.exploration.workSources).title === workTarget.title;
      if (r.action !== 'skip' && freshTopic && ((focusTopic && !explicitTopic && freshTopic === focusTopic) || resumedTopic)) {
        saveConfig({ ...fresh, exploration: { ...fresh.exploration, nextTopic: '' } });
      }
      if (r.action !== 'skip') {
        const explorationText = recordExplorationEmotion({ state: r.state, cfg: fresh });
        if (explorationText && shouldUseBuiltinEmotion(fresh, now) && emotionPeer(fresh) && host.ready) {
          void updatePortraitMood({
            cfg: fresh,
            persona,
            peer: emotionPeer(fresh),
            text: explorationText,
            at: r.state.lastAt || now,
            generate: host.generate,
            exploration: r.state.mood?.text || '',
            sourceLabel: '当前自主探索记录',
          }).catch((e) => log.warn('探索情绪更新失败：' + String(e?.message || e).slice(0, 120)));
        }
      }
      const foundBody = retry && r.state.lastRun?.sources?.some((source) => source.evidence === '网页正文') === true;
      if (retry) onRetryEvidence?.({ ok: true, foundBody });
      return { ok: true, action: r.action, ...explorationStatus(r.state, persona), ...(retry ? { foundBody } : {}) };
    } catch (e) {
      if (signal.aborted) return { ok: false, reason: signal.reason.message };
      log.warn(`自主探索失败：${String(e?.message || e).slice(0, 160)}`);
      return { ok: false, reason: 'EXPLORATION_ERROR' };
    } finally {
      clearTimeout(job.timer);
      if (explorationRun === job) explorationRun = null;
    }
  }

  const actionExecutor = {
    stopExploration,
    run: ({ params }, onRetryEvidence) => runExploration(true, params, onRetryEvidence),
    command: (cmd, cfg) => executeQqCommand({
      cmd, cfg,
      media: (cmd.type === 'explore_query' || cmd.type === 'browse_url') ? createExplorationMedia({
        tools: serviceOf(explorationToolsCtx || ctx, 'tools'),
        webService: serviceOf(explorationWebCtx || explorationToolsCtx || ctx, 'web'),
        web: cfg.exploration.web === true, timing: cfg.exploration,
      }) : null,
      explore: (request) => runExploration(true, null, null, request),
      state: loadExploration, persona: () => loadPersona({ cfg }),
    }),
    deferReport(entry) {
      const store = readChatData('task-callbacks');
      writeChatData('task-callbacks', { pending: [...(store.pending || []), entry] });
    },
    async report({ peer, result, cfg, command }) {
      const text = command ? result?.text || '这条任务没跑完，暂时没有结果。' : !result?.ok ? '这次换源没跑完，我先把这个坑留着。'
        : result.foundBody ? '换了个站，正文找到了。'
          : '换了来源找过，还是没拿到正文。';
      const sent = internalPrimary(cfg)
        ? await sendInternalMessage({ cfg, sessionId: peer, text, source: 'task' })
        : douyinPrimary(cfg)
          ? await sendDouyinText({ cfg, peer, text, source: 'task' })
          : await sendQqText({ to: peer, text, cfg, confirm: true, track: true });
      if (!sent.ok || sent.dryRun) log.warn('任务结果没能发到当前主通道：' + (sent.error || '演练模式'));
      return sent;
    },
  };
  const releaseActionExecutor = opt.enabled === false ? () => {} : bindActionExecutor(actionExecutor);
  const releaseInternalDispatcher = opt.enabled === false ? () => {} : bindInternalDispatcher(
    ({ sessionId, wrapped, cfg, timeoutMs }) => dispatchToHostSession({
      sessionId, wrapped, cfg, controller: sessionController(), sessions: sessionsHost(), timeoutMs,
    }),
  );

  async function flushTaskResults(cfg) {
    if (chatChanging() || cfg.dryRun !== false || cfg.send?.enabled !== true) return;
    const store = readChatData('task-callbacks');
    const pending = store.pending || [];
    const channel = activeChatChannel(cfg);
    const peer = chatPeer(cfg);
    const index = pending.findIndex(item => item.channel === channel && item.peer === peer);
    if (index < 0) return;
    const entry = pending[index];
    const result = await actionExecutor.report({ ...entry, cfg });
    if (result?.ok) {
      const latest = readChatData('task-callbacks').pending || [];
      writeChatData('task-callbacks', { pending: latest.filter((_, i) => i !== index) });
    }
  }

  function schedule(delayMs) {
    if (disposed) return;
    nextAt = Date.now() + delayMs;
    timer = setTimeout(async () => {
      timer = null;
      await runOnce('timer');
      schedule(intervalMs());
      await runExploration().catch((e) => log.warn(`自主探索失败：${String(e?.message || e).slice(0, 160)}`));
    }, Math.max(0, delayMs));
    // 不阻止宿主退出（Node 的 unref；Electron 里同样有效）
    timer.unref?.();
  }

  let lastQuickInbound = '';

  async function processAgreements(cfg, now) {
    if (opt.enabled === false || cfg.enabled === false || cfg.agreements?.enabled !== true) return false;
    pruneAgreements(cfg, now);
    const source = { channel: activeChatChannel(cfg), peer: chatPeer(cfg) };
    if (!source.peer || !canReadChat(cfg) || chatChanging() || inQuiet(now, cfg.quietHours, cfg.timezone)) return false;
    if (source.channel === 'qq') {
      const { incoming } = chatDialogue(cfg);
      const key = [incoming.peer, incoming.ts, incoming.text].join(':');
      const age = now - incoming.ts;
      if (key !== lastQuickInbound && incoming.kind === 'private' && incoming.peer === source.peer && incoming.observedAt &&
          age >= 0 && age <= Number(cfg.rules?.qqCommands?.freshSec ?? 120) * 1000) {
        lastQuickInbound = key;
        observePrivateMessage(ctx, { cfg, peer: source.peer, text: incoming.text, at: incoming.ts, timingOnly: true });
      }
    }
    void flushAgreementIntake(cfg, now, source).catch(() => {});
    if (running || !dueAgreement(cfg, now, source)) return false;
    running = true;
    try {
      const generate = opt.hostLlm === false ? null : agreementLlm(ctx, cfg, { temperature: 0.75, maxTokens: 256 });
      const result = await tickDueAgreement({ active: () => !disposed && opt.enabled !== false, generate });
      if (result && !result.ok) log.warn('小本本约定发送回执未确认');
      return Boolean(result);
    } finally {
      running = false;
    }
  }

  // 秒级检查热聊补话、短时来信和到期约定，不重复跑邮件、感知和普通主动消息。
  function scheduleContinuation() {
    if (disposed) return;
    continuationTimer = setTimeout(async () => {
      try {
        const cfg = loadConfig();
        const now = Date.now();
        if (await processAgreements(cfg, now)) return;
        if (opt.enabled !== false && cfg.enabled !== false && !running &&
            (!douyinPrimary(cfg) || !!readyDouyinBinding())) await flushTaskResults(cfg);
        if (opt.enabled === false || !qqContinuationEnabled(cfg) ||
            inQuiet(now, cfg.quietHours, cfg.timezone) || busyNow(now, cfg) || characterRestAt(cfg, now).asleep) {
          continuation.observe({ incoming: {}, outgoing: {} }, '', now);
          return;
        }
        const channel = activeChatChannel(cfg);
        const due = continuation.observe(chatDialogue(cfg), chatPeer(cfg), now, cfg.rules.qqTiming);
        if (!due || running || isHandledActionMessage(due.incoming.peer, due.incoming.ts, channel) ||
            (channel === 'qq' && isBridgeManagedMessage(due.incoming.peer, due.incoming.ts, now, Number(cfg.rules?.qqTiming?.inFlightSec ?? 180) * 1000, true))) return;
        continuation.consume(due);
        const host = llmNow(cfg);
        if (!host.ready) return;
        running = true;
        try {
          await tickQqContinuation({ candidate: due, read: () => chatDialogue(loadConfig()), generate: host.generate, active: () => !disposed });
        } finally {
          running = false;
        }
      } catch (e) {
        log.warn(`热聊补话出错：${String(e?.message || e).slice(0, 160)}`);
      } finally {
        scheduleContinuation();
      }
    }, Number(loadConfig().rules?.qqTiming?.pollSec ?? 2) * 1000);
    continuationTimer.unref?.();
  }

  function activeBoundSession(cfg = loadConfig()) {
    const binding = chatBinding();
    if (!internalPrimary(cfg) && !douyinPrimary(cfg)) {
      const qqActive = qqAdapter.activeSessionForPeer?.(cfg.channels?.qq?.peerId);
      if (qqActive?.sessionId) {
        return {
          ...binding,
          sessionId: qqActive.sessionId,
          sessionTitle: binding.sessionId === qqActive.sessionId ? (binding.sessionTitle || '') : '',
        };
      }
    }
    return binding;
  }

  const compactChatTools = createCompactChatTools({
    getConfig: () => disposed || opt.enabled === false ? null : loadConfig(),
    getSessionId: (cfg) => {
      if (chatChanging()) return '';
      if (internalPrimary(cfg)) return internalSessionId();
      if (douyinPrimary(cfg)) return readyDouyinBinding({ readOnly: true })?.sessionId || '';
      return qqAdapter.activeSessionForPeer(cfg.channels?.qq?.peerId)?.sessionId || '';
    },
    getHost: () => ({ agents: serviceOf(ctx, 'agents'), tools: serviceOf(ctx, 'tools') }),
    getTools: (agent) => serviceOf(agent.ctx, 'tools'),
    warn: log.warn,
  });

  /** 状态快照：状态接口、工具、以及 --status 之外的自检都用它。 */
  function snapshot() {
    const cfg = loadConfig();
    const binding = activeBoundSession(cfg);
    const isDy = douyinPrimary(cfg);
    const isInt = internalPrimary(cfg);
    const internalState = isInt && binding.sessionId ? readInternalState(binding.sessionId) : null;
    let st = {};
    try {
      st = loadState();
    } catch {
      st = {};
    }
    const llm = lastRun?.llm || null;
    return {
      plugin: name,
      enabled: opt.enabled !== false && cfg.enabled !== false,
      dryRun: cfg.dryRun !== false,
      tickMinutes: tickMinutes(),
      ticks,
      running,
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      nextAt: nextAt ? new Date(nextAt).toISOString() : null,
      lastError,
      last: lastRun,
      compactChatTools: compactChatTools.status(),
      agreements: { enabled: cfg.agreements?.enabled === true, timezone: cfg.timezone, items: listAgreements(cfg).map(
        ({ id, title, dueAt, explicit }) => ({ id, title, dueAt, explicit })) },
      exploration: (() => {
        const state = loadExploration();
        const persona = loadPersona({ cfg });
        const peakStatus = deepseekPeakStatus(Date.now(), cfg);
        const status = explorationStatus(state, persona);
        return { ...status, feedback: explorationFeedbackForUi(status, cfg), auto: cfg.exploration.auto, mode: cfg.exploration?.mode === 'light' ? 'light' : 'deep', running: Boolean(explorationRun),
          runId: explorationRun?.id || null, runNotice: explorationRunNotice, topicIssue: explorationTopicIssue,
          offPeakOnly: cfg.exploration.offPeakOnly === true,
          pausedForRest: cfg.exploration.auto === true && characterRestAt(cfg).asleep,
          nextTopic: String(cfg.exploration?.nextTopic || ''),
          peakStatus,
          mood: cfg.exploration.mood === true ? explorationMood(state, persona, Date.now(), cfg.exploration) : null };
      })(),
      today: {
        real: Number(st?.real?.todaySent) || 0,
        sim: Number(st?.sim?.todaySent) || 0,
      },
      content: {
        mode: String(cfg?.content?.mode || 'auto'),
        llm,
      },
      externalChat: {
        primary: cfg.channels.primary,
        restartRequired: isDy && !!switchState().restartBoot,
        sessionId: binding.sessionId || '',
        sessionTitle: binding.sessionTitle || internalState?.title || '',
        sharedWithQq: Boolean(binding.qqBinding?.peerId),
        ...(isInt ? {
          bound: Boolean(binding.sessionId),
          syncedAt: internalState?.syncedAt || 0,
          lastUserAt: internalState?.incoming?.ts || 0,
        } : {}),
        ...(isDy ? {
          polledAt: readDouyinState(douyinPeer(cfg)).polledAt,
          status: readDouyinState(douyinPeer(cfg)).pollError || readDouyinState(douyinPeer(cfg)).replyError || '',
          gap: !!readDouyinState(douyinPeer(cfg)).gap,
          retryAt: readDouyinState(douyinPeer(cfg)).retryAt,
        } : {}),
      },
      send: {
        enabled: cfg?.send?.enabled === true,
        peer: isInt
          ? (binding.sessionTitle || (binding.sessionId ? binding.sessionId.slice(0, 8) : ''))
          : isDy ? douyinPeerName(cfg) || douyinPeer(cfg) : cfg.channels.qq.peerId || '',
      },
      mail: {
        enabled: cfg?.mail?.enabled === true,
        last: lastRun?.mail || null,
      },
      // 三条链路：开关 + 实测（插件装没装、配对没、盯梢开着没、手机端配置齐没）
      sources: {
        switches: {
          phone: cfg?.sources?.phone?.enabled !== false,
          qq: cfg?.sources?.qq?.enabled !== false,
          douyin: cfg?.sources?.douyin?.enabled !== false,
        },
        detect: detectSources(cfg),
      },
      emotion: inspectActiveMood({ cfg, peer: emotionPeer(cfg), baseEmotion: { ...detectEmotionPortrait(), ...inspectEmotionPlugin({ cfg }) } }),
      memory: inspectMemory({ cfg }),
      extensions: listExtensions(),
      rollovers: pendingRollovers(rolloverFile, rolloverAdapter),
    };
  }

  async function openSharedSession(cfg, existingId, kind = 'douyin', customTitle = '') {
    const controller = sessionController();
    const registry = workspaceRegistry();
    if (existingId && !registry?.archivedSessionIds?.includes(existingId)) {
      if (typeof controller?.inspect !== 'function') throw new Error('DSH 会话服务尚未就绪，请稍后重试');
      try {
        if (await controller.inspect(existingId, AbortSignal.timeout(cfg.send.timeoutMs))) return existingId;
      } catch (error) {
        // The host throws ApiSessionNotFound for an absent cold Session.
        if (error.constructor?.name !== 'ApiSessionNotFound' &&
            !['session/not-found', 'SESSION_QUERY_SESSION_NOT_FOUND'].includes(error.code)) throw error;
      }
    }
    if (typeof controller?.create !== 'function') throw new Error('DSH 会话服务尚未就绪，暂时无法新建会话');
    const [workspace] = registry?.list?.() || [];
    const created = await controller.create(workspace?.id ? { workspaceId: workspace.id } : {});
    if (!created?.sessionId) throw new Error('DSH 未返回新建会话的编号');
    const title = String(customTitle || '').trim() || (
      kind === 'douyin'
        ? (douyinPeerName(cfg) ? `抖音私信 · ${douyinPeerName(cfg)}` : '抖音私信')
        : kind === 'qq'
          ? (cfg.channels?.qq?.peerId ? `QQ 陪伴 · ${cfg.channels.qq.peerId}` : 'QQ 陪伴')
          : '陪伴会话'
    );
    if (typeof controller.rename === 'function') {
      try {
        await controller.rename({ sessionId: created.sessionId, title });
      } catch {
        log.warn('会话已创建，暂时无法设置标题');
      }
    }
    return created.sessionId;
  }

  /** 设置页只保存 settings.js 白名单中的路径，校验后写入配置。 */
  async function saveFromBody(req) {
    let body = null;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return { ok: false, error: '请求体不是 JSON' };
    }
    if (!body || typeof body.path !== 'string' || !body.path) return { ok: false, error: '缺 path' };

    const initialCfg = loadConfig();
    const r = applyChange(initialCfg, body.path, body.value);
    if (!r.ok) return r;
    // 凭据类（IMAP 授权码）不进 config.json，单独落 credentials.json，且读了也不回显
    if (r.secret) {
      const s = saveSecret(r.path, r.value);
      if (!s.ok) return { ok: false, error: s.error };
      const secCfg = loadConfig();
      return {
        ok: true,
        path: r.path,
        value: '',
        secret: true,
        notes: ['授权码已存进 credentials.json（界面上只显示「已设置」，不会再显示出来）'],
        groups: listForUi(secCfg),
        presets: presetsForUi(secCfg),
        explorationItems: explorationItemsForUi(secCfg),
        channelItems: channelItemsForUi(secCfg),
        hiddenItems: hiddenItemsForSearch(secCfg),
        searchTags: SEARCH_TAGS,
        state: snapshot(),
      };
    }
    const notes = [];
    if (r.path === 'exploration.builtinFeeds' || r.path === 'exploration.rssUrls') {
      syncBuiltinExploreFeeds(() => r.cfg);
    }
    if (r.path === 'channels.primary') {
      try {
        const from = initialCfg.channels.primary;
        if (from !== r.value) {
          const call = localChatApi(localApiOrigin(req.headers || {}), { timeoutMs: r.cfg.send.timeoutMs, headers: req.headers || {} });
          const qqPeer = String(initialCfg.channels.qq.peerId || '').trim();
          const dyPeer = douyinPeer(initialCfg);
          const result = await changePrimaryChannel({ from, to: r.value, cfg: r.cfg, call,
            save() {
              const latest = loadConfig();
              if (latest.channels.primary !== from ||
                  String(latest.channels.qq.peerId || '').trim() !== qqPeer || douyinPeer(latest) !== dyPeer) {
                throw new Error('切换期间主通道或联系人已变更，请重试');
              }
              latest.channels = { ...latest.channels, primary: r.value };
              saveConfig(latest);
            },
            drain: () => douyin.drain(),
            openDouyinSession: existingId => openSharedSession(r.cfg, existingId, 'douyin'),
            openSession: (existingId, kind) => openSharedSession(r.cfg, existingId, kind || r.value),
            async canSwitchWithoutRestart(sessionId, qqBinding) {
              const controller = sessionController();
              if (typeof controller?.inspect !== 'function') return false;
              if (qqBinding) {
                const lastIn = bridgeLastIn();
                const lastOut = bridgeLastOut();
                if (lastIn?.ts && (!lastOut?.ts || lastOut.ts < lastIn.ts || !lastOut.lastAt)) return false;
              }
              const info = await controller.inspect(sessionId, AbortSignal.timeout(r.cfg.send.timeoutMs));
              return info?.events?.findLast?.(e => ['turn/start', 'turn/end'].includes(e.type))?.type !== 'turn/start';
            },
          });
          notes.push(...(result.notes || []));
          if (r.value === 'douyin') {
            douyin.start(pollDelayMs(loadConfig().channels.douyin));
            if (result.restartRequired) notes.push('请重启 DSH，完成抖音私信接管。');
          } else if (r.value === 'internal') {
            const sid = sharedSessionId();
            if (sid) {
              void syncInternalHistory({
                sessionId: sid, sessions: sessionsHost(), controller: sessionController(), persistence: sessionPersistence(),
              }).catch(() => {});
            }
          } else if (!notes.length) {
            notes.push(from === 'douyin' ? '已切回 QQ，抖音原聊天盯梢保持关闭。' : '已切到 QQ 主通道。');
          }
        }
      } catch (error) {
        return { ok: false, error: error.message };
      }
    }
    try {
      if (r.path !== 'channels.primary') saveConfig(r.cfg);
      if (['exploration.nextTopic', 'exploration.interest', 'exploration.workSources'].includes(r.path)) explorationTopicIssue = null;
      if (r.path === 'enabled' && r.value === false) stopExploration();
      if (r.path === 'exploration.auto') stopDisabledAutoExploration(r.cfg);
    } catch (e) {
      return { ok: false, error: `写 config.json 失败：${String(e?.message || e).slice(0, 120)}` };
    }

    if (r.path === 'dryRun' && r.value === true) notes.push('演练模式开着：之后只判定、不发');
    if (r.path === 'send.enabled' && r.value === true && r.cfg.dryRun !== false) {
      notes.push('「允许真的发送」开了，但演练模式还开着——两个都放行才会发出去');
    }
    if (r.path === 'enabled' && r.value === false) notes.push('总开关关掉了，这一拍之后就不动了');
    if (r.hostReset) {
      notes.push(`换了邮箱：IMAP 服务器原来是 ${r.hostReset.from}，已清成自动（会连 ${r.hostReset.to}）`);
    }
    if (r.path === 'mail.enabled' && r.value === true) {
      notes.push('读邮箱开了：下一次到间隔就去收信（填了账号和授权码才会真连）');
    }

    if (douyinPrimary(r.cfg) && r.path === 'channels.douyin.pollSec') douyin.start(pollDelayMs(r.cfg.channels.douyin));

    if (timer && ['tickMinutes', 'tickJitterSec'].includes(r.path) && !running) {
      clearTimeout(timer);
      schedule(intervalMs());
    }
    compactChatTools.sync();
    const latestCfg = loadConfig();
    return {
      ok: true,
      path: r.path,
      value: r.value,
      notes,
      groups: listForUi(latestCfg),
      presets: presetsForUi(latestCfg),
      explorationItems: explorationItemsForUi(latestCfg),
      channelItems: channelItemsForUi(latestCfg),
      hiddenItems: hiddenItemsForSearch(latestCfg),
      searchTags: SEARCH_TAGS,
      state: snapshot(),
    };
  }

  // ---------------------------------------------------------------- 可选：状态接口
  //
  // 挂路由要等 webServer 就绪（见 whenService 的注释）：apply 那一刻它还没 provide，
  // 直接取只会拿到 null，然后设置页永远 404。
  if (opt.statusApi !== false) {
    let mountedServer = null;
    const mountApi = (c) => {
      const ws = serviceOf(c, 'webServer');
      if (!ws || typeof ws.register !== 'function') {
        noteMount('api: webServer 拿不到，跳过');
        return;
      }
      if (mountedServer === ws) return;
      try {
        // 用注入后的子 ctx 管生命周期（跟 dsh-client-modules 的写法一致）：
        // webServer 被替换时，路由会跟着一起卸掉再挂。
        const eff = (c || ctx).effect || ctx.effect;
        eff(() => {
          const dispose = ws.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler: async (req, res) => {
              const url = req.url || '/';
              const route = url.split('?')[0].slice(API_PREFIX.length) || '/';
              const json = (code, body) => {
                res.statusCode = code;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                res.end(JSON.stringify(body, null, 2));
              };
              if (rejectIfUntrusted(req, c, ctx, json)) return;
              try {
                if (route === '/state' && (req.method || 'GET') === 'GET') return json(200, snapshot());
                if (route === '/config' && (req.method || 'GET') === 'GET') {
                  await refreshHostModelCatalog(ctx).catch(() => {});
                  if (sharedSessionId()) {
                    await syncBoundSessionModel({
                      sessionId: sharedSessionId(), sessions: sessionsHost(), controller: sessionController(), persistence: sessionPersistence(),
                    }).catch(() => {});
                  }
                  const curCfg = loadConfig();
                  return json(200, {
                    ok: true,
                    path: CONFIG_PATH,
                    groups: listForUi(curCfg),
                    presets: presetsForUi(curCfg),
                    explorationItems: explorationItemsForUi(curCfg),
                    channelItems: channelItemsForUi(curCfg),
                    hiddenItems: hiddenItemsForSearch(curCfg),
                    searchTags: SEARCH_TAGS,
                  });
                }
                if (route === '/config' && req.method === 'POST') {
                  return json(200, await saveFromBody(req));
                }
                if ((route === '/presets/apply' || route === '/presets/override' || route === '/presets/reset') && req.method === 'POST') {
                  let body;
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    body = raw ? JSON.parse(raw) : req?.body;
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const curCfg = loadConfig();
                  const r = route === '/presets/apply'
                    ? applyPresetToConfig(curCfg, body?.id)
                    : route === '/presets/override'
                    ? updatePresetOverride(curCfg, body?.presetId, body?.path, body?.value)
                    : resetPresetOverride(curCfg, body?.presetId);
                  if (!r.ok) return json(400, r);
                  saveConfig(r.cfg);
                  const latestCfg = loadConfig();
                  stopDisabledAutoExploration(latestCfg);
                  syncBuiltinExploreFeeds(() => latestCfg);
                  const note = route === '/presets/apply'
                    ? (r.active === 'custom' ? (r.restored ? '已切回自定义并恢复原参数' : '已切回自定义模式') : `已应用套餐：${presetsForUi(latestCfg).presets.find((p) => p.id === r.active)?.label || r.active}`)
                    : route === '/presets/override'
                    ? (r.syncedLive ? '已保存套餐参数并同步生效到当前配置' : '已保存套餐参数')
                    : (r.syncedLive ? '已恢复该套餐默认参数并同步生效' : '已恢复该套餐默认参数');
                  return json(200, {
                    ok: true,
                    notes: [note],
                    groups: listForUi(latestCfg),
                    presets: presetsForUi(latestCfg),
                    explorationItems: explorationItemsForUi(latestCfg),
                    channelItems: channelItemsForUi(latestCfg),
                    hiddenItems: hiddenItemsForSearch(latestCfg),
                    searchTags: SEARCH_TAGS,
                    state: snapshot(),
                  });
                }
                if (route === '/diagnostics' && (req.method || 'GET') === 'GET') {
                  const cfg = loadConfig();
                  return json(200, await diagnostics({ cfg, st: loadState(), host: llmNow(cfg, { quiet: true }) }));
                }
                if (route === '/feedback/receipt' && req.method === 'POST') {
                  let body;
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    body = raw ? JSON.parse(raw) : req?.body;
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const { slot, id, received } = body || {};
                  if (typeof slot !== 'string' || !slot || typeof id !== 'string' || !id || typeof received !== 'boolean') {
                    return json(400, { ok: false, error: '接住率修改缺少有效参数' });
                  }
                  const cfg = loadConfig();
                  const next = setFeedbackReceipt(slot, id, received, { tz: cfg.timezone, cfg });
                  if (!next) return json(409, { ok: false, error: '这条记录当前无法修改，请刷新后再试。' });
                  return json(200, { ok: true, slots: feedbackSlotsForUi(next, cfg.timezone, cfg) });
                }
                if (route === '/connectivity' && req.method === 'POST') {
                  const cfg = loadConfig();
                  return json(200, await connectivity({ cfg, host: llmNow(cfg, { quiet: true }) }));
                }
                if (route === '/tick' && req.method === 'POST') {
                  let body;
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    body = raw ? JSON.parse(raw) : req?.body;
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body))) {
                    return json(400, { ok: false, error: '请求体必须是 JSON 对象' });
                  }
                  if (body?.preview !== undefined && typeof body.preview !== 'boolean') {
                    return json(400, { ok: false, error: 'preview 必须是布尔值' });
                  }
                  const preview = body?.preview === true;
                  const r = await runOnce('api', { preview });
                  if (r.skipped === 'busy') return json(409, { ok: false, error: 'BUSY' });
                  return json(200, preview ? r : { ...r, state: snapshot() });
                }
                if ((route === '/agreements/dismiss' || route === '/exploration/feedback') && req.method === 'POST') {
                  let body;
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    body = raw ? JSON.parse(raw) : req?.body;
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  if (typeof body?.id !== 'string' || !/^[a-f0-9]{24}$/u.test(body.id)) {
                    return json(400, { ok: false, error: '缺少有效的条目标识' });
                  }
                  const cfg = loadConfig();
                  if (route === '/exploration/feedback' && !['more', 'change', 'pause', 'clear', 'delete'].includes(body.action)) {
                    return json(400, { ok: false, error: '未知的探索反馈操作' });
                  }
                  const changed = route === '/agreements/dismiss' ? dismissAgreement(body.id, cfg)
                    : applyExplorationFeedback({ id: body.id, action: body.action, cfg,
                      status: explorationStatus(loadExploration(), loadPersona({ cfg })) });
                  if (!changed) return json(409, { ok: false, error: '条目已变化，请刷新后再试。' });
                  if (route === '/exploration/feedback' && ['change', 'pause'].includes(body.action)) {
                    const avoid = explorationFeedbackHints(cfg, explorationStatus(loadExploration(), loadPersona({ cfg }))).avoid;
                    const clearNext = Boolean(cfg.exploration?.nextTopic && topicInExplorationFeedback(cfg.exploration.nextTopic, avoid));
                    const clearInterest = Boolean(cfg.exploration?.interest && topicInExplorationFeedback(cfg.exploration.interest, avoid));
                    if (clearNext || clearInterest) {
                      saveConfig({
                        ...cfg,
                        exploration: {
                          ...cfg.exploration,
                          ...(clearNext ? { nextTopic: '' } : {}),
                          ...(clearInterest ? { interest: '' } : {}),
                        },
                      });
                    }
                  }
                  const notes = {
                    more: '已标记「想多听听」，后续会优先关注这个方向',
                    change: '已标记「换个方向」，下轮探索将避开这个主题',
                    pause: '已标记「先放着」，近期不再主动展开这个主题',
                    clear: '已取消该反馈标记',
                    delete: '已移除该好奇候选',
                  };
                  const note = route === '/agreements/dismiss' ? '已忽略该约定' : (notes[body.action] || '已更新');
                  return json(200, { ok: true, note, state: snapshot() });
                }
                if (route === '/explore/stop' && req.method === 'POST') {
                  let body;
                  try { body = JSON.parse((await readBody(req)) || '{}'); }
                  catch { return json(400, { ok: false, error: '请求体不是 JSON' }); }
                  if (!body || typeof body !== 'object' || Array.isArray(body) ||
                      (body.runId !== undefined && typeof body.runId !== 'string')) {
                    return json(400, { ok: false, error: '探索轮次编号无效' });
                  }
                  return json(200, { ...stopExploration(body.runId), state: snapshot() });
                }
                if (route === '/explore/topic' && req.method === 'POST') {
                  let body;
                  try { body = JSON.parse((await readBody(req)) || '{}'); }
                  catch { return json(400, { ok: false, error: '请求体不是 JSON' }); }
                  const issue = explorationTopicIssue;
                  const fail = (reason) => json(200, { ok: false, reason, state: snapshot() });
                  if (!issue || issue.input !== body?.input || issue.field !== body?.field) return fail('TOPIC_CHANGED');
                  const cfg = loadConfig();
                  const next = { ...cfg.exploration };
                  const { field, input, title } = issue;
                  const items = field === 'interest' ? splitInterestItems(next.interest) : null;
                  if ((items && !items.includes(input)) || (field === 'nextTopic' && next.nextTopic.trim() !== input)) return fail('TOPIC_CHANGED');
                  if (body.choice === 'source') {
                    const source = publicExplorationUrl(body.url);
                    if (!source || !classifyExplorationTarget('作品：《' + title + '》 来源：' + source.href).hosts.length) {
                      return fail('INVALID_SOURCE');
                    }
                    const updated = setExplorationWorkSource(next.workSources, title, source.href);
                    if (updated.length > 1600 || !classifyExplorationTarget('作品：' + title, updated).hosts.length) return fail('INVALID_SOURCE');
                    next.workSources = updated;
                  } else if (!['work', 'topic'].includes(body.choice)) {
                    return fail('INVALID_CHOICE');
                  }
                  const replacement = (body.choice === 'topic' ? '主题：' : '作品：') + title;
                  if (items) next.interest = items.map(item => item === input ? replacement : item).join('\n');
                  else next.nextTopic = replacement;
                  if (next.interest.length > 160 || next.nextTopic.length > 120) return fail('INVALID_CHOICE');
                  saveConfig({ ...cfg, exploration: next });
                  explorationTopicIssue = body.choice === 'work' ? { ...issue, input: replacement, field: field || 'nextTopic',
                    reason: 'WORK_SOURCE_REQUIRED' } : null;
                  return json(200, { ok: true, state: snapshot(), explorationItems: explorationItemsForUi(loadConfig()) });
                }
                if (route === '/explore' && req.method === 'POST') {
                  let body = {};
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    if (raw) body = JSON.parse(raw);
                    else if (req?.body && typeof req.body === 'object') body = req.body;
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const manualTopic = typeof body?.topic === 'string' ? body.topic.trim() : '';
                  const r = await runExploration(true, null, null, null, manualTopic);
                  return json(200, { ...r, state: snapshot() });
                }
                if (route === '/sessions' && (req.method || 'GET') === 'GET') {
                  const cfg = loadConfig();
                  const list = await listHostSessions({
                    sessions: sessionsHost(),
                    persistence: sessionPersistence(),
                    workspaceRegistry: workspaceRegistry(),
                    projections: sessionProjections(),
                  });
                  const b = activeBoundSession(cfg);
                  const matchedTitle = b.sessionId ? (list.find((item) => item.id === b.sessionId)?.title || '') : '';
                  return json(200, {
                    ok: true,
                    sessions: list,
                    boundSessionId: b.sessionId || '',
                    sessionTitle: b.sessionTitle || matchedTitle,
                    primary: cfg.channels.primary,
                  });
                }
                if ((route === '/chat/session' || route === '/internal/session') && req.method === 'POST') {
                  let body = {};
                  try {
                    const raw = typeof req?.on === 'function' ? await readBody(req) : '';
                    body = raw ? JSON.parse(raw) : (req?.body || {});
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const cfg = loadConfig();
                  const primary = cfg.channels.primary || 'internal';
                  const isInt = internalPrimary(cfg);
                  const isDy = douyinPrimary(cfg);
                  const isQq = !isInt && !isDy;
                  const priorBinding = chatBinding();
                  let targetId = '';
                  let foundTitle = '';
                  let created = false;
                  if (body?.create === true) {
                    const customTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 60) : '';
                    targetId = await openSharedSession(cfg, undefined, isInt ? 'internal' : isDy ? 'douyin' : 'qq', customTitle);
                    foundTitle = customTitle || '陪伴会话';
                    created = true;
                  } else {
                    const sid = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
                    if (!sid) return json(400, { ok: false, error: '请提供 sessionId 或 create: true' });
                    const list = await listHostSessions({
                      sessions: sessionsHost(),
                      persistence: sessionPersistence(),
                      workspaceRegistry: workspaceRegistry(),
                      projections: sessionProjections(),
                    });
                    const matched = list.find((item) => item.id === sid);
                    foundTitle = matched?.title || '';
                    if (!matched) {
                      const controller = sessionController();
                      const live = sessionsHost()?.get?.(sid);
                      if (live) {
                        foundTitle = String(live.header?.title || '').trim();
                      } else if (typeof controller?.inspect === 'function') {
                        const info = await controller.inspect(sid, AbortSignal.timeout(cfg.send?.timeoutMs || 8000));
                        foundTitle = String(info?.events?.findLast?.((e) => e.type === 'session/title')?.data?.title || info?.meta?.title || '').trim();
                      } else {
                        return json(404, { ok: false, error: '找不到该会话，请刷新列表后重试' });
                      }
                    }
                    targetId = sid;
                  }

                  const bound = bindSharedSession(targetId, { title: foundTitle });
                  const notes = [];
                  if (isQq) {
                    try {
                      const prevQq = qqAdapter.activeSessionForPeer?.(cfg.channels?.qq?.peerId);
                      const preservedQq = prevQq
                        ? {
                          peerKind: prevQq.peerKind || 'private',
                          peerId: prevQq.peerId,
                          ...(prevQq.peerName ? { peerName: prevQq.peerName } : {}),
                          authoritative: true,
                        }
                        : null;
                      const call = localChatApi(localApiOrigin(req.headers || {}), { timeoutMs: 12_000, headers: req.headers || {} });
                      const qqNotes = await switchToQq(
                        { ...bound, sessionId: targetId, qqBinding: preservedQq },
                        call,
                        {
                          cfg,
                          commit: (nextBinding) => {
                            if (nextBinding) writeChatData('external-chat', { ...nextBinding, sessionTitle: foundTitle || nextBinding.sessionTitle || '' });
                          },
                        },
                      );
                      if (Array.isArray(qqNotes) && qqNotes.length) notes.push(...qqNotes);
                    } catch (error) {
                      writeChatData('external-chat', priorBinding);
                      return json(error?.status && error.status >= 400 && error.status < 600 ? error.status : 409, {
                        ok: false,
                        error: error?.message || '切换 QQ 绑定会话失败',
                      });
                    }
                  } else if (isInt) {
                    await syncInternalHistory({
                      sessionId: targetId, sessions: sessionsHost(), controller: sessionController(), persistence: sessionPersistence(),
                    }).catch(() => {});
                  }

                  // 手动切到非待接管目标的会话时，忽略旧的待交接续聊记录，避免把别的会话前情误注入
                  for (const pending of pendingRollovers(rolloverFile, rolloverAdapter)) {
                    if (pending.newSessionId !== targetId) {
                      dismissRollover(rolloverFile, pending.oldSessionId);
                    }
                  }

                  compactChatTools.sync();
                  const latestBinding = activeBoundSession(cfg);
                  const label = latestBinding.sessionTitle || foundTitle;
                  if (!notes.length) {
                    const verb = created ? '已新建并接入' : '已接入';
                    const chanLabel = isQq ? 'QQ ' : isDy ? '抖音私信' : '共用';
                    notes.push(`${verb}${chanLabel}会话${label ? `「${label}」` : ''}(${targetId.slice(0, 8)})。`);
                  }
                  return json(200, {
                    ok: true,
                    sessionId: targetId,
                    title: label,
                    primary,
                    notes,
                    state: snapshot(),
                  });
                }
                if (route === '/rollover/switch' && req.method === 'POST') {
                  localApiOrigin(req.headers || {});
                  const curCfg = loadConfig();
                  if (!douyinPrimary(curCfg) && !internalPrimary(curCfg)) return json(400, { ok: false, error: '当前主通道不是抖音或内部会话' });
                  const body = JSON.parse((await readBody(req)) || '{}');
                  const b = internalPrimary(curCfg)
                    ? (chatBinding().sessionId ? chatBinding() : null)
                    : readyDouyinBinding();
                  if (!b) return json(409, { ok: false, error: '请等主通道接管完成' });
                  const record = pendingRollovers(rolloverFile, rolloverAdapter).find(
                    row => row.oldSessionId === b.sessionId && row.newSessionId === body.sessionId);
                  if (!record) return json(400, { ok: false, error: '找不到这个待切换会话' });
                  writeChatData('external-chat', {
                    ...b,
                    sessionId: record.newSessionId,
                    preparedSessionId: '',
                    ...(record.title ? { sessionTitle: record.title } : {}),
                  });
                  compactChatTools.sync();
                  if (internalPrimary(curCfg)) {
                    await syncInternalHistory({
                      sessionId: record.newSessionId, sessions: sessionsHost(), controller: sessionController(), persistence: sessionPersistence(),
                    }).catch(() => {});
                  }
                  return json(200, { ok: true, state: snapshot() });
                }
                if (route === '/rollover/dismiss' && req.method === 'POST') {
                  let body = {};
                  try {
                    body = JSON.parse((await readBody(req)) || '{}');
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const oldSessionId = typeof body?.oldSessionId === 'string' ? body.oldSessionId.trim() : '';
                  if (!oldSessionId) return json(400, { ok: false, error: '缺 oldSessionId' });
                  const dismissed = dismissRollover(rolloverFile, oldSessionId);
                  return json(200, { ok: true, dismissed, state: snapshot() });
                }
                if (route === '/emotion/repair' && req.method === 'POST') {
                  const r = repairEmotionConfig({ cfg: loadConfig(), force: true });
                  return json(200, { ...r, state: snapshot() });
                }
                if (route === '/memory/merge' && req.method === 'POST') {
                  let body = {};
                  try {
                    const raw = await readBody(req);
                    if (raw) body = JSON.parse(raw);
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const targetFile = typeof body?.targetFile === 'string' ? body.targetFile.trim() : '';
                  const sourceFiles = Array.isArray(body?.sourceFiles)
                    ? body.sourceFiles.map((s) => String(s || '').trim()).filter(Boolean)
                    : null;
                  const dryRun = body?.dryRun === true;
                  const r = mergeMemorySessions({ cfg: loadConfig(), targetFile, sourceFiles, dryRun });
                  return json(200, { ...r, state: snapshot() });
                }
                if (route === '/memory/restore' && req.method === 'POST') {
                  let body = {};
                  try {
                    const raw = await readBody(req);
                    if (raw) body = JSON.parse(raw);
                  } catch {
                    return json(400, { ok: false, error: '请求体不是 JSON' });
                  }
                  const targetFile = typeof body?.targetFile === 'string' ? body.targetFile.trim() : '';
                  const r = restoreMemoryBackup({ cfg: loadConfig(), targetFile });
                  return json(200, { ...r, state: snapshot() });
                }
                return json(404, { ok: false, error: 'NOT_FOUND' });
              } catch (e) {
                return json(500, { ok: false, error: String(e?.message || e).slice(0, 200) });
              }
            },
          });
          mountedServer = ws;
          return () => {
            if (mountedServer === ws) mountedServer = null;
            if (typeof dispose === 'function') dispose();
          };
        });
        noteMount(`api: 已挂上 ${API_PREFIX}`);
        log.info(`状态接口：GET ${API_PREFIX}/state，POST ${API_PREFIX}/tick`);
      } catch (e) {
        noteMount(`api: 挂载失败 ${String(e?.message || e).slice(0, 160)}`);
        log.warn(`状态接口没挂上：${String(e?.message || e).slice(0, 160)}`);
      }
    };
    whenService(ctx, 'webServer', mountApi, log);
  }

  // The scheduler and settings route also need the optional tools and web services.
  if (opt.enabled !== false) whenService(ctx, 'tools', (c) => {
    if (!serviceOf(c, 'tools')) return;
    explorationToolsCtx = c;
    if (typeof c?.effect === 'function') c.effect(() => () => {
      if (explorationToolsCtx === c) explorationToolsCtx = null;
    });
  }, log);
  if (opt.enabled !== false) whenService(ctx, 'web', (c) => {
    if (!serviceOf(c, 'web')) return;
    explorationWebCtx = c;
    if (typeof c?.effect === 'function') c.effect(() => () => {
      if (explorationWebCtx === c) explorationWebCtx = null;
    });
  }, log);

  // ---------------------------------------------------------------- 可选：给模型的工具
  // 同样要等 tools 就绪（apply 那一刻 tools 服务通常还没 provide，直接取会静默跳过）。
  if (opt.tool !== false) {
    let toolMounted = false;
    const mountTool = (c) => {
      if (toolMounted) return;
      const tools = serviceOf(c, 'tools');
      if (!tools || typeof tools.register !== 'function') {
        noteMount('tool: tools 拿不到，跳过');
        return;
      }
      toolMounted = true;
      (async () => {
        try {
          let defineTool = null;
          try {
            const mod = await import('@deepseek-ai/dsh-tools');
            defineTool = mod?.defineTool || null;
          } catch {
            defineTool = null;
          }
          // 拿不到宿主的 defineTool 就用等价实现（它只是补一次 schema 校验）
          const spec = (o) => (defineTool ? defineTool(o) : o);
          const tool = spec({
            name: 'presence_status',
            description:
              '看 dsh-drop-by（主动找她说话的那个插件）现在是什么状态：开着没有、演练还是真发、' +
              '上一拍判了什么、今天已经发过几条、用的是哪个模型。' +
              'action="tick" 会在当前时刻立刻跑一拍（会真的生成一句话、dryRun 时不会发出去）。' +
              'action="explore" 仅在用户明确要求试跑自主探索时使用：运行一轮文字探索并返回进展，不发消息。' +
              '只在用户问「你还在盯着我吗 / 刚才那条是你发的吗 / 今天发了几条」时调用；' +
              '不要用它去主动发消息——发不发由插件自己按由头判断。',
            parameters: {
              action: {
                type: 'string',
                enum: ['status', 'tick', 'explore'],
                description: 'status=只看状态（默认）；tick=立刻跑一拍；explore=试跑一轮自主探索',
              },
            },
            async execute(args) {
              const action = String(args?.action || 'status');
              if (action === 'explore') return runExploration(true);
              if (action === 'tick') {
                const r = await runOnce('tool');
                return { ok: Boolean(r?.ok), result: r, state: snapshot() };
              }
              return snapshot();
            },
            // ⚠️ 2026-11-04：DSH 的 tools.register 要求每个工具声明 output
            // （`{ schema, render }`），缺了直接 TypeError：must declare output。
            // 老版本没有这条，所以以前这段代码「看着能跑」。
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
          });
          const dispose = tools.register(tool);
          if (typeof dispose === 'function') (c?.effect || ctx.effect)(() => dispose);
          const disposeWatch = tools.register(spec({
            name: 'presence_watch_video',
            description: '按抖音视频 ID 观察用户分享的视频。画面需要 dsh-video-storyboard 插件和支持图片的模型；不可用时返回可用口播及原因。此工具只观察，不发消息。',
            parameters: {
              id: { type: 'string', description: '分享卡片中的抖音视频 ID（aweme_id）' },
            },
            async execute(args) {
              const cfg = loadConfig();
              if (opt.enabled === false || cfg.enabled === false || cfg.content?.forward?.enabled === false) {
                return { ok: false, reason: 'FORWARD_DISABLED' };
              }
              const host = llmNow(cfg);
              const r = await watchVideo(args?.id, { cfg, host, llm: host.generate, ctx });
              // 只回有值的字段：undefined 会让工具的 output 校验报
              // 「value is not lossless JSON」，整次调用直接作废。
              const out = {
                ok: !!r.ok, id: r.id, source: r.source, summary: r.summary,
                reason: r.reason, visionReason: r.visionReason, durSec: r.durSec,
              };
              for (const k of Object.keys(out)) {
                if (out[k] === undefined || out[k] === null) delete out[k];
              }
              if (Array.isArray(r.frames) && r.frames.length) out.frames = r.frames.length;
              return out;
            },
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
          }));
          if (typeof disposeWatch === 'function') (c?.effect || ctx.effect)(() => disposeWatch);
          const mountedNames = ['presence_status', 'presence_watch_video'];
          if (loadConfig().rules?.exposeMaintenanceTools === true) {
            const disposeCalendar = tools.register(spec({
              name: 'presence_holiday_calendar',
              description:
                '看 / 刷新 dsh-drop-by 的节假日日历缓存（忙碌时段在法定节假日整天不生效）。' +
                'action="status" 看今年有没有缓存、内置表覆盖到哪一年；' +
                'action="refresh" 按设置里的「节假日日历接口」拉一次，把放假/调休写进 data/holidays-<年>.json。' +
                '用户说「更新一下今年的节假日」「明年放假表出来了」时用 refresh。',
              parameters: {
                action: { type: 'string', enum: ['status', 'refresh'], description: 'status=只看（默认）；refresh=联网拉一次并写缓存' },
                year: { type: 'number', description: '哪一年，默认今年' },
                url: { type: 'string', description: '临时指定接口地址（留空用设置里的），{year} 会替换成年份' },
              },
              async execute(args) {
                const cfg = loadConfig();
                const action = String(args?.action || 'status');
                const year = Number(args?.year) || new Date().getFullYear();
                if (action === 'refresh') {
                  const r = await refreshCalendar({ year, url: String(args?.url || cfg?.calendar?.url || ''), cfg });
                  return { ...r, builtin: builtinYears(), status: calendarStatus(cfg) };
                }
                return { builtin: builtinYears(), ...calendarStatus(cfg) };
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
              },
            }));
            if (typeof disposeCalendar === 'function') (c?.effect || ctx.effect)(() => disposeCalendar);
            const disposeEmotionRepair = tools.register(spec({
              name: 'presence_repair_emotion',
              description: '查看 emotion-state-portrait 情绪插件在本机的状态，或把配置里遗留的作者路径、模型 Key 与 QQ 号一键对齐到当前机器。',
              parameters: {
                action: { type: 'string', enum: ['status', 'repair'], description: 'status=只查看（默认）；repair=自动修复本机配置' },
              },
              async execute(args) {
                const cfg = loadConfig();
                if (String(args?.action || 'status') === 'repair') return repairEmotionConfig({ cfg, force: true });
                return inspectEmotionPlugin({ cfg });
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
              },
            }));
            if (typeof disposeEmotionRepair === 'function') (c?.effect || ctx.effect)(() => disposeEmotionRepair);
            const disposeMemoryMerge = tools.register(spec({
              name: 'presence_memory_merge',
              description: '查看 dsh-fish-memory 工作区/会话记忆文件，或按文本去重将历史 session-*.json 记忆只增不删地合并进默认工作区 ws_*.json（写入前自动备份）。',
              parameters: {
                action: { type: 'string', enum: ['status', 'merge'], description: 'status=只查看（默认）；merge=执行合并' },
                targetFile: { type: 'string', description: '可选：指定目标 ws_*.json 文件名，留空取最近有记忆的工作区' },
              },
              async execute(args) {
                const cfg = loadConfig();
                if (String(args?.action || 'status') === 'merge') {
                  return mergeMemorySessions({ cfg, targetFile: String(args?.targetFile || '') });
                }
                return inspectMemory({ cfg });
              },
              output: {
                schema: { type: 'object', additionalProperties: true },
                render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
              },
            }));
            if (typeof disposeMemoryMerge === 'function') (c?.effect || ctx.effect)(() => disposeMemoryMerge);
            mountedNames.push('presence_holiday_calendar', 'presence_repair_emotion', 'presence_memory_merge');
          }
          noteMount(`tool: ${mountedNames.join('、')} 已挂上`);
        } catch (e) {
          toolMounted = false;
          noteMount(`tool: 挂载失败 ${String(e?.message || e).slice(0, 160)}`);
          log.warn(`工具没挂上：${String(e?.message || e).slice(0, 160)}`);
        }
      })();
    };
    whenService(ctx, 'tools', mountTool, log);
  }

  const removeCompactToolListeners = [];
  if (opt.enabled !== false && typeof ctx.on === 'function') {
    removeCompactToolListeners.push(
      ctx.on('agent/created', () => compactChatTools.sync()),
      ctx.on('agent/disposed', ({ agent } = {}) => compactChatTools.sync({ disposing: agent })),
      ctx.on('session/event', (_session, event) => {
        // Re-read the bridge binding before DSH assembles the next turn's tool schemas.
        if (event?.type === 'turn/start') compactChatTools.sync();
      }),
      ctx.on('tools/change', () => compactChatTools.sync({ refresh: true })),
    );
  }

  const releases = new Map();
  let releaseModelObserver = null;
  let releaseAdaptersObserver = null;
  if (opt.enabled !== false && typeof ctx.on === 'function') {
    try {
      releaseModelObserver = ctx.on('session/event', (session, event) => {
        if (!disposed && session?.id) observeBoundSessionModel(session, event);
      });
    } catch { /* host may not emit session/event */ }
    try {
      releaseAdaptersObserver = ctx.on('llm/adapters-updated', () => {
        if (!disposed) void refreshHostModelCatalog(ctx).catch(() => {});
      });
    } catch { /* host may not emit llm/adapters-updated */ }
  }
  if (opt.enabled !== false) {
    whenService(ctx, 'llm', (c) => { void refreshHostModelCatalog(c || ctx).catch(() => {}); }, log);
    whenService(ctx, 'sessionProjections', (c) => { projectionsService = serviceOf(c, 'sessionProjections'); }, log);
    whenService(ctx, 'workspaceRegistry', (c) => { registryService = serviceOf(c, 'workspaceRegistry'); }, log);
    whenService(ctx, 'sessions', (c) => {
      sessionsService = serviceOf(c, 'sessions');
      if (sharedSessionId()) {
        if (internalPrimary(loadConfig())) {
          void syncInternalHistory({
            sessionId: sharedSessionId(), sessions: sessionsService, controller: sessionController(), persistence: sessionPersistence(),
          }).catch(() => {});
        } else {
          void syncBoundSessionModel({
            sessionId: sharedSessionId(), sessions: sessionsService, controller: sessionController(), persistence: sessionPersistence(),
          }).catch(() => {});
        }
      }
    }, log);
    whenService(ctx, 'sessionPersistence', (c) => {
      persistenceService = serviceOf(c, 'sessionPersistence');
      if (internalPrimary(loadConfig()) && sharedSessionId()) {
        void syncInternalHistory({
          sessionId: sharedSessionId(), sessions: sessionsHost(), controller: sessionController(), persistence: persistenceService,
        }).catch(() => {});
      }
    }, log);
    whenService(ctx, 'sessionController', (c) => {
      const controller = serviceOf(c, 'sessionController') || serviceOf(ctx, 'sessionController');
      if (disposed || !controller || releases.has(controller)) return;
      controllerService = controller;
      const rollover = createSessionRollover({
        controller,
        projections: () => projectionsService || serviceOf(ctx, 'sessionProjections'),
        workspaceRegistry,
        adapter: rolloverAdapter,
        file: rolloverFile,
        getConfig: loadConfig,
        log,
        async notify({ handoff, usage, prepared, displayTitle }) {
          compactChatTools.sync();
          const cfg = loadConfig();
          const isInt = internalPrimary(cfg);
          const dy = douyinPrimary(cfg);
          const to = isInt ? handoff.oldSessionId : dy ? douyinPeer(cfg) : cfg.channels?.qq?.peerId;
          if (disposed || cfg.enabled === false || cfg.dryRun !== false || cfg.send?.enabled !== true || !to ||
              (isInt && (cfg.channels?.internal?.enabled === false || cfg.channels?.internal?.send === false)) ||
              (!dy && !isInt && (cfg.sources?.qq?.enabled === false || cfg.channels?.qq?.enabled === false || cfg.channels?.qq?.send === false))) return;
          const { newSessionId, carryMessages, fallbackMessages } = handoff;
          const percent = Math.round(usage.ratio * 1000) / 10;
          const context = carryMessages ? `已备好 ${fallbackMessages.length} 条前情，切换时会更新到最近 ${carryMessages} 条` : '会从空白上下文开始';
          const title = displayTitle ? `「${displayTitle}」` : '续聊会话';
          const switching = prepared ? '方便时重启 DSH 自动切换，或在「陪伴」设置页点一下立即重绑'
            : '方便时在「陪伴」设置页点一下立即重绑';
          const text = `当前会话上下文用了 ${percent}%（${usage.used}/${usage.limit}）。已建好${title}[${newSessionId.slice(0, 8)}]，${context}。这边还能聊，${switching}。`;
          const sent = isInt
            ? await sendInternalMessage({ cfg, sessionId: to, text, source: 'rollover' })
            : dy
              ? await sendDouyinText({ cfg, text })
              : await sendQQPrivate({ to, text, dryRun: false, timeoutMs: cfg.send?.timeoutMs });
          if (!sent.ok) log.warn('续聊提醒发送失败：' + sent.error);
        },
      });
      const activeChatTurns = new Map();
      const isBoundChatSession = (sid) => {
        if (!sid) return false;
        const shared = sharedSessionId();
        if (shared && sid === shared) return true;
        try {
          const qqSid = chatBinding()?.qqBinding?.sessionId;
          if (qqSid && sid === qqSid) return true;
        } catch {}
        return false;
      };
      const notifyToolLimitPause = async (cfg, sessionId, limit) => {
        if (disposed || cfg.enabled === false || cfg.dryRun !== false || cfg.send?.enabled !== true) return;
        const text = `这轮工具调用已达到上限（${limit} 次），我先停下来了，免得把上下文撑满；需要继续直接说一声。`;
        try {
          if (internalPrimary(cfg)) {
            if (cfg.channels?.internal?.enabled === false || cfg.channels?.internal?.send === false) return;
            await sendInternalMessage({ cfg, sessionId, text, source: 'tool-limit' });
          } else if (douyinPrimary(cfg)) {
            if (cfg.channels?.douyin?.send === false) return;
            await sendDouyinText({ cfg, text });
          } else {
            const to = cfg.channels?.qq?.peerId;
            if (!to || cfg.sources?.qq?.enabled === false || cfg.channels?.qq?.enabled === false || cfg.channels?.qq?.send === false) return;
            await sendQQPrivate({ to, text, dryRun: false, timeoutMs: cfg.send?.timeoutMs });
          }
        } catch (err) {
          log.warn('工具上限暂停提示发送失败：' + String(err?.message || err).slice(0, 120));
        }
      };
      const aroundPrompt = async (payload, signal, next) => {
        let nextPayload = payload;
        let turnGuard = null;
        let unlinkSignal = null;
        let promptSignal = signal;
        const cfgAtStart = loadConfig();
        try {
          const cfg = cfgAtStart;
          const sid = internalPrimary(cfg) ? sharedSessionId() : '';
          if (sid && payload?.sessionId === sid && cfg.enabled !== false && canReadChat(cfg) && Array.isArray(payload.content) && payload.content.length) {
            const idx = payload.content.findIndex((part) => part?.type === 'text' && typeof part.text === 'string');
            const rawText = idx >= 0 ? payload.content[idx].text : textFromContent(payload.content);
            const trimmed = String(rawText || '').trim();
            if (trimmed && !isProactiveInternalText(trimmed) &&
                payload.source?.plugin !== name && payload.source?.proactive !== true &&
                !trimmed.startsWith('<qq_reply_context>') && !trimmed.startsWith('<external_reply_context>')) {
              const context = await buildReplyContext(ctx, {
                cfg, peer: sid, internalSession: sid, kind: 'private', text: trimmed, at: Date.now(), observed: false,
              });
              if (context) {
                const content = payload.content.slice();
                if (idx >= 0) content[idx] = { ...content[idx], text: context + '\n\n' + content[idx].text };
                else content.unshift({ type: 'text', text: context });
                nextPayload = { ...payload, content };
              }
            }
          }
          const toolCap = Math.max(0, Math.trunc(Number(cfg.rules?.chatSession?.maxToolCallsPerTurn) || 0));
          const isInternalControlMsg = payload?.source?.plugin === name || payload?.source?.proactive === true || payload?.source?.source === 'tool-limit';
          if (toolCap > 0 && !isInternalControlMsg && payload?.sessionId && isBoundChatSession(payload.sessionId)) {
            const ac = new AbortController();
            if (signal) {
              if (signal.aborted) ac.abort(signal.reason);
              else {
                const onAbort = () => ac.abort(signal.reason);
                signal.addEventListener('abort', onAbort, { once: true });
                unlinkSignal = () => signal.removeEventListener('abort', onAbort);
              }
            }
            turnGuard = { abortController: ac, turn: null, count: 0, limit: toolCap, hit: false };
            activeChatTurns.set(payload.sessionId, turnGuard);
            promptSignal = ac.signal;
          }
        } catch (error) {
          log.warn('内部会话上下文注入跳过：' + String(error?.message || error).slice(0, 120));
        }
        try {
          return await rollover.prompt(nextPayload, promptSignal, (p) => next(p, promptSignal));
        } finally {
          if (unlinkSignal) unlinkSignal();
          if (turnGuard && payload?.sessionId && activeChatTurns.get(payload.sessionId) === turnGuard) {
            activeChatTurns.delete(payload.sessionId);
          }
          if (turnGuard?.hit) {
            const freshCfg = loadConfig();
            if (freshCfg.rules?.chatSession?.notifyOnToolLimit !== false) {
              void notifyToolLimitPause(freshCfg, payload.sessionId, turnGuard.limit);
            }
          }
        }
      };
      const removePrompt = installQqPromptMerge(controller, aroundPrompt);
      const lastAssistant = new Map();
      const assistantText = (msg) => (Array.isArray(msg?.content) ? msg.content : [])
        .map((p) => (p?.type === 'text' ? String(p.text || '') : '')).join('').trim();
      const removeListener = ctx.on?.('session/event', (session, event) => {
        if (disposed || !session?.id) return;
        const guard = activeChatTurns.get(session.id);
        if (guard) {
          const evTurn = event?.data?.turn ?? null;
          if (event?.type === 'turn/start') {
            guard.turn = evTurn;
            guard.count = 0;
          } else if (event?.type === 'tool/call' && !guard.hit && (guard.turn == null || evTurn == null || guard.turn === evTurn)) {
            guard.count += 1;
            if (guard.count > guard.limit) {
              guard.hit = true;
              log.warn(`聊天会话单轮工具调用超过上限（${guard.limit} 次），已自动暂停本轮任务`);
              try { guard.abortController.abort(new Error('CHAT_TOOL_LIMIT')); } catch {}
              try {
                if (typeof controller.abort === 'function') void Promise.resolve(controller.abort(session.id)).catch(() => {});
                else if (typeof controller.cancel === 'function') void Promise.resolve(controller.cancel(session.id)).catch(() => {});
              } catch {}
            }
          } else if (event?.type === 'turn/end' && (guard.turn == null || evTurn == null || guard.turn === evTurn)) {
            activeChatTurns.delete(session.id);
          }
        }
        douyin.observe(session, event);
        const cfg = loadConfig();
        if (internalPrimary(cfg)) {
          observeInternalEvent(session, event, cfg);
          if (event?.type === 'assistant/message') {
            const text = assistantText(event.data?.message);
            if (text) lastAssistant.set(session.id, { turn: event.data?.turn, text });
            return;
          }
          if (event?.type === 'turn/end') {
            if (cfg.exploration?.portrait === true && session.id === sharedSessionId()) {
              const last = lastAssistant.get(session.id);
              if (last?.text && (last.turn === undefined || last.turn === event.data?.turn)) {
                lastAssistant.delete(session.id);
                const state = readInternalState(session.id);
                if (state.outgoing?.source === 'reply') {
                  appendEmotionInbox({ user: emotionPeer(cfg), role: 'ai', text: last.text, t: Date.now() });
                }
              }
            }
            return rollover.handleEvent(session, event).catch((error) => log.warn('续聊准备失败：' + error.message));
          }
          return;
        }
        if (douyinPrimary(cfg)) {
          if (event?.type === 'turn/end') return rollover.handleEvent(session, event).catch(error => log.warn('续聊准备失败：' + error.message));
          return;
        }
        if (event?.type === 'assistant/message') {
          const text = assistantText(event.data?.message);
          if (text) lastAssistant.set(session.id, { turn: event.data?.turn, text });
          return;
        }
        if (event?.type === 'turn/end') {
          if (cfg.exploration?.portrait === true) {
            const b = rolloverAdapter.bindingFor(session.id);
            const last = lastAssistant.get(session.id);
            if (b?.peerKind === 'private' && String(b.peerId) === String(cfg.channels?.qq?.peerId || '') &&
                last?.text && (last.turn === undefined || last.turn === event.data?.turn)) {
              lastAssistant.delete(session.id);
              appendEmotionInbox({ user: b.peerId, role: 'ai', text: last.text, t: Date.now() });
            }
          }
          return rollover.handleEvent(session, event).catch((error) => log.warn('续聊准备失败：' + error.message));
        }
      });
      releases.set(controller, () => {
        removePrompt();
        if (typeof removeListener === 'function') removeListener();
      });
    }, log);
  }

  // ---------------------------------------------------------------- 起钟
  const api = {
    snapshot,
    runOnce,
    runExploration: () => runExploration(false),
    stopExploration,
    registerExploreSource,
    registerMoodSource,
    registerMemorySource,
    registerTopicProvider,
    listExtensions,
    stop() {
      disposed = true;
      stopExploration();
      for (const dispose of removeCompactToolListeners.splice(0)) {
        if (typeof dispose === 'function') dispose();
      }
      compactChatTools.stop();
      releaseActionExecutor();
      releaseInternalDispatcher();
      douyin.stop();
      for (const release of releases.values()) release();
      releases.clear();
      if (typeof releaseModelObserver === 'function') releaseModelObserver();
      releaseModelObserver = null;
      if (typeof releaseAdaptersObserver === 'function') releaseAdaptersObserver();
      releaseAdaptersObserver = null;
      if (timer) clearTimeout(timer);
      if (continuationTimer) clearTimeout(continuationTimer);
      timer = null;
      nextAt = 0;
    },
  };

  // 跨年了、内置表还没覆盖到今年：启动时补一次日历接口（失败只记日志，不挡拍）。
  try {
    const c0 = loadConfig();
    if (opt.enabled !== false) {
      const synced = repairEmotionConfig({ cfg: c0, force: false });
      if (synced.changed) log.info('情绪插件配置已按本机环境自动对齐：' + synced.changes.join('；'));
    }
    const yr = new Date().getFullYear();
    if (c0?.calendar?.auto !== false && c0?.calendar?.url && !builtinYears().includes(yr)) {
      void refreshCalendar({ year: yr, url: c0.calendar.url, cfg: c0 })
        .then((r) => log.info(r.ok ? `节假日日历：已缓存 ${r.year}（放假 ${r.off} / 调休 ${r.work}）` : `节假日日历没拉到：${r.reason}`))
        .catch((e) => log.warn(`节假日日历出错：${String(e?.message || e).slice(0, 120)}`));
    }
  } catch {}

  const firstDelay = Math.max(0, Number(loadConfig().startupDelaySec ?? opt.startupDelaySec) || 0) * 1000;
  schedule(firstDelay);
  scheduleContinuation();
  if (opt.enabled !== false && douyinPrimary(loadConfig())) {
    markChatBoot();
    douyin.start(pollDelayMs(loadConfig().channels.douyin));
  } else if (opt.enabled !== false && internalPrimary(loadConfig())) {
    markChatBoot();
    if (sharedSessionId()) {
      void syncInternalHistory({
        sessionId: sharedSessionId(), sessions: sessionsHost(), controller: sessionController(), persistence: sessionPersistence(),
      }).catch(() => {});
    }
  }
  compactChatTools.sync();
  log.info(
    `插件已激活：每 ${tickMinutes()} 分钟一拍，首拍 +${Math.round(firstDelay / 1000)}s，` +
      `dryRun=${loadConfig().dryRun !== false}${opt.hostLlm === false ? '，宿主模型已关（走 spawn）' : ''}`
  );

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { syncBuiltinExploreFeeds({ exploration: { builtinFeeds: false } }); api.stop(); });
  } else if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => api.stop());
    } catch {
      /* 老宿主没有 dispose 事件就算了；定时器已 unref，不会吊住退出 */
    }
  }

  // cordis 不要求返回值，但测试与自检需要拿到 api
  try {
    if (typeof ctx.set === 'function') ctx.set('presenceGate', api);
  } catch {
    /* 服务名被占了也不影响插件本身 */
  }

  return api;
}
