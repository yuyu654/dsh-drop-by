import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SELF_MEMORY_TAG,
  formatMemoryHint,
  recallExplorationMemories,
  recordExplorationMemory,
  reinforceExplorationMemories,
} from '../src/exploration-memory.js';
import { exploreRound } from '../src/explore.js';
import { qqReplyContext } from '../src/qq-reply.js';
import { pickTopic } from '../src/topics.js';
import { inspectSessionContext } from '../src/diagnostics.js';
import { applyChange } from '../src/settings.js';

const persona = { ok: true, text: '喜欢百合漫画和自动化的小澪' };
const DAY = 86_400_000;

test('recordExplorationMemory: 轻量化不入库，深度探索固定带「我自己的事」标签并按衰减淘汰', () => {
  const now = 1_800_000_000_000;
  // 轻量化模式不写入长期探索记忆
  const afterLight = recordExplorationMemory([], { mode: 'light', topic: '倍速播放', text: '尾音变薄' }, { now });
  assert.equal(afterLight.length, 0);

  // 深度模式写入并附带「我自己的事」标签
  let list = recordExplorationMemory([], {
    mode: 'leisure',
    topic: '《“哆哆嗦嗦”逃离你》',
    progress: '看到第001话：艾栩答应挪工位，之逸先慌了。',
    next: '看第002话',
    checkpoint: '第001话',
    progressSource: { title: '001', evidence: '网页画面' },
  }, { now });
  assert.equal(list.length, 1);
  assert.ok(list[0].tags.includes(SELF_MEMORY_TAG));
  assert.equal(list[0].importance, 0.7);
  assert.equal(list[0].checkpoint, '第001话');

  // 重复写入相同内容会强化而不是新增重复条目
  list = recordExplorationMemory(list, {
    mode: 'leisure',
    topic: '《“哆哆嗦嗦”逃离你》',
    progress: '看到第001话：艾栩答应挪工位，之逸先慌了。',
    next: '看第002话',
  }, { now: now + DAY });
  assert.equal(list.length, 1);
  assert.equal(list[0].hits, 1);
  assert.equal(list[0].reinforcedAt, now + DAY);

  // 超过容量上限时，优先淘汰最久未强化的旧记忆
  let pool = [
    { id: 'old_weak', mode: 'leisure', topic: '很早的旧题', text: '旧内容', importance: 0.4, at: now - 40 * DAY, reinforcedAt: null, hits: 0 },
    { id: 'old_strong', mode: 'research', topic: '常被提起的旧题', text: '核心内容', importance: 0.8, at: now - 30 * DAY, reinforcedAt: now - DAY, hits: 3 },
  ];
  for (let i = 1; i <= 4; i++) {
    pool = recordExplorationMemory(pool, { mode: 'leisure', topic: `新题 ${i}`, progress: `新进展 ${i}` }, { now: now + i * 1000, maxItems: 5 });
  }
  assert.equal(pool.length, 5);
  assert.equal(pool.some((m) => m.id === 'old_weak'), false);
  assert.equal(pool.some((m) => m.id === 'old_strong'), true);
});

test('recallExplorationMemories 与 reinforceExplorationMemories：按关键词相关性优先召回并刷新衰减时钟', () => {
  const now = 1_800_000_000_000;
  let list = [];
  list = recordExplorationMemory(list, {
    mode: 'leisure',
    topic: '《“哆哆嗦嗦”逃离你》第001话',
    progress: '艾栩答应今天下班前挪工位，之逸低头问一起工作。',
    next: '看第002话',
  }, { now: now - 5 * DAY });
  list = recordExplorationMemory(list, {
    mode: 'research',
    topic: '宿舍插排功率计量',
    progress: 't120/t150 过 2.5 是强条件。',
  }, { now: now - DAY });

  // 问漫画时，即使它是 5 天前的，也能优先召回
  const hits = recallExplorationMemories(list, { query: '哆哆嗦嗦逃离你第一话艾栩干嘛了', now, limit: 2 });
  assert.equal(hits[0].topic, '《“哆哆嗦嗦”逃离你》第001话');

  const reinforced = reinforceExplorationMemories(list, [hits[0].id], now);
  const updated = reinforced.find((m) => m.id === hits[0].id);
  assert.equal(updated.reinforcedAt, now);
  assert.equal(updated.hits, 1);

  const hint = formatMemoryHint(hits, { topic: '《“哆哆嗦嗦”逃离你》', progress: '看完第001话', next: '看第002话' });
  assert.match(hint, /看第002话/);
});

test('exploreRound: 深度探索写入内置记忆并把进度传给浏览器，轻量化模式不写入长期记忆', async () => {
  const now = 1_800_000_000_000;
  let browseArgs = null;
  let planInput = '';
  const media = {
    web: true,
    video: false,
    calls: [],
    async browse(args) {
      browseArgs = args;
      return {
        query: args.initialQuery,
        sources: [{ url: 'https://manga.bilibili.com/mc38749/2', title: '002 - 哆哆嗦嗦逃离你', evidence: '网页画面', content: '第002话内容' }],
      };
    },
    async collect() {
      return [];
    },
  };

  // 第 1 轮深度探索
  const round1 = await exploreRound({
    persona,
    previous: null,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now,
    media,
    timing: { browseMode: 'browser_agent', mode: 'deep' },
    generate: async ({ prompt }) => {
      if (prompt.includes('替角色选这一轮的方向')) {
        return { ok: true, text: '{"mode":"leisure","kind":"web","query":"哆哆嗦嗦逃离你"}' };
      }
      return {
        ok: true,
        text: JSON.stringify({
          action: 'start',
          topic: '《“哆哆嗦嗦”逃离你》',
          progress: '翻到第001话：艾栩答应挪工位，之逸有点慌。',
          next: '看第002话',
          checkpoint: '第001话',
          progressSourceIndex: 0,
          sourceIndex: 0,
        }),
      };
    },
  });
  assert.equal(round1.ok, true);
  assert.equal(round1.state.memories.length, 1);
  assert.ok(round1.state.memories[0].tags.includes(SELF_MEMORY_TAG));

  // 第 2 轮深度探索：应把第 1 轮进度和记忆传给规划器和浏览器 Agent
  const round2 = await exploreRound({
    persona,
    previous: round1.state,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now: now + 3600_000,
    media,
    timing: { browseMode: 'browser_agent', mode: 'deep' },
    generate: async ({ prompt }) => {
      if (prompt.includes('替角色选这一轮的方向')) {
        planInput = prompt;
        return { ok: true, text: '{"mode":"leisure","kind":"web","query":"哆哆嗦嗦逃离你 第002话"}' };
      }
      return {
        ok: true,
        text: JSON.stringify({
          action: 'continue',
          topic: '《“哆哆嗦嗦”逃离你》',
          progress: '看到第002话：拒绝被驳回，两人正式成了邻桌。',
          next: '看第003话',
          checkpoint: '第002话',
          progressSourceIndex: 0,
          sourceIndex: 0,
        }),
      };
    },
  });
  assert.equal(round2.ok, true);
  assert.match(planInput, /看第002话/);
  assert.match(browseArgs.memoryHint, /第001话/);
  assert.match(browseArgs.memoryHint, /看第002话/);
  assert.equal(round2.state.memories.length, 2);
  // 第 1 轮记忆被同主题续追强化
  assert.equal(round2.state.memories[0].hits, 1);

  // 轻量化探索：只保存本轮 light，不往 memories 里追加
  const roundLight = await exploreRound({
    persona,
    previous: round2.state,
    exploreMode: 'light',
    now: now + 7200_000,
    generate: async () => ({
      ok: true,
      text: JSON.stringify({ action: 'light', topic: '雨伞小圆帽', summary: '挡伞骨尖也压住伞布边。' }),
    }),
  });
  assert.equal(roundLight.ok, true);
  assert.equal(roundLight.state.light.topic, '雨伞小圆帽');
  assert.equal(roundLight.state.memories.length, 2);
});

test('qqReplyContext: 深度模式可召回已被顶掉的旧探索记忆，轻量化模式不注入长期探索记忆', () => {
  const now = 1_800_000_000_000;
  const baseState = {
    personaKey: '', // 由 exploreRound 生成或手动对齐
  };
  // 用一次轻/深状态模拟：leisure 已换成别的题材，但 memories 里仍留着第001话
  const cfgDeep = {
    enabled: true,
    channels: { primary: 'qq', qq: { enabled: true, read: true, peerId: '728361417' } },
    exploration: { mode: 'deep', recentDays: 3, mood: false, portrait: false },
  };
  const cfgLight = {
    ...cfgDeep,
    exploration: { ...cfgDeep.exploration, mode: 'light' },
  };
  return exploreRound({
    persona,
    previous: null,
    interest: '《“哆哆嗦嗦”逃离你》',
    bias: 'leisure',
    now: now - 2 * DAY,
    generate: async () => ({
      ok: true,
      text: JSON.stringify({
        action: 'start',
        topic: '《“哆哆嗦嗦”逃离你》',
        progress: '第001话里艾栩答应挪工位，之逸先紧张了。',
        next: '看第002话',
      }),
    }),
  }).then((r1) => {
    const shifted = {
      ...r1.state,
      leisure: { topic: '另一个新漫画', progress: '刚翻了封面', at: now - 1000 },
    };
    const deepCtx = qqReplyContext({
      peer: '728361417',
      kind: 'private',
      cfg: cfgDeep,
      now,
      state: shifted,
      persona,
      text: '之前那本哆哆嗦嗦逃离你第一话讲啥来着？',
    });
    assert.match(deepCtx, /我自己的事/);
    assert.match(deepCtx, /艾栩答应挪工位/);

    const lightCtx = qqReplyContext({
      peer: '728361417',
      kind: 'private',
      cfg: cfgLight,
      now,
      state: shifted,
      persona,
      text: '之前那本哆哆嗦嗦逃离你第一话讲啥来着？',
    });
    assert.doesNotMatch(lightCtx, /我自己的事/);
  });
});

test('方案B：首次深度探索分享允许附链接，继续推进同一件事时标记 continuation=true 不主动附链接，且私聊上下文保留真实 url 供按需发送', async () => {
  const now = 1_800_000_000_000;
  const media = {
    web: true,
    video: false,
    calls: [],
    async collect() {
      return [{ url: 'https://manga.bilibili.com/detail/mc38749', title: '哆哆嗦嗦逃离你', evidence: '网页正文', content: '正文内容' }];
    },
  };

  // 第 1 轮（首次提到新作品）：continuation 应为 falsy
  const r1 = await exploreRound({
    persona,
    previous: null,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now,
    media,
    generate: async ({ prompt }) => {
      if (prompt.includes('替角色选这一轮的方向')) return { ok: true, text: '{"mode":"leisure","kind":"web","query":"哆哆嗦嗦逃离你"}' };
      return {
        ok: true,
        text: JSON.stringify({
          action: 'start',
          topic: '《“哆哆嗦嗦”逃离你》',
          progress: '看到第001话：艾栩和之逸搭档。',
          next: '看第002话',
          share: '翻到第001话，E人反倒先慌了。',
          progressSourceIndex: 0,
          sourceIndex: 0,
        }),
      };
    },
  });
  assert.equal(r1.ok, true);
  assert.equal(Boolean(r1.state.candidate.continuation), false);

  // 第 2 轮（继续推进同一部作品）：continuation 应为 true
  const r2 = await exploreRound({
    persona,
    previous: r1.state,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now: now + 3600_000,
    media,
    generate: async ({ prompt }) => {
      if (prompt.includes('替角色选这一轮的方向')) return { ok: true, text: '{"mode":"leisure","kind":"web","query":"哆哆嗦嗦逃离你 第002话"}' };
      return {
        ok: true,
        text: JSON.stringify({
          action: 'continue',
          topic: '《“哆哆嗦嗦”逃离你》',
          progress: '看到第002话：拒绝被驳回。',
          next: '看第003话',
          share: '第002话里拒绝被驳回了，这下真成邻桌了。',
          progressSourceIndex: 0,
          sourceIndex: 0,
        }),
      };
    },
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.state.candidate.continuation, true);

  // 未实际发过该题材链接时（linkAlreadySent 未置位），即使是第 2 轮推进也仍允许附首次链接
  const firstLinkTopic = pickTopic(
    {
      now: now + 3700_000,
      tz: 'Asia/Shanghai',
      her: {},
      me: {},
      fish: { ok: false },
      presence: { idleSec: 0, locked: false },
      self: { ...r2.state.candidate, exploration: true },
    },
    { enabled: true, timezone: 'Asia/Shanghai', content: { topics: {} } },
    now + 3700_000,
    { content: {} },
  );
  assert.equal(firstLinkTopic?.slot, 'share');
  assert.equal(firstLinkTopic?.evidence?.continuation, true);
  assert.equal(Boolean(firstLinkTopic?.evidence?.linkAlreadySent), false);
  assert.match(firstLinkTopic?.brief || '', /发送时会附来源/);

  // 该题材已实际发过一次链接后（linkAlreadySent=true），后续推进不再主动附链接
  const topic = pickTopic(
    {
      now: now + 3700_000,
      tz: 'Asia/Shanghai',
      her: {},
      me: {},
      fish: { ok: false },
      presence: { idleSec: 0, locked: false },
      self: { ...r2.state.candidate, exploration: true, linkAlreadySent: true },
    },
    { enabled: true, timezone: 'Asia/Shanghai', content: { topics: {} } },
    now + 3700_000,
    { content: {} },
  );
  assert.equal(topic?.slot, 'share');
  assert.equal(topic?.evidence?.continuation, true);
  assert.equal(topic?.evidence?.linkAlreadySent, true);
  assert.match(topic?.brief || '', /不主动附链接/);

  // 私聊上下文应带上真实 url，并注明用户明确索要时再发
  const cfg = {
    enabled: true,
    channels: { primary: 'qq', qq: { enabled: true, read: true, peerId: '728361417' } },
    exploration: { mode: 'deep', recentDays: 3, mood: false, portrait: false },
  };
  const replyCtx = qqReplyContext({
    peer: '728361417',
    kind: 'private',
    cfg,
    now: now + 3700_000,
    state: r2.state,
    persona,
    text: '把这本漫画的链接发我一下',
  });
  assert.match(replyCtx, /https:\/\/manga\.bilibili\.com\/detail\/mc38749/);
  assert.match(replyCtx, /只有用户明确索要链接/);
});

test('inspectSessionContext 轻量体检与 rules.exposeMaintenanceTools 开关校验', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-ctx-diag-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'qq-bridge'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'storages', 'session_projcache', 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'qq-bridge', 'bindings.json'), JSON.stringify({
    version: 1,
    sessions: {
      'sess-heavy': { peerId: '728361417', peerKind: 'private', enabled: true, authoritative: true },
    },
  }));
  fs.writeFileSync(path.join(dir, 'storages', 'session_projcache', 'sessions', 'sess-heavy.json'), JSON.stringify({
    record: {
      rows: {
        contextBreakdown: { val: { breakdown: { toolsTokens: 28418 } } },
        contextPressure: { val: { pressureTokens: 61069, contextWindow: 262144 } },
        contextHeaders: {
          val: {
            headers: [{
              tools: [
                { name: 'see_now', tokens: 1868 },
                { name: 'video_storyboard', tokens: 986 },
                { name: 'comfyui_workflow', tokens: 926 },
              ],
            }],
          },
        },
      },
    },
  }));

  const cfg = { channels: { primary: 'qq', qq: { peerId: '728361417' } } };
  const diag = inspectSessionContext(cfg, dir);
  assert.equal(diag?.key, 'session_context');
  assert.equal(diag?.level, 'warn');
  assert.match(diag?.detail || '', /28\.4k tokens/);
  assert.match(diag?.detail || '', /see_now\(1868\)/);

  // 无缓存时静默返回 null
  assert.equal(inspectSessionContext({ channels: { primary: 'qq', qq: { peerId: '99999' } } }, dir), null);

  // exposeMaintenanceTools 开关可正常保存
  const res = applyChange({}, 'rules.exposeMaintenanceTools', true);
  assert.equal(res.ok, true);
  assert.equal(res.cfg.rules.exposeMaintenanceTools, true);
});
