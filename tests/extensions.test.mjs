import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-extensions-'));
const cfgPath = path.join(dir, 'config.json');
const statePath = path.join(dir, 'state.json');
const logDir = path.join(dir, 'logs');
const dshHome = path.join(dir, 'dsh-home');
const prevEnv = {
  PG_CONFIG_PATH: process.env.PG_CONFIG_PATH,
  PG_STATE_PATH: process.env.PG_STATE_PATH,
  PG_LOG_DIR: process.env.PG_LOG_DIR,
  PG_DSH_HOME: process.env.PG_DSH_HOME,
};
process.env.PG_CONFIG_PATH = cfgPath;
process.env.PG_STATE_PATH = statePath;
process.env.PG_LOG_DIR = logDir;
process.env.PG_DSH_HOME = dshHome;

test.after(() => {
  for (const [k, v] of Object.entries(prevEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const { loadConfig } = await import('../src/settings/config.js');
const {
  registerExploreSource, registerMoodSource, registerMemorySource, registerTopicProvider,
  listExtensions, clearExtensions, extensionsDir,
  runExploreSource, readExternalMoods, resolveCombinedMood, shouldUseBuiltinEmotion, inspectActiveMood, notifyExternalMoodMessage, collectExternalTopics,
} = await import('../src/settings/extensions.js');
const { parseExtraToolNames, createExplorationMedia } = await import('../src/explore/explore-media.js');
const { exploreRound, explorationProgress } = await import('../src/explore/explore.js');
const { readMemory, detectMemory, inspectMemory } = await import('../src/decision/memorysource.js');
const { topicCandidates, pickTopic, tierOfSlot } = await import('../src/decision/topics.js');
const { topicLabel } = await import('../src/decision/explain.js');
const { applyChange, listForUi } = await import('../src/settings/settings.js');
const { apply } = await import('../src/plugin.js');

const persona = { ok: true, text: '平时喜欢逛 B 站看独立游戏评测和推理杂谈。' };
const jsonResult = (v) => ({ ok: true, text: JSON.stringify(v) });

function resetExtDir() {
  clearExtensions();
  fs.rmSync(extensionsDir(), { recursive: true, force: true });
}

test('注册校验、冲突保护、dispose 注销与 listExtensions', () => {
  resetExtDir();
  assert.throws(() => registerExploreSource({ id: 'bad id!', browse: () => [] }));
  assert.throws(() => registerExploreSource({ id: 'bili' }));
  assert.throws(() => registerMoodSource({ id: 'm1' }));
  assert.throws(() => registerMemorySource({ id: 'fish-memory', read: () => [] }), /内置适配器冲突/);
  assert.throws(() => registerTopicProvider({ slot: 'sleep', pick: () => null }), /内置由头冲突/);

  const d1 = registerExploreSource({ id: 'bili-hot', label: 'B站热门', mode: 'leisure', browse: async () => [] });
  const d2 = registerMoodSource({ id: 'my-mood', label: '心情扩展', read: () => '开心', onMessage: () => {} });
  const d3 = registerMemorySource({ id: 'my-mem', label: '图谱记忆', read: () => [] });
  const d4 = registerTopicProvider({ slot: 'biliLive', label: '主播开播', tier: 'event', pick: () => null });

  const listed = listExtensions();
  assert.equal(listed.exploreSources.length, 1);
  assert.equal(listed.exploreSources[0].id, 'bili-hot');
  assert.equal(listed.moodSources.length, 1);
  assert.equal(listed.moodSources[0].syncChat, true);
  assert.equal(listed.memorySources.length, 1);
  assert.equal(listed.memorySources[0].id, 'my-mem');
  assert.equal(listed.topicProviders.length, 1);
  assert.equal(listed.topicProviders[0].slot, 'biliLive');

  d1(); d2(); d3(); d4();
  const after = listExtensions();
  assert.deepEqual(after, { exploreSources: [], moodSources: [], memorySources: [], topicProviders: [] });
});

test('探索源扩展：接入 browse()、支持深度与轻探索并隔离异常和超时', async () => {
  resetExtDir();
  let captured = null;
  const disposeGood = registerExploreSource({
    id: 'bilibili-feed',
    label: 'B站动态',
    mode: 'both',
    description: '读取 B 站热门与关注动态',
    async browse(req) {
      captured = req;
      return {
        items: [
          {
            title: '独立游戏新作试玩拆解',
            url: 'https://www.bilibili.com/video/BV1test12345',
            content: '作者拆解了新作的关卡引导和叙事节奏，评论区都在夸开头十分钟。',
          },
          {
            title: '内网地址会被过滤但正文保留',
            url: 'http://127.0.0.1:8080/secret',
            content: '不会带上本地回环链接。',
          },
        ],
      };
    },
  });
  const disposeBad = registerExploreSource({
    id: 'broken-src',
    async browse() { throw new Error('boom'); },
  });
  const disposeSlow = registerExploreSource({
    id: 'slow-src',
    timeoutMs: 1000,
    async browse({ signal }) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return [{ title: signal.aborted ? 'aborted' : 'late', content: 'x' }];
    },
  });

  try {
    // 异常源和超时源都不会抛错拖垮主流程
    assert.deepEqual(await runExploreSource('broken-src'), []);
    const t0 = Date.now();
    const timedOut = await runExploreSource('slow-src', { timeoutMs: 1000 });
    assert.deepEqual(timedOut, []);
    assert.ok(Date.now() - t0 < 2000, '超时保护应及时返回');

    // 接入 createExplorationMedia（即便没开网页/视频工具也能启用）
    const media = createExplorationMedia({ tools: null, web: false, video: false });
    assert.ok(media);
    assert.equal(media.web, false);
    assert.equal(media.video, false);
    assert.ok(media.extSources.some((s) => s.id === 'bilibili-feed'));

    const round = await exploreRound({
      persona,
      now: 1000,
      media,
      generate: async ({ prompt }) => {
        if (prompt.includes('progressSourceIndex')) {
          assert.match(prompt, /独立游戏新作试玩拆解/);
          assert.match(prompt, /外部扩展资料/);
          return jsonResult({
            action: 'start',
            topic: '独立游戏叙事节奏',
            progress: '刷 B 站看到一个试玩拆解，说开头十分钟的引导特别稳。',
            next: '看看后续章节口碑',
            progressSourceIndex: 0,
            share: '刚才在 B 站刷到一个独立游戏拆解，开头十分钟的引导做得挺顺。',
          });
        }
        assert.match(prompt, /bilibili-feed/);
        return jsonResult({ mode: 'leisure', kind: 'ext', source: 'bilibili-feed', query: '独立游戏评测' });
      },
    });
    assert.equal(captured?.query, '独立游戏评测');
    assert.ok(media.calls.includes('ext:bilibili-feed'));
    const entries = explorationProgress(round.state, persona, 1001);
    assert.equal(entries[0].evidence, '外部扩展资料');
    assert.equal(round.state.leisure.progressSource.url, 'https://www.bilibili.com/video/BV1test12345');

    // 轻探索模式同样支持 ext
    const light = await exploreRound({
      persona,
      now: 2000,
      media,
      timing: { mode: 'light' },
      generate: async ({ prompt }) => {
        if (prompt.includes('progressSourceIndex')) {
          return jsonResult({
            action: 'light',
            topic: 'B站新游观察',
            summary: '顺手瞄了眼 B 站试玩视频，大家都在聊叙事节奏。',
            progressSourceIndex: 0,
            share: '',
          });
        }
        return jsonResult({ interest: '独立游戏', kind: 'ext', source: 'bilibili-feed', query: '独立游戏' });
      },
    });
    assert.equal(light.ok, true);
    assert.equal(light.state.light.progressSource.evidence, '外部扩展资料');
  } finally {
    disposeGood();
    disposeBad();
    disposeSlow();
  }
});

test('免代码 extraTools 白名单过滤危险工具、支持设置项保存与非默认 extTimeoutMs 运行时生效', async () => {
  resetExtDir();
  fs.rmSync(cfgPath, { force: true });
  const cfg = loadConfig();
  assert.equal(cfg.exploration.extraTools, '');
  assert.equal(cfg.exploration.extTimeoutMs, 12000);

  // 白名单放行只读工具，拦截写/执行/发消息/自查工具
  assert.deepEqual(
    parseExtraToolNames('bilibili_hot, bash, write_file，send_qq; presence_status, rss_fetch, exec_cmd, bilibili_hot'),
    ['bilibili_hot', 'rss_fetch'],
  );

  // 设置项读写回显（AGENTS.md 要求）
  const r1 = applyChange(cfg, 'exploration.extraTools', 'bilibili_hot, rss_fetch');
  assert.equal(r1.ok, true);
  assert.equal(r1.cfg.exploration.extraTools, 'bilibili_hot, rss_fetch');
  const r2 = applyChange(r1.cfg, 'exploration.extTimeoutMs', 2); // UI 单位是秒，scale=1000 -> 2000ms
  assert.equal(r2.ok, true);
  assert.equal(r2.cfg.exploration.extTimeoutMs, 2000);
  const allUi = listForUi(r2.cfg).flatMap((g) => g.items);
  assert.equal(allUi.find((i) => i.path === 'exploration.extraTools')?.value, 'bilibili_hot, rss_fetch');
  assert.equal(allUi.find((i) => i.path === 'exploration.extTimeoutMs')?.value, 2);

  // 运行时效果：调用允许的只读工具并返回「外部工具结果」，以及非默认 extTimeoutMs 确实按新值超时
  const toolMap = new Map([
    ['bilibili_hot', {
      description: '读取 B 站热门榜',
      async execute(args) {
        return JSON.stringify({ items: [{ title: `热门:${args.query}`, url: 'https://www.bilibili.com/video/BV1abc', summary: '今日热门汇总' }] });
      },
    }],
    ['slow_tool', {
      description: '模拟慢工具',
      async execute(_args, { signal }) {
        await new Promise((resolve) => setTimeout(resolve, 2600));
        return signal?.aborted ? '' : 'too late';
      },
    }],
    ['bash', {
      description: '危险工具',
      async execute() { return 'should never run'; },
    }],
  ]);
  const tools = { get: (n) => toolMap.get(n) || null };
  const media = createExplorationMedia({
    tools,
    web: false,
    video: false,
    extraTools: 'bilibili_hot, slow_tool, bash',
    timing: { extTimeoutMs: 1000 },
  });
  assert.ok(media);
  assert.deepEqual(media.extSources.map((s) => s.id), ['bilibili_hot', 'slow_tool']);

  const got = await media.collect('ext', '动漫', { sourceId: 'bilibili_hot' });
  assert.equal(got.length, 1);
  assert.equal(got[0].title, '热门:动漫');
  assert.equal(got[0].evidence, '外部工具结果');

  const t0 = Date.now();
  const slowRes = await media.collect('ext', '动漫', { sourceId: 'slow_tool' });
  assert.deepEqual(slowRes, []);
  assert.ok(Date.now() - t0 < 2000, '非默认 extTimeoutMs=1000 应在 ~1s 内中断慢工具');
});

test('心情扩展：registerMoodSource 同步读取 + onMessage 推送 + data/extensions/mood.json 免代码投递', () => {
  resetExtDir();
  const received = [];
  const dGood = registerMoodSource({
    id: 'affection',
    label: '好感度插件',
    read: ({ peer }) => ({ moodText: `对 ${peer} 很亲近，语气轻快` }),
    onMessage: (evt) => received.push(evt),
  });
  const dThrow = registerMoodSource({
    id: 'throw-mood',
    read: () => { throw new Error('broken'); },
    onMessage: () => { throw new Error('broken-notify'); },
  });
  const dAsync = registerMoodSource({
    id: 'async-mood',
    read: async () => '异步返回应被忽略',
  });

  try {
    const now = Date.parse('2026-11-22T15:00:00+08:00');
    fs.mkdirSync(extensionsDir(), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir(), 'mood.json'), JSON.stringify({
      moodText: '刚听完一张专辑心情很好',
      updatedAt: now - 10 * 60_000,
      ttlMin: 60,
    }));
    const merged = readExternalMoods({ peer: '10001', now });
    assert.match(merged, /对 10001 很亲近/);
    assert.match(merged, /刚听完一张专辑心情很好/);
    assert.doesNotMatch(merged, /异步返回/);

    // 过期 mood.json 会自动忽略
    fs.writeFileSync(path.join(extensionsDir(), 'mood.json'), JSON.stringify({
      moodText: '过期的旧情绪',
      updatedAt: now - 120 * 60_000,
      ttlMin: 30,
    }));
    const afterExpiry = readExternalMoods({ peer: '10001', now });
    assert.doesNotMatch(afterExpiry, /过期的旧情绪/);

    // 消息通知不受异常扩展影响
    notifyExternalMoodMessage({ peer: '10001', role: 'user', text: '晚上好', at: now, channel: 'qq' });
    assert.equal(received.length, 1);
    assert.equal(received[0].text, '晚上好');

    // 防冲突策略（exploration.moodSource）：auto / builtin / external / merge / 指定插件 ID + 设置保存回显
    fs.rmSync(cfgPath, { force: true });
    const baseCfg = loadConfig();
    assert.equal(baseCfg.exploration.moodSource, 'auto');
    const moodUi = listForUi(baseCfg).flatMap((g) => g.items).find((i) => i.path === 'exploration.moodSource');
    assert.ok(moodUi.options.some(([val, lbl]) => val === 'affection' && lbl.includes('好感度插件')));

    assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', now, cfg: baseCfg }), '对 10001 很亲近，语气轻快');
    const rBuiltin = applyChange(baseCfg, 'exploration.moodSource', 'builtin');
    assert.equal(rBuiltin.ok, true);
    assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', now, cfg: rBuiltin.cfg }), '内置平静');

    const rMerge = applyChange(baseCfg, 'exploration.moodSource', 'merge');
    assert.equal(rMerge.ok, true);
    assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', now, cfg: rMerge.cfg }), '内置平静；对 10001 很亲近，语气轻快');

    const rExternal = applyChange(baseCfg, 'exploration.moodSource', 'external');
    assert.equal(rExternal.ok, true);
    assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', now, cfg: rExternal.cfg }), '对 10001 很亲近，语气轻快');

    const rOnlyId = applyChange(baseCfg, 'exploration.moodSource', 'affection');
    assert.equal(rOnlyId.ok, true);
    assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', now, cfg: rOnlyId.cfg }), '对 10001 很亲近，语气轻快');

    // 实际对接插件随选择切换：内置 inbox/打分仅在 builtin 或 merge 时开启；选 builtin 时不向第三方推送消息
    const basePortraitOn = { ...baseCfg, exploration: { ...baseCfg.exploration, portrait: true } };
    assert.equal(shouldUseBuiltinEmotion({ ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'auto' } }, now), false);
    assert.equal(shouldUseBuiltinEmotion({ ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'builtin' } }, now), true);
    assert.equal(shouldUseBuiltinEmotion({ ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'merge' } }, now), true);
    assert.equal(shouldUseBuiltinEmotion({ ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'external' } }, now), false);

    const beforeCount = received.length;
    notifyExternalMoodMessage({ peer: '10001', role: 'user', text: '仅内置时不应收到', at: now, channel: 'qq', cfg: rBuiltin.cfg });
    assert.equal(received.length, beforeCount);
    notifyExternalMoodMessage({ peer: '10001', role: 'user', text: '选指定扩展应收到', at: now, channel: 'qq', cfg: rOnlyId.cfg });
    assert.equal(received.length, beforeCount + 1);

    // 情绪状态卡片括号标题随所选插件变化
    const emAuto = inspectActiveMood({ cfg: basePortraitOn, peer: '10001', now, baseEmotion: { version: '1.2.0' } });
    assert.equal(emAuto.activeKind, 'external');
    assert.match(emAuto.activePluginLabel, /自动 → .*好感度插件/);
    const emBuiltin = inspectActiveMood({ cfg: { ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'builtin' } }, peer: '10001', now, baseEmotion: { version: '1.2.0' } });
    assert.equal(emBuiltin.activePluginLabel, 'emotion-state-portrait v1.2.0');
    const emMerge = inspectActiveMood({ cfg: { ...basePortraitOn, exploration: { ...basePortraitOn.exploration, moodSource: 'merge' } }, peer: '10001', now, baseEmotion: { version: '1.2.0' } });
    assert.match(emMerge.activePluginLabel, /emotion-state-portrait v1\.2\.0 \+ .*好感度插件/);
  } finally {
    dGood();
    dThrow();
    dAsync();
  }
  // 无第三方心情扩展时，auto 自动回落到内置情绪插件
  assert.equal(resolveCombinedMood({ basePortrait: '内置平静', peer: '10001', cfg: loadConfig() }), '内置平静');
});

test('记忆扩展：注册后进入设置下拉选项、显式读取与 auto 回退均可用', () => {
  resetExtDir();
  fs.rmSync(cfgPath, { force: true });
  const dispose = registerMemorySource({
    id: 'neo-graph',
    label: '图谱记忆插件',
    read: ({ limit }) => ({
      files: ['graph.db'],
      items: [
        { text: '用户周三晚上固定去打羽毛球', category: 'stable_profile', importance: 0.9, day: '2026-11-20' },
        { text: '最近在追一部推理番', category: 'event', importance: 0.6, day: '2026-11-22' },
      ].slice(0, limit),
    }),
  });
  try {
    const cfg = loadConfig();
    // 设置页下拉选项自动带出第三方记忆插件（select options 为 [value, label] 二元组）
    const groups = listForUi(cfg);
    const memItem = groups.flatMap((g) => g.items).find((i) => i.path === 'sources.memory.plugin');
    assert.ok(memItem.options.some(([val, lbl]) => val === 'neo-graph' && lbl.includes('图谱记忆插件')));

    // 可通过 settings 选中该记忆插件
    const changed = applyChange(cfg, 'sources.memory.plugin', 'neo-graph');
    assert.equal(changed.ok, true);
    assert.equal(changed.cfg.sources.memory.plugin, 'neo-graph');

    // 显式读取 + detectMemory
    const res = readMemory({ cfg: changed.cfg });
    assert.equal(res.ok, true);
    assert.equal(res.plugin, 'neo-graph');
    assert.equal(res.items.length, 2);
    assert.match(res.items[0].text, /羽毛球/);
    const det = detectMemory(changed.cfg);
    assert.equal(det.ready, true);
    assert.equal(det.resolvedPlugin, 'neo-graph');
    const inspDirect = inspectMemory({ cfg: changed.cfg });
    assert.equal(inspDirect.resolvedPlugin, 'neo-graph');
    assert.equal(inspDirect.label, '图谱记忆插件（neo-graph）');
    assert.equal(inspDirect.files[0].name, 'graph.db');
    assert.equal(inspDirect.files[0].count, 2);

    // auto 模式且无本地内置目录时自动回退到已注册的记忆扩展，inspectMemory 标题与文件同步切换
    const autoCfg = {
      ...cfg,
      sources: { ...cfg.sources, memory: { enabled: true, plugin: 'auto', dir: path.join(dir, 'empty-mem'), session: '' } },
    };
    const autoRes = readMemory({ cfg: autoCfg });
    assert.equal(autoRes.ok, true);
    assert.equal(autoRes.resolvedPlugin, 'neo-graph');
    const inspAuto = inspectMemory({ cfg: autoCfg });
    assert.equal(inspAuto.resolvedPlugin, 'neo-graph');
    assert.equal(inspAuto.label, '自动识别 → 图谱记忆插件（neo-graph）');
  } finally {
    dispose();
  }
});

test('自定义由头扩展：registerTopicProvider + data/extensions/topics.json 去重、过期与文案解析', () => {
  resetExtDir();
  fs.rmSync(cfgPath, { force: true });
  const cfg = loadConfig();
  const now = Date.parse('2026-11-22T15:00:00+08:00');
  const dispose = registerTopicProvider({
    slot: 'biliUpdate',
    label: 'B站关注更新',
    why: '关注的 UP 主发了新视频',
    tier: 'event',
    pick: () => ({
      brief: '她常看的独立游戏 UP 主刚发了新视频《叙事设计拆解》，可以顺口提一句',
      dedupKey: 'BV1newvideo',
    }),
  });
  try {
    assert.equal(tierOfSlot('biliUpdate'), 'event');
    assert.equal(topicLabel('biliUpdate'), 'B站关注更新');

    // 配合 topics.json（包含有效项、过期项和冲突内置 slot 项）
    fs.mkdirSync(extensionsDir(), { recursive: true });
    fs.writeFileSync(path.join(extensionsDir(), 'topics.json'), JSON.stringify([
      {
        slot: 'steamDeal',
        label: 'Steam 史低',
        brief: '愿望单里的独立游戏刚打折到史低，可以提一句。',
        dedupKey: 'steam-123',
        expiresAt: now + 3600_000,
      },
      {
        slot: 'expiredOne',
        brief: '这条已经过期了',
        expiresAt: now - 1000,
      },
      {
        slot: 'sleep',
        brief: '试图冒充内置由头，应被拦截',
      },
    ]));

    const extOnly = collectExternalTopics({ ctx: {}, cfg, now, st: {} });
    assert.deepEqual(extOnly.map((t) => t.slot), ['biliUpdate', 'steamDeal']);

    // 进主选题管线，dedupKey 命中后不再重复触发
    const cands = [...topicCandidates({}, cfg, now, {})];
    assert.ok(cands.some((c) => c.slot === 'biliUpdate'));
    assert.ok(cands.some((c) => c.slot === 'steamDeal'));

    const picked = pickTopic({}, cfg, now, {});
    assert.equal(picked?.slot, 'biliUpdate');

    const afterDedup = [...topicCandidates({}, cfg, now, {
      content: { extTopicDedup: { biliUpdate: 'BV1newvideo', steamDeal: 'steam-123' } },
    })];
    assert.equal(afterDedup.some((c) => c.slot === 'biliUpdate' || c.slot === 'steamDeal'), false);
  } finally {
    dispose();
  }
});

test('plugin.js：通过 ctx.presenceGate 暴露注册接口并在 snapshot().extensions 中返回已注册扩展', () => {
  resetExtDir();
  const provided = {};
  const ctx = {
    get: () => null,
    set(k, v) { provided[k] = v; },
    effect() { return () => {}; },
    on() {},
  };
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false, statusApi: false });
  try {
    assert.equal(provided.presenceGate, api);
    assert.equal(typeof api.registerExploreSource, 'function');
    assert.equal(typeof api.registerMoodSource, 'function');
    assert.equal(typeof api.registerMemorySource, 'function');
    assert.equal(typeof api.registerTopicProvider, 'function');
    assert.equal(typeof api.listExtensions, 'function');

    const d = api.registerExploreSource({ id: 'rss-news', label: 'RSS', browse: async () => [] });
    try {
      const snap = api.snapshot();
      assert.equal(snap.extensions.exploreSources.length, 1);
      assert.equal(snap.extensions.exploreSources[0].id, 'rss-news');
    } finally {
      d();
    }
    assert.equal(api.snapshot().extensions.exploreSources.length, 0);
  } finally {
    api.stop();
  }
});
