import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { saveConfig, loadState } from '../settings/config.js';
import { explorationStatus, loadExploration } from '../explore/explore.js';
import { agendaSource, nextCourse, parseAgenda } from '../perception/agenda.js';
import { parseExams, examsSource } from '../perception/exams.js';
import { recentSharedExplorationTopic, recordExplorationDirection, topicInExplorationFeedback } from '../explore/exploration-feedback.js';
import { loadPersona } from '../decision/persona.js';
import { publicExplorationUrl } from '../explore/explore-media.js';
import { openExplorationLoginTab } from '../explore/explore-browser.js';
import { shiftDay } from '../settings/retention.js';
import { dayKey } from '../settings/time.js';
import { incomingMatches } from './action-proposal.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer } from '../channels/external.js';
import { saveTopicPreference } from '../decision/feedback.js';
import { explorationDirectionSite, looksLikeExplorationDirection, looksLikeTopicPreference, safeExplorationTopic } from './command-matcher.js';
import { topicLabel } from '../decision/explain.js';

export function verifiedPreferenceMessage({ peer, kind, text, bridgeText = text, at, cfg, internalSession, now = Date.now() }) {
  const message = String(bridgeText || '').trim();
  if (kind !== 'private' || !peer || chatPeer(cfg) !== String(peer) ||
      cfg.enabled === false || cfg.rules?.qqCommands?.enabled !== true || !canReadChat(cfg) ||
      message.length > 80 || !looksLikeTopicPreference(message)) return '';
  const age = now - Number(at);
  if (!(age >= 0 && age <= Number(cfg.rules.qqCommands.freshSec ?? 120) * 1000)) return '';
  const { incoming } = chatDialogue(cfg);
  return incomingMatches({ peer, kind, bridgeText, at, incoming, cfg, internalSession }) ? message : '';
}

export function applyTopicPreference(preference, input) {
  if (preference.quote !== verifiedPreferenceMessage(input)) return '';
  const { peer, at, cfg } = input;
  let result;
  try {
    result = saveTopicPreference(preference, { channel: activeChatChannel(cfg), peer, at }, cfg);
  } catch {
    return '【陪伴话题偏好】这次保存失败。请如实说明，建议用户稍后重试。';
  }
  if (!result) return '【陪伴话题偏好待确认】没有可核对的上一条主动话题。请在普通回复里请用户说出具体话题。';
  const label = result.target.slot ? topicLabel(result.target.slot) : result.target.keyword;
  const effect = { reset: '恢复默认', allow_silent: '照常考虑发送，用户没回复也不会因此追问或降频',
    mute_less: '有效期内暂停主动提起' }[result.mode];
  return '【陪伴话题偏好已保存】根据已生效的结果自然确认一句，无需调用工具。' + JSON.stringify({ 话题: label, 效果: effect });
}


// QQ's marker keeps only 80 characters. Require the entire command to be covered.
export function verifiedExplorationInput({ peer, kind, text, bridgeText = text, at, cfg, internalSession, now = Date.now() }) {
  const message = String(bridgeText || '');
  const channel = activeChatChannel(cfg);
  if (kind !== 'private' || !peer || chatPeer(cfg) !== String(peer) ||
      cfg.enabled === false || cfg.rules?.qqCommands?.enabled !== true || !canReadChat(cfg)) return null;
  const age = now - Number(at);
  if (!(age >= 0 && age <= Number(cfg.rules.qqCommands.freshSec ?? 120) * 1000)) return null;
  if (channel === 'internal') return internalSession === peer ? message.trim() : null;
  const { incoming } = chatDialogue(cfg);
  if (!incomingMatches({ peer, kind, bridgeText, at, incoming, cfg })) return null;
  // Count authenticated long turns without passing their truncated text to the matcher.
  return message.length <= (channel === 'qq' ? 80 : 180) ? message.trim() : '';
}

export function explorationDirectionContext({ cfg, peer }, recent = []) {
  const status = explorationStatus(loadExploration(), loadPersona({ cfg }));
  const entries = [status.thread, status.leisure, status.light].filter(entry => entry?.topic)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const share = recentSharedExplorationTopic({ cfg, peer, channel: activeChatChannel(cfg) });
  const directions = [share, ...entries.map(entry => entry.topic), cfg.exploration?.nextTopic, cfg.exploration?.interest]
    .map(safeExplorationTopic).filter(Boolean);
  return { recent, directions: [...new Set(directions)] };
}

function directionTopicKey(text) {
  const value = String(text || '').trim();
  const title = value.match(/^(?:[^《》]{1,24}[：:]\s*)?《([^《》]+)》$/u)?.[1] ||
    (explorationDirectionSite(value.split(/[：:]/u)[0]) ? value.replace(/^[^：:]+[：:]\s*/u, '') : value);
  return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function applyExplorationDirection(direction, input) {
  const { cfg } = input;
  const message = verifiedExplorationInput(input);
  if (message !== direction.quote || !looksLikeExplorationDirection(message)) return '';
  const target = safeExplorationTopic(direction.target);
  if (!target) return '';
  const options = cfg.exploration;
  let title = target;
  try {
    if (direction.action === 'focus') {
      const site = explorationDirectionSite(message);
      if (site && !explorationDirectionSite(target)) title = site + '：' + target;
      if (title.length > 120) return '';
      saveConfig({ ...cfg, exploration: { ...options, nextTopic: title } });
    } else {
      if (!explorationDirectionContext(input).directions.includes(target) ||
          !recordExplorationDirection({ cfg, action: direction.action, topic: target })) return '';
      const clearNext = Boolean(options?.nextTopic && (
        directionTopicKey(options.nextTopic) === directionTopicKey(target) ||
        topicInExplorationFeedback(options.nextTopic, [target])
      ));
      const clearInterest = Boolean(options?.interest && (
        directionTopicKey(options.interest) === directionTopicKey(target) ||
        topicInExplorationFeedback(options.interest, [target])
      ));
      if (clearNext || clearInterest) {
        saveConfig({
          ...cfg,
          exploration: {
            ...options,
            ...(clearNext ? { nextTopic: '' } : {}),
            ...(clearInterest ? { interest: '' } : {}),
          },
        });
      }
    }
  } catch {
    return '<qq_reply_context>\n【陪伴探索方向保存异常】按实际情况说明，别承诺更改已经完成。\n</qq_reply_context>';
  }
  const effect = direction.action === 'focus' ? '已设为下一轮探索主题'
    : direction.action === 'change' ? '已放下旧方向，接下来换个题目' : '已放下这个探索方向';
  return '<qq_reply_context>\n【陪伴探索方向已更新】按人设自然确认一句，无需调用工具。' +
    JSON.stringify({ 主题: title, 效果: effect }) + '\n</qq_reply_context>';
}

const exec = promisify(execFile);
const smokeFile = fileURLToPath(new URL('../../tools/qq-task-smoke.test.mjs', import.meta.url));
const brief = (value, max) => String(value || '').replace(/\s+/gu, ' ').replace(/\[CQ:/giu, '［CQ:').trim().slice(0, max);

export function formatSearchResult(sources) {
  const rows = sources.flatMap((source) => {
    const url = publicExplorationUrl(source.url);
    if (!url) return [];
    const label = source.evidence === '网页正文' ? '正文' : source.evidence === '需要登录' ? '登录后可读' : '仅摘要';
    const excerpt = label === '登录后可读' ? '' : brief(source.content, 120);
    return [[brief(source.title, 46) || url.hostname, '（' + label + '）', excerpt ? '\n' + excerpt : '', '\n' + url.href].join('')];
  });
  return rows.length ? ['翻到这些线索', ...rows.slice(0, 2)].join('\n\n') : '搜了一圈，没找到可以分享的结果。';
}

export function summarizeExplorationNotes(state, persona, target, now, tz) {
  const status = explorationStatus(state, persona);
  const today = dayKey(now, tz);
  const day = target === '昨天' ? shiftDay(today, -1) : target === '今天' ? today : null;
  const seen = new Set();
  const notes = [...(status.notes || []), status.thread, status.leisure, status.light].filter((entry) =>
    entry?.topic && (entry.progress || entry.summary) && Number.isFinite(entry.at) && entry.at <= now &&
    (!day || dayKey(entry.at, tz) === day))
    .sort((a, b) => b.at - a.at)
    .filter((entry) => {
      const key = JSON.stringify([entry.at, entry.topic, entry.progress || entry.summary]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
  if (!notes.length) return target + '没找到已保存的探索笔记。';
  return [target + '的探索笔记', ...notes.map((note) =>
    '· ' + brief(note.topic, 35) + '｜' + brief(note.progress || note.summary, 100) +
    (note.next ? '\n  接下来：' + brief(note.next, 60) : ''))].join('\n');
}

async function runPluginSmoke(cfg, signal) {
  const options = {
    windowsHide: true, cwd: fileURLToPath(new URL('../../', import.meta.url)),
    timeout: Number(cfg.rules?.qqCommands?.timeoutSec ?? 90) * 1000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    ...(signal ? { signal } : {}),
  };
  const render = (out) => {
    const passed = /^# pass (\d+)/m.exec(out)?.[1];
    const failed = /^# fail (\d+)/m.exec(out)?.[1];
    return passed != null && failed != null ? '陪伴快速测试跑完了，通过 ' + passed + ' 项，失败 ' + failed + ' 项。' : '';
  };
  try {
    const { stdout } = await exec(process.execPath, ['--test', '--test-reporter=tap', smokeFile], options);
    return render(stdout) || '陪伴快速测试结束了，但没读到统计。';
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') return null;
    return render(error.stdout || '') || '陪伴快速测试没跑完，没拿到可确认的结果。';
  }
}

/** 从近期探索记录里找出最近一条卡登录墙且带合法公网 URL 的记录，供调出登录页与登录后续跑。 */
export function latestLoginContext(explorationState = loadExploration(), cfg = {}) {
  const st = explorationState && typeof explorationState === 'object' ? explorationState : {};
  const status = explorationStatus(st, loadPersona({ cfg }));
  const candidates = [
    ...(Array.isArray(st.history) ? st.history : []),
    ...(status.candidate?.loginSite ? [{ ...status.candidate, url: status.candidate.source?.url,
      topic: st.lastRun?.query || status.candidate.source?.title }] : []),
    status.thread,
    status.leisure,
    status.light,
  ].filter(Boolean);
  candidates.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  for (const entry of candidates) {
    const urlObj = publicExplorationUrl(entry.url || entry.sourceUrl || '');
    const url = urlObj ? String(urlObj.href || urlObj) : '';
    const site = String(entry.loginSite || '').trim();
    if (url && site) {
      return {
        url,
        site,
        topic: String(entry.topic || '').trim().slice(0, 80),
        at: Number(entry.at) || 0,
      };
    }
  }
  return null;
}

async function openPublicUrlInBrowser(url, cfg = {}) {
  const safeObj = publicExplorationUrl(url);
  const safeUrl = safeObj ? String(safeObj.href || safeObj) : '';
  if (!safeUrl) return { ok: false, reason: 'INVALID_URL' };
  if (await openExplorationLoginTab(safeUrl, cfg.content?.forward).catch(() => false)) return { ok: true, url: safeUrl };
  const exec = promisify(execFile);
  if (process.platform === 'win32') {
    await exec('rundll32.exe', ['url.dll,FileProtocolHandler', safeUrl], { windowsHide: true, timeout: 8000 });
  } else if (process.platform === 'darwin') {
    await exec('open', [safeUrl], { timeout: 8000 });
  } else {
    await exec('xdg-open', [safeUrl], { timeout: 8000 });
  }
  return { ok: true, url: safeUrl, fallbackBrowser: true };
}

function formatLocalQuery(scope, cfg, explorationState, now) {
  const tz = cfg?.timezone || 'Asia/Shanghai';
  const lines = [];
  const want = (k) => !scope || scope === k;

  if (want('课表')) {
    const raw = agendaSource(cfg)?.text || '';
    const next = raw ? nextCourse(raw, now, tz, {
      periods: cfg?.content?.agenda?.periods || '',
      termStart: cfg?.content?.agenda?.termStart || '',
      off: cfg?.content?.agenda?.off || [],
    }) : null;
    lines.push(next
      ? `课表：下一节是「${next.name || '课程'}」（${next.dayLabel || ''}${next.hm || ''}${next.room ? ' @' + next.room : ''}）。`
      : '课表：当前没有查到待上的课程。');
  }
  if (want('考试')) {
    const raw = examsSource(cfg)?.text || '';
    const list = raw ? parseExams(raw, { tz, now }) : [];
    const upcoming = list.find((e) => Number(e.at) >= now) || null;
    lines.push(upcoming
      ? `考试：最近一场是「${upcoming.subject || '考试'}」（${upcoming.date || ''} ${upcoming.hm || ''}）。`
      : '考试：当前没有查到待考安排。');
  }
  if (want('探索')) {
    const status = explorationStatus(explorationState || {}, loadPersona({ cfg }));
    const active = [status.thread, status.leisure, status.light].filter((e) => e?.topic).sort((a, b) => (b.at || 0) - (a.at || 0))[0];
    lines.push(active
      ? `探索：最近在看「${brief(active.topic, 36)}」${active.next ? `，下一步：${brief(active.next, 60)}` : ''}。`
      : '探索：最近还没有保存的探索进展。');
  }
  if (want('状态')) {
    const st = loadState();
    const sent = Number(st?.real?.todaySent) || 0;
    const cap = Number(cfg?.rules?.dailyCap) || 0;
    const left = Math.max(0, cap - sent);
    lines.push(`陪伴状态：今天已主动发 ${sent}/${cap} 条（剩余 ${left} 条额度），当前模式为 ${cfg?.dryRun !== false ? '演练' : '正式'}。`);
  }
  return lines.join('\n') || '没查到对应的本地记录。';
}

export async function executeQqCommand({ cmd, cfg, media, explore, state, persona, openUrl = openPublicUrlInBrowser, now = Date.now(), signal = null }) {
  if (signal?.aborted) return { reason: 'CANCELLED' };
  switch (cmd.type) {
    case 'explore_query': {
      if (!media?.web) return { text: '这会儿网页搜索工具用不了，没搜到资料。' };
      const res = await media.collect('web', cmd.params.query);
      if (signal?.aborted) return { reason: 'CANCELLED' };
      return { text: formatSearchResult(res) };
    }
    case 'explore_trigger': {
      const result = await explore(cmd.params);
      if (signal?.aborted || result?.reason === 'CANCELLED') return { reason: 'CANCELLED' };
      if (result?.reason === 'EXPLORATION_TIMEOUT') return { text: '本轮自主探索到时限，已经停止。' };
      if (!result?.ok) return { text: result?.reason === 'UNAVAILABLE' ? '手头那轮探索还在跑，这次没能再起一轮。'
        : '这轮探索没跑完，没拿到新进展。' };
      const entry = result.action === 'light' ? result.light : result.thread;
      const progress = entry?.progress || entry?.summary;
      if (result.action === 'skip' || !progress) return { text: '这一轮看过了，暂时没有新进展。' };
      return { text: ['刚把「' + brief(entry.topic, 40) + '」往前推了一点。',
        brief(progress, 170),
        ...(entry.next ? ['接下来：' + brief(entry.next, 90)] : [])].join('\n') };
    }
    case 'summarize_notes':
      return { text: summarizeExplorationNotes(state(), persona(), cmd.params.target, now, cfg.timezone) };
    case 'run_tests': {
      const text = await runPluginSmoke(cfg, signal);
      if (signal?.aborted || text === null) return { reason: 'CANCELLED' };
      return { text };
    }
    case 'open_login_page': {
      const targetObj = publicExplorationUrl(cmd.params?.url || latestLoginContext(state?.(), cfg)?.url || '');
      const targetUrl = targetObj ? String(targetObj.href || targetObj) : '';
      if (!targetUrl) return { text: '最近没有记到需要登录的公开网页链接。' };
      try {
        const opened = await openUrl(targetUrl, cfg);
        if (!opened?.ok) return { text: '没能打开那个登录页面，可以手动打开：' + targetUrl };
        if (opened.fallbackBrowser) return { text: '已用默认浏览器打开页面。续读使用 DSH 的探索浏览器，登录时请用同一个浏览器。' };
        return { text: `已经在桌面把页面打开了（${targetUrl}），登完告诉我一声。` };
      } catch {
        return { text: '没能调起浏览器窗口，可以先手动打开：' + targetUrl };
      }
    }
    case 'resume_after_login': {
      const pending = latestLoginContext(state?.(), cfg);
      const topic = cmd.params?.topic || pending?.topic;
      const sourceUrl = cmd.params?.url || pending?.url;
      if (!sourceUrl) return { text: '最近没有找到可以续读的登录页面。' };
      const result = await explore({ mode: 'research', ...(topic ? { topic } : {}), sourceUrl, resumedAfterLogin: true });
      if (result?.reason === 'CANCELLED') return result;
      if (result?.reason === 'EXPLORATION_TIMEOUT') return { text: '续读到时限，已经停止。' };
      if (!result?.ok) return { text: result?.reason === 'UNAVAILABLE' ? '手头那轮探索还在跑，稍后再续。'
        : '登录后续读没有跑完，没拿到新进展。' };
      const entry = result.action === 'light' ? result.light : result.thread;
      const progress = entry?.progress || entry?.summary;
      if (result.action === 'skip' || !progress) return { text: '刚去重新看过了，暂时没有读到新进展。' };
      return { text: ['接着把「' + brief(entry.topic, 40) + '」往后读了一段。',
        brief(progress, 170),
        ...(entry.next ? ['接下来：' + brief(entry.next, 90)] : [])].join('\n') };
    }
    case 'browse_url': {
      const safeObj = publicExplorationUrl(cmd.params?.url || '');
      const safeUrl = safeObj ? String(safeObj.href || safeObj) : '';
      if (!safeUrl) return { text: '这个链接不是可访问的公开网址，后台没有打开。' };
      if (!media?.web) return { text: '这会儿探索网页工具没开或不可用，没法在后台读链接。' };
      const fetched = typeof media.fetch === 'function' ? await media.fetch(safeUrl) : await media.collect('web', safeUrl);
      if (signal?.aborted) return { reason: 'CANCELLED' };
      if (typeof fetched === 'string' && fetched.trim()) {
        return { text: `后台读完这个链接了：\n${brief(fetched, 260)}` };
      }
      return { text: formatSearchResult(fetched) };
    }
    case 'query_local':
      return { text: formatLocalQuery(cmd.params?.scope || '', cfg, state?.(), now) };
    default:
      return { text: '这条指令没有可执行的任务。' };
  }
}
