import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-explore-round-'));
const env = {
  PG_CONFIG_PATH: 'config.json', PG_STATE_PATH: 'state.json', PG_LOG_DIR: 'logs',
  PG_DSH_HOME: 'dsh', PG_CHAT_DATA_DIR: 'data', PG_SECRETS_PATH: 'credentials.json',
};
const previous = Object.keys(env).map(key => [key, process.env[key]]);
for (const [key, value] of Object.entries(env)) process.env[key] = path.join(dir, value);
test.after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const { exploreRound, explorationProgress, explorationShare, explorationMood, explorationStatus, explorationToneHint, styleApprovedDraft, personaKey } =
  await import('../src/explore/explore.js');

const persona = { ok: true, text: '喜欢推理小说，常留意不可靠叙述者。' };
const result = (value) => ({ ok: true, text: JSON.stringify(value) });

test('chooses from the current persona and can continue without QQ, browsing or vision', async () => {
  const first = await exploreRound({ persona, now: 100, generate: async ({ prompt }) => {
    assert.match(prompt, /不可靠叙述者/);
    assert.match(prompt, /没有网页浏览/);
    return result({ action: 'start', topic: '不可靠叙述者', progress: '想到一个判断视角：区分遗漏和撒谎。', next: '对照两种反例', share: '' });
  } });
  const second = await exploreRound({ persona, previous: first.state, now: 200, generate: async ({ prompt }) => {
    assert.match(prompt, /对照两种反例/);
    return result({ action: 'continue', progress: '记忆有缺口和主动误导，读者读起来其实很不一样。', next: '看角色是否知道自己记错', share: '我刚想到，不可靠叙述者最有意思的也许是她自己都不知道哪里记错了。' });
  } });
  assert.equal(second.state.thread.topic, '不可靠叙述者');
  assert.match(explorationShare(second.state, persona, 201).line, /不可靠叙述者/);
  assert.equal(explorationShare(second.state, { ...persona, text: '喜欢电子乐' }, 201), null);
});

test('progress evidence comes from the selected tool result, with no upgrade for a headline', async () => {
  const media = { web: true, collect: async () => [
    { url: 'https://example.com/body', title: '正文', evidence: '网页正文' },
    { url: 'https://example.com/title', title: '标题', evidence: '搜索摘要' },
  ] };
  for (const [index, evidence] of [[0, '网页正文'], [1, '仅标题或搜索摘要'], [99, '进展未标明来源，按未核验处理'], [null, '文字推演']]) {
    const round = await exploreRound({ persona, now: 100, media, generate: async ({ prompt }) =>
      prompt.includes('progressSourceIndex')
        ? result({ action: 'start', topic: '推理', progress: '想接着看', next: '找原文', progressSourceIndex: index, checkpoint: '读到第二段' })
        : result({ mode: 'research', kind: 'web', query: '推理短篇' }),
    });
    const entries = explorationProgress(round.state, persona, 101);
    assert.equal(entries[0].evidence, evidence);
    assert.equal(round.state.thread.checkpoint, index === 0 ? '读到第二段' : undefined);
    assert.deepEqual(explorationProgress(round.state, { ...persona, text: '新人设' }, 101), []);
    assert.deepEqual(explorationProgress(round.state, persona, 100 + 3 * 86_400_000), []);
  }
});

test('missing persona skips; invalid plans and explicit skips cannot fabricate progress', async () => {
  const noPersona = await exploreRound({ persona: { ok: false }, generate: async () => assert.fail('no model call') });
  assert.equal(noPersona.reason, 'NO_PERSONA');
  const invalid = await exploreRound({ persona, generate: async () => result({ action: 'continue', progress: '没这条线' }) });
  assert.equal(invalid.ok, false);
  const skip = await exploreRound({ persona, generate: async () => result({ action: 'skip' }) });
  assert.equal(skip.state.thread, null);
});

test('truncated continuation retries with a larger output budget and preserves the original topic', async () => {
  const start = await exploreRound({ persona, generate: async () => result({
    action: 'start', topic: '限电预警', progress: '考虑短时冲高', next: '比较判据',
  }) });
  const budgets = [];
  const follow = await exploreRound({ persona, previous: start.state, generate: async ({ minOutputTokens }) => {
    budgets.push(minOutputTokens);
    return budgets.length === 1
      ? { ok: true, text: '{"action":"continue","progress":"' }
      : result({ action: 'continue', progress: '比较短时与持续负载', next: '列出误报情况' });
  } });
  assert.deepEqual(budgets, [2048, 4096]);
  assert.equal(follow.state.thread.topic, '限电预警');
  assert.equal(follow.state.thread.progress, '比较短时与持续负载');
});

test('exploration stores a feeling in the same call, with expiry and persona isolation', async () => {
  let calls = 0;
  const round = await exploreRound({ persona, now: 100, includeMood: true, generate: async ({ prompt }) => {
    calls++;
    assert.match(prompt, /mood/);
    return result({ action: 'start', topic: '推理', progress: '想到了一个反例', next: '想第二个例子', mood: '有点得意，刚想到一个反例。' });
  } });
  assert.equal(calls, 1);
  assert.match(explorationMood(round.state, persona, 101).text, /得意/);
  assert.equal(explorationMood(round.state, persona, 100 + 2 * 3_600_000), null);
  assert.equal(explorationMood(round.state, { ...persona, text: '喜欢电气' }, 101), null);
});

test('a fresh QQ reply can change tone without supplying a new reason to send', async () => {
  const mood = { text: '有点得意，刚想到一个反例。' };
  const draft = { ok: true, text: '我想到一个反例。' };
  for (const [reply, revised] of [['讲讲，我想听', '嘿，这个反例我自己都没想到。'], ['我今天有点累', '我想到个反例，留着改天聊。']]) {
    const ctx = { explorationMood: mood, her: { lastChannel: 'qq', lastAgoSec: 30, lastText: reply } };
    const out = await styleApprovedDraft({ draft, ctx, persona, generate: async ({ prompt }) => {
      assert.ok(prompt.includes(reply));
      assert.match(prompt, /有点得意/);
      return { ok: true, text: revised };
    }, validate: (text) => ({ ok: true, text }) });
    assert.equal(out.text, revised);
  }
  const ctx = { explorationMood: mood, her: { lastChannel: 'qq', lastAgoSec: 30, lastText: '嗯' } };
  assert.doesNotMatch(explorationToneHint(ctx), /"嗯"/);
  assert.match(explorationToneHint({ explorationMood: mood, her: { lastChannel: 'douyin', lastAgoSec: 30, lastText: '讲讲看嘛' } }), /讲讲看嘛/);
  assert.equal(await styleApprovedDraft({ draft: { ok: false }, ctx, generate: () => assert.fail('no approved message') }).then((r) => r.ok), false);
});

test('HOST_LLM_EMPTY retries once with 4096 token budget and preserves note if still empty', async () => {
  const budgets = [];
  const recovered = await exploreRound({ persona, generate: async ({ minOutputTokens, prompt }) => {
    budgets.push(minOutputTokens);
    assert.doesNotMatch(prompt, /上次输出未通过校验/);
    return budgets.length === 1
      ? { ok: false, reason: 'HOST_LLM_EMPTY', note: 'finish=max-tokens · reasoning=900字 · maxTokens=2048' }
      : result({ action: 'start', topic: '限电预警', progress: '留出思考余量', next: '验证公式' });
  } });
  assert.deepEqual(budgets, [2048, 4096]);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.state.thread.topic, '限电预警');

  const failed = await exploreRound({ persona, generate: async () => (
    { ok: false, reason: 'HOST_LLM_EMPTY', note: 'finish=max-tokens · reasoning=1800字 · maxTokens=4096' }
  ) });
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'HOST_LLM_EMPTY');
  assert.match(failed.note, /finish=max-tokens/);
});

test('lightweight exploration runs a single shallow study without mutating thread or requiring next, and avoids recent topics', async () => {
  const deepBefore = await exploreRound({
    persona, now: 100,
    generate: async () => result({ action: 'start', topic: '长线课题', progress: '第一步想法', next: '第二步验证' }),
  });

  let fetchCalls = 0;
  const media = {
    web: true,
    calls: [],
    collect: async (_kind, _query, opts) => {
      assert.equal(opts?.light, true);
      fetchCalls++;
      return [{ url: 'https://example.org/espresso', title: '浅烘豆萃取温度', evidence: '网页正文' }];
    },
  };
  const light1 = await exploreRound({
    persona,
    previous: deepBefore.state,
    now: 200,
    timing: { mode: 'light' },
    media,
    generate: async ({ prompt }) => {
      if (prompt.includes('挑一件简单')) return result({ kind: 'web', query: '浅烘豆萃取温度' });
      assert.match(prompt, /轻量化自主探索/);
      assert.doesNotMatch(prompt, /next/);
      return result({
        action: 'light',
        topic: '浅烘豆水温',
        summary: '浅烘豆用 92 度左右出酸甜会更干净。',
        share: '刚看到说浅烘豆用九十二度冲比沸水更顺口，你平时手冲试过降一点水温吗？',
        progressSourceIndex: 0,
        sourceIndex: 0,
      });
    },
  });
  assert.equal(light1.ok, true);
  assert.equal(light1.action, 'light');
  assert.equal(fetchCalls, 1);
  // 不破坏原有长线 thread，且不生成 next
  assert.equal(light1.state.thread.topic, '长线课题');
  assert.equal(light1.state.thread.next, '第二步验证');
  assert.equal(light1.state.light.topic, '浅烘豆水温');
  assert.equal(light1.state.light.next, undefined);
  assert.equal(light1.state.lastRun.mode, 'light');
  assert.match(explorationShare(light1.state, persona, 201).line, /浅烘豆/);

  const lightProgress = explorationProgress(light1.state, persona, 201, { mode: 'light' });
  assert.equal(lightProgress.length, 1);
  assert.equal(lightProgress[0].mode, 'light');
  assert.equal(lightProgress[0].topic, '浅烘豆水温');
  assert.equal(lightProgress[0].evidence, '网页正文');

  // 下一轮轻量探索应把「浅烘豆水温」放进避重列表，且不重复
  const light2 = await exploreRound({
    persona,
    previous: light1.state,
    now: 300,
    timing: { mode: 'light' },
    generate: async ({ prompt }) => {
      assert.match(prompt, /浅烘豆水温/);
      return result({ action: 'light', topic: '雨天书店闲逛', summary: '雨天看老推理短篇很舒服。', share: '' });
    },
  });
  assert.equal(light2.ok, true);
  assert.deepEqual(light2.state.lightHistory.map((x) => x.topic), ['浅烘豆水温', '雨天书店闲逛']);
});

test('three exploration biases shape each four-round cycle in deep and light modes', async () => {
  const interest = '最近想了解独立游戏的设计';
  const expected = {
    leisure: ['leisure', 'leisure', 'research', 'leisure'],
    balanced: ['research', 'leisure', 'research', 'leisure'],
    research: ['research', 'research', 'leisure', 'research'],
  };
  for (const mode of ['deep', 'light']) {
    for (const [bias, directions] of Object.entries(expected)) {
      let previous;
      for (const [round, direction] of directions.entries()) {
        const output = await exploreRound({
          persona, previous, interest, bias, leisureEvery: 0, exploreMode: mode, now: 100 + round,
          generate: async ({ prompt }) => {
            assert.match(prompt, /最近想了解独立游戏的设计/);
            if (mode === 'light') {
              assert.match(prompt, direction === 'leisure' ? /本轮方向是休闲/ : /本轮方向是研究/);
              return result({ action: 'light', topic: '一个新点', summary: '想明白了一个细节' });
            }
            return result({ action: 'start', topic: '一个新点', progress: '想明白了一个细节', next: '再做对比' });
          },
        });
        assert.equal(output.ok, true, mode + ': ' + bias);
        assert.equal(mode === 'light' ? output.state.lastRun.direction : output.state.lastRun.mode, direction,
          mode + ': ' + bias + ' round ' + round);
        if (mode === 'light') {
          assert.equal(output.state.light.next, undefined);
          assert.equal(output.state.thread, null);
        }
        previous = output.state;
      }
    }
  }
});

test('light selection and writing both receive the direction while pinned subjects still win', async () => {
  const prompts = [];
  const media = { web: true, collect: async (kind, query, options) => {
    assert.equal(kind, 'web');
    assert.equal(query, '用户指定的题');
    assert.equal(options.light, true);
    return [];
  } };
  const round = await exploreRound({
    persona, focusTopic: '用户指定的题', interest: '平时的兴趣', bias: 'leisure', exploreMode: 'light', media,
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      assert.match(prompt, /本轮方向是研究/);
      assert.match(prompt, /用户指定的题/);
      return prompts.length === 1
        ? result({ kind: 'web', query: '平时的兴趣' })
        : result({ action: 'light', topic: '模型另选的题', summary: '一个发现' });
    },
  });
  assert.equal(prompts.length, 2);
  assert.equal(round.state.light.topic, '用户指定的题');
  assert.equal(round.state.lastRun.mode, 'light');
});

test('legacy cadence is unchanged in deep mode and remains unused in light mode', async () => {
  let previous;
  for (const direction of ['research', 'research', 'leisure', 'research']) {
    const round = await exploreRound({ persona, previous, leisureEvery: 3, generate: async () => result({ action: 'skip' }) });
    assert.equal(round.state.lastRun.mode, direction);
    previous = round.state;
  }
  const light = await exploreRound({ persona, previous, exploreMode: 'light', leisureEvery: 1, generate: async ({ prompt }) => {
    assert.doesNotMatch(prompt, /本轮方向是/);
    return result({ action: 'skip' });
  } });
  assert.equal(light.state.lastRun.mode, 'light');
});

test('哔哩哔哩漫画或「不要视频」指定主题强制纠偏为 web 搜索并保留休闲回传规划', async () => {
  for (const [focusTopic, expectedQuery, site] of [
    ['哔哩哔哩漫画作品：《”哆哆嗦嗦“逃离你》', '哆哆嗦嗦逃离你', 'manga.bilibili.com'],
    ['漫画，不要视频', '漫画'],
  ]) {
    const collected = [];
    const media = {
      web: true,
      video: true,
      calls: [],
      collect: async (kind, query, options) => {
        collected.push({ kind, query, options });
        return [{ url: 'https://manga.bilibili.com/detail/mc123', title: expectedQuery, evidence: '网页正文', content: '漫画简介正文' }];
      },
    };
    const round = await exploreRound({
      persona,
      focusTopic,
      bias: 'leisure',
      media,
      generate: async ({ prompt }) => {
        if (prompt.includes('替角色选这一轮的方向')) {
          assert.match(prompt, /严禁选 video/);
          // 模拟模型偏偏返回 mode=leisure 且误选 kind=video 的情况
          return result({ mode: 'leisure', kind: 'video', query: focusTopic });
        }
        return result({ action: 'start', topic: focusTopic, progress: '看了漫画简介正文', next: '继续看第一话', progressSourceIndex: 0 });
      },
    });
    assert.equal(round.ok, true);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].kind, 'web');
    assert.ok(collected[0].query.includes(expectedQuery));
    assert.doesNotMatch(collected[0].query, /作品：|[《》”“]|不要视频/);
    if (site) {
      assert.ok(collected[0].query.includes('site:' + site));
      assert.deepEqual(collected[0].options.preferredSites, [site]);
      assert.equal(collected[0].options.fallbackQuery, expectedQuery);
    }
    assert.equal(round.state.lastRun.kind, 'web');
    assert.equal(round.state.lastRun.query, expectedQuery);
    assert.equal(round.state.thread.progressSource.evidence, '网页正文');
  }
});

test('interest 指定哔哩哔哩漫画时即使规划模型返回 none 且无 query 也会强制转 web 搜索', async () => {
  for (const [mode, exploreMode] of [['leisure', 'deep'], ['research', 'deep'], ['leisure', 'light']]) {
    const collected = [];
    const media = {
      web: true,
      video: true,
      calls: [],
      collect: async (kind, query, options) => {
        collected.push({ kind, query, options });
        return [{ url: 'https://manga.bilibili.com/detail/mc123', title: '“哆哆嗦嗦”逃离你', evidence: '搜索摘要', content: '职场喜剧漫画简介' }];
      },
    };
    const round = await exploreRound({
      persona,
      interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
      bias: mode === 'leisure' ? 'leisure' : 'research',
      exploreMode,
      media,
      generate: async ({ prompt }) => {
        if (prompt.includes('替角色选这一轮的方向') || prompt.includes('挑一件简单')) {
          return result({ mode, kind: 'none', query: '' });
        }
        return exploreMode === 'light'
          ? result({ action: 'light', topic: '“哆哆嗦嗦”逃离你', summary: '看了职场喜剧漫画简介', progressSourceIndex: 0 })
          : result({ action: 'start', topic: '“哆哆嗦嗦”逃离你', progress: '看了职场喜剧漫画简介', next: '看看网友评价', progressSourceIndex: 0 });
      },
    });
    assert.equal(round.ok, true);
    assert.equal(collected.length, 1);
    assert.equal(collected[0].kind, 'web');
    assert.equal(collected[0].query, '哆哆嗦嗦逃离你 site:manga.bilibili.com');
    assert.deepEqual(collected[0].options.preferredSites, ['manga.bilibili.com']);
    assert.equal(collected[0].options.fallbackQuery, '哆哆嗦嗦逃离你');
    assert.equal(round.state.lastRun.kind, 'web');
    assert.equal(round.state.lastRun.query, '哆哆嗦嗦逃离你');
  }
});

function explorationRunData(prompt) {
  return JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"persona"')));
}

test('new interests withhold an unrelated research thread from planning and writing', async () => {
  const old = await exploreRound({ persona, now: 100, generate: async () => result({
    action: 'start', topic: '插排过载保护设计', progress: '记录漏保配置', next: '对照浪涌保护器型号',
  }) });
  const prompts = [];
  const round = await exploreRound({
    persona, previous: old.state, interest: '最近想了解独立游戏的关卡设计', now: 200,
    media: { web: true, collect: async () => assert.fail('no web search expected') },
    generate: async ({ prompt }) => {
      const data = explorationRunData(prompt);
      prompts.push(data);
      assert.equal(data.thread, null);
      assert.doesNotMatch(prompt, /对照浪涌保护器型号/);
      return prompts.length === 1 ? result({ kind: 'none', mode: 'research' }) : result({
        action: 'start', topic: '独立游戏关卡设计', progress: '从无文字提示入手', next: '比较两个关卡的引导方式',
      });
    },
  });
  assert.equal(prompts.length, 2);
  assert.equal(round.state.thread.topic, '独立游戏关卡设计');
  assert.ok(round.state.notes.some((entry) => entry.topic === '插排过载保护设计'));

  for (const interest of ['最近想了解独立游戏的关卡设计', '随便看看有意思的东西']) {
    const followed = await exploreRound({
      persona, previous: round.state, interest, now: 300,
      generate: async ({ prompt }) => {
        assert.equal(explorationRunData(prompt).thread.topic, '独立游戏关卡设计');
        return result({ action: 'continue', progress: '对比了两种引导', next: '补个反例' });
      },
    });
    assert.equal(followed.ok, true);
    assert.equal(followed.action, 'continue');
  }
});

test('a one-round research focus only carries over while related long-term interest is present', async () => {
  const title = '哔哩哔哩漫画作品：《”哆哆嗦嗦“逃离你》';
  const first = await exploreRound({
    persona, focusTopic: title, now: 100,
    generate: async () => result({ action: 'start', topic: title, progress: '想到一个伏笔', next: '比较人物动机' }),
  });
  assert.equal(first.state.thread.pinnedOnce, true);

  const matching = await exploreRound({
    persona, previous: first.state, interest: '想继续追 B漫《哆哆嗦嗦逃离你》的连载', now: 200,
    generate: async ({ prompt }) => {
      assert.equal(explorationRunData(prompt).thread.topic, title);
      return result({ action: 'continue', progress: '梳理了人物动机', next: '比较叙事节奏' });
    },
  });
  assert.equal(matching.state.thread.pinnedOnce, true);

  for (const interest of ['', '随便看看有意思的东西', '想了解其他漫画的创作流程']) {
    const independent = await exploreRound({
      persona, previous: matching.state, interest, now: 300,
      generate: async ({ prompt }) => {
        assert.equal(explorationRunData(prompt).thread, null);
        assert.doesNotMatch(prompt, /比较叙事节奏/);
        return result({ action: 'start', topic: '另一个小问题', progress: '换一条线', next: '比较例子' });
      },
    });
    assert.equal(independent.state.thread.topic, '另一个小问题');
    assert.equal(independent.state.thread.pinnedOnce, undefined);
    assert.ok(independent.state.notes.some((entry) => entry.topic === title));
  }

  const task = await exploreRound({
    persona, requestedResearch: { topic: title }, now: 100,
    generate: async () => result({ action: 'start', topic: title, progress: '想到一个伏笔', next: '比较人物动机' }),
  });
  assert.equal(task.state.thread.pinnedOnce, undefined);
});

test('light exploration uses a target site and a clean topic on its first web search', async () => {
  const collected = [];
  const round = await exploreRound({
    persona, interest: '在知乎看看《城市散步地图》', exploreMode: 'light',
    media: { web: true, collect: async (kind, query, options) => {
      collected.push({ kind, query, options });
      return [];
    } },
    generate: async ({ prompt }) => prompt.includes('挑一件简单')
      ? result({ kind: 'web', query: '城市散步地图 路线' })
      : result({ action: 'light', topic: '步行路线', summary: '转角可以连成环线' }),
  });
  assert.equal(round.action, 'light');
  assert.equal(collected.length, 1);
  assert.equal(collected[0].kind, 'web');
  assert.match(collected[0].query, /(?:^|\s)site:zhihu\.com(?:\s|$)/);
  assert.match(collected[0].query, /城市散步地图/);
  assert.doesNotMatch(collected[0].query, /《|》/);
  assert.deepEqual(collected[0].options.preferredSites, ['zhihu.com']);
  assert.equal(collected[0].options.light, true);
  assert.match(collected[0].options.fallbackQuery, /城市散步地图/);
  assert.doesNotMatch(collected[0].options.fallbackQuery, /site:/);
  assert.equal(round.state.lastRun.query, collected[0].options.fallbackQuery);
});

test('an avoided exploration direction yields to a fresh subject without a replacement interest', async () => {
  const old = await exploreRound({
    persona, now: 100, generate: async () => result({
      action: 'start', topic: '插排过载保护', progress: '记了一个断电条件', next: '查漏保型号',
    }),
  });
  const calls = [];
  const round = await exploreRound({
    persona, now: 200, previous: old.state, topicFeedback: { avoid: ['插排过载保护'] },
    media: { web: true, collect: async () => assert.fail('no web search expected') },
    generate: async ({ prompt }) => {
      const data = explorationRunData(prompt);
      calls.push(data);
      assert.deepEqual(data.avoidTopics, ['插排过载保护']);
      assert.equal(data.thread, null);
      assert.doesNotMatch(prompt, /查漏保型号/);
      return calls.length === 1 ? result({ kind: 'none', mode: 'research' }) : result({
        action: 'start', topic: '不可靠叙述者', progress: '想到一个读者故意被误导的例子', next: '对照漏叙的例子',
      });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(round.state.thread.topic, '不可靠叙述者');
});

test('a short named interest can continue its study, but similar Latin spellings cannot', async () => {
  for (const [topic, interest, continues] of [
    ['插排过载保护', '最近想看看插排', true],
    ['Java 泛型', '最近想了解 JavaScript 模块', false],
  ]) {
    const old = await exploreRound({
      persona, now: 100, generate: async () => result({
        action: 'start', topic, progress: '先列出一个问题', next: '再看两个具体例子',
      }),
    });
    const round = await exploreRound({
      persona, now: 200, previous: old.state, interest,
      generate: async ({ prompt }) => {
        assert.equal(explorationRunData(prompt).thread?.topic, continues ? topic : undefined);
        return result({ action: 'skip' });
      },
    });
    assert.equal(round.ok, true);
  }
});

test('multi-source round preserves share via progressSourceIndex when sourceIndex is omitted', async () => {
  const media = {
    web: true,
    collect: async () => [
      { url: 'https://example.org/a', title: '结果A', evidence: '网页正文', content: 'A 正文' },
      { url: 'https://example.org/b', title: '结果B', evidence: '搜索摘要', content: 'B 摘要' },
    ],
  };
  const round = await exploreRound({
    persona,
    media,
    generate: async ({ prompt }) => prompt.includes('替角色选')
      ? result({ mode: 'research', kind: 'web', query: '测试题' })
      : result({
          action: 'start',
          topic: '测试题',
          progress: '读到了 A 正文',
          next: '继续看',
          share: '刚看到结果A里讲了一个有趣的细节。',
          discovery: 'A 正文的关键设定',
          progressSourceIndex: 0,
          sourceIndex: null,
        }),
  });
  assert.equal(round.ok, true);
  assert.equal(round.state.candidate.source.url, 'https://example.org/a');
  assert.match(round.state.candidate.line, /结果A/);
});

test('withholds sourceless web-text speculation thread once media.web is enabled and passes anchor options', async () => {
  const priorSpeculation = {
    personaKey: (await exploreRound({ persona, now: 50, generate: async () => result({ action: 'skip' }) })).state.personaKey,
    lastAt: 100,
    thread: {
      topic: '哔哩哔哩漫画作品：《”哆哆嗦嗦“逃离你》',
      progress: '标题的引号是突破口，像在试探第二人称的语气。',
      next: '想一下以第二人称“你”作对象的标题通常怎么处理。',
      at: 100,
      progressSource: null,
    },
    candidate: null,
  };
  const collectCalls = [];
  const prompts = [];
  const media = {
    web: true,
    collect: async (kind, query, options) => {
      collectCalls.push({ kind, query, options });
      return [{ url: 'https://manga.bilibili.com/m/detail/mc38749', title: '“哆哆嗦嗦”逃离你', evidence: '网页正文', content: '简介：潮玩设计师艾栩与搭档之逸。' }];
    },
  };
  const round = await exploreRound({
    persona,
    previous: priorSpeculation,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now: 200,
    media,
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.includes('替角色选这一轮的方向')) {
        assert.equal(explorationRunData(prompt).thread, null);
        assert.doesNotMatch(prompt, /第二人称“你”/);
        return result({ mode: 'leisure', kind: 'web', query: '哆哆嗦嗦逃离你 第二人称 叙事' });
      }
      assert.match(prompt, /绝不切换到搜索结果里顺带提到的其他作品/);
      return result({
        action: 'start',
        topic: '“哆哆嗦嗦”逃离你',
        progress: '看了漫画简介，主角是潮玩设计师艾栩与搭档之逸。',
        next: '',
        progressSourceIndex: 0,
      });
    },
  });
  assert.equal(round.ok, true);
  assert.equal(prompts.length, 2);
  assert.equal(collectCalls.length, 1);
  assert.equal(collectCalls[0].options.anchorQuery, '哆哆嗦嗦逃离你 site:manga.bilibili.com');
  assert.equal(collectCalls[0].options.anchorKeywords, '哆哆嗦嗦逃离你');
  assert.equal(round.state.leisure.topic, '“哆哆嗦嗦”逃离你');
  assert.equal(round.state.leisure.progressSource.evidence, '网页正文');
});

test('deep continuation with grounded progress (without explicit discovery field) generates a new discoveryId', async () => {
  const media = {
    web: true,
    collect: async () => [{
      url: 'https://manga.bilibili.com/mc38749/1950876',
      title: '001 - “哆哆嗦嗦”逃离你',
      evidence: '网页画面',
      content: '画面观察：第一话分镜里有主角抱着潮玩盒子的特写。',
    }],
  };
  const round = await exploreRound({
    persona,
    interest: '哔哩哔哩漫画：“哆哆嗦嗦”逃离你',
    bias: 'leisure',
    now: 300,
    media,
    generate: async ({ prompt }) => {
      if (prompt.includes('替角色选这一轮的方向')) {
        return result({ mode: 'leisure', kind: 'web', query: '哆哆嗦嗦逃离你' });
      }
      return result({
        action: 'start',
        topic: '《“哆哆嗦嗦”逃离你》',
        progress: '翻到第一话画面，主角开会时全靠 PPT 躲社恐，反差挺逗。',
        next: '',
        share: '刚翻到第一话，社恐设计师拿 PPT 顶例会笑死我了。',
        progressSourceIndex: 0,
        sourceIndex: 0,
      });
    },
  });
  assert.equal(round.ok, true);
  assert.ok(round.state.candidate?.discoveryId, '应由有依据的新 progress 生成 discoveryId，避免被同主题冷却误拦');
  assert.match(round.state.candidate.discovery, /第一话画面/);
});

test('editing persona wording for the same character preserves exploration progress while switching character isolates it', async () => {
  const v1 = { ok: true, text: '## 人格（全局 · AGENT.md）\n# 江小澪 · 全局人格\n- **我 = 江小澪**：喜欢百合、二次元和电气。' };
  const v2 = { ok: true, text: '## 人格（全局 · AGENT.md）\n# 江小澪 · 全局人格\n- **我 = 江小澪**：精简版人设，爱猫系撒娇。' };
  const other = { ok: true, text: '## 人格（全局 · AGENT.md）\n# 林晚 · 全局人格\n- **我 = 林晚**：完全不同的另一个角色。' };

  assert.equal(personaKey(v1), personaKey(v2));
  assert.notEqual(personaKey(v1), personaKey(other));

  const first = await exploreRound({
    persona: v1,
    now: 100,
    generate: async () => result({ action: 'start', topic: '哆哆嗦嗦逃离你', progress: '看到第二话 17p', next: '接着看第二话后半' }),
  });
  assert.equal(first.state.roundCount, 1);

  const second = await exploreRound({
    persona: v2,
    previous: first.state,
    now: 200,
    generate: async ({ prompt }) => {
      assert.match(prompt, /第二话 17p/);
      return result({ action: 'continue', progress: '看完了第二话', next: '开第三话' });
    },
  });
  assert.equal(second.state.roundCount, 2);
  assert.equal(second.state.thread.topic, '哆哆嗦嗦逃离你');
  assert.equal(explorationStatus(second.state, other).thread, null);

  // Legacy full-text SHA-256 personaKey saved before upgrade should still match and migrate seamlessly.
  const legacyState = {
    ...first.state,
    personaKey: createHash('sha256').update(v2.text).digest('hex'),
  };
  assert.equal(explorationStatus(legacyState, v2).thread?.topic, '哆哆嗦嗦逃离你');
  const migrated = await exploreRound({
    persona: v2,
    previous: legacyState,
    now: 300,
    generate: async () => result({ action: 'continue', progress: '兼容迁移后继续推进', next: '继续' }),
  });
  assert.equal(migrated.state.personaKey, personaKey(v2));
  assert.equal(migrated.state.roundCount, 2);
});
