import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { explorationStatus } from './explore.js';
import { publicExplorationUrl } from './explore-media.js';
import { shiftDay } from './retention.js';
import { dayKey } from './time.js';

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
  const notes = [...(status.notes || []), status.thread, status.leisure].filter((entry) =>
    entry?.topic && entry?.progress && Number.isFinite(entry.at) && entry.at <= now &&
    (!day || dayKey(entry.at, tz) === day))
    .sort((a, b) => b.at - a.at)
    .filter((entry) => {
      const key = JSON.stringify([entry.at, entry.topic, entry.progress]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 4);
  if (!notes.length) return target + '没找到已保存的探索笔记。';
  return [target + '的探索笔记', ...notes.map((note) =>
    '· ' + brief(note.topic, 35) + '｜' + brief(note.progress, 100) +
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
      if (result.action === 'skip' || !result.thread?.progress) return { text: '这一轮看过了，暂时没有新进展。' };
      return { text: ['刚把「' + brief(result.thread.topic, 40) + '」往前推了一点。',
        brief(result.thread.progress, 170),
        ...(result.thread.next ? ['接下来：' + brief(result.thread.next, 90)] : [])].join('\n') };
    }
    case 'summarize_notes':
      return { text: summarizeExplorationNotes(state(), persona(), cmd.params.target, now, cfg.timezone) };
    case 'run_tests':
      return { text: await runPluginSmoke(cfg) };
    default:
      return { text: '这条指令没有可执行的任务。' };
  }
}
