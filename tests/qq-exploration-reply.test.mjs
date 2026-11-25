import test from 'node:test';
import assert from 'node:assert/strict';
import { qqReplyContext } from '../src/chat/qq-reply.js';
import { exploreRound } from '../src/explore/explore.js';

test('QQ reply gets relevant exploration context only for the configured private contact', async () => {
  const persona = { ok: true, text: '喜欢推理' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mood: true } };
  const at = 1_000_000;
  const { state } = await exploreRound({ persona, now: at, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '推理短篇', progress: '想到一个反例',
      next: '再试一遍', mood: '有点得意' }),
  }) });
  const input = { kind: 'private', peer: '42', cfg, state, persona, now: at + 1000 };
  const context = qqReplyContext(input);
  assert.match(context, /推理短篇/);
  assert.match(context, /有点得意/);
  assert.match(context, /优先接住这次 QQ 消息/);
  assert.doesNotMatch(qqReplyContext({ ...input, now: at + 7_200_000 }), /有点得意/);
  assert.equal(qqReplyContext({ ...input, kind: 'group' }), '');
  assert.equal(qqReplyContext({ ...input, peer: '43' }), '');
  assert.equal(qqReplyContext({ ...input, persona: { ok: true, text: '另一角色' } }), '');
});

test('QQ 背景里的「当前感受」只留情绪，不把探索的业务词带进私聊', async () => {
  const persona = { ok: true, text: '喜欢推理' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mood: true } };
  const at = 2_000_000;
  const { state } = await exploreRound({ persona, now: at, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '推理短篇', progress: '想到一个反例',
      next: '再试一遍', mood: '术语对上了，但人都还没进去，卡在这儿不上不下，有点闷。' }),
  }) });
  const context = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: at + 1000 });
  assert.match(context, /有点闷/);
  for (const w of ['术语', '不上不下']) assert.equal(context.includes(w), false, w);
});

test('QQ reply omits heavy exploration JSON blocks on minimal replies like 好', async () => {
  const persona = { ok: true, text: '喜欢推理' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mood: true } };
  const at = 3_000_000;
  const { state } = await exploreRound({ persona, now: at, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '长篇漫画《示例》', progress: '详细分析人物关系和分镜节奏',
      next: '接下来分析第二话', mood: '有点得意' }),
  }) });
  const minimal = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: at + 1000, text: '好' });
  assert.doesNotMatch(minimal, /研究进展|休闲发现|详细分析/);
  assert.match(minimal, /有点得意/);
  const full = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: at + 1000, text: '那部漫画后来怎样了' });
  assert.match(full, /研究进展/);
  assert.doesNotMatch(full, /接下来分析第二话/);
});

test('QQ 背景按相关性懒加载：超过热窗口的普通闲聊只给极简索引，命中关键词或追问词时展开详情', async () => {
  const persona = { ok: true, text: '喜欢百合漫画' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mode: 'deep', mood: true } };
  const at = 4_000_000;
  const { state } = await exploreRound({
    persona,
    now: at,
    bias: 'leisure',
    includeMood: true,
    generate: async () => ({
      ok: true,
      text: JSON.stringify({
        action: 'start',
        topic: '《“哆哆嗦嗦”逃离你》',
        progress: '艾栩嘴上答应挪工位，之逸反倒先紧张了。',
        next: '看第002话',
        mood: '有点想笑',
      }),
    }),
  });
  const later = at + 2 * 3_600_000; // 2 小时后，已过 30 分钟热窗口
  // 普通日常闲聊：不展开详细进展，只留极简「近期关注」
  const casual = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: later, text: '中午吃什么呀' });
  assert.match(casual, /近期关注/);
  assert.doesNotMatch(casual, /休闲发现|艾栩嘴上答应/);

  // 命中探索关键词：展开完整进展
  const hitKeyword = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: later, text: '艾栩后来怎么样了' });
  assert.match(hitKeyword, /休闲发现/);
  assert.match(hitKeyword, /艾栩嘴上答应/);

  // 命中追问/要链接词：展开完整进展
  const hitAsk = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: later, text: '把链接发我一下' });
  assert.match(hitAsk, /休闲发现/);
  assert.match(hitAsk, /只有用户明确索要链接/);
});
