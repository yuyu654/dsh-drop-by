// mood / seed 的硬约束：情绪脱敏、素材互斥、原话抄写拦截、专有名词锁定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toneOf, explorationToneHint } from '../src/explore.js';
import { guard, buildChitchatPrompt } from '../src/compose.js';
import { seedEntities } from '../src/seeds.js';

const RAW = '术语对上了，但人都还没进去，卡在这儿不上不下，有点闷。';

test('toneOf：业务细节全剥掉，只剩情绪', () => {
  assert.equal(toneOf(RAW), '有点闷');
  const s = toneOf('积分 dA/dt=(P/Pth)²−A/τ 的 τ 反解出来了，挺顺');
  assert.doesNotMatch(s, /[0-9A-Za-z]/);
  assert.doesNotMatch(s, /τ|积分|反解/);
});

test('toneOf：整句都是事实时返回空（宁可没有语气）', () => {
  assert.equal(toneOf('视频标题写着热量积累模型加反时限'), '');
  assert.equal(toneOf(''), '');
});

test('explorationToneHint：注入的只有情绪，不带原始业务词', () => {
  const hint = explorationToneHint({ explorationMood: { text: RAW } });
  assert.match(hint, /情绪/);
  for (const w of ['术语', '进去', '不上不下', '积分']) assert.equal(hint.includes(w), false, w);
  assert.equal(explorationToneHint({ explorationMood: { text: '视频标题写着热量积累模型' } }), '');
});

test('guard：照抄 mood 原话 → MOOD_LEAK', () => {
  const g = guard('术语对上了，但人都还没进去，卡在这儿有点闷', {}, { explorationMood: { raw: RAW } });
  assert.equal(g.ok, false);
  assert.ok(g.violations.some((v) => v.code === 'MOOD_LEAK'));
});

test('guard：换个说法（只说自己的感受）不算抄', () => {
  const g = guard('今天有点提不起劲，回来就瘫着。', {}, { explorationMood: { raw: RAW } });
  assert.equal(g.violations.some((v) => v.code === 'MOOD_LEAK'), false);
});

test('seedEntities：书名、引号、本机名字都能标出来', () => {
  const cfg = { content: { local: { names: ['逸遐', '艾栩'] } } };
  const e = seedEntities('看了《“哆哆嗦嗦”逃离你》，艾栩和逸遐那种别扭劲儿', cfg);
  assert.ok(e.includes('《“哆哆嗦嗦”逃离你》'));
  assert.ok(e.includes('逸遐'));
  assert.ok(e.includes('艾栩'));
});

test('buildChitchatPrompt：有种子时不注入 mood，也不塞「最近聊到的」', () => {
  const cfg = { content: {} };
  const ctx = { clock: '10:00', tz: 'Asia/Shanghai', now: Date.now(), her: {}, explorationMood: { text: '有点闷', raw: RAW } };
  const persona = { text: '示例角色' };
  const withSeed = buildChitchatPrompt({
    ctx, cfg, persona,
    topic: { slot: 'chitchat', evidence: { seed: '《某某》看完了', conversation: '她：在改毕设', seedEntities: ['逸遐'] } },
  });
  assert.doesNotMatch(withSeed, /情绪/);
  assert.match(withSeed, /种子里的名字必须照抄：逸遐/);
  assert.doesNotMatch(withSeed, /你们最近聊到的/);

  const noSeed = buildChitchatPrompt({
    ctx, cfg, persona,
    topic: { slot: 'chitchat', evidence: { conversation: '她：在改毕设' } },
  });
  assert.match(noSeed, /情绪/);
  assert.match(noSeed, /你们最近聊到的/);
});