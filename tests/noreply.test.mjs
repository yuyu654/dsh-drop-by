// noreply.test.mjs —— 忙碌时段 + 「我发过去她一直没回」这条追问。
import test from 'node:test';
import assert from 'node:assert/strict';
import { inBusy, lastWindowEnd } from '../src/perception/schedule.js';
import { decide } from '../src/decision/decide.js';
import {
  pickNoReply,
  noReplyDue,
  judgeAway,
  judgePrompt,
  pendingFromFeedback,
  pendingFromDouyin,
} from '../src/chat/noreply.js';
import { pickTopic, explainNoTopic } from '../src/decision/topics.js';
import { renderTemplate } from '../src/decision/compose.js';

const TZ = 'Asia/Shanghai';
/** 北京时间 → UTC 时间戳 */
const at = (mo, d, h, m = 0) => Date.UTC(2026, mo - 1, d, h - 8, m);

const cfgOf = (o = {}) => ({
  timezone: TZ,
  busyHours: o.busyHours ?? [],
  sources: { douyin: { enabled: o.douyinOn ?? true } },
  content: {
    topics: {
      noReply: true,
      noReplyMin: 120,
      noReplyAfterHerMin: 120,
      noReplyAfterBusyMin: 20,
      noReplyDouyin: true,
      followCasualSilence: true,
      noReplyJudge: true,
      ...(o.topics || {}),
    },
    agenda: { text: '', termStart: '', periods: '', off: [] },
    exams: { text: '' },
  },
  idle: { onlineSec: 30, awaySec: 600 },
  rules: { replyCooldownMin: 5, minGapMin: 240, dailyCap: 3 },
});

const ctxOf = (o = {}) => ({
  tz: TZ,
  her: { lastTs: o.herTs ?? null, lastText: o.herText ?? '', lastAgoSec: null },
  me: { lastTs: null, lastText: '', lastAgoSec: null },
  fish: { ok: false },
  presence: { idleSec: 10 },
  recent: o.recent ?? [],
  noReply: o.noReply ?? null,
});

// ---------------------------------------------------------------- 忙碌时段

test('忙碌时段：多段、跨零点、空数组=不忙', () => {
  const now = at(11, 5, 10, 30);
  assert.equal(inBusy(now, [], TZ), false);
  assert.equal(inBusy(now, [['09:00', '12:00']], TZ), true);
  assert.equal(inBusy(now, [['13:00', '15:00']], TZ), false);
  // 跨零点：23:00–07:00 的凌晨那一头也算
  assert.equal(inBusy(at(11, 5, 2, 0), [['23:00', '07:00']], TZ), true);
  assert.equal(inBusy(at(11, 5, 12, 0), [['23:00', '07:00']], TZ), false);
});

test('忙碌时段结束的时间点：今天最近一次结束', () => {
  const now = at(11, 5, 13, 0);
  const end = lastWindowEnd(now, [['09:00', '12:00']], TZ);
  assert.equal(end, at(11, 5, 12, 0));
  // 还没经历过任何一段 → 0
  assert.equal(lastWindowEnd(at(11, 5, 8, 0), [['09:00', '12:00']], TZ), 0);
  assert.equal(lastWindowEnd(now, [], TZ), 0);
});

test('decide：忙碌时段压住主动，但压不住回复', () => {
  const now = at(11, 5, 10, 30);
  const base = {
    cfg: cfgOf(),
    now,
    idleSec: 10,
    quiet: false,
    busy: true,
    lastUserTs: null,
    lastUserChannel: null,
    lastSendTs: null,
    todaySent: 0,
    allDown: false,
  };
  const d = decide(base);
  assert.equal(d.decision, 'skip');
  assert.equal(d.reason, 'BUSY_HOURS');
  // 她说话了、过了冷却 → 照常回
  const r = decide({ ...base, lastUserTs: now - 10 * 60_000 });
  assert.equal(r.track, 'reply');
  assert.equal(r.decision, 'send');
});

// ---------------------------------------------------------------- 挑候选

const stateOf = (o = {}) => ({
  feedback: { pending: o.pending ?? [], catch: [], streak: 0 },
  content: {},
  noReply: o.noReply ?? null,
});

test('QQ 侧：够久的 pending 才算，太新的不动', () => {
  const now = at(11, 5, 20);
  const fresh = stateOf({ pending: [{ slot: 'share', ts: now - 30 * 60_000, text: '新发的' }] });
  assert.equal(pendingFromFeedback(fresh, cfgOf(), now), null);
  const old = stateOf({ pending: [{ slot: 'share', ts: now - 200 * 60_000, text: '那条' }] });
  const c = pendingFromFeedback(old, cfgOf(), now);
  assert.equal(c.channel, 'qq');
  assert.equal(c.silenceMin, 200);
  assert.equal(c.text, '那条');
});

test('抖音侧：插件关着 / 开关关着就不参与；她之后说过话也不算没回', () => {
  const now = at(11, 5, 20);
  const out = { ts: now - 300 * 60_000, channel: 'douyin' };
  assert.equal(pendingFromDouyin({ cfg: cfgOf({ douyinOn: false }), now, herTs: null, lastOut: out }), null);
  assert.equal(pendingFromDouyin({ cfg: cfgOf({ topics: { noReplyDouyin: false } }), now, herTs: null, lastOut: out }), null);
  assert.equal(pendingFromDouyin({ cfg: cfgOf(), now, herTs: now - 60 * 60_000, lastOut: out }), null);
  const c = pendingFromDouyin({ cfg: cfgOf(), now, herTs: null, lastOut: out });
  assert.equal(c.channel, 'douyin');
  assert.equal(c.silenceMin, 300);
});

test('抖音侧：她在抖音回过了就不再追问（QQ 的旧时间戳不能代替）', () => {
  const now = at(11, 5, 20);
  const out = { ts: now - 300 * 60_000, channel: 'douyin' };
  // QQ 上她最后一句比分享还早 —— 只看 herTs 会误判「没回」，实际她在抖音已经回过
  const herQq = now - 400 * 60_000;
  assert.equal(pendingFromDouyin({ cfg: cfgOf(), now, herTs: herQq, lastOut: out, herOnDouyin: now - 200 * 60_000 }), null);
  // 她在抖音回的那句在分享之前 → 仍然该问
  const c = pendingFromDouyin({ cfg: cfgOf(), now, herTs: herQq, lastOut: out, herOnDouyin: now - 600 * 60_000 });
  assert.equal(c.channel, 'douyin');
});

test('两条都有时挑离现在更近的那条', () => {
  const now = at(11, 5, 20);
  const st = stateOf({ pending: [{ slot: 'reply', ts: now - 400 * 60_000, text: 'QQ 那条' }] });
  const douyinOut = { ts: now - 200 * 60_000 };
  const c = pickNoReply({ st, cfg: cfgOf(), now, herTs: null, douyinOut });
  assert.equal(c.channel, 'douyin');
});

test('默认忽略没有回复的分享、问候和 QQ 闲聊', () => {
  const now = at(11, 5, 20);
  const ts = now - 300 * 60_000;
  const st = stateOf({ pending: ['share', 'chitchat', 'backHome', 'catchup', 'noReply']
    .map((slot) => ({ slot, ts, text: '普通消息' })) });
  const cfg = cfgOf({ topics: { followCasualSilence: false } });
  assert.equal(pickNoReply({ st, cfg, now, douyinOut: { ts } }), null);
  st.feedback.pending.push({ slot: 'agenda', ts: ts + 1, text: '课表提醒' });
  assert.equal(pickNoReply({ st, cfg, now })?.slot, 'agenda');
});

test('只追问一次：先筛掉已追问的消息和更早的积压，再挑最新候选', () => {
  const now = at(11, 5, 20);
  const ts = now - 300 * 60_000;
  const st = stateOf({ pending: [
    { slot: 'agenda', ts: ts + 3, draft: '新的提醒' },
    { slot: 'agenda', ts, draft: '更早的提醒' },
    { slot: 'steps', ts: ts + 4, draft: '低步数提醒' },
    { slot: 'noReply', ts: ts + 2, draft: '先前追问' },
    { slot: 'agenda', ts: ts + 1, draft: '已经追过' },
  ] });
  st.content.lastNoReplyFor = 'qq:' + (ts + 1);
  assert.equal(pickNoReply({ st, cfg: cfgOf(), now })?.text, '新的提醒');
  assert.equal(pickNoReply({ st, cfg: cfgOf(), now, herTs: ts + 4 }), null);
  st.feedback.pending.shift();
  assert.equal(pickNoReply({ st, cfg: cfgOf(), now, douyinOut: { ts } }), null);
});

// ---------------------------------------------------------------- 时间规则

test('追问时间：她刚说完 → 还要再等她那条；忙/睡的等她忙完再等 20 分钟', () => {
  const now = at(11, 5, 20);
  const cand = { channel: 'qq', at: now - 300 * 60_000, silenceMin: 300, text: '在吗' };

  // 她 30 分钟前说过话 → 压住
  const g1 = noReplyDue({ cand, cfg: cfgOf(), now, herTs: now - 30 * 60_000, tz: TZ });
  assert.equal(g1.ok, false);
  assert.match(g1.why, /才说过话/);

  // 不是忙 → 直接放行
  assert.equal(noReplyDue({ cand: { ...cand, verdict: { away: false } }, cfg: cfgOf(), now, herTs: null, tz: TZ }).ok, true);

  // 判断忙到 21:30 → 21:50 之后才问
  const away = { ...cand, verdict: { away: true, untilHm: '21:30' } };
  const g2 = noReplyDue({ cand: away, cfg: cfgOf(), now, herTs: null, tz: TZ });
  assert.equal(g2.ok, false);
  assert.equal(g2.dueAt, at(11, 5, 21, 50));
  assert.equal(noReplyDue({ cand: away, cfg: cfgOf(), now: at(11, 5, 21, 55), herTs: null, tz: TZ }).ok, true);
});

test('追问时间：忙碌时段结束 20 分钟后才可以问（比模型给的 until 更晚就按更晚的）', () => {
  const now = at(11, 5, 12, 10);
  const cand = {
    channel: 'qq',
    at: now - 300 * 60_000,
    silenceMin: 300,
    text: '',
    verdict: { away: true, untilHm: null },
  };
  const g = noReplyDue({ cand, cfg: cfgOf({ busyHours: [['09:00', '12:00']] }), now, herTs: null, tz: TZ });
  assert.equal(g.ok, false);
  assert.equal(g.dueAt, at(11, 5, 12, 20));
  assert.equal(
    noReplyDue({ cand, cfg: cfgOf({ busyHours: [['09:00', '12:00']] }), now: at(11, 5, 12, 25), herTs: null, tz: TZ }).ok,
    true
  );
});

// ---------------------------------------------------------------- 模型判断

test('judgeAway：读到 JSON 就用它；读不懂/没开模型一律当「不是忙」', async () => {
  const cand = { channel: 'qq', at: at(11, 5, 17), silenceMin: 180, text: '那条' };
  const ctx = ctxOf({ herTs: at(11, 5, 16), herText: '等下说' });

  const ok = await judgeAway({
    cand,
    ctx,
    cfg: cfgOf(),
    now: at(11, 5, 20),
    tz: TZ,
    generate: async () => ({ ok: true, text: '{"away": true, "until": "21:30", "why": "在赶作业"}' }),
  });
  assert.deepEqual({ away: ok.away, untilHm: ok.untilHm }, { away: true, untilHm: '21:30' });

  const bad = await judgeAway({
    cand,
    ctx,
    cfg: cfgOf(),
    now: at(11, 5, 20),
    tz: TZ,
    generate: async () => ({ ok: true, text: '我觉得她在忙' }),
  });
  assert.equal(bad.away, false);

  let called = 0;
  const off = await judgeAway({
    cand,
    ctx,
    cfg: cfgOf(),
    now: at(11, 5, 20),
    tz: TZ,
    llmReady: false,
    generate: async () => {
      called++;
      return { ok: true, text: '{}' };
    },
  });
  assert.equal(called, 0);
  assert.equal(off.away, false);
});

test('judgePrompt：把我那条、她最后一句、最近对话、忙碌时段都给到，要求只输出 JSON', () => {
  const cand = { channel: 'qq', at: at(11, 5, 17), silenceMin: 180, text: '晚上吃啥' };
  const ctx = ctxOf({
    herTs: at(11, 5, 16),
    herText: '我今晚有课',
    recent: [{ from: 'me', text: '晚上吃啥' }, { from: 'her', text: '我今晚有课' }],
  });
  const p = judgePrompt({ cand, ctx, cfg: cfgOf({ busyHours: [['09:00', '12:00']] }), now: at(11, 5, 20), tz: TZ });
  assert.match(p, /晚上吃啥/);
  assert.match(p, /我今晚有课/);
  assert.match(p, /09:00-12:00/);
  assert.match(p, /只输出一行 JSON/);
});

// ---------------------------------------------------------------- 由头

test('由头：够久没回 → noReply（QQ）；同一条只问一次；能关掉', () => {
  const now = at(11, 5, 20);
  const ctx = ctxOf({
    noReply: { channel: 'qq', at: now - 300 * 60_000, silenceMin: 300, text: '在吗', key: 'qq:1', verdict: { away: false } },
  });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'noReply');
  // 只说「到现在没回」，不再报精确分钟（报 300 分钟像在数着日子）
  assert.match(t.brief, /到现在没回/);
  assert.doesNotMatch(t.brief, /\d+ 分钟/);
  assert.equal(renderTemplate(t, ctx), '那条你还没回我。……在忙，还是睡了。');

  const again = pickTopic(ctx, cfgOf(), now, { content: { lastNoReplyFor: 'qq:1' } });
  assert.notEqual(again?.slot, 'noReply');

  const off = pickTopic(ctx, cfgOf({ topics: { noReply: false } }), now, {});
  assert.notEqual(off?.slot, 'noReply');
});

test('由头：抖音分享那条走另一句模板；她刚说完话不放行，并在 --why 里说清原因', () => {
  const now = at(11, 5, 20);
  const ctx = ctxOf({
    herTs: now - 30 * 60_000,
    noReply: { channel: 'douyin', at: now - 300 * 60_000, silenceMin: 300, text: '', key: 'douyin:1', verdict: null },
  });
  assert.notEqual(pickTopic(ctx, cfgOf(), now, {})?.slot, 'noReply');
  const reasons = explainNoTopic(ctx, cfgOf(), now, {});
  assert.ok(reasons.some((r) => /追问还不到时候/.test(r)), reasons.join('\n'));

  // 过了她那条 2 小时的门槛就能问
  const later = at(11, 5, 22, 30);
  const t = pickTopic({ ...ctx, her: { ...ctx.her, lastTs: now - 30 * 60_000 } }, cfgOf(), later, {});
  assert.equal(t.slot, 'noReply');
  // 模板不写时间词（看不出真实间隔），但必须说清是抖音那条（2026-11-07 修）
  assert.equal(renderTemplate(t, ctx), '在抖音给你发的那个，看了没。');
});

test('等用户发图本身不能支持到点追问', async () => {
  const now = at(11, 5, 20);
  const cand = { channel: 'qq', at: now - 180 * 60_000, silenceMin: 180, text: '改好了发图，我等你' };
  const verdict = await judgeAway({ cand, cfg: cfgOf(), now, tz: TZ,
    ctx: { her: { lastText: '好，我改好给你' } },
    generate: async () => ({ ok: true, text: '{"away":false,"until":null,"followUp":false}' }),
  });
  assert.equal(noReplyDue({ cand: { ...cand, verdict }, cfg: cfgOf(), now, tz: TZ }).ok, false);
});

test('用户明确约了提醒时，才接受引用实际约定的追问判断', async () => {
  const now = at(11, 5, 20);
  const cand = { channel: 'qq', at: now - 180 * 60_000, silenceMin: 180, text: '好，到时叫你' };
  const ctx = { her: { lastText: '晚点提醒我交一下作业' } };
  for (const [quote, expected] of [['晚点提醒我交一下作业', true], ['改完催我发图', false]]) {
    const verdict = await judgeAway({ cand, ctx, cfg: cfgOf(), now, tz: TZ,
      generate: async () => ({ ok: true, text: JSON.stringify({ away: false, followUp: true, quote }) }),
    });
    assert.equal(noReplyDue({ cand: { ...cand, verdict }, cfg: cfgOf(), now, tz: TZ }).ok, expected);
  }
});
