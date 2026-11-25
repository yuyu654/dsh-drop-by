// exams.test.mjs —— 考试：一行一场；考前一周提复习（按天），考前几十分钟提快考了（按分钟）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExams, examKey, reviewDue, soonDue, dayDiff } from '../src/perception/exams.js';
import { pickTopic } from '../src/decision/topics.js';
import { renderTemplate } from '../src/decision/compose.js';

const TZ = 'Asia/Shanghai';
const at = (mo, d, h, m = 0) => Date.UTC(2026, mo - 1, d, h - 8, m);

const TEXT = [
  '2026-12-20 09:00 电机学 @教三201',
  '12月18日 14:00-16:00 电力电子 教三201',
  '11/09 08:30 概率论',
  '没写年份也能认 12-31 10:00 电磁场',
  '# 注释行跳过',
].join('\n');

test('解析：年月日三种写法、缺年份、场地、注释行', () => {
  const list = parseExams(TEXT, { now: at(11, 5, 20) });
  assert.equal(list.length, 3); // 「没写年份也能认」那行前面不是日期，跳过
  assert.deepEqual(list.map((e) => e.date), ['2026-11-09', '2026-12-18', '2026-12-20']);
  assert.deepEqual(list.map((e) => e.hm), ['08:30', '14:00', '09:00']);
  assert.deepEqual(list.map((e) => e.subject), ['概率论', '电力电子', '电机学']);
  assert.equal(list[1].room, '教三201');
  assert.equal(list[2].room, '教三201');
  assert.equal(list[0].room, '');
});

test('没写年份：日子还没到就是今年，已经过了就当下一年', () => {
  const early = parseExams('01-05 09:00 高数', { now: at(11, 5, 20) });
  assert.equal(early[0].date, '2027-01-05');
  const later = parseExams('12-31 10:00 电磁场', { now: at(11, 5, 20) });
  assert.equal(later[0].date, '2026-12-31');
});

test('复习窗口按天：日历日差正好 7 天那次提，差 6 天/8 天都不提', () => {
  const exam = parseExams('2026-11-12 09:00 电机学', { now: at(11, 5, 20) })[0];
  const now = at(11, 5, 20);
  assert.equal(dayDiff(exam, now, TZ), 7);
  assert.equal(reviewDue([exam], now, TZ, 7)?.subject, '电机学');
  assert.equal(reviewDue([exam], now, TZ, 6), null);
  assert.equal(reviewDue([exam], now, TZ, 8), null);
  // 已经开考了就不再提醒复习
  assert.equal(reviewDue([exam], at(11, 12, 10), TZ, 0), null);
});

test('快考了按分钟：进窗口才提，过了 60 分钟窗口就不提；开考后不提', () => {
  const exam = parseExams('2026-11-06 09:00 电机学', { now: at(11, 5, 20) })[0];
  assert.equal(soonDue([exam], at(11, 6, 8, 1), 60)?.subject, '电机学'); // 59 分钟
  assert.equal(soonDue([exam], at(11, 6, 7, 59), 60), null); // 61 分钟
  assert.equal(soonDue([exam], at(11, 6, 9, 1), 60), null); // 已开考
});

test('同一场考试 key 不变；改了时间就是新的一场', () => {
  const a = parseExams('2026-12-20 09:00 电机学 @教三201', { now: at(11, 5, 20) })[0];
  const b = parseExams('12月20日 09:00 电机学 教三201', { now: at(11, 5, 20) })[0];
  assert.equal(examKey(a), examKey(b));
  const c = parseExams('2026-12-20 14:00 电机学 @教三201', { now: at(11, 5, 20) })[0];
  assert.notEqual(examKey(a), examKey(c));
});

const cfgOf = (o = {}) => ({
  timezone: TZ,
  idle: { awaySec: 600 },
  content: {
    mode: 'template',
    topics: { ...(o.topics || {}) },
    agenda: { text: '', termStart: '', periods: '', off: [] },
    exams: { text: o.text ?? '' },
  },
});
const ctxOf = () => ({
  tz: TZ,
  her: { lastTs: null, lastText: '', lastAgoSec: null },
  me: { lastTs: null, lastText: '', lastAgoSec: null },
  fish: { ok: false },
  presence: { idleSec: 10 },
  recent: [],
});

test('由头：考前 30 分钟 → examSoon；同一场只提一次', () => {
  const now = at(11, 6, 8, 30);
  const t = pickTopic(ctxOf(), cfgOf({ text: '2026-11-06 09:00 电机学 @教三201' }), now, {});
  assert.equal(t.slot, 'examSoon');
  assert.equal(t.evidence.leftMin, 30);
  assert.equal(t.evidence.room, '教三201');
  assert.match(t.brief, /还有 30 分钟/);
  assert.equal(renderTemplate(t, ctxOf()), '还有 30 分钟开考。东西带齐，别慌。');
  const again = pickTopic(ctxOf(), cfgOf({ text: '2026-11-06 09:00 电机学 @教三201' }), now, {
    content: { lastExamSoon: t.evidence.key },
  });
  assert.notEqual(again?.slot, 'examSoon');
});

test('考前多久可改（按分钟）：改成 5 分钟，30 分钟前就不吭声', () => {
  const now = at(11, 6, 8, 30);
  const t = pickTopic(ctxOf(), cfgOf({ text: '2026-11-06 09:00 电机学', topics: { examSoonMin: 5 } }), now, {});
  assert.notEqual(t?.slot, 'examSoon');
  const off = pickTopic(ctxOf(), cfgOf({ text: '2026-11-06 09:00 电机学', topics: { examSoon: false } }), now, {});
  assert.notEqual(off?.slot, 'examSoon');
});

test('由头：考前 7 天 → examReview；天数可改；只提一次', () => {
  const now = at(11, 5, 20);
  const text = '2026-11-12 09:00 电机学';
  const t = pickTopic(ctxOf(), cfgOf({ text }), now, {});
  assert.equal(t.slot, 'examReview');
  assert.equal(t.evidence.days, 7);
  assert.match(t.brief, /还有 7 天考「电机学」/);
  assert.match(renderTemplate(t, ctxOf()), /7 天后考「电机学」/);
  const again = pickTopic(ctxOf(), cfgOf({ text }), now, { content: { lastExamReview: t.evidence.key } });
  assert.notEqual(again?.slot, 'examReview');
  // 改成提前 10 天：7 天前不再提
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text, topics: { examReviewDays: 10 } }), now, {})?.slot, 'examReview');
  // 关掉复习提醒
  assert.notEqual(pickTopic(ctxOf(), cfgOf({ text, topics: { examReview: false } }), now, {})?.slot, 'examReview');
});