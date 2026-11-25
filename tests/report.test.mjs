// report.test.mjs —— 阶段 5.2：日报格式与按天去重。
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-report-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'secrets.json');
fs.mkdirSync(process.env.PG_LOG_DIR, { recursive: true });

const { buildDailyReport, writeDailyReport, reportFile, readDayRecords, dayFile, recentReports, maybeWriteYesterdayReport } = await import('../src/decision/report.js');
const { pruneOldRecords, shiftDay } = await import('../src/settings/retention.js');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

const DAY = '2026-11-06';
const rec = (over) => ({ ts: 0, decision: 'skip', reason: 'GAP_TOO_SHORT', ...over });
const sent = (slot, source, over = {}) =>
  rec({ decision: 'send', content_ok: true, topic: { slot }, content: { source }, delivery: { attempted: true, ok: true }, ...over });

function writeDay(rows, day = DAY) {
  fs.mkdirSync(process.env.PG_LOG_DIR, { recursive: true });
  fs.writeFileSync(dayFile(day), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

beforeEach(() => {
  for (const f of fs.readdirSync(process.env.PG_LOG_DIR)) fs.unlinkSync(path.join(process.env.PG_LOG_DIR, f));
});

test('汇总：发了什么、来源、被拦、接住、judge', () => {
  const rows = [
    sent('agenda', 'llm'),
    sent('agenda', 'template'),
    sent('share', 'llm', { judge: { say: true, fallback: false } }),
    rec({ reason: 'GAP_TOO_SHORT' }),
    rec({ reason: 'GAP_TOO_SHORT' }),
    rec({ reason: 'AWAY' }),
    rec({ backfill: { hit: true }, reason: 'NO_TOPIC' }),
    rec({ judge: { say: false, fallback: false }, reason: 'DAILY_CAP' }),
    rec({ judge: { fallback: true, say: null } }),
  ];
  writeDay(rows);
  const text = buildDailyReport({ day: DAY, records: readDayRecords(DAY), cfg: { logging: { dayStartHour: 7 } } });
  assert.match(text, /日报 2026-11-06/);
  assert.match(text, /发了 3 条（真发 3 \/ 演练 0）：agenda×2、share×1/);
  assert.match(text, /来源：llm×2、template×1/);
  assert.match(text, /被拦 6 拍：AWAY×1/);
  assert.match(text, /克制记录：这 3 拍没有打扰（间隔保护 3 拍）/);
  assert.doesNotMatch(text, /GAP_TOO_SHORT/);
  assert.match(text, /她接住 1 条/);
  assert.match(text, /judge：真判 3（说 1 \/ 不说 1 \/ 判坏 1）/);
  assert.ok(text.trimEnd().split('\n').length <= 15);
});

test('演练计入「演练」，不算真发', () => {
  writeDay([sent('sleep', 'llm', { delivery: { attempted: false, reason: 'DRY_RUN' } })]);
  const text = buildDailyReport({ day: DAY, records: readDayRecords(DAY), cfg: {} });
  assert.match(text, /发了 1 条（真发 0 \/ 演练 1）/);
});

test('没有记录：只写一行发 0 条，不崩', () => {
  writeDay([]);
  const text = buildDailyReport({ day: DAY, records: readDayRecords(DAY), cfg: {} });
  assert.match(text, /发了 0 条/);
  assert.equal(text.trimEnd().split('\n').length, 4);
});

test('按天去重：第二次不重写，force 才重算', () => {
  writeDay([sent('agenda', 'llm')]);
  const a = writeDailyReport({ day: DAY, now: Date.now(), cfg: { timezone: 'Asia/Shanghai' }, st: {} });
  assert.equal(a.written, true);
  assert.equal(fs.readFileSync(reportFile(DAY), 'utf8'), a.text);
  const mtime = fs.statSync(reportFile(DAY)).mtimeMs;

  const b = writeDailyReport({ day: DAY, now: Date.now() + 1000, cfg: { timezone: 'Asia/Shanghai' }, st: {} });
  assert.equal(b.written, false);
  assert.equal(fs.statSync(reportFile(DAY)).mtimeMs, mtime);

  const c = writeDailyReport({ day: DAY, now: Date.now() + 2000, cfg: { timezone: 'Asia/Shanghai' }, st: {}, force: true });
  assert.equal(c.written, true);
});
test('日报汇总无由头的原因，并标出本日手机数据暂停', () => {
  const records = [
    { decision: 'skip', reason: 'NO_TOPIC', topicMisses: [
      { slot: 'sleep', reason: 'fish_stale' }, { slot: 'steps', reason: 'fish_stale' },
      { slot: 'chitchat', reason: 'chitchat_budget' },
    ] },
    { kind: 'fish_stale', ageHours: 74, limitHours: 36 },
  ];
  const report = buildDailyReport({ day: DAY, records });
  assert.match(report, /手机数据过期×1/);
  assert.match(report, /随口话已到今天的生效上限×1/);
  assert.match(report, /74 小时.*睡眠、压力、步数、屏幕时间 4 类话题已暂停/);
  assert.ok(report.trim().split('\n').length < 15);
});

test('日报无由头 Top 3 只统计具体原因', () => {
  const generic = [
    { slot: 'reply', reason: 'no_data' },
    { slot: 'chitchat', reason: 'disabled' },
    { slot: 'screen', reason: 'phone_disabled' },
  ];
  const skip = (misses) => ({ decision: 'skip', reason: 'NO_TOPIC', topicMisses: [...generic, ...misses] });
  const records = [
    skip([]),
    skip([{ slot: 'steps', reason: 'out_of_window' }]),
    skip([{ slot: 'stress', reason: 'cooldown' }]),
    skip([{ slot: 'sleep', reason: 'fish_stale' }]),
  ];
  const text = buildDailyReport({ day: DAY, records });
  const reasons = text.split('\n').find(line => line.startsWith('无合适由头'));
  assert.match(reasons, /还没到适用时段×1/);
  assert.match(reasons, /还在冷却中×1/);
  assert.match(reasons, /手机数据过期×1/);
  assert.doesNotMatch(reasons, /没有可用的资料|已关闭/);
  assert.doesNotMatch(buildDailyReport({ day: DAY, records: [skip([])] }), /无合适由头/);
});

test('克制记录归并静默、忙碌、角色休息和间隔保护，只计实际跳过', () => {
  const records = ['GLOBAL_QUIET', 'QUIET_HOURS', 'BUSY_HOURS', 'CHARACTER_ASLEEP', 'GAP_TOO_SHORT', 'DATA_UNAVAILABLE']
    .map(reason => rec({ reason }));
  records.push(sent('share', 'llm', { reason: 'BUSY_HOURS' }));
  const text = buildDailyReport({ day: DAY, records });
  assert.match(text, /发了 1 条（真发 1 \/ 演练 0）/);
  assert.match(text, /被拦 6 拍：DATA_UNAVAILABLE×1/);
  assert.match(text, /克制记录：这 5 拍没有打扰（全局静默 2 拍、你在忙 1 拍、角色休息 1 拍、间隔保护 1 拍）/);
  assert.doesNotMatch(text, /GLOBAL_QUIET|QUIET_HOURS|BUSY_HOURS|CHARACTER_ASLEEP|GAP_TOO_SHORT/);
});

test('回顾按记录日最多展示近 7 天，旧日报无需原始日志且今天用实况', () => {
  const cfg = { timezone: 'Asia/Shanghai', logging: { dayStartHour: 7, keepDays: 2 } };
  // 自然日已经是 11 月 7 日，记录日尚未切到 07:00。
  const now = Date.parse('2026-11-07T06:30:00+08:00');
  const days = Array.from({ length: 7 }, (_, age) => shiftDay(DAY, -age));
  for (const day of [...days, shiftDay(DAY, -7), shiftDay(DAY, 1)]) {
    fs.writeFileSync(reportFile(day), '# 日报 ' + day + '\n发了 9 条（真发 9 / 演练 0）\n');
  }
  writeDay([sent('share', 'llm'), rec({ reason: 'CHARACTER_ASLEEP' })]);
  writeDay([rec({ reason: 'NO_TOPIC' })], days[1]);
  const before = fs.readdirSync(process.env.PG_LOG_DIR).sort();

  const reports = recentReports({ cfg, st: {}, now });
  assert.deepEqual(reports.map(r => r.day), days);
  assert.match(reports[0].text, /发了 1 条/);
  assert.match(reports[0].text, /克制记录/);
  assert.match(reports[1].text, /发了 9 条/);
  assert.match(reports[6].text, /发了 9 条/);
  assert.ok(reports.every(r => r.sent));
  assert.equal(recentReports({ cfg: { ...cfg, logging: { ...cfg.logging, reportDays: 2 } }, st: {}, now }).length, 2);
  assert.equal(recentReports({ cfg: { ...cfg, logging: { ...cfg.logging, reportDays: 99 } }, st: {}, now }).length, 7);
  assert.deepEqual(fs.readdirSync(process.env.PG_LOG_DIR).sort(), before);
});

test('回顾可借用今天的归档和昨日仍在磁盘上的原始日志，缺失日期不补零', () => {
  const cfg = { timezone: 'Asia/Shanghai' };
  const now = Date.parse(DAY + 'T12:00:00+08:00');
  const yesterday = shiftDay(DAY, -1);
  fs.writeFileSync(reportFile(DAY), '# 日报 ' + DAY + '\n发了 2 条（真发 0 / 演练 2）\n');
  writeDay([rec({ reason: 'BUSY_HOURS' })], yesterday);
  fs.writeFileSync(dayFile(shiftDay(DAY, -2)), 'invalid JSON\n');
  const reports = recentReports({ cfg, st: {}, now });
  assert.deepEqual(reports.map(r => [r.day, r.sent]), [[DAY, false], [yesterday, false]]);
  assert.match(reports[0].text, /发了 2 条/);
  assert.match(reports[1].text, /你在忙 1 拍/);
  assert.equal(fs.existsSync(reportFile(yesterday)), false);
});

test('自动归档在裁剪原始日志前补齐仍有记录的日期，保留已有日报', () => {
  const cfg = { timezone: 'Asia/Shanghai', logging: { dayStartHour: 7, keepDays: 1 } };
  const now = Date.parse(DAY + 'T12:00:00+08:00');
  const yesterday = shiftDay(DAY, -1);
  const earlier = shiftDay(DAY, -3);
  writeDay([sent('agenda', 'llm')], earlier);
  writeDay([rec({ reason: 'BUSY_HOURS' })], yesterday);
  fs.writeFileSync(reportFile(yesterday), '# 日报 ' + yesterday + '\n已归档\n');
  const st = {};
  const result = maybeWriteYesterdayReport({ cfg, now, st });
  assert.equal(result.written, true);
  assert.equal(result.day, earlier);
  assert.equal(maybeWriteYesterdayReport({ cfg, now, st }).reason, 'ALREADY_TRIED');
  const removed = pruneOldRecords(cfg, now, { fishDir: path.join(dir, 'fish') }).removed;
  assert.equal(removed.length, 2);
  assert.match(fs.readFileSync(reportFile(yesterday), 'utf8'), /已归档/);
  assert.match(fs.readFileSync(reportFile(earlier), 'utf8'), /真发 1/);
  assert.deepEqual(recentReports({ cfg, st, now }).map(r => r.day), [yesterday, earlier]);
});
