import { randomUUID } from 'node:crypto';
import { loadConfig, saveConfig } from '../settings/config.js';
import { minutesOfDayOf } from '../settings/time.js';
import { inQuiet } from '../perception/schedule.js';
import { busyNow, offPeakNow } from '../perception/holidays.js';
import { fullscreenGuardStatus, isFullscreenBlocked } from '../perception/fullscreen-guard.js';
import { watchVideo } from '../perception/video-host.js';
import { loadPersona } from '../decision/persona.js';
import { characterRestAt } from '../decision/character-rest.js';
import { updatePortraitMood } from '../decision/emotion-portrait.js';
import { recordExplorationEmotion } from '../decision/emotion-sync.js';
import { listExploreSources, shouldUseBuiltinEmotion } from '../settings/extensions.js';
import { emotionPeer } from '../channels/external.js';
import {
  exploreRound,
  explorationStatus,
  loadExploration,
  personaKey,
  saveExploration,
} from './explore.js';
import { createExplorationMedia, pickInterestItem, publicExplorationUrl, splitInterestItems } from './explore-media.js';
import { abortable } from './exploration-abort.js';
import {
  consumeExplorationFeedback,
  explorationFeedbackHints,
  topicInExplorationFeedback,
} from './exploration-feedback.js';
import {
  TRUSTED_WORK_CATALOGS,
  classifyExplorationTarget,
  resolveExplorationTarget,
} from './exploration-target.js';

/**
 * 自主探索调度器：管理运行态、超时中止、作品定位与探索后情绪同步。
 */
export function createExplorationRunner({
  ctx,
  opt,
  log,
  serviceOf,
  llmNow,
  isDisposed,
  getToolsCtx,
  getWebCtx,
}) {
  let explorationRun = null;
  let explorationRunNotice = null;
  let explorationTopicIssue = null;
  let lastExploreAttempt = 0;

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
    if (isDisposed() || opt.enabled === false || explorationRun) return { ok: false, reason: 'UNAVAILABLE' };
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
    if (!manual) {
      const fg = await isFullscreenBlocked(cfg, { now });
      if (fg.blocked) return { ok: false, reason: fg.reason || 'FULLSCREEN_GAME' };
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
    if (!manual && fullscreenGuardStatus(cfg).enabled) {
      let checkingFs = false;
      job.fsTimer = setInterval(() => {
        if (checkingFs || signal.aborted || explorationRun !== job) return;
        if (fullscreenGuardStatus(cfg).mode === 'powershell') return;
        checkingFs = true;
        void isFullscreenBlocked(cfg, { maxCacheMs: 4000 })
          .then((fg) => {
            if (fg.blocked && !signal.aborted && explorationRun === job) {
              log.info('检测到进入全屏游戏，已中止本轮自主探索并保留已有进度');
              stopExploration(job.id, 'FULLSCREEN_GAME');
            }
          })
          .catch(() => {})
          .finally(() => { checkingFs = false; });
      }, 5000);
      job.fsTimer.unref?.();
    }
    explorationRun = job;
    explorationRunNotice = null;
    lastExploreAttempt = now;
    const generate = (args) => abortable(() => host.generate({ ...args, signal }), signal);
    const toolsCtx = getToolsCtx();
    const webCtx = getWebCtx();
    try {
      const media = createExplorationMedia({ timing: cfg.exploration, signal,
        tools: serviceOf(toolsCtx || ctx, 'tools'),
        webService: serviceOf(webCtx || toolsCtx || ctx, 'web'),
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
        watchDouyin: (id) => watchVideo(id, { cfg, host, llm: generate, ctx: toolsCtx || ctx, signal }),
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
      if (isDisposed() || fresh.enabled === false || (!manual && fresh.exploration.auto !== true) ||
          (retry && (fresh.rules?.actionGate?.enabled !== true || fresh.exploration.web !== true)) ||
          (requestedResearch && fresh.rules?.qqCommands?.enabled !== true) ||
          personaKey(loadPersona({ cfg: fresh })) !== personaKey(persona)) return { ok: false, reason: 'CANCELLED' };
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
      if (job.fsTimer) clearInterval(job.fsTimer);
      if (explorationRun === job) explorationRun = null;
    }
  }

  return {
    runExploration,
    stopExploration,
    stopDisabledAutoExploration,
    getRun: () => explorationRun,
    getRunNotice: () => explorationRunNotice,
    getTopicIssue: () => explorationTopicIssue,
    setTopicIssue: (issue) => { explorationTopicIssue = issue; },
  };
}
