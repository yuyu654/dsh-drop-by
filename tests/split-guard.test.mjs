// split-guard.test.mjs —— 空行 = 要拆成几条发：那就每条各自守字数，整轮最多四段。
import test from 'node:test';
import assert from 'node:assert/strict';
import { guard } from '../src/compose.js';

const cfg = { content: { maxChars: 60 } };

test('两段各 40 字 → 不算超长（整段加起来 80 也能过）', () => {
  const text = `${'甲'.repeat(40)}\n\n${'乙'.repeat(40)}`;
  const r = guard(text, cfg);
  assert.ok(!r.violations.some((v) => v.code === 'TOO_LONG'), JSON.stringify(r.violations));
});

test('其中一段 70 字 → 那段算超长', () => {
  const text = `${'甲'.repeat(20)}\n\n${'乙'.repeat(70)}`;
  const r = guard(text, cfg);
  assert.ok(r.violations.some((v) => v.code === 'TOO_LONG'), JSON.stringify(r.violations));
});

test('没有空行的一整段 80 字 → 还是超长（空行不是拿来写小作文的）', () => {
  const r = guard('甲'.repeat(80), cfg);
  assert.ok(r.violations.some((v) => v.code === 'TOO_LONG'));
});

test('五段 → TOO_MANY_PARTS', () => {
  const text = ['一', '二', '三', '四', '五'].join('\n\n');
  const r = guard(text, cfg);
  assert.ok(r.violations.some((v) => v.code === 'TOO_MANY_PARTS'), JSON.stringify(r.violations));
});