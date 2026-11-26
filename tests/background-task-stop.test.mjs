import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-task-stop-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(dir, 'chat');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const {
  activeBackgroundTask,
  bindActionExecutor,
  queueQqCommand,
  stopBackgroundTask,
  tryStopBackgroundTaskCommand,
  tryStopExplorationCommand,
} = await import('../src/chat/action-proposal.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { runBrowserExploreLoop, selectRelevantLinks } = await import('../src/explore/explore-browser.js');
const { formatMemoryHint } = await import('../src/explore/exploration-memory.js');

function setupInternalConfig() {
  const loaded = loadConfig();
  saveConfig({
    ...loaded,
    dryRun: false,
    channels: { ...loaded.channels, primary: 'internal' },
    send: { ...loaded.send, enabled: true },
    exploration: { ...loaded.exploration, web: true },
    rules: {
      ...loaded.rules,
      actionGate: { ...loaded.rules.actionGate, ackWaitSec: 0 },
      qqCommands: { ...loaded.rules.qqCommands, enabled: true, timeoutSec: 30 },
    },
  });
  writeChatData('external-chat', { sessionId: 'bound' });
  return loadConfig();
}

test('stopBackgroundTask aborts active command, releases queue lock, and suppresses late report', async (t) => {
  const cfg = setupInternalConfig();
  let finishTask;
  let capturedSignal = null;
  let exploreStops = 0;
  const reports = [];
  t.after(bindActionExecutor({
    stopExploration() {
      exploreStops += 1;
      return { ok: true, reason: 'CANCELLED' };
    },
    command(_cmd, _cfg, { signal } = {}) {
      capturedSignal = signal;
      return new Promise((resolve) => { finishTask = resolve; });
    },
    report({ result }) { reports.push(result); },
  }));

  const at = Date.now();
  assert.equal(activeBackgroundTask(), null);
  assert.equal(queueQqCommand({
    cfg, peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '帮我查网页资料', at, now: at, cmd: { type: 'explore_query', params: { query: 'test' } },
  }), 'accepted');
  await new Promise((resolve) => setImmediate(resolve));

  const task = activeBackgroundTask();
  assert.ok(task);
  assert.equal(task.type, 'explore_query');
  assert.equal(task.label, '查网页');

  // 队列被占用时第二条命令被拒
  assert.equal(queueQqCommand({
    cfg, peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '再查一次', at: at + 1, now: at + 1, cmd: { type: 'explore_query', params: { query: 'test2' } },
  }), 'busy');

  // 私聊「中止自主探索」严格独立：不影响当前非探索类后台任务
  const expCtx = tryStopExplorationCommand({
    cfg, peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '中止自主探索', at: at + 2, now: at + 2,
  });
  assert.match(expCtx, /本轮自主探索已中止/);
  assert.equal(exploreStops, 1);
  assert.equal(activeBackgroundTask()?.id, task.id);

  // 私聊「中止后台任务」只中止后台任务，不再触发 stopExploration
  const taskCtx = tryStopBackgroundTaskCommand({
    cfg, peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '中止后台任务', at: at + 3, now: at + 3,
  });
  assert.match(taskCtx, /后台任务「查网页」已中止/);
  assert.equal(exploreStops, 1);
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(activeBackgroundTask(), null);

  // 迟到结果不会再触发回执
  finishTask({ text: '迟到的搜索结果' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reports.length, 0);

  // 队列锁已释放，立刻可以接新任务
  assert.equal(queueQqCommand({
    cfg, peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '新任务', at: at + 4, now: at + 4, cmd: { type: 'explore_query', params: { query: 'test3' } },
  }), 'accepted');
  assert.equal(stopBackgroundTask().ok, true);
  assert.equal(activeBackgroundTask(), null);
});

test('runBrowserExploreLoop skips vision:look when blankCanvas persists after refreshSnapshot', async () => {
  let lookCalls = 0;
  let refreshCalls = 0;
  let step = 0;
  const actions = [
    '{"action":"open","url":"https://manga.bilibili.com/mc38749/1950878"}',
    '{"action":"look","prompt":"看这一页漫画"}',
    '{"action":"done","summary":"页面画布一直空白"}',
  ];
  const calls = [];
  const res = await runBrowserExploreLoop({
    maxSteps: 6,
    calls,
    generate: async () => ({ ok: true, text: actions[step++] || '{"action":"done","summary":"end"}' }),
    saveImage: async (buf) => buf,
    observeImage: async () => { lookCalls += 1; return { ok: true, text: 'should not be called' }; },
    openTab: async () => ({
      open: async (url) => ({
        url,
        title: '002 - 漫画',
        text: '第002话',
        links: [],
        screenshot: { data: Buffer.alloc(14_000), mediaType: 'image/jpeg', name: 'blank.jpg' },
        blankCanvas: true,
      }),
      refreshSnapshot: async () => {
        refreshCalls += 1;
        return {
          url: 'https://manga.bilibili.com/mc38749/1950878',
          title: '002 - 漫画',
          text: '第002话',
          links: [],
          screenshot: { data: Buffer.alloc(14_000), mediaType: 'image/jpeg', name: 'blank.jpg' },
          blankCanvas: true,
        };
      },
      scroll: async () => null,
      close: async () => {},
    }),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(lookCalls, 0);
  assert.equal(calls.includes('vision:look'), false);
  assert.ok(Array.isArray(res.sources));
});

test('selectRelevantLinks windows 2000-chapter novel TOC around memoryHint and filters footer noise', () => {
  const raw = [
    { text: '关于我们', href: 'https://novel.example.com/about' },
    { text: '互联网 ICP 备案', href: 'https://beian.miit.gov.cn/' },
    { text: '下一章', href: 'https://novel.example.com/book/1/ch-1351' },
  ];
  for (let i = 1; i <= 2000; i++) {
    raw.push({ text: `第${i}章 风起云涌`, href: `https://novel.example.com/book/1/ch-${i}` });
  }
  const hint = formatMemoryHint([], {
    topic: '测试长篇小说',
    progress: '刚看完第1350章，主角进城了。',
    next: '接着看第1351章。',
    progressSource: { url: 'https://novel.example.com/book/1/ch-1350' },
  });
  assert.match(hint, /上次页面：https:\/\/novel\.example\.com\/book\/1\/ch-1350/);

  const res = selectRelevantLinks(raw, {
    currentUrl: 'https://novel.example.com/book/1',
    memoryHint: hint,
    maxLinks: 24,
  });
  assert.equal(res.truncated, true);
  assert.equal(res.totalLinks, 2000); // 2000 个去重后的章节链接（页脚噪声已过滤）
  assert.ok(res.links.length >= 20 && res.links.length <= 24);
  assert.equal(res.links[0].text, '下一章');
  assert.ok(res.links.some((l) => l.text.startsWith('第1350章')));
  assert.ok(res.links.some((l) => l.text.startsWith('第1352章')));
  assert.ok(res.links.some((l) => l.text.startsWith('第2000章')));
  assert.equal(res.links.some((l) => /ICP|关于我们/.test(l.text)), false);
});

test('runBrowserExploreLoop find_link locates chapter 1888 out of 2000 chapters', async () => {
  const allLinks = [];
  for (let i = 1; i <= 2000; i++) {
    allLinks.push({ text: `第${i}章 章节标题${i}`, href: `https://novel.example.com/book/1/ch-${i}` });
  }
  let openedUrl = '';
  let step = 0;
  const actions = [
    '{"action":"open","url":"https://novel.example.com/book/1"}',
    '{"action":"find_link","keyword":"第1888章"}',
    '{"action":"click","index":0}',
    '{"action":"done","summary":"读到了第1888章正文"}',
  ];
  await runBrowserExploreLoop({
    maxSteps: 8,
    generate: async () => ({ ok: true, text: actions[step++] || '{"action":"done","summary":"end"}' }),
    openTab: async () => ({
      open: async (url) => {
        openedUrl = url;
        return {
          url,
          title: '目录',
          text: url.endsWith('ch-1888') ? '第1888章正文内容' : '目录页',
          links: allLinks.slice(0, 24).map((l, idx) => ({ index: idx, ...l })),
          allLinks,
          totalLinks: allLinks.length,
          screenshot: null,
        };
      },
      scroll: async () => null,
      close: async () => {},
    }),
  });
  assert.equal(openedUrl, 'https://novel.example.com/book/1/ch-1888');
});
