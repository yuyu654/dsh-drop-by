import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { saveConfig } from './config.js';
import { explorationStatus, loadExploration } from './explore.js';
import { recentSharedExplorationTopic, recordExplorationDirection, topicInExplorationFeedback } from './exploration-feedback.js';
import { loadPersona } from './persona.js';
import { publicExplorationUrl } from './explore-media.js';
import { shiftDay } from './retention.js';
import { dayKey } from './time.js';
import { incomingMatches } from './action-proposal.js';
import { activeChatChannel, canReadChat, chatDialogue, chatPeer } from './channels/external.js';
import { saveTopicPreference } from './feedback.js';
import { explorationDirectionSite, looksLikeExplorationDirection, looksLikeTopicPreference, safeExplorationTopic } from './command-matcher.js';
import { topicLabel } from './explain.js';

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
const smokeFile = fileURLToPath(new URL('../tools/qq-task-smoke.test.mjs', import.meta.url));
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

async function runPluginSmoke(cfg) {
  const options = {
    windowsHide: true, cwd: fileURLToPath(new URL('../', import.meta.url)),
    timeout: Number(cfg.rules?.qqCommands?.timeoutSec ?? 90) * 1000,
    maxBuffer: 256 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
    return render(error.stdout || '') || '陪伴快速测试没跑完，没拿到可确认的结果。';
  }
}

export async function executeQqCommand({ cmd, cfg, media, explore, state, persona, now = Date.now() }) {
  switch (cmd.type) {
    case 'explore_query':
      return { text: media?.web ? formatSearchResult(await media.collect('web', cmd.params.query))
        : '这会儿网页搜索工具用不了，没搜到资料。' };
    case 'explore_trigger': {
      const result = await explore(cmd.params);
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
    case 'run_tests':
      return { text: await runPluginSmoke(cfg) };
    default:
      return { text: '这条指令没有可执行的任务。' };
  }
}
