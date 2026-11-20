// chitchat.test.mjs —— 随口说话（阶段 1）：没有由头时那一条候选的产出条件与生成纪律。
import test from 'node:test';
import assert from 'node:assert/strict';
import { chitchatGate, chitchatTopic, noteChitchatSent, chitchatToday, chitchatYield, chitchatJudgeNo, allowBareToday, bareRemainingToday, bareLimit } from '../src/chitchat.js';
import { REASONS } from '../src/decide.js';
import { compose, composeDraft, guard, buildChitchatPrompt } from '../src/compose.js';
import { buildSnapshot } from '../src/snapshot.js';
import { noteSent, settle, sweep, slotStats } from '../src/feedback.js';
import { SCHEMA, applyChange } from '../src/settings.js';

const TZ = 'Asia/Shanghai';
const HOUR = 3_600_000;
const DAY = 86_400_000;
// 北京 2026-11-06 12:00
const NOON = Date.UTC(2026, 10, 6, 4, 0);

const cfgOf = (over = {}) => ({
  timezone: TZ,
  rules: {
    replyCooldownMin: 5,
    judge: { enabled: true },
    feedback: { enabled: true },
    chitchat: { enabled: true, perDay: 3, dayStart: 480, dayEnd: 1410, maxChars: 40 },
    ...(over.rules || {}),
  },
  content: { maxChars: 60, mode: 'auto', llm: { attempts: 2 } },
  ...over,
});

const ctxOf = (over = {}) => ({ clock: '12:00', tz: TZ, her: {}, recentOutbound: [], ...over });

test('关着的时候不产出候选，也不往 --why 里写噪音', () => {
  const g = chitchatGate({ cfg: cfgOf({ rules: { judge: { enabled: true }, chitchat: { enabled: false } } }), now: NOON, st: {}, ctx: ctxOf(), tz: TZ });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'CHITCHAT_OFF');
  assert.equal(g.silent, true);
});

test('judge 没开就不许放开：没有软决策层不能裸奔', () => {
  const g = chitchatGate({ cfg: cfgOf({ rules: { judge: { enabled: false }, chitchat: { enabled: true } } }), now: NOON, st: {}, ctx: ctxOf(), tz: TZ });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'CHITCHAT_NO_JUDGE');
  assert.ok(!g.silent);
});

test('每天 3 条：用满就不再产出，跨天自动归零', () => {
  const cfg = cfgOf();
  const st = { chitchat: { day: '2026-11-06', count: 3, recentSeeds: [] } };
  const g = chitchatGate({ cfg, now: NOON, st, ctx: ctxOf(), tz: TZ });
  assert.equal(g.reason, 'NO_CHITCHAT_BUDGET');
  // 第二天：计数已经不认了（day 不同），于是能产
  const next = chitchatGate({ cfg, now: NOON + DAY, st, ctx: ctxOf(), tz: TZ });
  assert.equal(next.ok, true);
  assert.equal(next.state.count, 0);
});

test('时段：凌晨一律不说，08:00–23:30 之间才行', () => {
  const cfg = cfgOf();
  const at = (h, m = 0) => Date.UTC(2026, 10, 6, h - 8, m); // 北京 h 点 → UTC
  assert.equal(chitchatGate({ cfg, now: at(2), st: {}, ctx: ctxOf(), tz: TZ }).reason, 'NO_CHITCHAT_WINDOW');
  assert.equal(chitchatGate({ cfg, now: at(6, 59), st: {}, ctx: ctxOf(), tz: TZ }).reason, 'NO_CHITCHAT_WINDOW');
  assert.equal(chitchatGate({ cfg, now: at(7, 59), st: {}, ctx: ctxOf(), tz: TZ }).reason, 'NO_CHITCHAT_WINDOW');
  assert.equal(chitchatGate({ cfg, now: at(8), st: {}, ctx: ctxOf(), tz: TZ }).ok, true);
  // 睡着时段用回退值 23:00–07:00（这里没喂 rest），所以 23:00 起就不说了
  assert.equal(chitchatGate({ cfg, now: at(22, 59), st: {}, ctx: ctxOf(), tz: TZ }).ok, true);
  assert.equal(chitchatGate({ cfg, now: at(23, 0), st: {}, ctx: ctxOf(), tz: TZ }).reason, 'NO_CHITCHAT_WINDOW');
});

test('她刚说完、还在回复等待窗口里：不抢答', () => {
  const cfg = cfgOf();
  const her = { lastTs: NOON - 2 * 60_000, lastText: '嗯' };
  const g = chitchatGate({ cfg, now: NOON, st: {}, ctx: ctxOf({ her }), tz: TZ });
  assert.equal(g.reason, 'CHITCHAT_REPLY_PENDING');
  // 过了等待窗口就行
  const g2 = chitchatGate({ cfg, now: NOON, st: {}, ctx: ctxOf({ her: { lastTs: NOON - 10 * 60_000 } }), tz: TZ });
  assert.equal(g2.ok, true);
});

test('候选长什么样：slot/label/字数上限都在，优先级靠「别的由头挑不出来」保证', () => {
  const t = chitchatTopic(cfgOf());
  assert.equal(t.slot, 'chitchat');
  assert.equal(t.label, '随口说一句');
  assert.equal(t.evidence.maxChars, 40);
  assert.equal(t.evidence.allowBare, false);
});

test('计数只在真发出去时加：跨天从零算', () => {
  const st = {};
  noteChitchatSent(st, NOON, TZ);
  noteChitchatSent(st, NOON + 60_000, TZ);
  assert.equal(chitchatToday(st, NOON + 120_000, TZ).count, 2);
  assert.equal(chitchatToday(st, NOON + DAY, TZ).count, 0);
});

test('没有模型就不发，绝不拿模板兜底', async () => {
  const r = await compose({ ctx: ctxOf({ now: NOON }), topic: chitchatTopic(cfgOf()), persona: null, cfg: cfgOf(), now: NOON, st: {}, llmReady: false });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CHITCHAT_NO_MODEL');
});

test('模型只会写「在吗」：打回重写，两次都退就这一拍不发', async () => {
  let calls = 0;
  const gen = async () => {
    calls += 1;
    return { ok: true, text: '在吗', ms: 1 };
  };
  const r = await compose({ ctx: ctxOf({ now: NOON }), topic: chitchatTopic(cfgOf()), persona: null, cfg: cfgOf(), now: NOON, st: {}, generate: gen, llmReady: true });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'CHITCHAT_GUARD_REJECTED');
  assert.equal(calls, 2);
  assert.equal(r.text, undefined); // 没有任何模板文本掉出来
});

test('写得具体就发：走 llm，字数落在随口话的上限里', async () => {
  const gen = async () => ({ ok: true, text: '饮水机那桶水是不是又没了，你路过顺手换一下嘛。', ms: 1 });
  const r = await compose({ ctx: ctxOf({ now: NOON }), topic: chitchatTopic(cfgOf()), persona: null, cfg: cfgOf(), now: NOON, st: {}, generate: gen, llmReady: true });
  assert.equal(r.ok, true);
  assert.equal(r.slot, 'chitchat');
  assert.ok(r.text.length <= 40);
});

test('guard：随口话超 40 字算违规，普通由头不受影响', () => {
  const long = '今天下午我在楼下看见那家店换了招牌，颜色跟以前完全不一样，你上次说想去看看的那家。';
  const g = guard(long, cfgOf(), null, { maxChars: 40, bare: true });
  assert.ok(g.violations.some((v) => v.code === 'TOO_LONG'));
  const g2 = guard(long, cfgOf(), null, {});
  assert.equal(g2.ok, true);
});

test('测试期：发出去的只留痕、不进分母、不动 streak，也不判没接住', () => {
  const st = {};
  noteSent(st, 'chitchat', NOON, '那个水你换了没', { test: true });
  assert.equal(st.feedback.streak, 0);
  assert.equal(st.feedback.slots.chitchat, undefined);
  // 她回了：配一对留着看，但没有统计
  settle(st, NOON + 10 * 60_000, NOON + 11 * 60_000, '换啦');
  assert.equal(st.feedback.testPairs.length, 1);
  assert.equal(st.feedback.testPairs[0].herReply, '换啦');
  assert.equal(slotStats(st).chitchat, undefined);
  // 她没回：sweep 也不判 miss
  const st2 = {};
  noteSent(st2, 'chitchat', NOON, '在忙？', { test: true });
  const judged = sweep(st2, NOON + 5 * HOUR, { tz: TZ, canJudge: true });
  assert.equal(judged, 0);
  assert.equal(st2.feedback.pending.length, 1);
  assert.equal(slotStats(st2).chitchat, undefined);
});

test('非测试期照旧：没回就是没接住', () => {
  const st = {};
  noteSent(st, 'sleep', NOON, '昨晚只睡了五个小时。');
  assert.equal(st.feedback.streak, 1);
  assert.equal(slotStats(st).sleep.sent, 1);
});
function buildPromptFor(topic, cfg) {
  return buildChitchatPrompt({
    ctx: { clock: '20:00', tz: TZ, now: NOON, styleSamples: [] },
    topic,
    persona: { text: '人格' },
    cfg,
    st: {},
  });
}

test('睡着时段从鱼鱼数据来：她睡到 09:00，08:00 也不说', () => {
  const cfg = cfgOf();
  const at = (h, m = 0) => Date.UTC(2026, 10, 6, h - 8, m);
  const rest = { from: 'history', nights: 5, bedMin: 60, wakeMin: 540, startMin: 30, endMin: 570 };
  assert.equal(chitchatGate({ cfg, now: at(8), st: {}, ctx: ctxOf(), tz: TZ, rest }).reason, 'NO_CHITCHAT_WINDOW');
  assert.equal(chitchatGate({ cfg, now: at(9, 40), st: {}, ctx: ctxOf(), tz: TZ, rest }).ok, true);
});

test('随口话的 prompt：起点写成「素材，不是任务」，有起点时不再塞最近聊到哪', () => {
  const cfg = cfgOf();
  const topic = chitchatTopic(cfg, {
    seed: '停电只证明了拉了这个开关',
    seedId: 'm:abc',
    conversation: '她 20 分钟前说：「今天好累」',
  });
  const prompt = buildPromptFor(topic, cfg);
  assert.match(prompt, /这一句的起点（是素材，不是任务）：停电只证明了拉了这个开关/);
  assert.match(prompt, /素材/);
  // 素材互斥：一拍只有一个锚点，种子在就不给「最近聊到的」
  assert.doesNotMatch(prompt, /你们最近聊到的：/);

  const noSeed = buildPromptFor(chitchatTopic(cfg, { conversation: '她 20 分钟前说：「今天好累」' }), cfg);
  assert.match(noSeed, /你们最近聊到的：她 20 分钟前说：「今天好累」/);
});

test('任务书里的四个被拦码都在：名字一致、都有解释', () => {
  for (const code of ['NO_CHITCHAT_BUDGET', 'NO_CHITCHAT_WINDOW', 'CHITCHAT_LOW_PRIORITY', 'CHITCHAT_JUDGE_NO']) {
    assert.ok(REASONS[code] && REASONS[code].length > 0, code);
  }
});

test('让位 / 模型否掉都只记一笔账，不碰判定', () => {
  const y = chitchatYield('reply');
  assert.equal(y.reason, 'CHITCHAT_LOW_PRIORITY');
  assert.match(y.why, /reply/);
  assert.equal(chitchatJudgeNo('她在忙').reason, 'CHITCHAT_JUDGE_NO');
  assert.equal(chitchatJudgeNo('她在忙').why, '她在忙');
  assert.equal(chitchatJudgeNo('').why, '模型说这一拍不说');
});

test('全局静默里随口话也不说：不说时段跟着静默走，不是另写死一段 00:00–07:00', () => {
  const cfg = { ...cfgOf(), quietHours: [['22:30', '07:30']] };
  const late = Date.UTC(2026, 10, 6, 15, 30); // 北京 23:30
  const g = chitchatGate({ cfg, now: late, st: {}, ctx: ctxOf(), tz: TZ });
  assert.equal(g.ok, false);
  assert.equal(g.reason, 'NO_CHITCHAT_WINDOW');
  assert.match(g.why, /静默/);
  // 静默之外照旧能走窗口那套
  assert.equal(chitchatGate({ cfg, now: NOON, st: {}, ctx: ctxOf(), tz: TZ }).ok, true);
});

test('设置页的主开关说明不写死条数和时段，指到下面的设置项', () => {
  const spec = SCHEMA.find((s) => s.path === 'rules.chitchat.enabled');
  assert.ok(spec);
  assert.doesNotMatch(spec.hint, /每天最多 3 条/);
  assert.doesNotMatch(spec.hint, /00:00–07:00/);
  assert.match(spec.hint, /随口话一天最多几条/);
  assert.match(spec.hint, /静默/);
  const perDay = SCHEMA.find((s) => s.path === 'rules.chitchat.perDay');
  assert.ok(perDay, '条数得能自己设');
  assert.ok(perDay.min >= 1 && perDay.max >= 3);
});

test('放开轻招呼口子：allowBare=true 且无种子时允许「在吗」一次，当天再次尝试仍拦截', async () => {
  const allowTopic = chitchatTopic(cfgOf(), { allowBare: true });
  const denyTopic = chitchatTopic(cfgOf(), { allowBare: false });

  const promptAllow = buildChitchatPrompt({ ctx: ctxOf({ now: NOON }), topic: allowTopic, persona: null, cfg: cfgOf(), st: {} });
  assert.match(promptAllow, /也可以直接发一句简单的轻招呼/);
  assert.doesNotMatch(promptAllow, /✗ 在吗/);

  const promptDeny = buildChitchatPrompt({ ctx: ctxOf({ now: NOON }), topic: denyTopic, persona: null, cfg: cfgOf(), st: {} });
  assert.match(promptDeny, /不许「在吗」「睡了吗」单独成句/);
  assert.match(promptDeny, /✗ 在吗/);

  let calls = 0;
  const r1 = await compose({
    ctx: ctxOf({ now: NOON }),
    topic: allowTopic,
    persona: null,
    cfg: cfgOf(),
    now: NOON,
    st: {},
    generate: async () => { calls += 1; return { ok: true, text: '在吗', ms: 1 }; },
    llmReady: true,
  });
  assert.equal(r1.ok, true);
  assert.equal(r1.text, '在吗');
  assert.equal(calls, 1);

  const d1 = composeDraft({ ctx: ctxOf({ now: NOON }), draft: '在吗', cfg: cfgOf(), topic: allowTopic });
  assert.equal(d1.ok, true);
  const d2 = composeDraft({ ctx: ctxOf({ now: NOON }), draft: '在吗', cfg: cfgOf(), topic: denyTopic });
  assert.equal(d2.ok, false);
  assert.ok(d2.violations.some((v) => v.code === 'CHITCHAT_BARE'));

  const snapAllow = buildSnapshot({ ctx: ctxOf({ now: NOON }), topic: allowTopic, cfg: cfgOf(), st: {}, now: NOON, tz: TZ });
  assert.match(snapAllow, /无事轻招呼的额度/);
  const snapDeny = buildSnapshot({ ctx: ctxOf({ now: NOON }), topic: denyTopic, cfg: cfgOf(), st: {}, now: NOON, tz: TZ });
  assert.doesNotMatch(snapDeny, /无事轻招呼的额度/);
});

test('轻招呼每日次数上限可由 rules.chitchat.barePerDay 配置与校验（0–10）', () => {
  const spec = SCHEMA.find((s) => s.path === 'rules.chitchat.barePerDay');
  assert.ok(spec, '设置页要有轻招呼每日次数设置项');
  assert.equal(spec.min, 0);
  assert.equal(spec.max, 10);

  const base = cfgOf();
  assert.equal(applyChange(base, 'rules.chitchat.barePerDay', 0).value, 0);
  assert.equal(applyChange(base, 'rules.chitchat.barePerDay', 2).value, 2);
  assert.equal(applyChange(base, 'rules.chitchat.barePerDay', -1).ok, false);
  assert.equal(applyChange(base, 'rules.chitchat.barePerDay', 11).ok, false);

  const cfg0 = cfgOf({ rules: { chitchat: { enabled: true, perDay: 3, barePerDay: 0 } } });
  assert.equal(bareLimit(cfg0), 0);
  assert.equal(allowBareToday({}, NOON, TZ, cfg0), false);

  const cfg2 = cfgOf({ rules: { chitchat: { enabled: true, perDay: 3, barePerDay: 2 } } });
  const st = {};
  assert.equal(bareRemainingToday(st, NOON, TZ, cfg2), 2);
  noteChitchatSent(st, NOON, TZ, '在吗');
  assert.equal(bareRemainingToday(st, NOON + 60_000, TZ, cfg2), 1);
  assert.equal(allowBareToday(st, NOON + 60_000, TZ, cfg2), true);
  noteChitchatSent(st, NOON + 120_000, TZ, '在干嘛'); // 非 BARE 不耗裸招呼次数
  assert.equal(bareRemainingToday(st, NOON + 180_000, TZ, cfg2), 1);
  noteChitchatSent(st, NOON + 240_000, TZ, '人呢');
  assert.equal(bareRemainingToday(st, NOON + 300_000, TZ, cfg2), 0);
  assert.equal(allowBareToday(st, NOON + 300_000, TZ, cfg2), false);

  // 跨天重置计数
  assert.equal(bareRemainingToday(st, NOON + DAY, TZ, cfg2), 2);
});

test('persona 类型随口话种子可聊偏好，但已发生的事需要依据', async () => {
  const { judgePrompt } = await import('../src/judge.js');
  const pTopic = chitchatTopic(cfgOf(), {
    seedKind: 'persona',
    seed: '天生胃不好：熬夜就犯，但还是嘴馋爱喝冰的。',
  });
  const prompt = buildChitchatPrompt({ ctx: ctxOf({ now: NOON }), topic: pTopic, persona: null, cfg: cfgOf(), st: {} });
  assert.match(prompt, /不必每条都围着她转/);
  assert.match(prompt, /已发生的动作.*要有本轮候选或对话事实支撑/);
  const jp = judgePrompt({ snapshot: '现在：12:00', persona: { text: '短句' } });
  assert.match(jp, /人设只提供口吻、偏好和表达习惯/);
});
