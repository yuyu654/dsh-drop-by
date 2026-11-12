// report.test.mjs —— 阶段 5.2：日报格式与按天去重。
import { test, beforeEach } from 'node:test';
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

const { buildDailyReport, writeDailyReport, reportFile, readDayRecords, dayFile } = await import('../src/report.js');

const DAY = '2026-11-06';
const rec = (over) => ({ ts: 0, decision: 'skip', reason: 'GAP_TOO_SHORT', ...over });
const sent = (slot, source, over = {}) =>
  rec({ decision: 'send', content_ok: true, topic: { slot }, content: { source }, delivery: { attempted: true, ok: true }, ...over });

function writeDay(rows) {
  fs.mkdirSync(process.env.PG_LOG_DIR, { recursive: true });
  fs.writeFileSync(dayFile(DAY), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
  assert.match(text, /被拦 6 拍：GAP_TOO_SHORT×3、AWAY×1/);
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