import { CONFIG_PATH, loadConfig, loadState, saveConfig } from './config.js';
import {
  SEARCH_TAGS,
  applyChange,
  channelItemsForUi,
  explorationItemsForUi,
  hiddenItemsForSearch,
  listForUi,
  saveSecret,
} from './settings.js';
import {
  applyPresetToConfig,
  presetsForUi,
  resetPresetOverride,
  updatePresetOverride,
} from './presets.js';
import { connectivity, diagnostics, feedbackSlotsForUi } from './diagnostics.js';
import { refreshHostModelCatalog } from '../decision/hostllm.js';
import { loadPersona } from '../decision/persona.js';
import { setFeedbackReceipt } from '../decision/feedback.js';
import { mergeMemorySessions, restoreMemoryBackup } from '../decision/memorysource.js';
import { repairEmotionConfig } from '../decision/emotion-sync.js';
import { redeployFullscreenHelper } from '../perception/fullscreen-guard.js';
import { dismissAgreement } from '../chat/agreements.js';
import { dismissRollover, pendingRollovers } from '../chat/session-rollover.js';
import { stopBackgroundTask } from '../chat/action-proposal.js';
import { bridgeLastIn, bridgeLastOut } from '../chat/outbound.js';
import { explorationStatus, loadExploration } from '../explore/explore.js';
import { publicExplorationUrl, splitInterestItems } from '../explore/explore-media.js';
import {
  applyExplorationFeedback,
  explorationFeedbackHints,
  topicInExplorationFeedback,
} from '../explore/exploration-feedback.js';
import {
  classifyExplorationTarget,
  setExplorationWorkSource,
} from '../explore/exploration-target.js';
import { syncBuiltinExploreFeeds } from '../explore/explore-feeds.js';
import { douyinPeer, douyinPrimary, pollDelayMs, writeChatData } from '../channels/douyin-im.js';
import {
  internalPrimary,
  listHostSessions,
  sharedSessionId,
  syncBoundSessionModel,
  syncInternalHistory,
} from '../channels/internal.js';
import {
  bindSharedSession,
  changePrimaryChannel,
  chatBinding,
  localApiOrigin,
  localChatApi,
  readyDouyinBinding,
  switchToQq,
} from '../channels/chat-switch.js';

const API_PREFIX = '/api/dsh-drop-by';
const LOOPBACK_HOST_RE = /^(?:127(?:\.\d{1,3}){3}|localhost|\[?::1\]?)$/i;

function firstHeader(headers, name) {
  const v = headers?.[name];
  return String(Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();
}

function connectionOf(c, ctx, serviceOf) {
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
function rejectIfUntrusted(req, c, ctx, json, serviceOf) {
  const conn = connectionOf(c, ctx, serviceOf);
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

/** 读请求体（设置页最多几十字节；给 64KB 上限，别让人拿它当上传口）。 */
export function readBody(req, limit = 64 * 1024) {
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

/**
 * 挂载 `/api/dsh-drop-by/*` 设置与状态 HTTP 接口。
 */
export function registerPluginHttpRoutes({
  ctx,
  log,
  serviceOf,
  whenService,
  noteMount,
  snapshot,
  llmNow,
  runOnce,
  runExploration,
  stopExploration,
  stopDisabledAutoExploration,
  getExplorationTopicIssue,
  setExplorationTopicIssue,
  douyin,
  openSharedSession,
  activeBoundSession,
  sessionsHost,
  sessionController,
  sessionPersistence,
  workspaceRegistry,
  sessionProjections,
  qqAdapter,
  rolloverFile,
  rolloverAdapter,
  compactChatTools,
  rescheduleIfIdle,
}) {
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
      if (['exploration.nextTopic', 'exploration.interest', 'exploration.workSources'].includes(r.path)) setExplorationTopicIssue(null);
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

    if (['tickMinutes', 'tickJitterSec'].includes(r.path)) {
      rescheduleIfIdle();
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

  let mountedServer = null;
  const mountApi = (c) => {
    const ws = serviceOf(c, 'webServer');
    if (!ws || typeof ws.register !== 'function') {
      noteMount('api: webServer 拿不到，跳过');
      return;
    }
    if (mountedServer === ws) return;
    try {
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
            if (rejectIfUntrusted(req, c, ctx, json, serviceOf)) return;
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
              if (route === '/task/stop' && req.method === 'POST') {
                let body;
                try { body = JSON.parse((await readBody(req)) || '{}'); }
                catch { return json(400, { ok: false, error: '请求体不是 JSON' }); }
                if (!body || typeof body !== 'object' || Array.isArray(body) ||
                    (body.taskId !== undefined && typeof body.taskId !== 'string')) {
                  return json(400, { ok: false, error: '任务编号无效' });
                }
                const result = stopBackgroundTask(body.taskId);
                const note = result.ok
                  ? `已中止后台任务：${result.task?.label || '后台任务'}`
                  : result.reason === 'STALE_TASK'
                    ? '当前后台任务已更换，请重新确认后再中止'
                    : '当前没有正在运行的后台任务';
                return json(200, { ...result, note, state: snapshot() });
              }
              if (route === '/explore/topic' && req.method === 'POST') {
                let body;
                try { body = JSON.parse((await readBody(req)) || '{}'); }
                catch { return json(400, { ok: false, error: '请求体不是 JSON' }); }
                const issue = getExplorationTopicIssue();
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
                setExplorationTopicIssue(body.choice === 'work' ? { ...issue, input: replacement, field: field || 'nextTopic',
                  reason: 'WORK_SOURCE_REQUIRED' } : null);
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
              if (route === '/fullscreen-guard/redeploy' && req.method === 'POST') {
                const r = await redeployFullscreenHelper();
                const note = r.ok
                  ? '全屏检测原生辅助进程已重新部署并就绪'
                  : '原生编译不可用，已自动退回 PowerShell 兜底模式';
                return json(200, { ok: true, result: r, note, state: snapshot() });
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
