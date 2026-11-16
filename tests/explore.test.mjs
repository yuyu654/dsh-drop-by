import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreRound, explorationProgress, explorationShare, explorationMood, explorationToneHint, styleApprovedDraft } from '../src/explore.js';

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
