// coarse-time.test.mjs —— 2026-11-07 她提的两件事：
// ①「你那 144 分钟是在写代码吧」太精确，像在监视 → 时间一律说大概；
// ②「忙完了把那条视频点开看一眼」她不知道是哪条 → 提到我发过的东西必须带标题。
import test from 'node:test';
import assert from 'node:assert/strict';
import { coarseAgo, buildPrompt, renderTemplate } from '../src/compose.js';
import { pickTopic } from '../src/topics.js';

const cfgOf = (o = {}) => ({ content: { mode: 'llm', maxChars: 60, ...o } });
const topicOf = (slot, evidence = {}) => ({ slot, label: slot, why: '', evidence, brief: `由头 ${slot}`, at: Date.now() });
const ctxOf = (o = {}) => ({
  tz: 'Asia/Shanghai',
  clock: '22:17',
  presence: { idleSec: 0 },
  her: { lastTs: null, lastText: '', lastAgoSec: 600 },
  me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
  fish: { ok: false },
  recent: [],
  ...o,
});

test('coarseAgo：程度都压到人话粒度——一小时以内一律「刚刚」', () => {
  // 2026-11-07 她补的一条：几分钟前也嫌掐表，「刚刚」就够；
  // 一小时没回，聊天里问的是「你刚才在忙啥」，不是「一个小时前你在干嘛」。
  assert.equal(coarseAgo(0), '刚刚');
  assert.equal(coarseAgo(5), '刚刚');
  assert.equal(coarseAgo(20), '刚刚');
  assert.equal(coarseAgo(45), '刚刚');
  assert.equal(coarseAgo(59), '刚刚');
  assert.equal(coarseAgo(60), '有一阵子了');
  assert.equal(coarseAgo(144), '有一阵子了');
  assert.equal(coarseAgo(400), '今天早些时候');
  assert.equal(coarseAgo(1500), '昨天');
  assert.equal(coarseAgo(4000), '前几天');
  assert.equal(coarseAgo(undefined), '刚刚');
  for (const m of [0, 5, 45, 144, 400, 1500, 4000]) assert.doesNotMatch(coarseAgo(m), /\d/);
});

test('prompt：她最后一条的时间说大概，不报精确分钟', () => {
  const p = buildPrompt({
    ctx: ctxOf({ her: { lastTs: 1, lastText: '刚下课', lastAgoSec: 144 * 60 } }),
    topic: topicOf('share'),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /刚下课」/);
  assert.doesNotMatch(p, /144 分钟/);
  assert.match(p, /有一阵子了/);
});

test('prompt：时间粒度只在追问时放宽，且不写成套话', () => {
  const p = buildPrompt({ ctx: ctxOf(), topic: topicOf('noReply', { channel: 'qq', silenceMin: 144 }), persona: { text: '' }, cfg: cfgOf() });
  // 规则里只讲原则：平常别说精确时间，真要问她时才用；不塞例句（她会照着套）
  assert.match(p, /平常报出来像盯梢/);
  assert.match(p, /固定句式/);
  assert.doesNotMatch(p, /刚刚你在干嘛/);
  assert.doesNotMatch(p, /144 分钟/);
});

test('prompt：追问分享卡片要带标题，不许只说「那条视频」', () => {
  const p = buildPrompt({
    ctx: ctxOf(),
    topic: topicOf('noReply', {
      channel: 'douyin',
      kind: 'card',
      item: '7704617393389194511',
      title: '梁圣开源超级Agent架构',
      silenceMin: 144,
    }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /我给她分享了一个视频《梁圣开源超级Agent架构》/);
  assert.match(p, /有一阵子了/);
  assert.doesNotMatch(p, /144 分钟/);
  // 硬性要求里写明：提到发过的东西要带标题
  assert.match(p, /提到我发过的东西/);
  assert.match(p, /别只说「那条视频」/);
});

test('prompt：卡片没有标题时，明确禁止拿「那条视频」指代', () => {
  const p = buildPrompt({
    ctx: ctxOf(),
    topic: topicOf('noReply', { channel: 'douyin', kind: 'card', silenceMin: 30 }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /这条分享的标题我没记住/);
  assert.match(p, /别提「那条视频」/);
});

test('prompt：抖音上发的普通文字也把原话带上，不写成「一个视频」', () => {
  const p = buildPrompt({
    ctx: ctxOf(),
    topic: topicOf('noReply', { channel: 'douyin', kind: 'text', text: '这段代码你写得完吗', silenceMin: 200 }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /我给她发了一条：「这段代码你写得完吗」/);
  assert.doesNotMatch(p, /分享了一个视频/);
});

test('由头：抖音分享的 brief 带标题，不再数分钟', () => {
  const now = Date.now();
  const ctx = ctxOf({
    noReply: {
      channel: 'douyin',
      kind: 'card',
      item: '7699694307528512474',
      title: '迎着阳光 盛大逃亡',
      at: now - 144 * 60_000,
      silenceMin: 144,
      key: 'douyin:1',
      verdict: { away: false },
    },
  });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'noReply');
  assert.match(t.brief, /视频《迎着阳光 盛大逃亡》/);
  assert.doesNotMatch(t.brief, /\d+ 分钟/);
  assert.equal(t.evidence.title, '迎着阳光 盛大逃亡');
  assert.equal(t.evidence.item, '7699694307528512474');
  assert.equal(t.evidence.kind, 'card');
});
test('模板：抖音追问带标题；没标题才退回「那个」', () => {
  const withTitle = renderTemplate(topicOf('noReply', { channel: 'douyin', kind: 'card', title: '梁圣开源超级Agent架构' }), ctxOf());
  assert.equal(withTitle, '在抖音给你发的《梁圣开源超级Agent架构》，看了没。');
  const noTitle = renderTemplate(topicOf('noReply', { channel: 'douyin', kind: 'card' }), ctxOf());
  assert.equal(noTitle, '在抖音给你发的那个，看了没。');
  const long = renderTemplate(topicOf('noReply', { channel: 'douyin', kind: 'card', title: '一二三四五六七八九十一二三四五六七八九十' }), ctxOf());
  assert.match(long, /…》/);
});
