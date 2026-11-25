// agenda.test.mjs —— 课表：一行一节，早课前一晚催睡、下一节课前提醒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgenda, weekdayOf, coursesOn, coursesTomorrow, nextCourse, currentWeek, courseApplies, courseKey, courseEnabled, parsePeriods } from '../src/perception/agenda.js';
import { pickTopic } from '../src/decision/topics.js';

const TZ = 'Asia/Shanghai';
// 2026-11-04 是周三；用 UTC 换算成北京时间
const at = (d, h, m = 0) => Date.UTC(2026, 10, d, h - 8, m);
const MIN = 60_000;

const TEXT = [
  '周一 08:00-09:40 电机学',
  '星期一 14:00-15:40 电力电子',
  '周三 10:00~11:40 信号与系统',
  '周五 08:00-09:40',
  '# 这行是注释',
  '周四 8:00-9:40 半角也行',
  '周三 9:00-8:00 结束早于开始，跳过',
  '周五 08:00-09:40 晚课当实习',
].join('\n');

test('解析：周几/全角冒号/波浪号/半角/没写课名都认，坏行跳过', () => {
  const list = parseAgenda(TEXT);
  assert.equal(list.length, 6); // 周五两节同时间也照收（课表本来就可能有重叠）
  const mon = list.filter((c) => c.weekday === 1);
  assert.equal(mon.length, 2);
  assert.equal(mon[0].fromMin, 480);
  assert.equal(mon[0].name, '电机学');
  const wed = list.filter((c) => c.weekday === 3);
  assert.equal(wed.length, 1);
  assert.equal(wed[0].name, '信号与系统');
  assert.equal(list.find((c) => c.weekday === 5).name, '');
});

test('weekdayOf：周日是 7，周一是 1', () => {
  assert.equal(weekdayOf(at(4, 12), TZ), 3); // 11-04 周三
  assert.equal(weekdayOf(at(8, 12), TZ), 7); // 11-08 周日
});

test('coursesTomorrow：周日的明天是周一，不会跳过', () => {
  const sun = at(8, 20);
  const list = coursesTomorrow(TEXT, sun, TZ);
  assert.equal(list.length, 2);
  assert.equal(list[0].weekday, 1);
  assert.equal(coursesOn(TEXT, 1).length, 2);
});

test('nextCourse：先给今天还没开始的，今天的都过了才给明天', () => {
  const wed9 = at(4, 9);
  const nc = nextCourse(TEXT, wed9, TZ);
  assert.equal(nc.weekday, 3);
  assert.equal(nc.fromMin, 600);
  assert.equal(nc.inDays, 0);
  const wed12 = at(4, 12);
  const later = nextCourse(TEXT, wed12, TZ);
  assert.equal(later.weekday, 4); // 周三的课都过了，下一节是周四早上八点
  assert.equal(later.inDays, 1);
});

test('课表空：nextCourse 返回 null，不抛', () => {
  assert.equal(nextCourse('', at(4, 12), TZ), null);
  assert.deepEqual(parseAgenda('随便写点什么'), []);
});

// ---------------------------------------------------------------- 整学期 / 周次

test('周次：1-16周、1-8,10-16周、单周、双周都认，「第3-4节」也能换算成时间', () => {
  const list = parseAgenda(
    [
      '周一 08:00-09:40 电机学 (1-16周)',
      '周二 10:00-11:40 电路 单周',
      '周三 第3-4节 电力电子 1-8,10-16周',
      '周四 09:50-11:30 概率论 双周',
    ].join('\n')
  );
  assert.deepEqual(list[0].weeks, { ranges: [[1, 16]], parity: null });
  assert.equal(list[0].name, '电机学');
  assert.equal(list[1].weeks.parity, 'odd');
  assert.equal(list[1].name, '电路');
  assert.equal(list[2].fromMin, 600); // 第 3-4 节 = 10:00
  assert.equal(list[2].toMin, 700);
  assert.deepEqual(list[2].weeks.ranges, [[1, 8], [10, 16]]);
  assert.equal(list[3].weeks.parity, 'even');
  assert.equal(list[3].name, '概率论');
});

test('currentWeek：开学第一周的周一 → 第 9 周；没填或填错就是 null', () => {
  assert.equal(currentWeek(at(4, 12), TZ, '2026-09-07'), 9);
  assert.equal(currentWeek(at(4, 12), TZ, ''), null);
  assert.equal(currentWeek(at(4, 12), TZ, '9月7日'), null);
});

test('courseApplies：周次 + 单双周；没写周次的课每周都上', () => {
  const [c] = parseAgenda('周一 08:00-09:40 电机学 1-8周');
  assert.equal(courseApplies(c, 3), true);
  assert.equal(courseApplies(c, 9), false);
  const [odd] = parseAgenda('周一 08:00-09:40 电路 单周');
  assert.equal(courseApplies(odd, 5), true);
  assert.equal(courseApplies(odd, 6), false);
  const [plain] = parseAgenda('周一 08:00-09:40 电机学');
  assert.equal(courseApplies(plain, 9), true);
});

test('nextCourse：第 9 周时 1-8 周的课自动跳过；没填开学日期就不过滤', () => {
  const text = ['周一 08:00-09:40 电机学 1-8周', '周二 14:00-15:40 电力电子'].join('\n');
  const mon7 = at(2, 7); // 周一 07:00
  const withTerm = nextCourse(text, mon7, TZ, { termStart: '2026-09-07' });
  assert.equal(withTerm.inDays, 1);
  assert.equal(withTerm.name, '电力电子');
  assert.equal(withTerm.week, 9);
  const noTerm = nextCourse(text, mon7, TZ);
  assert.equal(noTerm.inDays, 0);
  assert.equal(noTerm.name, '电机学');
});

test('coursesTomorrow：按明天的周次筛，周次过了就不算明天的课', () => {
  const text = '周二 08:00-09:40 电机学 1-8周';
  assert.equal(coursesTomorrow(text, at(2, 21), TZ, { termStart: '2026-09-07' }).length, 0);
  assert.equal(coursesTomorrow(text, at(2, 21), TZ).length, 1);
});

// ---------------------------------------------------------------- 由头

const cfgOf = (o = {}) => ({
  timezone: TZ,
  idle: { awaySec: 600 },
  content: {
    mode: 'template',
    agenda: { text: o.text ?? TEXT, termStart: o.termStart ?? '', periods: o.periods ?? '', off: o.off ?? [] },
    topics: { ...(o.topics || {}) },
  },
});

const ctxOf = (o = {}) => ({
  tz: TZ,
  her: { lastTs: o.herTs ?? null, lastText: '', lastAgoSec: null },
  me: { lastTs: o.meTs ?? null, lastText: '', lastAgoSec: null },
  fish: { ok: false },
  presence: { idleSec: o.idleSec ?? 10 },
  recent: [],
});

test('周日晚上：明早有早八 → agenda/early，且一晚只提一次', () => {
  const now = at(8, 21, 30); // 周日 21:30
  const cfg = cfgOf();
  const t = pickTopic(ctxOf(), cfg, now, {});
  assert.equal(t.slot, 'agenda');
  assert.equal(t.evidence.kind, 'early');
  assert.equal(t.evidence.at, '08:00');
  assert.equal(t.evidence.when, '明天');
  assert.match(t.brief, /明天早上 08:00/);
  // 同一晚已经提过 → 不再提
  const used = { content: { lastAgendaNight: t.evidence.nightKey } };
  const t2 = pickTopic(ctxOf(), cfg, now + 30 * MIN, used);
  assert.notEqual(t2?.slot, 'agenda');
});

test('周三 21:30：明天周四 8 点有课也算早课', () => {
  const now = at(4, 21, 30);
  const t = pickTopic(ctxOf(), cfgOf(), now, {});
  assert.equal(t.slot, 'agenda');
  assert.equal(t.evidence.at, '08:00');
});

test('晚上但明天第一节是 9:50：不算早课，不催睡', () => {
  const now = at(4, 21, 30);
  const text = '周四 09:50-11:30 概率论';
  const t = pickTopic(ctxOf(), cfgOf({ text }), now, {});
  assert.notEqual(t?.slot, 'agenda');
});

test('提前说明天的课：18 点前不算（太早像通知）', () => {
  const now = at(4, 17);
  const t = pickTopic(ctxOf(), cfgOf(), now, {});
  assert.notEqual(t?.slot, 'agenda');
});

test('下一节 15 分钟后开始：agenda/soon，人在电脑前才提（默认 20 分钟内）', () => {
  const now = at(4, 9, 45); // 周三 10:00 信号与系统
  const t = pickTopic(ctxOf(), cfgOf(), now, {});
  assert.equal(t.slot, 'agenda');
  assert.equal(t.evidence.kind, 'soon');
  assert.equal(t.evidence.leftMin, 15);
  assert.match(t.brief, /还有 15 分钟/);
  // 人不在（空闲超过阈值）→ 不提
  const away = pickTopic(ctxOf({ idleSec: 3600 }), cfgOf(), now, {});
  assert.notEqual(away?.slot, 'agenda');
});

test('提前多少分钟可以改：默认 20 分钟内的才提，30 分钟前不吭声', () => {
  const half = at(4, 9, 30); // 距 10:00 还有 30 分钟
  assert.notEqual(pickTopic(ctxOf(), cfgOf(), half, {})?.slot, 'agenda');
  // 设置页改成 45 分钟 → 30 分钟前就该提
  const wide = pickTopic(ctxOf(), cfgOf({ topics: { agendaSoonMin: 45 } }), half, {});
  assert.equal(wide?.slot, 'agenda');
  assert.equal(wide.evidence.leftMin, 30);
});

test('同一节课只提一次（按 日期:开始分钟 去重）', () => {
  const now = at(4, 9, 45);
  const t = pickTopic(ctxOf(), cfgOf(), now, {});
  const used = { content: { lastAgendaSoon: t.evidence.key } };
  const again = pickTopic(ctxOf(), cfgOf(), now + 5 * MIN, used);
  assert.notEqual(again?.slot, 'agenda');
});

test('课表由头关掉 / 课表没填：都不会冒出来', () => {
  const now = at(8, 21, 30);
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ topics: { agenda: false } }), now, {})?.slot, 'agenda');
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text: '' }), now, {})?.slot, 'agenda');
});

test('被反馈闭环压住的那一类会跳过（课表也压）', () => {
  const now = at(8, 21, 30);
  const st = { feedback: { pending: [], streak: 0, slots: { agenda: { sent: 9, replied: 0, latencySum: 0, coldUntil: now + 3 * 86_400_000 } } } };
  const t = pickTopic(ctxOf(), cfgOf(), now, st);
  assert.notEqual(t?.slot, 'agenda');
});

test('整学期课表：第 9 周不再提 1-8 周的早课；单周课在单周还提、双周课在双周不提', () => {
  const mon = at(2, 21, 30); // 周一 21:30，第 9 周（单周）
  const termStart = '2026-09-07';
  // 1-8 周：第 9 周已结课，明早没有课
  const ended = '周二 08:00-09:40 电机学 1-8周';
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text: ended, termStart }), mon, {})?.slot, 'agenda');
  // 没填开学日期：不敢拿周次挡，照常提
  assert.equal(pickTopic(ctxOf(), cfgOf({ text: ended }), mon, {})?.slot, 'agenda');
  // 第 9 周是单周：单周课提，双周课不提
  const odd = '周二 08:00-09:40 电路 单周';
  assert.equal(pickTopic(ctxOf(), cfgOf({ text: odd, termStart }), mon, {})?.slot, 'agenda');
  const even = '周二 08:00-09:40 电路 双周';
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text: even, termStart }), mon, {})?.slot, 'agenda');
  // 第 10 周（双周）反过来
  const mon10 = at(9, 21, 30);
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text: odd, termStart }), mon10, {})?.slot, 'agenda');
  assert.equal(pickTopic(ctxOf(), cfgOf({ text: even, termStart }), mon10, {})?.slot, 'agenda');
});

test('作息表能自己填：写「第1-2节」时按填的时间算，空则用内置', () => {
  const t = '周一 第1-2节 电机学';
  assert.equal(parseAgenda(t)[0].fromMin, 480); // 内置 08:00
  const custom = parseAgenda(t, { periods: '1-2 08:30-10:10' })[0];
  assert.equal(custom.fromMin, 510);
  assert.equal(custom.toMin, 610);
  // 课表里已经写了具体时间的行，作息表再怎么填都不影响它
  const fixed = parseAgenda('周一 09:00-10:40 电机学', { periods: '1-2 08:30-10:10' })[0];
  assert.equal(fixed.fromMin, 540);
  assert.deepEqual(parsePeriods('1-2 08:30-10:10\n乱写一行\n3-4 10:30-12:10').map((p) => p.slice(0, 2)), [[1, 2], [3, 4]]);
});

test('教室：@、地点：、末尾带教室/楼的词、3-201 这种编号都认，且不留在课名里', () => {
  const list = parseAgenda(
    ['周一 08:00-09:40 电机学 @教三201', '周二 10:00-11:40 电路 地点：实验楼302', '周三 14:00-15:40 概率论 3-201', '周四 08:00-09:40 信号与系统 教二101'].join('\n')
  );
  assert.deepEqual(list.map((c) => c.room), ['教三201', '实验楼302', '3-201', '教二101']);
  assert.deepEqual(list.map((c) => c.name), ['电机学', '电路', '概率论', '信号与系统']);
});

test('课程可以逐节勾掉：取消勾选的课不再提，回复勾选又提', () => {
  const text = '周三 10:00-11:40 信号与系统';
  const now = at(4, 9, 45); // 距 10:00 还有 15 分钟
  const c = parseAgenda(text)[0];
  assert.equal(courseEnabled(c, []), true);
  assert.equal(courseEnabled(c, [courseKey(c)]), false);
  assert.equal(pickTopic(ctxOf(), cfgOf({ text }), now, {})?.slot, 'agenda');
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text, off: [courseKey(c)] }), now, {})?.slot, 'agenda');
  // 勾掉的课也不算「明天早上的课」
  const early = '周四 08:00-09:40 电路';
  const wedNight = at(4, 21, 30);
  assert.equal(pickTopic(ctxOf(), cfgOf({ text: early, termStart: '2026-09-07' }), wedNight, {})?.slot, 'agenda');
});