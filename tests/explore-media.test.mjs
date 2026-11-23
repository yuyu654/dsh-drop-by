import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-media-'));
const env = { PG_CONFIG_PATH: 'config.json', PG_STATE_PATH: 'state.json', PG_LOG_DIR: 'logs',
  PG_DSH_HOME: 'dsh', PG_CHAT_DATA_DIR: 'chat', PG_SECRETS_PATH: 'credentials.json' };
const originalEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
for (const [key, name] of Object.entries(env)) process.env[key] = path.join(home, name);
test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const { createExplorationMedia, guidedWebSearch, planInitialWebSearch } = await import('../src/explore-media.js');
const { exploreRound } = await import('../src/explore.js');

const toolsFor = (handlers) => ({ get: (name) => handlers[name] && { execute: handlers[name] } });
const source = { url: 'https://example.org/article', title: '厂商资料' };

test('leisure cadence and a named work still apply with no media tools', async () => {
  const r = await exploreRound({ persona: { ok: true, text: '爱看漫画' }, interest: '长期追某部漫画',
    leisureEvery: 1, generate: async ({ prompt }) => {
      assert.match(prompt, /这轮是休闲/);
      assert.match(prompt, /长期追某部漫画/);
      return { ok: true, text: '{"action":"start","topic":"某部漫画","progress":"准备找作品页"}' };
    } });
  assert.equal(r.state.leisure.topic, '某部漫画');
  assert.equal(r.state.lastRun.mode, 'leisure');
  assert.deepEqual(r.state.lastRun.calls, []);
});

test('an explicit login response yields a reminder even when the model skips the round', async () => {
  const media = createExplorationMedia({ web: true, tools: toolsFor({
    advanced_search: () => ({ sources: [source] }),
    web_fetch: () => ({ statusCode: 401, body: { content: 'Login' } }),
  }) });
  const r = await exploreRound({ persona: { ok: true, text: '爱看漫画' }, media,
    generate: async ({ prompt }) => ({ ok: true, text: prompt.includes('替角色选')
      ? '{"mode":"research","kind":"web","query":"漫画"}' : '{"action":"skip"}' }) });
  assert.equal(r.state.candidate.loginSite, 'example.org');
  assert.deepEqual(r.state.lastRun.calls, ['advanced_search', 'web_fetch']);
});

test('prefers free search, falls back with the DSH argument shape, then reads at most two pages', async () => {
  const calls = [];
  let freeResults = [source];
  const media = createExplorationMedia({ web: true, tools: toolsFor({
    advanced_search: ({ query }) => { calls.push(['free', query]); return { sources: freeResults }; },
    web_search: ({ queries }, { signal }) => {
      assert.ok(signal);
      calls.push(['dsh', queries]);
      return { sources: [source, source, { url: 'http://127.0.0.1/a' }, { url: 'https://example.org/second' }, { url: 'https://example.org/third' }] };
    },
    web_fetch: ({ url }) => {
      calls.push(['fetch', url]);
      return { statusCode: 200, body: { kind: 'text', content: '可核对的正文' } };
    },
  }) });
  const primary = await media.collect('web', '芯片手册');
  assert.equal(primary[0].evidence, '网页正文');
  assert.deepEqual(calls.map(([name]) => name), ['free', 'fetch']);
  freeResults = [];
  calls.length = 0;
  const fallback = await media.collect('web', '芯片手册');
  assert.equal(fallback.length, 2);
  assert.deepEqual(calls, [['free', '芯片手册'], ['dsh', ['芯片手册']], ['fetch', source.url], ['fetch', 'https://example.org/second']]);
});

test('a text-only model gets available captions, otherwise just the video title', async () => {
  const video = { url: 'https://www.bilibili.com/video/BV123abc', title: '推理演示' };
  let board = { images: [{}], text: 'cell 1 = 0:00-0:05\n    "这是口播。"' };
  const media = createExplorationMedia({ video: true, observeVideo: async () => ({ ok: false }), tools: toolsFor({
    video_search: () => ({ sources: [video] }),
    video_storyboard: ({ input, to }) => { assert.equal(input, video.url); assert.equal(to, 60); return board; },
  }) });
  assert.equal((await media.collect('video', '推理'))[0].evidence, '仅字幕或口播转写');
  board = null;
  assert.equal((await media.collect('video', '推理'))[0].evidence, '仅标题或搜索摘要');
});

test('leisure preserves the research thread and records the exact source for sharing', async () => {
  const persona = { ok: true, text: '对电气好奇，也爱看推理。' };
  const output = (value) => ({ ok: true, text: JSON.stringify(value) });
  const first = await exploreRound({ persona, generate: async () => output({
    action: 'start', topic: '限电预警', progress: '比较判据', next: '查采样率',
  }) });
  let calls = 0;
  const result = await exploreRound({ persona, previous: { ...first.state, lastMode: 'research', modeStreak: 2 },
    media: { web: true, async collect(kind, query) {
      assert.equal(kind, 'web');
      assert.equal(query, '推理短篇');
      return [{ ...source, evidence: '网页正文', content: '两个叙述者看到不同的事。' }];
    } },
    generate: async ({ prompt }) => {
      if (++calls === 1) {
        assert.match(prompt, /本轮 mode 必须是 leisure/);
        return output({ mode: 'leisure', kind: 'web', query: '推理短篇' });
      }
      assert.match(prompt, /两个叙述者/);
      return output({ action: 'start', topic: '推理短篇', progress: '喜欢叙述视角的反差', next: '留着下次再找', share: '两个人讲同一幕，居然都没说谎。', sourceIndex: 0 });
    },
  });
  assert.deepEqual(result.state.thread, first.state.thread);
  assert.equal(result.state.leisure.topic, '推理短篇');
  assert.equal(result.state.candidate.source.url, source.url);
});

test('first-round queries prefer pinned sites and keep only planner terms grounded in the named work', () => {
  const pinnedTopic = '哔哩哔哩漫画作品：《”哆哆嗦嗦“逃离你》';
  const interest = '知乎';
  assert.deepEqual(planInitialWebSearch({ pinnedTopic, interest, query: '隔壁漫画 site:zhihu.com' }), {
    query: '哆哆嗦嗦逃离你 site:manga.bilibili.com', preferredSites: ['manga.bilibili.com'], fallbackQuery: '哆哆嗦嗦逃离你',
  });
  assert.deepEqual(planInitialWebSearch({ pinnedTopic, query: '哆哆嗦嗦逃离你 简介' }), {
    query: '哆哆嗦嗦逃离你 简介 site:manga.bilibili.com', preferredSites: ['manga.bilibili.com'], fallbackQuery: '哆哆嗦嗦逃离你 简介',
  });
  assert.deepEqual(planInitialWebSearch({ interest: '去知乎看看漫画分镜', query: '漫画分镜' }), {
    query: '漫画分镜 site:zhihu.com', preferredSites: ['zhihu.com'], fallbackQuery: '漫画分镜',
  });
  assert.deepEqual(planInitialWebSearch({ pinnedTopic: '猫侦探', interest: '在知乎看 Vue', query: '猫侦探' }), {
    query: '猫侦探', preferredSites: [], fallbackQuery: '',
  });
  assert.deepEqual(planInitialWebSearch({ pinnedTopic: '猫侦探', interest: '去知乎看看猫侦探', query: '猫侦探 简介' }), {
    query: '猫侦探 简介 site:zhihu.com', preferredSites: ['zhihu.com'], fallbackQuery: '猫侦探 简介',
  });
  assert.deepEqual(planInitialWebSearch({ query: 'site:zhihu.com《猫侦探》' }), {
    query: '猫侦探 site:zhihu.com', preferredSites: ['zhihu.com'], fallbackQuery: '猫侦探',
  });
  assert.deepEqual(planInitialWebSearch({ query: 'Node.js 内存分配' }), {
    query: 'Node.js 内存分配', preferredSites: [], fallbackQuery: '',
  });
  assert.deepEqual(planInitialWebSearch({ query: '咖啡 萃取 (site:zhihu.com OR site:github.com)' }), {
    query: '咖啡 萃取 (site:zhihu.com OR site:github.com)', preferredSites: ['zhihu.com', 'github.com'], fallbackQuery: '咖啡 萃取',
  });
});

test('first-round site search falls back once if there are no in-scope results; retries stay scoped', async () => {
  const calls = [];
  const manga = { url: 'https://manga.bilibili.com/detail/mc1', title: '漫画详情', snippet: '公开简介' };
  const video = { url: 'https://www.bilibili.com/video/BV123abc', title: '视频', snippet: '视频标注' };
  let indexed = false;
  const media = createExplorationMedia({ web: true, tools: toolsFor({
    advanced_search: ({ query }) => {
      calls.push(query);
      return { sources: [video, ...(indexed || !query.includes('site:') ? [manga] : [])] };
    },
    web_fetch: () => ({ statusCode: 200, body: { content: '<script>load()</script>' } }),
  }) });
  const plan = planInitialWebSearch({ pinnedTopic: 'B漫《猫侦探》' });
  const { query, ...options } = plan;
  const broad = await media.collect('web', query, { ...options, excludedUrls: [video.url] });
  assert.deepEqual(calls, ['猫侦探 site:manga.bilibili.com', '猫侦探']);
  assert.deepEqual(broad.map((item) => item.url), [manga.url]);
  calls.length = 0;
  const retry = guidedWebSearch('猫侦探', 'B漫');
  assert.deepEqual(await media.collect('web', retry.query, { preferredSites: retry.preferredSites }), []);
  assert.deepEqual(calls, ['猫侦探 site:manga.bilibili.com']);
  calls.length = 0;
  indexed = true;
  assert.deepEqual((await media.collect('web', query, options)).map((item) => item.url), [manga.url]);
  assert.deepEqual(calls, ['猫侦探 site:manga.bilibili.com']);
});

test('only snippet-only rounds add up to four distinct summaries without fetching extra pages', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    url: 'https://example.org/article-' + index, title: '公开结果 ' + index, snippet: '摘要证据 ' + index,
  }));
  const fetched = [];
  let hasBody = false;
  const media = createExplorationMedia({ web: true, tools: toolsFor({
    advanced_search: () => ({ sources: [rows[0], rows[0], { url: 'http://127.0.0.1/private' }, ...rows.slice(1)] }),
    web_fetch: ({ url }) => {
      fetched.push(url);
      return { statusCode: 200, body: { content: hasBody ? '可核对的正文' : 'You need to enable JavaScript to run this app.' } };
    },
  }) });
  const summaries = await media.collect('web', '漫画简介');
  assert.deepEqual(fetched, rows.slice(0, 2).map((row) => row.url));
  assert.deepEqual(summaries, rows.slice(0, 4).map(({ url, title, snippet }) => ({ url, title, evidence: '搜索摘要', content: snippet })));
  fetched.length = 0;
  hasBody = true;
  assert.deepEqual((await media.collect('web', '漫画简介')).map((item) => item.evidence), ['网页正文', '网页正文']);
  assert.equal(fetched.length, 2);
});

test('falls back to host ctx.web service when tool-web is disabled on host plane and reads meta description', async () => {
  const searched = [];
  const fetched = [];
  const media = createExplorationMedia({
    web: true,
    tools: toolsFor({
      advanced_search: ({ query }) => {
        searched.push(query);
        return { sources: [{ url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你', snippet: '站内简介' }] };
      },
    }),
    webService: {
      async fetch({ url }) {
        fetched.push(url);
        return {
          url,
          statusCode: 200,
          body: {
            kind: 'html',
            content: '<html><head><meta name="description" content="潮玩设计师艾栩与搭档之逸的故事。" /></head><body><div>全部章节</div></body></html>',
          },
          truncated: false,
        };
      },
    },
  });
  assert.equal(media.web, true);
  const res = await media.collect('web', '哆哆嗦嗦逃离你 site:manga.bilibili.com', { preferredSites: ['manga.bilibili.com'] });
  assert.deepEqual(searched, ['哆哆嗦嗦逃离你 site:manga.bilibili.com']);
  assert.deepEqual(fetched, ['https://manga.bilibili.com/m/detail/mc38749']);
  assert.equal(res.length, 1);
  assert.equal(res[0].evidence, '网页正文');
  assert.match(res[0].content, /潮玩设计师艾栩/);
});

test('retries with clean anchorQuery and filters unrelated site padding when extra planner terms miss the work', async () => {
  const searched = [];
  const fetched = [];
  const media = createExplorationMedia({
    web: true,
    tools: toolsFor({
      advanced_search: ({ query }) => {
        searched.push(query);
        if (query.includes('第二人称')) {
          return {
            sources: [
              { url: 'https://manga.bilibili.com/m/detail/mc26808', title: '《Blue Period.》_哔哩哔哩漫画', snippet: '第二人称视觉表达' },
              { url: 'https://manga.bilibili.com/blackboard/activity.html', title: '2024新人选拔赛', snippet: '叙事评选活动' },
            ],
          };
        }
        return {
          sources: [
            { url: 'https://manga.bilibili.com/m/detail/mc26808', title: '《Blue Period.》_哔哩哔哩漫画', snippet: '蓝色时期' },
            { url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你_哔哩哔哩漫画', snippet: 'I人xE人职场喜剧' },
          ],
        };
      },
      web_fetch: ({ url }) => {
        fetched.push(url);
        return {
          statusCode: 200,
          body: { kind: 'html', content: '<head><meta name="description" content="潮玩设计师艾栩" /></head>' },
        };
      },
    }),
  });
  const results = await media.collect('web', '哆哆嗦嗦逃离你 第二人称 叙事 site:manga.bilibili.com', {
    preferredSites: ['manga.bilibili.com'],
    fallbackQuery: '哆哆嗦嗦逃离你 第二人称 叙事',
    anchorQuery: '哆哆嗦嗦逃离你 site:manga.bilibili.com',
    anchorKeywords: '哆哆嗦嗦逃离你',
  });
  assert.deepEqual(searched, [
    '哆哆嗦嗦逃离你 第二人称 叙事 site:manga.bilibili.com',
    '哆哆嗦嗦逃离你 site:manga.bilibili.com',
  ]);
  assert.deepEqual(fetched, ['https://manga.bilibili.com/m/detail/mc38749']);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, 'https://manga.bilibili.com/m/detail/mc38749');
  assert.match(results[0].content, /潮玩设计师艾栩/);
});

test('falls back to global fetch when webService.fetch rejects due to Fake-IP 198.18.x.x SSRF block', async () => {
  const origFetch = globalThis.fetch;
  const directUrls = [];
  globalThis.fetch = async (url) => {
    directUrls.push(url);
    return {
      url,
      status: 200,
      text: async () => '<html><head><meta name="description" content="Fake-IP 兜底抓到的简介" /></head><body><div>全部章节</div></body></html>',
    };
  };
  try {
    const media = createExplorationMedia({
      web: true,
      tools: toolsFor({
        advanced_search: () => ({
          sources: [{ url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你', snippet: '简介' }],
        }),
      }),
      webService: {
        async fetch() {
          throw new Error('SSRF blocked: manga.bilibili.com resolves to private address 198.18.0.68');
        },
      },
    });
    const results = await media.collect('web', '哆哆嗦嗦逃离你 site:manga.bilibili.com', { preferredSites: ['manga.bilibili.com'] });
    assert.deepEqual(directUrls, ['https://manga.bilibili.com/m/detail/mc38749']);
    assert.equal(results.length, 1);
    assert.equal(results[0].evidence, '网页正文');
    assert.match(results[0].content, /Fake-IP 兜底抓到的简介/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Route A (vision_light) extracts page image and upgrades evidence to 网页画面 when vision model is available', async () => {
  const origFetch = globalThis.fetch;
  const saved = [];
  const observed = [];
  globalThis.fetch = async (url) => {
    if (String(url).includes('cover.jpg')) {
      const bytes = new Uint8Array(2048);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return {
        ok: true,
        headers: { get: () => 'image/jpeg' },
        arrayBuffer: async () => bytes.buffer,
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const media = createExplorationMedia({
      web: true,
      browseMode: 'vision_light',
      edgePort: 1, // ensure CDP is not reachable so HTML image extraction path runs deterministically
      saveImage: async (buf) => {
        saved.push(buf);
        return { attachmentId: 'att-1', mediaType: buf.mediaType };
      },
      observeVideo: async ({ images, prompt }) => {
        observed.push({ images, prompt });
        return { ok: true, text: '封面是两位站在街头的小人，线条清爽偏暖色调。' };
      },
      tools: toolsFor({
        advanced_search: () => ({
          sources: [{ url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你', snippet: '简介' }],
        }),
        web_fetch: () => ({
          statusCode: 200,
          body: {
            kind: 'html',
            content: '<html><head><meta property="og:image" content="https://i0.hdslb.com/cover.jpg" /><meta name="description" content="潮玩设计师故事" /></head><body><div>正文内容足够长以供展示</div></body></html>',
          },
        }),
      }),
    });
    const results = await media.collect('web', '哆哆嗦嗦逃离你 site:manga.bilibili.com', { preferredSites: ['manga.bilibili.com'] });
    assert.equal(saved.length, 1);
    assert.equal(observed.length, 1);
    assert.equal(results[0].evidence, '网页画面');
    assert.match(results[0].content, /线条清爽偏暖色调/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('Route B (browser_agent) runs bounded multi-step open -> look -> done loop and closes tab', async () => {
  const { runBrowserExploreLoop } = await import('../src/explore-browser.js');
  let closed = false;
  let stepCount = 0;
  const actions = [
    { action: 'open', url: 'https://manga.bilibili.com/m/detail/mc38749' },
    { action: 'look', prompt: '看看漫画封面和分镜' },
    { action: 'done', summary: '看完了封面与第一话画面' },
  ];
  const result = await runBrowserExploreLoop({
    maxSteps: 40,
    initialQuery: '哆哆嗦嗦逃离你',
    interest: '哔哩哔哩漫画《哆哆嗦嗦逃离你》',
    generate: async () => {
      const cmd = actions[stepCount++] || { action: 'done' };
      return { ok: true, text: JSON.stringify(cmd) };
    },
    saveImage: async () => ({ attachmentId: 'att-b1', mediaType: 'image/jpeg' }),
    observeImage: async () => ({ ok: true, text: '第一话分镜里有主角抱着潮玩盒子的特写，表情很慌张。' }),
    search: async () => [{ url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你', snippet: '简介' }],
    openTab: async () => ({
      async open(url) {
        return {
          url,
          title: '“哆哆嗦嗦”逃离你',
          text: '潮玩设计师艾栩与搭档之逸的故事',
          links: [{ text: '第1话', url: 'https://manga.bilibili.com/mc38749/1' }],
          screenshot: { data: Buffer.from([1, 2, 3, 4]), mediaType: 'image/jpeg', name: 'page.jpg' },
        };
      },
      async scroll() { return null; },
      async close() { closed = true; },
    }),
  });
  assert.equal(closed, true);
  assert.equal(result.stepsUsed, 3);
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].evidence, '网页画面');
  assert.match(result.sources[0].content, /抱着潮玩盒子的特写/);
});

test('multi-item exploration.interest splits cleanly, inherits shared site prefix, and picks one work per round', async () => {
  const { splitInterestItems, planInitialWebSearch } = await import('../src/explore-media.js');
  const shared = splitInterestItems('哔哩哔哩漫画：《作品甲》、《作品乙》');
  assert.deepEqual(shared, ['哔哩哔哩漫画:《作品甲》', '哔哩哔哩漫画:《作品乙》']);

  // Planner chose 作品乙 -> locks ONLY onto 作品乙 + manga.bilibili.com
  const byQuery = planInitialWebSearch({
    interest: '哔哩哔哩漫画：《作品甲》、《作品乙》',
    query: '作品乙 角色设定',
  });
  assert.deepEqual(byQuery.preferredSites, ['manga.bilibili.com']);
  assert.match(byQuery.query, /作品乙/);
  assert.doesNotMatch(byQuery.query, /作品甲/);

  // Newline-separated multi-site list rotates away from recently explored work
  const multiSite = '哔哩哔哩漫画：《作品甲》\n知乎：城市散步地图';
  const rotated = planInitialWebSearch({
    interest: multiSite,
    recentTopics: ['《作品甲》'],
    roundCount: 0,
  });
  assert.deepEqual(rotated.preferredSites, ['zhihu.com']);
  assert.match(rotated.query, /城市散步地图/);
  assert.doesNotMatch(rotated.query, /作品甲/);
});

test('Route B prioritizes 网页画面 over 搜索摘要, merges multi-scroll look observations, and reports trace errors when vision is missing', async () => {
  const { runBrowserExploreLoop } = await import('../src/explore-browser.js');
  let step = 0;
  let lookCount = 0;
  const actions = [
    { action: 'open', url: 'https://manga.bilibili.com/detail/mc38749' },
    { action: 'open', url: 'https://manga.bilibili.com/mc38749/1950876' },
    { action: 'look', prompt: '看第一页' },
    { action: 'scroll', direction: 'down' },
    { action: 'look', prompt: '看第二页' },
    { action: 'done' },
  ];
  const res = await runBrowserExploreLoop({
    maxSteps: 20,
    initialQuery: '哆哆嗦嗦逃离你',
    generate: async () => ({ ok: true, text: JSON.stringify(actions[step++] || { action: 'done' }) }),
    search: async () => [
      { url: 'https://manga.bilibili.com/a', title: '搜索摘要A', snippet: '摘要A' },
      { url: 'https://manga.bilibili.com/b', title: '搜索摘要B', snippet: '摘要B' },
    ],
    saveImage: async () => ({ attachmentId: 'att', mediaType: 'image/jpeg' }),
    observeImage: async () => ({ ok: true, text: ++lookCount === 1 ? '第一页画面：主角坐在工位发抖。' : '第二页画面：同事笑着拍她肩膀。' }),
    openTab: async () => ({
      async open(url) {
        return { url, title: url.includes('1950876') ? '第1话' : '详情页', text: '正文', links: [], screenshot: { data: Buffer.from([1, 2, 3]), mediaType: 'image/jpeg' } };
      },
      async scroll() {
        return { url: 'https://manga.bilibili.com/mc38749/1950876', title: '第1话', text: '正文', links: [], screenshot: { data: Buffer.from([4, 5, 6]), mediaType: 'image/jpeg' } };
      },
      async close() {},
    }),
  });
  assert.equal(res.sources.length, 3);
  assert.equal(res.sources[0].evidence, '网页画面');
  assert.match(res.sources[0].content, /主角坐在工位发抖/);
  assert.match(res.sources[0].content, /同事笑着拍她肩膀/);

  // Verify missing vision writes an explicit trace error instead of looping silently
  const seenPrompts = [];
  let s2 = 0;
  await runBrowserExploreLoop({
    maxSteps: 5,
    initialQuery: '',
    generate: async ({ prompt }) => {
      seenPrompts.push(prompt);
      return { ok: true, text: JSON.stringify(s2++ === 0 ? { action: 'look' } : { action: 'done' }) };
    },
  });
  assert.match(seenPrompts[1], /请先打开页面再调用 look/);
});
