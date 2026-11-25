// logger.test.mjs —— 一天只落一条同 kind 的日志（appendOnce）。
//
// 为什么需要它：数据断供提醒每 10 分钟一拍都会命中，不能每拍都写一行；
// 而 tail 只读「记录日」当天的文件，天然按天去重，不用往 state 里塞标记（dryRun 也不该碰 state）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-log-'));
process.env.PG_LOG_DIR = dir;
const { append, appendOnce, tail } = await import('../src/settings/logger.js');

const TZ = 'Asia/Shanghai';
const now = Date.parse('2026-11-06T10:00:00+08:00');

test('appendOnce：同一种 kind 一个记录日只写一次', () => {
  const first = appendOnce({ kind: 'fish_stale', ageHours: 50, limitHours: 36 }, now, TZ);
  const second = appendOnce({ kind: 'fish_stale', ageHours: 51, limitHours: 36 }, now, TZ);
  assert.equal(first, true);
  assert.equal(second, false);
  const rows = tail(10, now, TZ).filter((r) => r.kind === 'fish_stale');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ageHours, 50);
});

test('appendOnce：不同 kind 各写一条；没有 kind 的记录照常写', () => {
  assert.equal(appendOnce({ kind: 'mail_error', why: 'x' }, now, TZ), true);
  assert.equal(appendOnce({ kind: 'mail_error', why: 'y' }, now, TZ), false);
  assert.equal(appendOnce({ why: 'no kind' }, now, TZ), true);
  assert.equal(appendOnce({ why: 'no kind' }, now, TZ), true);
  const rows = tail(20, now, TZ);
  assert.equal(rows.filter((r) => r.kind === 'mail_error').length, 1);
  assert.equal(rows.filter((r) => r.why === 'no kind').length, 2);
});

test('append：写进当天文件，tail 能按顺序读回', () => {
  append({ hello: 1 }, now, TZ);
  append({ hello: 2 }, now, TZ);
  const rows = tail(2, now, TZ);
  assert.deepEqual(rows.map((r) => r.hello), [1, 2]);
});