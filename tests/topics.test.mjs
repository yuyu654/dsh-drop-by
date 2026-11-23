// topics.test.mjs —— 「有没有由头」的纯函数。这是「要不要发」最关键的一层。
import test from 'node:test';
import assert from 'node:assert/strict';
import { topicCandidates, pickTopic, explainNoTopic, looksForwarded, classifySleep, fishStale } from '../src/topics.js';

const TZ = 'Asia/Shanghai';
const at = (h, m = 0) => Date.UTC(2026, 10, 4, h - 8, m);
const MIN = 60_000;
const HOUR = 3_600_000;

const cfgOf = (topics = {}, content = {}) => ({
  timezone: TZ,
  content: { mode: 'template', ...content, topics: { ...topics } },
});

const ctxOf = (o = {}) => ({
  tz: TZ,
  her: { lastTs: o.herTs ?? null, lastText: o.herText ?? '', lastAgoSec: null },
  me: { lastTs: o.meTs ?? null, lastText: o.meText ?? '', lastAgoSec: null },
  fish: o.fish || { ok: false },
  self: o.self || null,
  presence: {},
  recent: [],
});

const fishOf = (o = {}) => ({
  ok: true,
  ageMin: o.ageMin ?? 30,
  date: o.date ?? '11-04',
  fetchedAt: o.fetchedAt ?? null,
  sleepMin: o.sleepMin ?? null,
  deepMin: o.deepMin ?? null,
  remMin: o.remMin ?? null,
  screenMin: o.screenMin ?? null,
  wakeHm: o.wakeHm ?? null,
  bedHm: o.bedHm ?? null,
  sleepFrom: o.sleepFrom ?? null,
  stress: o.stress ?? null,
  steps: o.steps ?? null,
  dateTs: o.dateTs ?? null,
});

test('她说了话我还没回 → reply，优先级最高', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 10 * MIN, herText: '在吗', meTs: now - 60 * MIN });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'reply');
  assert.match(t.brief, /在吗/);
});

test('已回过就不再算 reply', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 60 * MIN, herText: '在吗', meTs: now - 10 * MIN });
  assert.notEqual(pickTopic(ctx, cfgOf({ share: false, catchup: false }), now, {})?.slot, 'reply');
});

test('她转来一条带话题标签的内容 → forward', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 5 * MIN, herText: '这条太顶了 #AI #工具', meTs: now - 600 * MIN });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'forward');
});

test('回复过期（超过 replyMaxAgeMin）就不再硬回', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 20 * HOUR, herText: '在吗', meTs: now - 30 * HOUR });
  const t = pickTopic(ctx, cfgOf({ replyMaxAgeMin: 720, share: false, catchup: false }), now, {});
  assert.equal(t, null);
});

test('关掉 reply 开关就不选 reply', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 5 * MIN, herText: '在吗', meTs: now - 60 * MIN });
  const t = pickTopic(ctx, cfgOf({ reply: false }), now, {});
  assert.notEqual(t?.slot, 'reply');
});

// ---- 睡眠由头：短睡要「深睡也少」，且要分清熬夜 / 没睡好

test('睡眠：7 小时 39 分 / 深睡 2 小时 25，两项都过线 → 不构成由头', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 459, deepMin: 145, wakeHm: '07:57' }) });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
  assert.equal(classifySleep(fishOf({ sleepMin: 459, deepMin: 145, wakeHm: '07:57' }), cfgOf()), null);
});

test('睡眠：短 + 深睡少 + 入睡 00:40 → 判为熬夜', () => {
  const now = at(8);
  // 07:00 起、睡 6 小时 20 → 入睡 00:40（晚于 00:30 的线）
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00' }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'sleep');
  assert.equal(t.evidence.kind, 'late_night');
  assert.equal(t.evidence.bedHm, '00:40');
  assert.equal(t.evidence.lateBed, true);
  assert.match(t.brief, /熬夜/);
  assert.match(t.brief, /00:40/);
});

test('睡眠：短 + 深睡少，但入睡 23:50 → 判为没睡好，不许说成熬夜', () => {
  const now = at(8);
  // 06:40 起、睡 6 小时 50 → 入睡 23:50
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 410, deepMin: 100, wakeHm: '06:40' }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'sleep');
  assert.equal(t.evidence.kind, 'poor_sleep');
  assert.equal(t.evidence.bedHm, '23:50');
  assert.equal(t.evidence.lateBed, false);
  assert.match(t.brief, /没睡好/);
});

test('睡眠：短但深睡够 → 不发（两个条件缺一不可）', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 130, wakeHm: '06:30' }) });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
});

test('睡眠：睡得够但深睡少 → 不发（只看深睡不算由头）', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 480, deepMin: 80, wakeHm: '08:00' }) });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
});

test('睡眠：应用不报深睡（读不到）→ 只看时长，照样判熬夜', () => {
  const now = at(8);
  // 07:00 起、睡 6 小时 20 → 入睡 00:40
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: null, wakeHm: '07:00' }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'sleep');
  assert.equal(t.evidence.kind, 'late_night');
  assert.equal(t.evidence.deepKnown, false);
  assert.match(t.brief, /这封没带深睡/);
  assert.doesNotMatch(t.brief, /深睡才/);
});

test('睡眠：没深睡数据但时长够 → 不发', () => {
  const now = at(8);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ sleepMin: 480, deepMin: null, wakeHm: '08:00' }) }), cfgOf(), now, {}), null);
});

test('睡眠：深睡读到的判定不变（deepKnown=true，仍要两个条件）', () => {
  const now = at(8);
  const t = pickTopic(ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00' }) }), cfgOf(), now, {});
  assert.equal(t.evidence.deepKnown, true);
  assert.equal(classifySleep(fishOf({ sleepMin: 380, deepMin: 130, wakeHm: '07:00' }), cfgOf()), null);
});

test('睡眠：阈值边界（小于才触发，正好等于不触发）', () => {
  const now = at(8);
  // 419 分 = 差 1 分钟到 7h，深睡 119 分 = 差 1 分钟到 2h → 触发
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ sleepMin: 419, deepMin: 119 }) }), cfgOf(), now, {}).slot, 'sleep');
  // 任意一项正好在线 → 不发
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ sleepMin: 420, deepMin: 100 }) }), cfgOf(), now, {}), null);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ sleepMin: 400, deepMin: 120 }) }), cfgOf(), now, {}), null);
});

test('睡眠：三个阈值都能由配置改，改完立刻按新值判', () => {
  const now = at(8);
  const f = fishOf({ sleepMin: 400, deepMin: 100, wakeHm: '07:00' });
  // 默认 420/120 → 触发
  assert.equal(pickTopic(ctxOf({ fish: f }), cfgOf(), now, {}).slot, 'sleep');
  // 睡少线放到 390（6h30）→ 400 不算短，不再触发
  assert.equal(pickTopic(ctxOf({ fish: f }), cfgOf({ sleepShortMin: 390 }), now, {}), null);
  // 深睡线放到 90 → 100 不算少，不再触发
  assert.equal(pickTopic(ctxOf({ fish: f }), cfgOf({ sleepDeepShortMin: 90 }), now, {}), null);
  // 睡多线降到 390 → 400 > 390，改判成睡太多
  const t = pickTopic(ctxOf({ fish: f }), cfgOf({ sleepLongMin: 390 }), now, {});
  assert.equal(t.evidence.kind, 'long_sleep');
});

test('睡眠：睡超过 9.5 小时 → 关心是不是累到了', () => {
  const now = at(9);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 620, deepMin: 180, wakeHm: '11:20' }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'sleep');
  assert.equal(t.evidence.kind, 'long_sleep');
  assert.match(t.brief, /累/);
});

test('睡眠：没有起床时间 → 归为没睡好，不猜熬夜', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90 }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.evidence.kind, 'poor_sleep');
  assert.equal(t.evidence.bedUnknown, true);
  assert.equal(t.evidence.bedHm, null);
});

test('睡眠：邮件带了入睡时间 → 直接用它，不再反推', () => {
  const now = at(8);
  // 起床 08:00、睡 6h20 → 反推是 01:40（会判熬夜）；邮件直给 00:40
  const c = classifySleep(fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '08:00', bedHm: '00:40' }), cfgOf());
  assert.equal(c.bedHm, '00:40');
  assert.equal(c.bedFrom, 'direct');
  assert.equal(c.kind, 'late_night');
  const t = pickTopic(ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '08:00', bedHm: '00:40' }) }), cfgOf(), now, {});
  assert.match(t.brief, /邮件里直接给的/);
  // 邮件说 23:30（反推 01:40 会误判成熬夜）→ 按直给值判没睡好
  const d = classifySleep(fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '08:00', bedHm: '23:30' }), cfgOf());
  assert.equal(d.kind, 'poor_sleep');
  assert.equal(d.bedFrom, 'direct');
  assert.equal(d.bedHm, '23:30');
});

test('睡眠：入睡时间没读到 → 走原来的「起床 − 睡眠」反推', () => {
  const c = classifySleep(fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00', bedHm: null }), cfgOf());
  assert.equal(c.bedFrom, 'inferred');
  assert.equal(c.bedHm, '00:40');
  assert.equal(c.kind, 'late_night');
  const t = pickTopic(ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00', bedHm: null }) }), cfgOf(), at(8), {});
  assert.match(t.brief, /反推入睡是 00:40/);
});

test('睡眠：只有入睡时间、起床时间没读到 → 照样能判熬夜', () => {
  const c = classifySleep(fishOf({ sleepMin: 380, deepMin: 90, bedHm: '01:10' }), cfgOf());
  assert.equal(c.bedFrom, 'direct');
  assert.equal(c.wakeHm, null);
  assert.equal(c.kind, 'late_night');
  const t = pickTopic(ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, bedHm: '01:10' }) }), cfgOf(), at(8), {});
  assert.equal(t.slot, 'sleep');
  assert.match(t.brief, /入睡 01:10/);
  assert.match(t.brief, /熬夜/);
});

test('睡眠：只拿到总睡眠 → 不拿它当昨夜那一觉，这一句不发', () => {
  const now = at(8);
  // 起床 07:40、总睡眠 6.5h（没带夜间睡眠）→ 分类本身还是能算出 late_night，
  // 但总睡眠含白天小睡，拿它说「昨晚睡了多久」就是编，所以由头层面直接不发。
  const f = fishOf({ sleepMin: 390, deepMin: 90, wakeHm: '07:40', sleepFrom: 'total' });
  const c = classifySleep(f, cfgOf());
  assert.equal(c.kind, 'late_night');
  assert.equal(c.sleepSrc, 'total');
  const t = pickTopic(ctxOf({ fish: f }), cfgOf(), now, {});
  assert.notEqual(t?.slot, 'sleep', '总睡眠不是昨夜睡眠，不能说「昨晚睡了」');
});

test('睡眠：昨天那封今天才抓到 → 不算昨夜，这条不发', () => {
  // 2026-11-10 真踩到的：11-09 19:16 那封（睡眠 11.2h，只有总睡眠），
  // 11-10 09:27 才被轮询抓回来，抓取时间被刷新成「今天」，于是被当成昨夜。
  const now = at(9);
  const mailTs = Date.UTC(2026, 10, 3, 11, 16); // 11-03 19:16 CST
  const f = fishOf({
    sleepMin: 672,
    wakeHm: '07:20',
    sleepFrom: 'night',
    dateTs: mailTs,
    ageMin: Math.round((now - mailTs) / MIN),
  });
  const t = pickTopic(ctxOf({ fish: f }), cfgOf(), now, {});
  assert.notEqual(t?.slot, 'sleep', '邮件日期不属于这个健康日，就不能当昨夜的数据');
});

test('睡眠：今早那封、带夜间睡眠 → 照常发，时长说粗的', () => {
  const now = at(8);
  const mailTs = Date.UTC(2026, 10, 4, 0, 40); // 11-04 08:40 CST
  const f = fishOf({
    sleepMin: 392,
    deepMin: 60,
    wakeHm: '08:40',
    sleepFrom: 'night',
    dateTs: mailTs,
    ageMin: Math.round((now - mailTs) / MIN),
  });
  const t = pickTopic(ctxOf({ fish: f }), cfgOf(), now, {});
  assert.equal(t.slot, 'sleep');
  assert.match(t.brief, /六个半小时|不到七个小时|六个多小时/);
  assert.doesNotMatch(t.brief, /\d+ 小时 \d+ 分钟/);
});

test('睡眠：有夜间睡眠时用它反推，不拿总睡眠凑（两者可能差得多）', () => {
  // 夜间只睡 6h、总睡眠 9h（含白天补觉）：用总睡眠反推是 22:39（判没睡好），
  // 用夜间睡眠反推才是 01:39（真熬夜）
  const f = fishOf({ sleepMin: 360, deepMin: 90, wakeHm: '07:39', sleepFrom: 'night' });
  const c = classifySleep(f, cfgOf());
  assert.equal(c.bedHm, '01:39');
  assert.equal(c.sleepSrc, 'night');
  assert.equal(c.kind, 'late_night');
});

test('睡眠：跨零点的入睡时间反推不会翻车', () => {
  // 03:00 起、睡 5 小时 → 22:00 入睡（前一天晚上）
  const c = classifySleep(fishOf({ sleepMin: 300, deepMin: 60, wakeHm: '03:00' }), cfgOf());
  assert.equal(c.bedHm, '22:00');
  assert.equal(c.lateBed, false);
  // 08:00 起、睡 6 小时 → 02:00 入睡
  const d = classifySleep(fishOf({ sleepMin: 360, deepMin: 60, wakeHm: '08:00' }), cfgOf());
  assert.equal(d.bedHm, '02:00');
  assert.equal(d.kind, 'late_night');
});

test('睡眠：一个健康日只发一次，7 点前算前一天', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '06:30' }) });
  // 08:00 属于 2026-11-04 这个健康日
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.evidence.day, '2026-11-04');
  // 同一天再判一次 → 不再发
  assert.equal(pickTopic(ctx, cfgOf(), now, { content: { lastSleepFor: '2026-11-04' } }), null);
  // 06:30 判 → 还没到 7 点，不在窗口
  assert.equal(pickTopic(ctx, cfgOf(), at(6, 30), {}), null);
});

test('睡眠：晚上 11 点不拿早上的数据说事', () => {
  const now = at(23);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 330, ageMin: 600 }) });
  assert.equal(pickTopic(ctx, cfgOf({ share: false, catchup: false }), now, {}), null);
});

test('睡眠：睡够了就不提', () => {
  const now = at(8);
  const ctx = ctxOf({ fish: fishOf({ sleepMin: 480 }) });
  assert.equal(pickTopic(ctx, cfgOf({ share: false, catchup: false }), now, {}), null);
});

test('屏幕：晚上 + 达到 12 小时 → screen', () => {
  const now = at(22);
  const ctx = ctxOf({ fish: fishOf({ screenMin: 720 }) });
  const t = pickTopic(ctx, cfgOf({ share: false }), now, {});
  assert.equal(t.slot, 'screen');
  assert.equal(t.evidence.screenMin, 720);
});

test('屏幕：白天不提（会像查岗）', () => {
  const now = at(14);
  const ctx = ctxOf({ fish: fishOf({ screenMin: 720 }) });
  assert.equal(pickTopic(ctx, cfgOf({ share: false, catchup: false }), now, {}), null);
});

test('share：有可公开的判断就抛出来；间隔内不重复', () => {
  const now = at(16);
  const line = 'x'.repeat(80);
  const ctx = ctxOf({ self: { section: '想法', at: '11-04', line, chars: line.length } });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'share');
  assert.match(t.brief, /不能照搬/);

  const st = { content: { lastShareAt: now - 2 * HOUR, lastShareLine: line.slice(0, 80) } };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
});

test('share：判断太短就不用（没东西可说）', () => {
  const now = at(16);
  const ctx = ctxOf({ self: { section: '', at: '11-04', line: '太短了', chars: 3 } });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
});

test('有正文依据的新发现排在普通屏幕提醒前', () => {
  const now = at(22);
  const ctx = ctxOf({ fish: fishOf({ screenMin: 720 }), self: {
    section: '推理短篇', line: '这个叙述视角有点意思。', exploration: true,
    discoveryId: 'new-discovery', discovery: '两个角色看到的是同一幕',
    source: { evidence: '网页正文', url: 'https://example.org/story' },
  } });
  const due = { key: 'qq:' + (now - 5 * HOUR), at: now - 5 * HOUR, channel: 'qq', silenceMin: 300, text: '上次的提醒' };
  assert.equal(pickTopic({ ...ctx, noReply: due }, cfgOf(), now, {})?.evidence.discoveryId, 'new-discovery');
  assert.equal(pickTopic(ctx, cfgOf({ share: false }), now, {})?.slot, 'screen');
});

test('catchup：几天没说话才用', () => {
  const now = at(16);
  const ctx = ctxOf({ herTs: now - 3 * 24 * HOUR, herText: '嗯', meTs: now - 3 * 24 * HOUR + 1 });
  const t = pickTopic(ctx, cfgOf({ share: false }), now, {});
  assert.equal(t.slot, 'catchup');
  assert.equal(t.evidence.silentDays, 3);
});

test('什么由头都没有 → null，并且能说清卡在哪', () => {
  const now = at(14);
  const ctx = ctxOf({});
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
  const why = explainNoTopic(ctx, cfgOf(), now, {});
  assert.ok(why.length >= 2);
  assert.ok(why.some((x) => /鱼鱼/.test(x)));
  assert.ok(why.some((x) => /等我回/.test(x)));
});

test('looksForwarded 认标签、链接、长文本', () => {
  assert.equal(looksForwarded('#话题 文案'), true);
  assert.equal(looksForwarded('看这个 https://a.cn/x'), true);
  assert.equal(looksForwarded('啊'.repeat(200)), true);
  assert.equal(looksForwarded('在吗'), false);
});

// ---------------------------------------------------------------- 压力由头
// 压力值来自 App 首页那行「· 压力 36」，> 59 就该主动关心；
// 同时必须能一键关掉、能限一天次数，否则它是最容易变成骚扰的一类。

const DAY = '2026-11-04';

test('压力：62 > 59 → stress，带阈值和当日第几次', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 62 }) });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'stress');
  assert.equal(t.evidence.stress, 62);
  assert.equal(t.evidence.nth, 1);
  assert.equal(t.evidence.day, DAY);
  assert.match(t.brief, /62/);
});

test('压力：等于阈值（59）不算，要严格大于', () => {
  const now = at(15);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ stress: 59 }) }), cfgOf(), now, {}), null);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ stress: 60 }) }), cfgOf(), now, {}).slot, 'stress');
});

test('压力：读不到值 → 不发（不猜）', () => {
  const now = at(15);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ stress: null }) }), cfgOf(), now, {}), null);
});

test('压力：只在 09:00–22:00 之间说得出口', () => {
  const ctx = ctxOf({ fish: fishOf({ stress: 80 }) });
  assert.equal(pickTopic(ctx, cfgOf(), at(8, 30), {}), null);
  assert.equal(pickTopic(ctx, cfgOf(), at(9), {}).slot, 'stress');
  assert.equal(pickTopic(ctx, cfgOf(), at(22), {}).slot, 'stress');
  assert.equal(pickTopic(ctx, cfgOf(), at(23), {}), null);
});

test('压力：可以整个关掉', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 90 }) });
  assert.equal(pickTopic(ctx, cfgOf({ stress: false }), now, {}), null);
});

test('压力：数据超过 12 小时就不提了（隔夜的数说明不了今天）', () => {
  const now = at(15);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ stress: 80, ageMin: 60 * 13 }) }), cfgOf(), now, {}), null);
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ stress: 80, ageMin: 60 * 11 }) }), cfgOf(), now, {}).slot, 'stress');
});

test('压力：一天一次（默认），同一天第二次不再发', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 70 }) });
  const st = { content: { stressDay: DAY, stressCount: 1, lastStressAt: now - 5 * HOUR } };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
});

test('压力：把上限改成 2，第二次仍可发，且标成 nth=2', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 70 }) });
  const st = { content: { stressDay: DAY, stressCount: 1, lastStressAt: now - 5 * HOUR, lastStressValue: 62 } };
  const t = pickTopic(ctx, cfgOf({ stressDailyMax: 2 }), now, st);
  assert.equal(t.slot, 'stress');
  assert.equal(t.evidence.nth, 2);
  assert.match(t.brief, /没降/);
  // 已经用了 2 次 → 第三次不发
  const st2 = { content: { stressDay: DAY, stressCount: 2, lastStressAt: now - 5 * HOUR } };
  assert.equal(pickTopic(ctx, cfgOf({ stressDailyMax: 2 }), now, st2), null);
});

test('压力：跨健康日次数自动清零', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 70 }) });
  // 昨天的计数不该影响今天
  const st = { content: { stressDay: '2026-11-03', stressCount: 3, lastStressAt: now - 6 * HOUR } };
  assert.equal(pickTopic(ctx, cfgOf(), now, st).evidence.nth, 1);
});

test('压力：两次之间至少隔 180 分钟', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 70 }) });
  const cfg = cfgOf({ stressDailyMax: 3 });
  const near = { content: { stressDay: DAY, stressCount: 1, lastStressAt: now - 30 * MIN, lastStressValue: 70 } };
  assert.equal(pickTopic(ctx, cfg, now, near), null);
  const far = { content: { stressDay: DAY, stressCount: 1, lastStressAt: now - 200 * MIN, lastStressValue: 70 } };
  assert.equal(pickTopic(ctx, cfg, now, far).slot, 'stress');
});

test('压力：比上次低了就不再说，哪怕次数还没用完', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 61 }) });
  const st = { content: { stressDay: DAY, stressCount: 1, lastStressAt: now - 5 * HOUR, lastStressValue: 78 } };
  assert.equal(pickTopic(ctx, cfgOf({ stressDailyMax: 3 }), now, st), null);
});

test('压力：阈值和次数都能由配置改', () => {
  const now = at(15);
  const ctx = ctxOf({ fish: fishOf({ stress: 62 }) });
  // 阈值提到 70 → 62 不再触发
  assert.equal(pickTopic(ctx, cfgOf({ stressHighMin: 70 }), now, {}), null);
  // 阈值降到 55 → 触发
  assert.equal(pickTopic(ctx, cfgOf({ stressHighMin: 55 }), now, {}).slot, 'stress');
});

test('压力：优先于屏幕时间（身体信号比用多久电脑更要紧）', () => {
  const now = at(21, 30);
  const ctx = ctxOf({ fish: fishOf({ stress: 75, screenMin: 720, date: '2026-11-04' }) });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}).slot, 'stress');
});

test('压力：睡眠数据也异常时，早上仍先问睡眠', () => {
  const now = at(9, 30);
  const ctx = ctxOf({ fish: fishOf({ stress: 75, sleepMin: 380, deepMin: 90, wakeHm: '07:00' }) });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}).slot, 'sleep');
});

test('转发没看内容：由头就承认只有标题，不许装看过', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 5 * MIN, herText: '这条太顶了 #AI', meTs: now - 600 * MIN });
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'forward');
  assert.equal(t.evidence.hasContent, false);
  assert.equal(t.evidence.contentSummary, null);
  assert.match(t.brief, /标题/);
  assert.doesNotMatch(t.brief, /看过了|内容是/);
});

test('转发有内容摘要时由头才说「看过了」', () => {
  const now = at(15);
  const ctx = ctxOf({ herTs: now - 5 * MIN, herText: '这条太顶了 #AI', meTs: now - 600 * MIN });
  ctx.her.forwardSummary = 'AI 生成的猫片，最后两秒翻车';
  const t = pickTopic(ctx, cfgOf(), now, {});
  assert.equal(t.slot, 'forward');
  assert.equal(t.evidence.hasContent, true);
  assert.match(t.brief, /看过了/);
  assert.match(t.brief, /翻车/);
});

// ---- 步数由头：18 点后、新邮件、两头才算

const stepsCfg = (extra = {}) =>
  cfgOf({ sleep: false, stress: false, screen: false, share: false, catchup: false, ...extra });

test('步数：19 点收到新邮件，不到 600 步 → 少量活动记录', () => {
  const now = at(19, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 20 }) });
  const t = pickTopic(ctx, stepsCfg(), now, {});
  assert.equal(t.slot, 'steps');
  assert.equal(t.evidence.kind, 'low');
  assert.equal(t.evidence.steps, 500);
  assert.match(t.brief, /可能有漏记/);
});

test('步数：19 点走了 17000 步 → 明显偏多', () => {
  const now = at(19, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 17000, ageMin: 20 }) });
  const t = pickTopic(ctx, stepsCfg(), now, {});
  assert.equal(t.slot, 'steps');
  assert.equal(t.evidence.kind, 'high');
  assert.equal(t.evidence.steps, 17000);
  assert.match(t.brief, /明显比普通活动量多/);
});

test('步数：中间那一段（600–16000）不构成由头', () => {
  const now = at(19, 0);
  for (const steps of [600, 1200, 9000, 16000]) {
    const ctx = ctxOf({ fish: fishOf({ steps, ageMin: 20 }) });
    assert.equal(pickTopic(ctx, stepsCfg(), now, {}), null, `${steps} 步不该发`);
  }
  const reasons = explainNoTopic(ctxOf({ fish: fishOf({ steps: 4000, ageMin: 20 }) }), stepsCfg(), now, {});
  assert.ok(reasons.some((r) => /4000/.test(r)), reasons.join(' / '));
});

test('步数：18 点之前不看（白天还没走完）', () => {
  const now = at(16, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 10 }) });
  assert.equal(pickTopic(ctx, stepsCfg(), now, {}), null);
});

test('步数：邮件太旧（超过 stepsMaxAgeMin）不当新数据', () => {
  const now = at(21, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 300 }) });
  assert.equal(pickTopic(ctx, stepsCfg(), now, {}), null);
  const fresh = ctxOf({ fish: fishOf({ steps: 500, ageMin: 30 }) });
  assert.equal(pickTopic(fresh, stepsCfg(), now, {})?.slot, 'steps');
});

test('步数：一天只说一次', () => {
  const now = at(20, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 10 }) });
  const t = pickTopic(ctx, stepsCfg(), now, {});
  assert.equal(t.slot, 'steps');
  assert.equal(pickTopic(ctx, stepsCfg(), now, { content: { lastStepsFor: t.evidence.day } }), null);
});

test('步数：可以收紧阈值，旧配置不能放宽新门槛', () => {
  const now = at(19, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 4000, ageMin: 20 }) });
  assert.equal(pickTopic(ctx, stepsCfg(), now, {}), null);
  assert.equal(pickTopic(ctx, stepsCfg({ stepsLowMax: 5000, stepsHighMin: 3000 }), now, {}), null);
  const low = ctxOf({ fish: fishOf({ steps: 500, ageMin: 20 }) });
  const high = ctxOf({ fish: fishOf({ steps: 17000, ageMin: 20 }) });
  assert.equal(pickTopic(low, stepsCfg({ stepsLowMax: 400 }), now, {}), null);
  assert.equal(pickTopic(high, stepsCfg({ stepsHighMin: 18000 }), now, {}), null);
});

test('步数：关掉开关就不选', () => {
  const now = at(19, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 10 }) });
  assert.equal(pickTopic(ctx, stepsCfg({ steps: false }), now, {}), null);
});

test('步数：手机端总闸关掉时也不选', () => {
  const now = at(19, 0);
  const ctx = ctxOf({ fish: fishOf({ steps: 500, ageMin: 10 }) });
  const cfg = { ...stepsCfg(), sources: { phone: { enabled: false } } };
  assert.equal(pickTopic(ctx, cfg, now, {}), null);
});

// ---- 只看电脑的三类：深夜没睡 / 坐太久 / 刚回来（不接手机 App 时的主力）

const pcCtx = (o = {}) => {
  const ctx = ctxOf({ herTs: o.herTs ?? null, herText: o.herText ?? '', meTs: o.meTs ?? null });
  ctx.presence = { idleSec: o.idleSec ?? 30 };
  ctx.clock = o.clock ?? '12:00';
  return ctx;
};

test('深夜 23:40 她还在电脑前 → lateUp', () => {
  const now = at(23, 40);
  const ctx = pcCtx({ clock: '23:40' });
  const st = { pc: { day: '2026-11-04', activeSince: at(22), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 } };
  const t = pickTopic(ctx, cfgOf(), now, st);
  assert.equal(t.slot, 'lateUp');
  assert.match(t.brief, /23:40/);
  assert.ok(t.evidence.nightKey);
});

test('深夜同一晚只提一次', () => {
  const now = at(23, 40) + 90 * MIN; // 次日 00:10，仍算同一晚
  const ctx = pcCtx();
  const first = pickTopic(ctx, cfgOf(), at(23, 40), { pc: {} });
  const st = { content: { lastLateUpFor: first.evidence.nightKey }, pc: {} };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
});

test('深夜但人不在（空闲太久）→ 不算', () => {
  const now = at(23, 40);
  const ctx = pcCtx({ idleSec: 1800 });
  assert.equal(pickTopic(ctx, cfgOf(), now, { pc: {} }), null);
});

test('电脑连续活跃 5 小时 → longSit，记录起始时间', () => {
  const now = at(16);
  const ctx = pcCtx();
  const st = { pc: { day: '2026-11-04', activeSince: at(11), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 } };
  const t = pickTopic(ctx, cfgOf(), now, st);
  assert.equal(t.slot, 'longSit');
  assert.equal(t.evidence.since, '11:00');
  assert.match(t.brief, /实际坐了多久未知/);
});

test('步数、屏幕、久坐降为最后候选，并跨类型共用冷却', () => {
  const now = at(22);
  const ctx = ctxOf({ fish: fishOf({ screenMin: 720 }) });
  const recentSteps = { feedback: { slots: { steps: { lastSentAt: now - 95 * HOUR } } } };
  assert.equal(pickTopic(ctx, cfgOf(), now, recentSteps), null);
  recentSteps.feedback.slots.steps.lastSentAt -= HOUR;
  assert.equal(pickTopic(ctx, cfgOf(), now, recentSteps)?.slot, 'screen');
  assert.equal(pickTopic(ctxOf({ fish: fishOf({ screenMin: 600 }) }), cfgOf(), now, {}), null);
  const self = { section: '追漫画', line: '这个转场还挺有意思', chars: 10, exploration: true };
  assert.equal(pickTopic({ ...ctx, self }, cfgOf(), now, {})?.slot, 'share');
});

test('坐太久今天说过一次就不再提', () => {
  const now = at(16);
  const ctx = pcCtx();
  const st = {
    content: { lastLongSitFor: '2026-11-04' },
    pc: { day: '2026-11-04', activeSince: at(11), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 },
  };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
});

test('离开 45 分钟又回来、她两小时没说话 → backHome', () => {
  const now = at(15);
  const ctx = pcCtx({ herTs: now - 5 * HOUR, meTs: now - 4 * HOUR });
  const st = { pc: { day: '2026-11-04', activeSince: 0, awaySince: 0, lastReturnAt: at(14, 50), lastAwayMs: 45 * MIN } };
  const t = pickTopic(ctx, cfgOf(), now, st);
  assert.equal(t.slot, 'backHome');
  assert.match(t.brief, /45 分钟/);
});

test('她刚说过话 → 不用「刚回来」再开场', () => {
  const now = at(15);
  const ctx = pcCtx({ herTs: now - 20 * MIN, meTs: now - 30 * MIN });
  const st = { pc: { day: '2026-11-04', activeSince: 0, awaySince: 0, lastReturnAt: at(14, 50), lastAwayMs: 45 * MIN } };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
});

test('手机端总闸关着时，这三类照样能出（数据只来自本机探针）', () => {
  const now = at(23, 40);
  const ctx = pcCtx();
  const cfg = { ...cfgOf(), sources: { phone: { enabled: false } } };
  const st = { pc: { day: '2026-11-04', activeSince: at(22), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 } };
  assert.equal(pickTopic(ctx, cfg, now, st)?.slot, 'lateUp');
});

test('三类开关都能单独关掉', () => {
  const now = at(23, 40);
  const ctx = pcCtx();
  const st = { pc: { day: '2026-11-04', activeSince: at(22), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 } };
  const off = cfgOf({ lateUp: false, longSit: false, backHome: false });
  assert.equal(pickTopic(ctx, off, now, st), null);
});

test('fishStale：超过 staleHours 才算停；dateTs 缺失当作新鲜', () => {
  const now = at(8);
  const fresh = fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00', dateTs: now - 5 * HOUR });
  const old = fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00', dateTs: now - 50 * HOUR });
  assert.equal(fishStale(fresh, cfgOf(), now).stale, false);
  const r = fishStale(old, cfgOf(), now);
  assert.equal(r.stale, true);
  assert.equal(Math.round(r.ageHours), 50);
  assert.equal(r.limitHours, 36);
  // 没有 dateTs / 没有邮件 → 不判过期（宁可照旧，也别因为读不到邮件头全停）
  assert.equal(fishStale(fishOf({ sleepMin: 380 }), cfgOf(), now).stale, false);
  assert.equal(fishStale({ ok: false }, cfgOf(), now).stale, false);
  // 阈值可调，下限 6 小时
  assert.equal(fishStale(old, { ...cfgOf(), sources: { phone: { staleHours: 100 } } }, now).stale, false);
  assert.equal(fishStale(old, { ...cfgOf(), sources: { phone: { staleHours: 1 } } }, now).limitHours, 6);
  // 总闸关掉：不管多旧都当新鲜
  assert.equal(fishStale(old, { ...cfgOf(), sources: { phone: { staleGuard: false } } }, now).stale, false);
});

test('数据过期：睡眠/压力/步数/屏幕四类都不再当由头，--why 说得出原因', () => {
  const now = at(8);
  const fish = fishOf({ sleepMin: 380, deepMin: 90, wakeHm: '07:00', dateTs: now - 50 * HOUR });
  const ctx = ctxOf({ fish });
  assert.equal(pickTopic(ctx, cfgOf(), now, {}), null);
  const why = explainNoTopic(ctx, cfgOf(), now, {}).join('\n');
  assert.match(why, /鱼鱼数据 50 小时没更新/);
  // 同一份数据，时间改新鲜了就照旧构成由头
  const fresh = { ...fish, dateTs: now - 5 * HOUR };
  assert.equal(pickTopic(ctxOf({ fish: fresh }), cfgOf(), now, {}).slot, 'sleep');
});

test('刚回来这一类：两小时内说过一次就不再提（她嫌话题全围着电脑）', () => {
  const now = at(15);
  const ctx = pcCtx({ herTs: now - 5 * HOUR, meTs: now - 4 * HOUR });
  const pc = { day: '2026-11-04', activeSince: 0, awaySince: 0, lastReturnAt: at(14, 50), lastAwayMs: 45 * MIN };
  const st = { content: { lastBackSendAt: now - 30 * MIN }, pc };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);

  const ok = { content: { lastBackSendAt: now - 3 * HOUR }, pc: { ...pc, lastReturnAt: at(14, 50) } };
  assert.equal(pickTopic(ctx, cfgOf(), now, ok)?.slot, 'backHome');
});

test('最近四条里两句都在说她坐屏幕前 → 这一拍换掉', () => {
  const now = at(16);
  const ctx = pcCtx();
  const pc = { day: '2026-11-04', activeSince: at(11), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 };
  const base = { pc };
  assert.equal(pickTopic(ctx, cfgOf(), now, base)?.slot, 'longSit');

  const st = {
    content: { recentSends: ['你今天屏幕十个小时。', '别在电脑前硬撑了。', '吃饭了没。'] },
    pc,
  };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);
  assert.equal(pickTopic(ctx, { ...cfgOf(), debugMode: true }, now, st), null);
});

test('同一类由头连着两拍 → 第三拍不再来', () => {
  const now = at(16);
  const ctx = pcCtx();
  const pc = { day: '2026-11-04', activeSince: at(11), awaySince: 0, lastReturnAt: 0, lastAwayMs: 0 };
  const st = { content: { recentSlots: ['longSit', 'longSit'] }, pc };
  assert.equal(pickTopic(ctx, cfgOf(), now, st), null);

  assert.equal(pickTopic(ctx, { ...cfgOf(), debugMode: true }, now, st)?.slot, 'longSit');

  const once = { content: { recentSlots: ['share', 'longSit'] }, pc };
  assert.equal(pickTopic(ctx, cfgOf(), now, once)?.slot, 'longSit');
});

test('调试模式让连续两条分享后的新探索通过同类检查', () => {
  const now = at(20);
  const ctx = ctxOf({ self: { section: '漫画分镜', line: '有个漫画分镜用留白做出了空间感。', exploration: true } });
  const cfg = cfgOf({ shareGapMin: 0 });
  const st = { content: { recentSlots: ['share', 'share'] } };
  const misses = new Map();
  assert.deepEqual([...topicCandidates(ctx, cfg, now, st, undefined, misses)], []);
  assert.equal(misses.get('share'), 'repeated');
  assert.equal([...topicCandidates(ctx, { ...cfg, debugMode: true }, now, st, undefined, misses)][0]?.slot, 'share');
  assert.equal(misses.has('share'), false);
});

test('选题遍历记录分由头原因，与实际的开关、时段和数据门槛一致', () => {
  const now = Date.UTC(2026, 10, 21, 3);
  const cfg = { ...cfgOf(), sources: { phone: { staleHours: 36 } },
    content: { topics: { sleep: false, stepsFromHour: 18 } } };
  const ctx = { tz: 'Asia/Shanghai', fish: { ok: true, steps: 120, ageMin: 10, dateTs: now - 74 * 3_600_000 } };
  const misses = new Map();
  [...topicCandidates(ctx, cfg, now, {}, undefined, misses)];
  assert.equal(misses.get('sleep'), 'disabled');
  assert.equal(misses.get('steps'), 'fish_stale');
  assert.equal(misses.get('share'), 'no_data');

  ctx.fish.dateTs = now - 10 * 60_000;
  misses.clear();
  [...topicCandidates(ctx, cfg, now, {}, undefined, misses)];
  assert.equal(misses.get('steps'), 'out_of_window');
});

test('课表已经产出候选，迭代到下一个由头时也没有误记未命中', () => {
  const cfg = { ...cfgOf(), content: { agenda: { text: '周三 01:15-02:00 电机学' }, topics: {} } };
  const ctx = {
    tz: 'Asia/Shanghai', presence: { idleSec: 0 },
    self: { discoveryId: 'new', exploration: true, line: '我发现了一个新进展。' },
  };
  const st = { content: { lastAgendaSoon: '2026-11-04:75' } };
  const misses = new Map();
  const candidates = topicCandidates(ctx, cfg, at(1), st, undefined, misses);
  const first = candidates.next().value;
  assert.equal(first.slot, 'agenda');
  assert.equal(first.evidence.kind, 'early');
  assert.equal(candidates.next().value.slot, 'share');
  assert.equal(misses.has('agenda'), false);
});
