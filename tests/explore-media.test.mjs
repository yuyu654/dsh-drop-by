import test from 'node:test';
import assert from 'node:assert/strict';
import { createExplorationMedia } from '../src/explore-media.js';
import { exploreRound } from '../src/explore.js';

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
