// fish-parse.test.mjs —— 邮件摘要 → 数字。睡眠由头全靠这一层，抠错就全错。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFishSummary, minsOf } from '../src/decision/context.js';

// 真实邮件正文（构建 7 之后：只发解析结果，不发页面原文）
const REAL = [
  '起床 07:57 · 睡眠 7.6h · 步数 6045 · 压力 36 · 心率 72 · 血氧 97%',
  '睡眠详情',
  '夜间睡眠：7 小时 39 分钟',
  '深睡：2 小时 25 分钟',
  '浅睡：3 小时 59 分钟',
  '快速眼动：1 小时 15 分钟',
  '屏幕时间：5 小时 12 分（微信 48 分、浏览器 32 分）',
].join('\n');

test('解析真实邮件正文：四项 + 起床时间', () => {
  const r = parseFishSummary(REAL);
  assert.equal(r.sleepMin, 7 * 60 + 39);
  assert.equal(r.deepMin, 2 * 60 + 25);
  assert.equal(r.lightMin, 3 * 60 + 59);
  assert.equal(r.remMin, 75);
  assert.equal(r.screenMin, 5 * 60 + 12);
  assert.equal(r.wakeHm, '07:57');
});

test('睡眠详情优先于首页的 7.6h（详情能到分钟）', () => {
  const r = parseFishSummary(REAL);
  assert.notEqual(r.sleepMin, 456); // 7.6h = 456 分，不该被采用
});

test('只有首页那行（详情没采到）时，用 x.xh 兜底', () => {
  const r = parseFishSummary('起床 06:44 · 睡眠 6.3h · 步数 900 · 压力 40 · 心率 68 · 血氧 96%');
  assert.equal(r.sleepMin, 378); // 6.3h
  assert.equal(r.deepMin, null); // 没详情就是 null，不猜
  assert.equal(r.wakeHm, '06:44');
});

test('简介里的「· 睡眠 7.6h」不会被当成「睡眠时间：」误取', () => {
  assert.equal(minsOf('7.6h'), null);
  const r = parseFishSummary('夜间睡眠：7 小时 5 分钟\n· 睡眠 9.9h');
  assert.equal(r.sleepMin, 425);
});

test('起床时间也认「23:41-07:57」这种区间（取后半段）', () => {
  assert.equal(parseFishSummary('23:41-07:57 睡了 8 小时').wakeHm, '07:57');
  assert.equal(parseFishSummary('起床：06:15').wakeHm, '06:15');
});

test('入睡时间：读得到就用，读不到 null，不拿区间或时长凑', () => {
  assert.equal(parseFishSummary('入睡时间：23:41\n起床 07:20').bedHm, '23:41');
  assert.equal(parseFishSummary('入睡 0:55').bedHm, '00:55');
  assert.equal(parseFishSummary('睡着时间 01:07').bedHm, '01:07');
  // 空字段 / 没这一项 / 只有「入睡用时」→ 都是 null，不猜
  assert.equal(parseFishSummary('入睡时间：--\n起床 07:20').bedHm, null);
  assert.equal(parseFishSummary('起床 07:57 · 睡眠 7.6h').bedHm, null);
  assert.equal(parseFishSummary('入睡用时 12 分钟').bedHm, null);
  // 睡眠区间「23:41-07:57」不能被当成入睡时间
  assert.equal(parseFishSummary('23:41-07:57 睡了 8 小时').bedHm, null);
});

test('总睡眠和夜间睡眠分开记：判定优先夜间，没有才退回总睡眠', () => {
  // 真实邮件的样子：首页 11.1h（总睡眠，含白天小睡）+ 详情 8 小时 8 分（夜间）
  const both = parseFishSummary(
    [
      '起床 07:39 · 睡眠 11.1h · 步数 8731 · 压力 55',
      '睡眠详情：睡眠时间 8小时8分钟 · 深睡 2小时10分钟 · 浅睡 4小时22分钟 · 快速眼动 1小时36分钟',
    ].join('\n'),
  );
  assert.equal(both.totalMin, Math.round(11.1 * 60));
  assert.equal(both.nightMin, 488);
  assert.equal(both.sleepMin, 488, '夜间优先');
  assert.equal(both.sleepFrom, 'night');
  // 只有首页那行（一天只采一次的常见情况）→ 退回总睡眠
  const totalOnly = parseFishSummary('起床 07:39 · 睡眠 8.8h · 步数 2404');
  assert.equal(totalOnly.nightMin, null);
  assert.equal(totalOnly.sleepMin, Math.round(8.8 * 60));
  assert.equal(totalOnly.sleepFrom, 'total');
  // 两个都没读到
  const none = parseFishSummary('起床 未读到 · 睡眠 未读到');
  assert.equal(none.sleepMin, null);
  assert.equal(none.sleepFrom, null);
});

test('没有起床时间就是 null，不拿别的时间凑', () => {
  const r = parseFishSummary('夜间睡眠：6 小时 10 分钟\n深睡：1 小时 20 分钟');
  assert.equal(r.wakeHm, null);
  assert.equal(r.sleepMin, 370);
});

test('步数：首页那行「· 步数 6045」抠成数字', () => {
  const r = parseFishSummary('起床 07:57 · 睡眠 7.6h · 步数 6045 · 压力 36 · 心率 72 · 血氧 97%');
  assert.equal(r.steps, 6045);
  assert.equal(r.stress, 36, '步数不能被压力那条正则抢走');
});

test('压力是区间时取右端（最大值），判断高不高只看最高档', () => {
  const r = parseFishSummary('起床 07:57 · 睡眠 7.6h · 步数 6045 · 压力 45-62 · 心率 72 · 血氧 97%');
  assert.equal(r.stress, 62);
});

test('压力没有区间时照旧只取那个数', () => {
  const r = parseFishSummary('起床 07:57 · 睡眠 7.6h · 步数 6045 · 压力 36 · 心率 72 · 血氧 97%');
  assert.equal(r.stress, 36);
});

test('压力区间不抢睡眠时间/步数：只有压力附近那段才算', () => {
  const r = parseFishSummary('夜间睡眠 23:41-07:57 · 步数 2000-3000 · 压力 30');
  assert.equal(r.stress, 30);
});

test('步数：一天里有多封邮件时取最新那封（摘要第一行）', () => {
  const r = parseFishSummary('起床 07:39 · 睡眠 8.8h · 步数 2984 · 压力 40\n睡眠详情：…\n起床 07:39 · 睡眠 8.8h · 步数 2159 · 压力 15');
  assert.equal(r.steps, 2984);
});

test('步数：「步数 未读到」和离谱值都不猜', () => {
  assert.equal(parseFishSummary('起床 未读到 · 睡眠 8.8h · 步数 未读到 · 压力 54').steps, null);
  assert.equal(parseFishSummary('步数 9999999').steps, null);
});
