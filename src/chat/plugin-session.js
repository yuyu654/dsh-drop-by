import { loadConfig } from '../settings/config.js';
import { builtinYears } from '../perception/holidays.js';
import { calendarStatus, refreshCalendar } from '../perception/calendar.js';
import { watchVideo } from '../perception/video-host.js';
import { appendEmotionInbox, inspectEmotionPlugin, repairEmotionConfig } from '../decision/emotion-sync.js';
import { inspectMemory, mergeMemorySessions } from '../decision/memorysource.js';
import { refreshHostModelCatalog } from '../decision/hostllm.js';
import { buildReplyContext } from './qq-reply.js';
import { installQqPromptMerge } from './qq-debounce.js';
import { createSessionRollover } from './session-rollover.js';
import { sendQQPrivate } from './send.js';
import { canReadChat, emotionPeer } from '../channels/external.js';
import { douyinPeer, douyinPrimary, sendDouyinText } from '../channels/douyin-im.js';
import {
  internalPrimary,
  isProactiveInternalText,
  observeInternalEvent,
  readInternalState,
  sendInternalMessage,
  sharedSessionId,
  syncBoundSessionModel,
  syncInternalHistory,
  textFromContent,
} from '../channels/internal.js';
import { chatBinding } from '../channels/chat-switch.js';

/**
 * 向 DSH 注册模型可调用的工具（presence_status / presence_watch_video 及可选维护工具）。
 */
export function registerPluginTools({
  ctx,
  opt,
  log,
  serviceOf,
  whenService,
  noteMount,
  snapshot,
  llmNow,
  runOnce,
  runExploration,
}) {
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

/**
 * 挂载会话监听、精简陪聊工具同步、单轮工具上限守卫与自动续聊交接。
 */
export function registerPluginSessionHooks({
  ctx,
  pluginName,
  log,
  serviceOf,
  whenService,
  isDisposed,
  compactChatTools,
  douyin,
  rolloverAdapter,
  rolloverFile,
  observeBoundSessionModel,
  setServices,
  getServices,
}) {
  const removeCompactToolListeners = [];
  if (typeof ctx.on === 'function') {
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
  if (typeof ctx.on === 'function') {
    try {
      releaseModelObserver = ctx.on('session/event', (session, event) => {
        if (!isDisposed() && session?.id) observeBoundSessionModel(session, event);
      });
    } catch { /* host may not emit session/event */ }
    try {
      releaseAdaptersObserver = ctx.on('llm/adapters-updated', () => {
        if (!isDisposed()) void refreshHostModelCatalog(ctx).catch(() => {});
      });
    } catch { /* host may not emit llm/adapters-updated */ }
  }

  whenService(ctx, 'llm', (c) => { void refreshHostModelCatalog(c || ctx).catch(() => {}); }, log);
  whenService(ctx, 'sessionProjections', (c) => { setServices({ projectionsService: serviceOf(c, 'sessionProjections') }); }, log);
  whenService(ctx, 'workspaceRegistry', (c) => { setServices({ registryService: serviceOf(c, 'workspaceRegistry') }); }, log);
  whenService(ctx, 'sessions', (c) => {
    const sessionsService = serviceOf(c, 'sessions');
    setServices({ sessionsService });
    if (sharedSessionId()) {
      const { sessionController, sessionPersistence } = getServices();
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
    const persistenceService = serviceOf(c, 'sessionPersistence');
    setServices({ persistenceService });
    if (internalPrimary(loadConfig()) && sharedSessionId()) {
      const { sessionsHost, sessionController } = getServices();
      void syncInternalHistory({
        sessionId: sharedSessionId(), sessions: sessionsHost(), controller: sessionController(), persistence: persistenceService,
      }).catch(() => {});
    }
  }, log);
  whenService(ctx, 'sessionController', (c) => {
    const controller = serviceOf(c, 'sessionController') || serviceOf(ctx, 'sessionController');
    if (isDisposed() || !controller || releases.has(controller)) return;
    setServices({ controllerService: controller });
    const { sessionProjections, workspaceRegistry } = getServices();
    const rollover = createSessionRollover({
      controller,
      projections: () => sessionProjections() || serviceOf(ctx, 'sessionProjections'),
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
        if (isDisposed() || cfg.enabled === false || cfg.dryRun !== false || cfg.send?.enabled !== true || !to ||
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
      if (isDisposed() || cfg.enabled === false || cfg.dryRun !== false || cfg.send?.enabled !== true) return;
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
              payload.source?.plugin !== pluginName && payload.source?.proactive !== true &&
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
        const isInternalControlMsg = payload?.source?.plugin === pluginName || payload?.source?.proactive === true || payload?.source?.source === 'tool-limit';
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
      if (isDisposed() || !session?.id) return;
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

  return {
    stop() {
      for (const dispose of removeCompactToolListeners.splice(0)) {
        if (typeof dispose === 'function') dispose();
      }
      for (const release of releases.values()) release();
      releases.clear();
      if (typeof releaseModelObserver === 'function') releaseModelObserver();
      releaseModelObserver = null;
      if (typeof releaseAdaptersObserver === 'function') releaseAdaptersObserver();
      releaseAdaptersObserver = null;
    },
  };
}
