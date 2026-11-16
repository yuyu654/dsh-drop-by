// compose.test.mjs —— 清洗、红线、模板、模式回落。全部不联网、不调模型。
import test from 'node:test';
import assert from 'node:assert/strict';
import { clean, guard, renderTemplate, compose, composeDraft, buildPrompt, styleSamples, coarseMin } from '../src/compose.js';

const cfgOf = (o = {}) => ({
  content: { mode: 'template', maxChars: 60, ...o, topics: {} },
});

const topicOf = (slot, evidence = {}) => ({ slot, label: slot, why: '', evidence, brief: `由头 ${slot}` });
const ctxOf = (o = {}) => ({
  tz: 'Asia/Shanghai',
  clock: '15:00',
  presence: { idleSec: 60 },
  her: { lastTs: null, lastText: o.herText || '', lastAgoSec: 600 },
  me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
  fish: o.fish || { ok: false },
  recent: [],
});

test('clean：去掉前缀、引号、代码块、多余段落', () => {
  assert.equal(clean('要发的句子：跑完了。'), '跑完了。');
  assert.equal(clean('「跑完了。」'), '跑完了。');
  assert.equal(clean('```\n跑完了。\n```'), '跑完了。');
  assert.equal(clean('跑完了。\n\n我先想了想她的处境'), '跑完了。');
  assert.equal(clean('  '), '');
});

test('guard：括号动作、AI 自称、客服腔、清单、路径都拦', () => {
  const cfg = cfgOf();
  assert.equal(guard('我给你带了一杯（顺手放在桌上）', cfg).ok, false);
  assert.equal(guard('我是一个 AI，无法…', cfg).ok, false);
  assert.equal(guard('您好，很高兴为您服务', cfg).ok, false);
  assert.equal(guard('记得：\n1. 早睡\n2. 别熬', cfg).ok, false);
  assert.equal(guard('我把结果写到 C:\\Users\\x\\a.json 了', cfg).ok, false);
  assert.equal(guard('按你的人格设定，我应该说…', cfg).ok, false);
});

test('guard：正常的短句能过', () => {
  const r = guard('昨晚就睡了五个半小时。今天早点躺。', cfgOf());
  assert.equal(r.ok, true);
  assert.deepEqual(r.violations, []);
});

test('guard：太长/太短/空都拦', () => {
  assert.equal(guard('好', cfgOf()).ok, false);
  assert.equal(guard('', cfgOf()).ok, false);
  assert.equal(guard('啊'.repeat(80), cfgOf()).ok, false);
});

test('guard：口头禅「别多想」拦（本机规则，走 local-style 注入）', () => {
  const cfg = cfgOf({ local: { taboos: [{ code: 'CATCHPHRASE', pattern: '别多想', why: '口头禅用滥了' }] } });
  const r = guard('……胃有点闹。别多想。', cfg);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'CATCHPHRASE'), JSON.stringify(r.violations));
  // 没有这句的同一句话照常过
  assert.equal(guard('……胃有点闹。别问。', cfg).ok, true);
});

test('guard：命令口气「滚回床上躺着」拦（本机规则，走 local-style 注入）', () => {
  const cfg = cfgOf({ local: { taboos: [{ code: 'TOO_RUDE', pattern: '滚(?:回|去|开|一边|蛋|远点)|给我(?:滚|闭嘴)', why: '命令式骂人太凶' }] } });
  const r = guard('烧退了没。没退就滚回床上躺着，别在电脑前硬撑。', cfg);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.code === 'TOO_RUDE'), JSON.stringify(r.violations));
  // 同样的关心，改成直说就过
  assert.equal(guard('烧退了没。没退就去躺着，别在电脑前硬撑。', cfg).ok, true);
});

test('renderTemplate：屏幕时长说粗的，不报分钟', () => {
  const txt = renderTemplate(topicOf('screen', { screenMin: 304 }), ctxOf());
  assert.match(txt, /五个多小时/);
  assert.doesNotMatch(txt, /\d+\s*小时\s*\d+\s*分钟/);
  assert.equal(guard(txt, cfgOf()).ok, true, txt);
});

test('coarseMin：分钟级数字换成人的说法', () => {
  assert.equal(coarseMin(304), '五个多小时');
  assert.equal(coarseMin(380), '六个小时');
  assert.equal(coarseMin(359), '快六个小时');
  assert.equal(coarseMin(45), '四十多分钟');
  assert.equal(coarseMin(30), '半个多小时');
  assert.equal(coarseMin(5), '不到十分钟');
});

test('guard：拦「5 小时 4 分钟」这种报表时长', () => {
  const r = guard('今天屏幕 5 小时 4 分钟。眼睛不疼？', cfgOf());
  assert.ok(r.violations.some((v) => v.code === 'TOO_PRECISE_TIME'), JSON.stringify(r.violations));
  assert.equal(guard('今天屏幕五个多小时。眼睛不疼？', cfgOf()).ok, true);
});

test('renderTemplate：数据类由头有句子，需要读懂的返回 null', () => {
  // 短睡分两种：熬夜只说入睡点，没睡好只说时长+深睡，长睡问是不是累到了
  assert.match(renderTemplate(topicOf('sleep', { kind: 'late_night', sleepMin: 380, deepMin: 90, bedHm: '00:40' }), ctxOf()), /又是 00:40 才睡/);
  assert.match(renderTemplate(topicOf('sleep', { kind: 'poor_sleep', sleepMin: 380, deepMin: 90, bedHm: '23:50' }), ctxOf()), /睡了六个小时，深睡才一个半小时/);
  assert.match(renderTemplate(topicOf('sleep', { kind: 'long_sleep', sleepMin: 620, deepMin: 180 }), ctxOf()), /是不是累到了/);
  // 模板句本身必须过 guard，不然等于没有兜底
  for (const ev of [
    { kind: 'late_night', sleepMin: 380, deepMin: 90, bedHm: '00:40' },
    { kind: 'poor_sleep', sleepMin: 380, deepMin: 90 },
    { kind: 'long_sleep', sleepMin: 620, deepMin: 180 },
  ]) {
    const txt = renderTemplate(topicOf('sleep', ev), ctxOf());
    assert.equal(guard(txt, cfgOf()).ok, true, `模板句过不了 guard：${txt}`);
  }
  assert.match(renderTemplate(topicOf('screen', { screenMin: 600 }), ctxOf()), /十个多小时/);
  assert.match(renderTemplate(topicOf('catchup', {}), ctxOf()), /好几天/);
  assert.equal(renderTemplate(topicOf('reply'), ctxOf()), null);
  assert.equal(renderTemplate(topicOf('share'), ctxOf()), null);
});

test('renderTemplate：追问必须说清通道和多久以前（不许一律「刚」）', () => {
  const fresh = renderTemplate(topicOf('noReply', { channel: 'douyin', silenceMin: 30 }), ctxOf());
  assert.match(fresh, /^在抖音给你发的那个，看了没。$/);
  // 19 小时前分享的也不许写成「刚」——模板看不出间隔，就别写时间词
  const old = renderTemplate(topicOf('noReply', { channel: 'douyin', silenceMin: 1140 }), ctxOf());
  assert.equal(old, fresh);
  assert.doesNotMatch(old, /刚/);
  const qq = renderTemplate(topicOf('noReply', { channel: 'qq', silenceMin: 900, text: '在吗' }), ctxOf());
  assert.match(qq, /那条你还没回我/);
  for (const t of [fresh, old, qq]) assert.equal(guard(t, cfgOf()).ok, true, t);
});

test('compose：template 模式遇到 reply 如实说写不出来', async () => {
  const r = await compose({ ctx: ctxOf(), topic: topicOf('reply'), persona: { text: '' }, cfg: cfgOf() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'TEMPLATE_CANT_WRITE');
  assert.match(r.note, /llm/);
});

test('compose：template 模式能出睡眠那句，并过红线', async () => {
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('sleep', { sleepMin: 330, anomaly: 'too_short' }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'template');
  assert.equal(r.slot, 'sleep');
});

test('compose：想用 llm 但环境不全 → 回落模板，并记原因', async () => {
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('screen', { screenMin: 600 }),
    persona: { text: '' },
    cfg: { content: { mode: 'llm', maxChars: 60, llm: { electron: 'X:\\nope.exe', cli: 'X:\\nope.js' }, topics: {} } },
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'template-after-llm-missing');
  assert.equal(r.meta.llmReason, 'LLM_NO_ELECTRON');
});

test('compose：没有由头就不生成', async () => {
  const r = await compose({ ctx: ctxOf(), topic: null, persona: { text: '' }, cfg: cfgOf() });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'NO_TOPIC');
});

test('buildPrompt：带人格、带硬约束，share 有专门约束', () => {
  const p = buildPrompt({
    ctx: ctxOf({ herText: '在吗' }),
    topic: topicOf('share', {}),
    persona: { text: '# 人格\n短句。' },
    cfg: cfgOf(),
  });
  assert.match(p, /# 人格/);
  assert.match(p, /不写括号/);
  assert.match(p, /照搬原句/);
  assert.match(p, /不超过 60 字/);
  // 关键：必须把「具体」和「不许泛指」写进硬要求，并且把反面示例钉在里面
  assert.match(p, /必须落到一个具体的东西/);
  assert.match(p, /不许用「人」「大家」/);
  assert.match(p, /写成这样就废了/);
  // 第 11 条（她 2026-11-06 提的）：没由头的旧梗/数落不许出现
  assert.match(p, /不许凭空引入旧梗和旧账/);
});

test('buildPrompt：L2 说她在干什么，L3 只给 OCR 线索并标明可能认错', () => {
  const ctx = ctxOf({ herText: '在吗' });
  ctx.activity = { kind: 'game', speaking: false, fgTitle: '原神', fgName: 'genshin.exe' };
  ctx.screen = { ok: true, hints: ['第三关 打完收工', 'Boss 血条'] };
  const p = buildPrompt({ ctx, topic: topicOf('catchup'), persona: { text: '# 人格' }, cfg: cfgOf() });
  // 2026-11-08：只给「在打游戏」，不给窗口名——给了就会写成「原神那个？」，
  // 等于承认自己在看她的屏。
  assert.match(p, /她电脑前：在打游戏/);
  assert.doesNotMatch(p, /原神/);
  assert.match(p, /OCR 可能认错/);
  assert.match(p, /第三关 打完收工/);
  // 有线索不等于可以把「我在看你屏幕」说出口
  assert.match(p, /不许提「屏幕」/);
});

test('buildPrompt：没开 L2/L3 时一个字都不提电脑和屏幕', () => {
  const ctx = ctxOf({ herText: '在吗' });
  ctx.screen = { ok: false, reason: 'L3_TOO_SOON' };
  const p = buildPrompt({ ctx, topic: topicOf('catchup'), persona: { text: '# 人格' }, cfg: cfgOf() });
  assert.equal(/她电脑前/.test(p), false);
  assert.equal(/OCR 可能认错/.test(p), false);
});

test('compose：auto 模式在没有 CLI 时自动退模板，而不是什么都不发', async () => {
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('sleep', { sleepMin: 330, anomaly: 'too_short' }),
    persona: { text: '' },
    cfg: { content: { mode: 'auto', maxChars: 60, llm: { electron: 'X://nope.exe', cli: 'X://nope.js' }, topics: {} } },
  });
  assert.equal(r.ok, true);
  // auto 直接按环境选路，所以这里是干净的 template，不是「llm 失败后回落」
  assert.equal(r.source, 'template');
});

// ---------------------------------------------------------------- 空泛拦截
// 这几条来自实测：同一人格连跑三次，三次都是格言体，全部以此类形状开头。

test('guard：拦「感悟/格言」这一类——形式合规但不像一条消息', () => {
  const cfg = cfgOf({ maxChars: 80 });
  const bad = [
    '我最近在想，人不是没劲，是缺一个不用替自己找理由。',
    '说到底，我们都该学会接受自己的节奏。',
    '人没动力的时候，缺的往往不是力气。',
    '灵感不是休息出来的，是换输入源换来的。',
    '今天早点睡，慢慢来。',
  ];
  for (const t of bad) {
    const r = guard(t, cfg);
    assert.equal(r.ok, false, `应当拦下：${t}`);
  }
});

test('guard：具体、有对象、有台阶的句子不误伤', () => {
  const cfg = cfgOf({ maxChars: 80 });
  const good = [
    '别瞎猜。我又没换人。',
    '昨晚就睡了五个半小时。今天早点躺。',
    '那篇我看完了。第三段那个说法站不住，你别照着用。',
    '你桌上那杯冰的还没喝完吧。少来这套，我也不管。',
  ];
  for (const t of good) {
    const r = guard(t, cfg);
    assert.equal(r.ok, true, `不该拦：${t} -> ${r.violations.map((v) => v.code).join(',')}`);
  }
});

test('styleSamples：优先用我真实发过的话，长度不合适就跳过', () => {
  const ctx = {
    ...ctxOf(),
    recent: [
      { from: 'her', text: '随便一条她说的' },
      { from: 'me', text: '这条值得存。开源免费，从下载到启动一步一步写了。' },
      { from: 'me', text: '短' },
    ],
  };
  const s = styleSamples(ctx);
  assert.equal(s.length, 1);
  assert.match(s[0], /这条值得存/);
});

test('styleSamples：没有历史时给内置语气样本，不会返回空', () => {
  const s = styleSamples({ recent: [] });
  assert.ok(s.length >= 1);
});

// ---------------------------------------------------------------- 压力
test('模板：压力话题两态，且都过 guard', () => {
  const first = renderTemplate(topicOf('stress', { stress: 72, nth: 1, max: 1 }), ctxOf());
  assert.match(first, /72/);
  const second = renderTemplate(topicOf('stress', { stress: 72, nth: 2, max: 3 }), ctxOf());
  assert.match(second, /压力还没降/);
  assert.notEqual(first, second); // 第二次不能是第一次的复读
  for (const ev of [
    { stress: 72, nth: 1 },
    { stress: 72, nth: 2 },
  ]) {
    const txt = renderTemplate(topicOf('stress', ev), ctxOf());
    assert.equal(guard(txt, cfgOf()).ok, true, `模板句过不了 guard：${txt}`);
  }
});

test('prompt：压力这一条要禁止空问句和减压道理，且第二次不许重复关心', () => {
  const ctx = { ...ctxOf(), fish: { ok: true, stress: 72 } };
  const p1 = buildPrompt({ ctx, topic: topicOf('stress', { stress: 72, nth: 1 }), persona: { text: '# 人格' }, cfg: cfgOf() });
  assert.match(p1, /不许问「怎么了」/);
  assert.match(p1, /放松一下/);
  assert.match(p1, /压力值：72/);
  const p2 = buildPrompt({ ctx, topic: topicOf('stress', { stress: 72, nth: 2 }), persona: { text: '# 人格' }, cfg: cfgOf() });
  assert.match(p2, /已经关心过一次/);
});

// —— 注入点：插件把宿主的 ctx.llm 传进来，就不该再去 spawn 命令行 ——

test('compose：注入 generate 后走注入的那条，不再 spawn CLI', async () => {
  const cfg = { content: { mode: 'llm', maxChars: 60, topics: {} } };
  const calls = [];
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('share'),
    persona: { kind: 'local', text: '# 人格', sources: [] },
    cfg,
    now: Date.now(),
    llmReady: true,
    generate: async ({ prompt }) => {
      calls.push(prompt);
      return { ok: true, text: '跑完了。第三行那个报错是路径写错。', ms: 5 };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes('由头 share'), true);
  assert.equal(r.ok, true);
  assert.equal(r.source, 'llm');
  assert.equal(r.meta.attempts, 1);
});

test('buildPrompt：深睡没读到 → 要求不提深睡，事实里也没有深睡那一行', () => {
  const ctx = ctxOf({ herText: '在吗' });
  ctx.fish = { ok: true, sleepMin: 380, deepMin: null, wakeHm: '07:00' };
  const p = buildPrompt({
    ctx,
    topic: topicOf('sleep', { kind: 'late_night', sleepMin: 380, deepMin: null, deepKnown: false, bedHm: '00:40' }),
    persona: { text: '# 人格' },
    cfg: cfgOf(),
  });
  assert.match(p, /没有深睡/);
  assert.equal(/^- 深睡：/m.test(p), false);
});

test('compose：llmReady=false 时直接走模板，不问模型', async () => {
  let called = 0;
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('sleep', { kind: 'long_sleep', sleepMin: 620, deepMin: 180 }),
    persona: { kind: 'local', text: '', sources: [] },
    cfg: { content: { mode: 'auto', maxChars: 60, topics: {} } },
    now: Date.now(),
    llmReady: false,
    generate: async () => {
      called += 1;
      return { ok: true, text: '不该被调用。' };
    },
  });
  assert.equal(called, 0);
  assert.equal(r.ok, true);
  assert.match(r.source, /template/);
});

test('compose：注入的生成器报错 → 退回模板 / 或明确失败，不抛', async () => {
  const r = await compose({
    ctx: ctxOf(),
    topic: topicOf('share'),
    persona: { kind: 'local', text: '', sources: [] },
    cfg: { content: { mode: 'llm', maxChars: 60, topics: {} } },
    now: Date.now(),
    llmReady: true,
    generate: async () => ({ ok: false, reason: 'HOST_LLM_TIMEOUT' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'HOST_LLM_TIMEOUT');
});

test('转发没内容：prompt 明确禁止编内容，且不给「我看完的结论」那套', () => {
  const p = buildPrompt({
    ctx: ctxOf({ herText: '这条太顶了 #AI' }),
    topic: topicOf('forward', { herText: '这条太顶了 #AI', hasContent: false }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /没看过/);
  assert.match(p, /不许编细节/);
  assert.doesNotMatch(p, /先说一句我看完的结论/);
  assert.doesNotMatch(p, /内容（我自己看的）/);
});

test('转发有摘要：摘要进事实块，规则换成先说结论', () => {
  const p = buildPrompt({
    ctx: ctxOf({ herText: '这条太顶了 #AI' }),
    topic: topicOf('forward', { herText: '这条太顶了 #AI', hasContent: true, contentSummary: 'AI 猫片，最后两秒翻车' }),
    persona: { text: '' },
    cfg: cfgOf(),
  });
  assert.match(p, /内容（我自己看的）：AI 猫片，最后两秒翻车/);
  assert.match(p, /先说一句我看完的结论/);
  assert.doesNotMatch(p, /不许编细节/);
});

test('步数模板：两头两种说法，中间不写', () => {
  assert.match(renderTemplate(topicOf('steps', { kind: 'low', steps: 900 }), ctxOf()), /900/);
  assert.match(renderTemplate(topicOf('steps', { kind: 'low', steps: 900 }), ctxOf()), /走两步/);
  assert.match(renderTemplate(topicOf('steps', { kind: 'high', steps: 9000 }), ctxOf()), /9000/);
});

test('步数 prompt：没动的那一头不许说教，活动好的那一头不许夸成健身教练', () => {
  const low = buildPrompt({
    ctx: ctxOf({ fish: { ok: true, steps: 900 } }),
    topic: topicOf('steps', { kind: 'low', steps: 900 }),
    persona: { text: '人格' },
    cfg: cfgOf(),
  });
  assert.match(low, /不许说教|不许「多运动」|别用「又」/);
  assert.match(low, /今日步数：900/);

  const high = buildPrompt({
    ctx: ctxOf({ fish: { ok: true, steps: 9000 } }),
    topic: topicOf('steps', { kind: 'high', steps: 9000 }),
    persona: { text: '人格' },
    cfg: cfgOf(),
  });
  assert.match(high, /别夸成健身教练|不许说「真棒」/);
  assert.match(high, /今日步数：9000/);
});

// ---- 只看电脑的三类：模板要能自己说出口，规则不许滑成说教

test('renderTemplate：深夜 / 坐太久 / 刚回来都有模板', () => {
  assert.match(renderTemplate(topicOf('lateUp', { at: '23:40' }), ctxOf()), /23:40/);
  assert.match(renderTemplate(topicOf('longSit', { since: '13:20' }), ctxOf()), /13:20/);
  assert.match(renderTemplate(topicOf('backHome', {}), ctxOf()), /刚回来/);
});

test('buildPrompt：深夜这条不许讲早睡道理，坐太久不许当妈', () => {
  const late = buildPrompt({ ctx: ctxOf(), topic: topicOf('lateUp', { at: '23:40' }), persona: { text: '# 人格' }, cfg: cfgOf() });
  assert.match(late, /只说睡觉/);
  assert.match(late, /不许讲早睡的道理/);
  const sit = buildPrompt({ ctx: ctxOf(), topic: topicOf('longSit', { since: '13:20' }), persona: { text: '# 人格' }, cfg: cfgOf() });
  assert.match(sit, /小台阶/);
  assert.match(sit, /注意身体/);
});

test('buildPrompt：带上最近真发出去的几条（时间分今天/昨天/更早），没有就整段省略', () => {
  const now = Date.parse('2026-11-06T15:00:00+08:00');
  const base = { ...ctxOf({ herText: '在吗' }), now };
  const p = buildPrompt({
    ctx: {
      ...base,
      recentOutbound: [
        { ts: Date.parse('2026-11-06T09:05:00+08:00'), channel: 'qq', text: '今天第一节是电机学吧' },
        { ts: Date.parse('2026-11-05T21:40:00+08:00'), channel: 'douyin', text: '这个视频你肯定喜欢' },
        { ts: Date.parse('2026-11-02T08:00:00+08:00'), channel: 'qq', text: '早' },
      ],
    },
    topic: topicOf('reply'),
    persona: { text: '人格' },
    cfg: cfgOf(),
    st: {},
  });
  assert.match(p, /你最近发出去的 3 条/);
  assert.match(p, /今天第一节是电机学吧」（QQ，09:05）/);
  assert.match(p, /这个视频你肯定喜欢」（抖音，昨天 21:40）/);
  assert.match(p, /「早」（QQ，11-02 08:00）/);
  assert.match(p, /别用同样的句式开头/);

  const empty = buildPrompt({ ctx: { ...base, recentOutbound: [] }, topic: topicOf('reply'), persona: { text: '人格' }, cfg: cfgOf() });
  assert.doesNotMatch(empty, /你最近发出去的/);

  // 开关关掉：整段不进 prompt（和加这段之前一样）
  const offCfg = { ...cfgOf(), content: { ...cfgOf().content, prompt: { recentOutbound: false } } };
  const offPrompt = buildPrompt({ ctx: base, topic: topicOf('reply'), persona: { text: '人格' }, cfg: offCfg });
  assert.doesNotMatch(offPrompt, /你最近发出去的/);
});

test('buildPrompt：话题接住率只列发过的，feedback 关着就不列', () => {
  const st = { feedback: { slots: { sleep: { sent: 9, replied: 2 }, stress: { sent: 6, replied: 5 }, steps: { sent: 0, replied: 0 } } } };
  const p = buildPrompt({ ctx: { ...ctxOf(), recentOutbound: [] }, topic: topicOf('reply'), persona: { text: '人格' }, cfg: cfgOf(), st });
  assert.match(p, /话题接住情况/);
  assert.match(p, /拿睡眠说事 2\/9（22%）/);
  assert.match(p, /她压力偏高 5\/6（83%）/);
  assert.doesNotMatch(p, /拿今天的步数说事/);
  assert.match(p, /接不住的话题，换角度说/);

  const off = { ...cfgOf(), rules: { feedback: { enabled: false } } };
  const q = buildPrompt({ ctx: { ...ctxOf(), recentOutbound: [] }, topic: topicOf('reply'), persona: { text: '人格' }, cfg: off, st });
  assert.doesNotMatch(q, /话题接住情况/);

  // 独立开关：feedback 开着，但这段素材自己关掉
  const offStat = { ...cfgOf(), content: { ...cfgOf().content, prompt: { slotStats: false } } };
  const r = buildPrompt({ ctx: { ...ctxOf(), recentOutbound: [] }, topic: topicOf('reply'), persona: { text: '人格' }, cfg: offStat, st });
  assert.doesNotMatch(r, /话题接住情况/);
});

test('buildPrompt：主动由头不带「我最后一条」，回复类才带', () => {
  const ctx = { ...ctxOf(), me: { lastText: '对着 claude 说「不会再放开你的手」……你酸不酸啊。', lastAgoSec: 1200 }, recentOutbound: [] };
  const agenda = buildPrompt({ ctx, topic: topicOf('agenda', { kind: 'early', at: '08:30', when: '明天', name: '单片机原理及应用A' }), persona: { text: '人格' }, cfg: cfgOf() });
  assert.doesNotMatch(agenda, /我最后一条/);
  assert.doesNotMatch(agenda, /酸不酸/);
  assert.match(agenda, /只说课表这一件事/);

  const reply = buildPrompt({ ctx, topic: topicOf('reply'), persona: { text: '人格' }, cfg: cfgOf() });
  assert.match(reply, /我最后一条/);
});

test('guard：照抄我上一句里连续 8 个字要拦', () => {
  const ctx = { me: { lastText: '对着 claude 说「不会再放开你的手」……你酸不酸啊。' } };
  const bad = guard('对着 claude 说不放手，那手伸过来。', cfgOf(), ctx);
  assert.equal(bad.ok, false);
  assert.equal(bad.violations[0].code, 'ECHO_SELF');

  // 自己写的、跟上一句不重合的句子照常过
  assert.equal(guard('明早八点半的课，今晚别熬。', cfgOf(), ctx).ok, true);
});

test('prompt 不许报软件名（2026-11-08 她说「WorkBuddy 那个？」太刻意）', () => {
  const ctx = ctxOf({ herText: '' });
  ctx.activity = { kind: 'coding', speaking: false, fgTitle: 'WorkBuddy', fgName: 'workbuddy.exe' };
  const p = buildPrompt({ ctx, topic: topicOf('noReply'), persona: { text: '' }, cfg: cfgOf() });
  assert.doesNotMatch(p, /窗口「WorkBuddy」/);   // 事实里不再带窗口名
  assert.doesNotMatch(p, /她电脑前：在写代码（/);
  assert.match(p, /回来就写代码/);            // 规则里给的正面写法
  assert.match(p, /一条只说一件事/);          // 不和自己的事拼在一起
  assert.match(p, /只问这一件事，别捎带别的话题/); // noReply 槽的约束
});

// —— 2026-11-10 QQ 事故：模型重写时只吐了两个字「那条」，被当成一条消息发了 ——

test('guard：碎片「那条」拦（ECHO_TOPIC），短句「在吗」放行（2026-11-10 她：不必多于六字）', () => {
  const cfg = cfgOf();
  const r = guard('那条', cfg, null, { topicLabel: '那条还没回' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.violations.map((v) => v.code), ['ECHO_TOPIC']);
  // 短句本身不废：能独立成话就放行
  assert.equal(guard('在吗', cfg, null, { topicLabel: '那条还没回' }).ok, true);
  assert.equal(guard('干嘛呢', cfg, null, { topicLabel: '那条还没回' }).ok, true);
  assert.equal(guard('睡了？', cfg, null, { topicLabel: '那条还没回' }).ok, true);
  // minChars 选项留着给「这条必须说满」的由头用，默认仍是 2（只拦单字）
  assert.equal(guard('那条', cfg, null, { minChars: 6 }).ok, false);
  assert.equal(guard('在。', cfg).ok, true);
});

test('compose：模型两次都只吐「那条」→ 要么不发，要么退回完整模板，绝不发碎片', async () => {
  const cfg = { content: { mode: 'llm', maxChars: 60, topics: {} } };
  const calls = [];
  const r = await compose({
    ctx: ctxOf(),
    topic: { ...topicOf('noReply', { key: 'k', channel: 'douyin', at: Date.now(), silenceMin: 158 }), label: '那条还没回', brief: '我在 15:35 给她分享了个视频，到现在没动静。' },
    persona: { kind: 'local', text: '# 人格', sources: [] },
    cfg,
    now: Date.now(),
    llmReady: true,
    generate: async ({ prompt }) => {
      calls.push(prompt);
      return { ok: true, text: '那条', ms: 3 };
    },
  });
  assert.equal(calls.length, 2);
  assert.notEqual(r.text, '那条');
  assert.equal((r.violations || []).some((v) => v.code === 'ECHO_TOPIC'), true);
  if (r.ok) {
    assert.match(r.source, /template/);
    assert.ok((r.text || '').length >= 6);
  } else {
    assert.equal(r.reason, 'GUARD_REJECTED');
  }
});

test('composeDraft / compose：share 探索内容拦公式黑话和无接话口子的独白，有接话口子的大白话放行', async () => {
  const cfg = { content: { mode: 'llm', maxChars: 60, topics: {} } };
  const exploreTopic = topicOf('share', { section: '探索', at: Date.now() });

  // 1. 纯独白定论（无问句、无接话邀请）被 SHARE_NO_HOOK 拦掉
  const closed = composeDraft({
    ctx: ctxOf(),
    topic: exploreTopic,
    cfg,
    draft: '插排上那只功率计量，别只盯着超没超线——把超出的那点攒成热量，先热起来的才先跳。',
  });
  assert.equal(closed.ok, false);
  assert.equal(closed.violations.some((v) => v.code === 'SHARE_NO_HOOK'), true);

  // 2. 带公式符号被 SHARE_TOO_TECHNICAL 拦掉
  const formula = composeDraft({
    ctx: ctxOf(),
    topic: exploreTopic,
    cfg,
    draft: '热记忆方程 ds/dt=(P/Pn)^A-1，你看懂了吗？',
  });
  assert.equal(formula.ok, false);
  assert.equal(formula.violations.some((v) => v.code === 'SHARE_TOO_TECHNICAL'), true);

  // 3. 大白话 + 留接话口子放行
  const good = composeDraft({
    ctx: ctxOf(),
    topic: exploreTopic,
    cfg,
    draft: '要是插排按超负荷攒的热量慢慢跳闸，你在宿舍遇见过一开吹风机就断电不？',
  });
  assert.equal(good.ok, true);

  // 4. compose 重试闭环：第一版给无钩子独白被退回，第二版改出问句通过
  let turn = 0;
  const retried = await compose({
    ctx: ctxOf(),
    topic: exploreTopic,
    persona: { kind: 'local', text: '# 人格', sources: [] },
    cfg,
    now: Date.now(),
    llmReady: true,
    generate: async () => {
      turn += 1;
      return turn === 1
        ? { ok: true, text: '插排功率计量其实按发热累积来算才准。', ms: 3 }
        : { ok: true, text: '宿舍插排老是忽然跳闸挺烦的，你那边也这样吗？', ms: 3 };
    },
  });
  assert.equal(retried.ok, true);
  assert.equal(retried.source, 'llm-retry');

  // 5. actionRetry / loginSite 不受 share 接话钩子限制误伤
  const retryDraft = composeDraft({
    ctx: ctxOf(),
    topic: topicOf('share', { actionRetry: true, at: Date.now() }),
    cfg,
    draft: '刚才那条没打开发现被挡住了，换个站点查查。',
  });
  assert.equal(retryDraft.ok, true);
});

test('guard：去标点后与近期发送 recentSends 连续 8 字重复也判 ECHO_SELF', () => {
  const cfg = cfgOf();
  const ctx = {
    ...ctxOf(),
    recentSends: ['明天八点电力电子。这会儿就别再开新坑了，收一收，早点睡。'],
  };
  const r = guard('明早八点电力电子……这会儿别开新的了，早点睡。', cfg, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.violations.some((v) => v.code === 'ECHO_SELF'), true);
});
