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
import { loadConfig, loadState, CONFIG_PATH, LOG_DIR } from './settings/config.js';
import { tick, tickDueAgreement, tickQqContinuation, qqContinuationEnabled } from './decision/engine.js';
import { listAgreements, dueAgreement, flushAgreementIntake, pruneAgreements } from './chat/agreements.js';
import { explorationFeedbackForUi } from './explore/exploration-feedback.js';
import { createQqContinuation } from './chat/qq-continuation.js';
import { createCompactChatTools } from './chat/compact-chat-tools.js';
import { characterRestAt } from './decision/character-rest.js';
import { inQuiet } from './perception/schedule.js';
import { busyNow, builtinYears, deepseekPeakStatus } from './perception/holidays.js';
import { refreshCalendar } from './perception/calendar.js';
import { loadPersona } from './decision/persona.js';
import { explorationStatus, explorationMood, loadExploration } from './explore/explore.js';
import { makeHostLlm, setHostLlmContext, setHostLlmTrace } from './decision/hostllm.js';
import { detectSources, detectEmotionPortrait } from './settings/detect.js';
import { inspectEmotionPlugin, appendEmotionInbox } from './decision/emotion-sync.js';
import { inspectMemory } from './decision/memorysource.js';
import { watchVideo } from './perception/video-host.js';
import { bindActionExecutor, isHandledActionMessage, tryStopExplorationCommand } from './chat/action-proposal.js';
import { sendQqText } from './chat/qq-send.js';
import { pendingRollovers } from './chat/session-rollover.js';
import { qqRolloverAdapter } from './chat/qq-rollover-adapter.js';
import { isBridgeManagedMessage } from './chat/qq-debounce.js';
import { executeQqCommand } from './chat/qq-command.js';
import { createExplorationMedia } from './explore/explore-media.js';
import { syncBuiltinExploreFeeds } from './explore/explore-feeds.js';
import { createExplorationRunner } from './explore/plugin-exploration.js';
import { registerPluginHttpRoutes } from './settings/plugin-http.js';
import { registerPluginSessionHooks, registerPluginTools } from './chat/plugin-session.js';
import {
  registerExploreSource, registerMoodSource, registerMemorySource, registerTopicProvider,
  listExtensions, notifyExternalMoodMessage, shouldUseBuiltinEmotion, inspectActiveMood,
} from './settings/extensions.js';
import { chatBinding, chatChanging, markChatBoot, readyDouyinBinding, switchState } from './channels/chat-switch.js';
import { douyinPeer, douyinPeerName, douyinPrimary, pollDelayMs, readChatData, readDouyinState, sendDouyinText, writeChatData } from './channels/douyin-im.js';
import {
  bindInternalDispatcher, dispatchToHostSession, internalPrimary, internalSessionId,
  observeBoundSessionModel, readInternalState, sendInternalMessage, sharedSessionId, syncInternalHistory,
} from './channels/internal.js';
import { createDouyinSession } from './channels/douyin-session.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer, emotionPeer } from './channels/external.js';
import { agreementLlm, buildReplyContext, observePrivateMessage } from './chat/qq-reply.js';
import { topicLabel } from './decision/explain.js';

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
    // 单元测试未显式隔离日志目录时，不污染真实仓库的 logs/plugin.log
    if (!envLog && !envCfg && (process.env.NODE_TEST_CONTEXT || process.argv.includes('--test'))) return;
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
  let explorationToolsCtx = null;
  let explorationWebCtx = null;
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

  const explorationRunner = createExplorationRunner({
    ctx, opt, log, serviceOf, llmNow,
    isDisposed: () => disposed,
    getToolsCtx: () => explorationToolsCtx,
    getWebCtx: () => explorationWebCtx,
  });
  const { runExploration, stopExploration, stopDisabledAutoExploration } = explorationRunner;

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
        return { ...status, feedback: explorationFeedbackForUi(status, cfg), auto: cfg.exploration.auto, mode: cfg.exploration?.mode === 'light' ? 'light' : 'deep', running: Boolean(explorationRunner.getRun()),
          runId: explorationRunner.getRun()?.id || null, runNotice: explorationRunner.getRunNotice(), topicIssue: explorationRunner.getTopicIssue(),
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

  if (opt.statusApi !== false) {
    registerPluginHttpRoutes({
      ctx, log, serviceOf, whenService, noteMount, snapshot, llmNow, runOnce,
      runExploration, stopExploration, stopDisabledAutoExploration,
      getExplorationTopicIssue: explorationRunner.getTopicIssue,
      setExplorationTopicIssue: explorationRunner.setTopicIssue,
      douyin, openSharedSession, activeBoundSession,
      sessionsHost, sessionController, sessionPersistence, workspaceRegistry, sessionProjections,
      qqAdapter, rolloverFile, rolloverAdapter, compactChatTools,
      rescheduleIfIdle() {
        if (timer && !running) { clearTimeout(timer); schedule(intervalMs()); }
      },
    });
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

  if (opt.tool !== false) {
    registerPluginTools({
      ctx, opt, log, serviceOf, whenService, noteMount, snapshot, llmNow, runOnce, runExploration,
    });
  }

  const sessionHooks = opt.enabled !== false ? registerPluginSessionHooks({
    ctx, pluginName: name, log, serviceOf, whenService,
    isDisposed: () => disposed,
    compactChatTools, douyin, rolloverAdapter, rolloverFile, observeBoundSessionModel,
    setServices(patch) {
      if ('controllerService' in patch) controllerService = patch.controllerService;
      if ('projectionsService' in patch) projectionsService = patch.projectionsService;
      if ('registryService' in patch) registryService = patch.registryService;
      if ('sessionsService' in patch) sessionsService = patch.sessionsService;
      if ('persistenceService' in patch) persistenceService = patch.persistenceService;
    },
    getServices: () => ({ sessionsHost, sessionController, sessionPersistence, workspaceRegistry, sessionProjections }),
  }) : null;

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
      sessionHooks?.stop();
      compactChatTools.stop();
      releaseActionExecutor();
      releaseInternalDispatcher();
      douyin.stop();
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
