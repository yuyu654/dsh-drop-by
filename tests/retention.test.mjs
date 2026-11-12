// retention.test.mjs —— 记录保留：怎么分天、留几天、删哪些。
// 全部在临时目录里跑，绝不碰真实的 logs / data/fish。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  archiveFishMail,
  mailUpdateMode,
  cutoffDay,
  dayStartHour,
  pruneOldRecords,
  readFishArchive,
  recordDay,
  recordSummary,
  shiftDay,
} from '../src/retention.js';

const TZ = 'Asia/Shanghai';
const cfgOf = (logging = {}) => ({ timezone: TZ, logging: { keepDays: 2, dayStartHour: 7, ...logging } });
/** 上海时间 h:m 的时间戳。 */
const at = (h, m = 0, day = 4) => Date.UTC(2026, 10, day, h - 8, m);

let seq = 0;
function tmpDirs() {
  const base = path.join(os.tmpdir(), `pg-ret-${process.pid}-${Date.now()}-${++seq}`);
  const logDir = path.join(base, 'logs');
  const fishDir = path.join(base, 'fish');
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(fishDir, { recursive: true });
  return { base, logDir, fishDir };
}

const touch = (dir, name, body = '{}\n') => fs.writeFileSync(path.join(dir, name), body, 'utf8');

test('记录日：07:00 换日，凌晨算前一天', () => {
  const cfg = cfgOf();
  assert.equal(recordDay(at(6, 59), TZ, cfg), '2026-11-03');
  assert.equal(recordDay(at(7, 0), TZ, cfg), '2026-11-04');
  assert.equal(recordDay(at(23, 59), TZ, cfg), '2026-11-04');
  // 换日时刻可改
  assert.equal(recordDay(at(3), TZ, cfgOf({ dayStartHour: 4 })), '2026-11-03');
  assert.equal(recordDay(at(5), TZ, cfgOf({ dayStartHour: 4 })), '2026-11-04');
  // 坏配置回落到 7
  assert.equal(dayStartHour({ logging: { dayStartHour: 99 } }), 7);
  assert.equal(dayStartHour({}), 7);
});

test('shiftDay：跨月、跨年、非法输入', () => {
  assert.equal(shiftDay('2026-11-04', -1), '2026-11-03');
  assert.equal(shiftDay('2026-11-01', -1), '2026-10-31');
  assert.equal(shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(shiftDay('2026-02-28', 1), '2026-03-01');
  assert.equal(shiftDay('2026-11-04', 1), '2026-11-05');
  assert.equal(shiftDay('bad', 1), null);
});

test('cutoff：留 2 天 = 今天 + 昨天', () => {
  const now = at(9);
  assert.equal(cutoffDay(cfgOf(), now), '2026-11-03');
  assert.equal(cutoffDay(cfgOf({ keepDays: 1 }), now), '2026-11-04');
  assert.equal(cutoffDay(cfgOf({ keepDays: 3 }), now), '2026-11-02');
});

test('pruneOldRecords：删掉前天及更早，留今天和昨天', () => {
  const { logDir, fishDir } = tmpDirs();
  touch(logDir, 'decision-2026-11-02.jsonl');
  touch(logDir, 'decision-2026-11-03.jsonl');
  touch(logDir, 'decision-2026-11-04.jsonl');
  touch(logDir, 'perception-2026-11-01.jsonl');
  touch(logDir, 'mail-2026-11-04.jsonl');
  touch(fishDir, '2026-11-02.json');
  touch(fishDir, '2026-11-03.json');
  touch(fishDir, '2026-11-04.json');
  // 不该被碰的东西
  touch(logDir, 'notes.txt');
  touch(logDir, 'decision-latest.jsonl');
  touch(fishDir, 'fish-latest.json');

  const r = pruneOldRecords(cfgOf(), at(9), { logDir, fishDir });
  assert.equal(r.cutoff, '2026-11-03');
  assert.deepEqual(
    r.removed.map((x) => path.basename(x.file)).sort(),
    ['2026-11-02.json', 'decision-2026-11-02.jsonl', 'perception-2026-11-01.jsonl'],
  );
  assert.deepEqual(fs.readdirSync(logDir).sort(), [
    'decision-2026-11-03.jsonl',
    'decision-2026-11-04.jsonl',
    'decision-latest.jsonl',
    'mail-2026-11-04.jsonl',
    'notes.txt',
  ]);
  assert.deepEqual(fs.readdirSync(fishDir).sort(), ['2026-11-03.json', '2026-11-04.json', 'fish-latest.json']);
});

test('pruneOldRecords：幂等，跑第二遍不删东西', () => {
  const { logDir, fishDir } = tmpDirs();
  touch(logDir, 'decision-2026-11-01.jsonl');
  touch(logDir, 'decision-2026-11-04.jsonl');
  const first = pruneOldRecords(cfgOf(), at(9), { logDir, fishDir });
  assert.equal(first.removed.length, 1);
  const second = pruneOldRecords(cfgOf(), at(9), { logDir, fishDir });
  assert.equal(second.removed.length, 0);
  assert.equal(second.kept.length, 1);
});

test('pruneOldRecords：目录不存在也不炸', () => {
  const r = pruneOldRecords(cfgOf(), at(9), { logDir: path.join(os.tmpdir(), 'nope-xyz'), fishDir: path.join(os.tmpdir(), 'nope-abc') });
  assert.equal(r.removed.length, 0);
  assert.equal(r.errors.length, 0);
});

test('archiveFishMail（append 模式）：同 uid 覆盖、不同 uid 追加并按时间排', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf({ mailUpdateMode: 'append' });
  const now = at(9);
  archiveFishMail({ uid: 5, subject: 'FISH 11-04 07:00', fetchedAt: now, summary: 'a', text: 'a' }, { cfg, now, dir: fishDir });
  archiveFishMail({ uid: 6, subject: 'FISH 11-04 09:00', fetchedAt: now + 7200_000, summary: 'b', text: 'b' }, { cfg, now, dir: fishDir });
  archiveFishMail({ uid: 5, subject: 'FISH 11-04 07:00（重读）', fetchedAt: now, summary: 'a2', text: 'a2' }, { cfg, now, dir: fishDir });

  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(doc.mails.length, 2, '同 uid 不该重复');
  assert.equal(doc.mails[0].subject, 'FISH 11-04 07:00（重读）');
  assert.equal(doc.mails[0].summary, 'a2');
  assert.equal(doc.mails[1].uid, 6);
  assert.ok(doc.updatedAt);
});

test('archiveFishMail：解析结果和原文都留，但原文有上限', () => {
  const { fishDir } = tmpDirs();
  const long = 'x'.repeat(20000);
  archiveFishMail(
    { uid: 7, subject: 'FISH', fetchedAt: at(9), summary: 's'.repeat(6000), text: long },
    { cfg: cfgOf(), now: at(9), dir: fishDir, parsed: { sleepMin: 400, stress: 68 } },
  );
  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.deepEqual(doc.mails[0].parsed, { sleepMin: 400, stress: 68 });
  assert.equal(doc.mails[0].text.length, 8000);
  assert.equal(doc.mails[0].summary.length, 4000);
});

test('readFishArchive：只给保留期内的，最新在前', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf();
  const now = at(9);
  archiveFishMail({ uid: 1, subject: '旧', fetchedAt: at(9, 0, 2), text: 'x' }, { cfg, now, dir: fishDir });
  archiveFishMail({ uid: 2, subject: '昨', fetchedAt: at(9, 0, 3), text: 'x' }, { cfg, now, dir: fishDir });
  archiveFishMail({ uid: 3, subject: '今', fetchedAt: now, text: 'x' }, { cfg, now, dir: fishDir });

  const got = readFishArchive(cfg, now, { dir: fishDir });
  assert.deepEqual(got.map((m) => m.uid), [3, 2], '11-02 已过保留期，不该出现');
  assert.equal(got[0].day, '2026-11-04');
});

test('recordSummary：分组、大小、哪些已经过期', () => {
  const { logDir, fishDir } = tmpDirs();
  touch(logDir, 'decision-2026-11-02.jsonl', 'a'.repeat(100));
  touch(logDir, 'decision-2026-11-04.jsonl', 'b'.repeat(200));
  touch(fishDir, '2026-11-04.json', 'c'.repeat(50));
  const s = recordSummary(cfgOf(), at(9), { logDir, fishDir });
  assert.equal(s.today, '2026-11-04');
  assert.equal(s.cutoff, '2026-11-03');
  assert.equal(s.keepDays, 2);
  assert.equal(s.groups.decision.length, 2);
  assert.equal(s.groups.decision[0].stale, true, '11-02 已过期');
  assert.equal(s.groups.decision[1].stale, false);
  assert.equal(s.groups.decision[1].size, 200);
  assert.equal(s.groups.fish[0].day, '2026-11-04');
  assert.equal(s.groups.perception.length, 0);
});


// ---------------------------------------------------------------- 同日新邮件：补充 / 替换
// 一天里 App 可能发好几封（每次采集一封）。早上那封有睡眠和起床，中午那封只有压力/屏幕。
// 补充 = 一天一条，缺的字段用旧的补；替换 = 一天一条，只留最新。

const MORNING = [
  '起床 07:42 · 睡眠 7.1h · 步数 5120 · 压力 68 · 心率 74 · 血氧 97%',
  '睡眠详情',
  '夜间睡眠：7 小时 6 分钟',
  '深睡：2 小时 4 分钟 · 浅睡 3 小时 40 分钟 · 快速眼动 1 小时 22 分钟',
].join('\n');

const NOON = ['屏幕时间：4 小时 12 分钟', '压力 75'].join('\n');

const arch = (fishDir, cfg, uid, subject, summary, fetchedAt, parsed) =>
  archiveFishMail({ uid, subject, fetchedAt, summary, text: summary }, { cfg, now: fetchedAt, dir: fishDir, parsed });

test('merge：一天只留一条，新邮件有的覆盖、缺的保留', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf(); // 默认就是 merge
  const t0 = at(8);
  const t1 = at(13);
  arch(fishDir, cfg, 10, 'FISH 11-04 07:42', MORNING, t0, { sleepMin: 426, deepMin: 124, wakeHm: '07:42', stress: 68 });
  const r = arch(fishDir, cfg, 11, 'FISH 11-04 12:10', NOON, t1, { sleepMin: null, deepMin: null, wakeHm: null, stress: 75, screenMin: 252 });

  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(doc.mails.length, 1, '补充模式下一天只有一条');
  const m = doc.mails[0];
  assert.equal(m.uid, 11, 'uid 记最新那封');
  assert.deepEqual(m.uids, [11, 10], '按从新到旧记');
  assert.equal(m.mailCount, 2);
  assert.equal(m.merged, true);
  assert.equal(m.fetchedAt, t1);
  assert.equal(m.firstAt, t0);
  // 摘要：新的在前，旧的按行补进来
  assert.ok(m.summary.startsWith('屏幕时间'), '新邮件的内容在最前');
  assert.match(m.summary, /夜间睡眠：7 小时 6 分钟/, '早上那封的睡眠还在，没被顶掉');
  assert.match(m.summary, /起床 07:42/);
  // 解析：缺的字段补上，有的字段用新的
  assert.equal(m.parsed.sleepMin, 426, '新邮件没睡眠 → 用早上的');
  assert.equal(m.parsed.deepMin, 124);
  assert.equal(m.parsed.stress, 75, '新邮件有压力 → 用新的');
  assert.equal(m.parsed.screenMin, 252, '新邮件才有屏幕');
  assert.equal(m.parsed.wakeHm, '07:42');
  assert.equal(m.earlier.length, 1);
  assert.equal(m.earlier[0].uid, 10);
  assert.equal(r.mailsToday, 2);
});

test('merge：同一封再读一次不重复计数，也不丢之前合进来的内容', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf();
  const t0 = at(8);
  const t1 = at(13);
  arch(fishDir, cfg, 10, 'FISH 07:42', MORNING, t0, { sleepMin: 426, deepMin: 124, wakeHm: '07:42', stress: 68 });
  arch(fishDir, cfg, 11, 'FISH 12:10', NOON, t1, { stress: 75, screenMin: 252 });
  arch(fishDir, cfg, 11, 'FISH 12:10', NOON, t1 + 60_000, { stress: 75, screenMin: 252 });

  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(doc.mails.length, 1);
  assert.deepEqual(doc.mails[0].uids, [11, 10], '重读不该把 11 记两遍');
  assert.equal(doc.mails[0].mailCount, 2);
  assert.match(doc.mails[0].summary, /夜间睡眠/, '重读后早上的内容仍在');
  assert.equal(doc.mails[0].parsed.sleepMin, 426);
});

test('merge：3 封按从新到旧合并，摘要不重复同一行', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf();
  arch(fishDir, cfg, 1, 'A', '压力 61\n步数 1000', at(8), { stress: 61 });
  arch(fishDir, cfg, 2, 'B', '步数 1000\n血氧 97%', at(11), { stress: null });
  arch(fishDir, cfg, 3, 'C', '心率 74', at(15), { stress: null });
  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  const m = doc.mails[0];
  assert.equal(m.mailCount, 3);
  assert.equal((m.summary.match(/步数 1000/g) || []).length, 1, '同一行只留一次');
  const lines = m.summary.split('\n');
  assert.equal(lines[0], '心率 74');
  assert.equal(m.parsed.stress, 61, '三封都没新压力 → 保留最早的 61');
});

test('replace：只留最新一封，旧内容整条丢掉', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf({ mailUpdateMode: 'replace' });
  arch(fishDir, cfg, 10, 'FISH 07:42', MORNING, at(8), { sleepMin: 426, deepMin: 124 });
  arch(fishDir, cfg, 11, 'FISH 12:10', NOON, at(13), { stress: 75, screenMin: 252 });
  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(doc.mails.length, 1);
  const m = doc.mails[0];
  assert.equal(m.uid, 11);
  assert.equal(m.summary, '屏幕时间：4 小时 12 分钟\n压力 75', '没有残留早上的内容');
  assert.equal(m.parsed.sleepMin, undefined, '早上的睡眠不该跟过来');
  assert.equal(m.replaced, 1, '记下顶掉了几条');
  assert.equal(m.uids, undefined);
});

test('replace：同一封重读不把 replaced 越滚越大', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf({ mailUpdateMode: 'replace' });
  arch(fishDir, cfg, 10, 'A', MORNING, at(8), {});
  arch(fishDir, cfg, 11, 'B', NOON, at(13), {});
  arch(fishDir, cfg, 11, 'B', NOON, at(13) + 60_000, {});
  const doc = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(doc.mails.length, 1);
  assert.equal(doc.mails[0].replaced, undefined, '同一封重读时没有可被替换的旧封');
});

test('merge：跨 07:00 的两封不会并到一起', () => {
  const { fishDir } = tmpDirs();
  const cfg = cfgOf();
  arch(fishDir, cfg, 10, '昨夜', MORNING, at(6, 30), {}); // → 11-03
  arch(fishDir, cfg, 11, '今早', NOON, at(7, 30), {}); // → 11-04
  const d3 = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-03.json'), 'utf8'));
  const d4 = JSON.parse(fs.readFileSync(path.join(fishDir, '2026-11-04.json'), 'utf8'));
  assert.equal(d3.mails.length, 1);
  assert.equal(d4.mails.length, 1);
  assert.equal(d3.mails[0].uid, 10);
  assert.equal(d4.mails[0].uid, 11);
  assert.equal(d4.mails[0].mailCount, 1);
});

test('非法 mailUpdateMode 回退成 merge', () => {
  assert.equal(mailUpdateMode({ logging: { mailUpdateMode: '瞎写' } }), 'merge');
  assert.equal(mailUpdateMode({}), 'merge');
  assert.equal(mailUpdateMode({ logging: { mailUpdateMode: 'REPLACE' } }), 'replace');
});
