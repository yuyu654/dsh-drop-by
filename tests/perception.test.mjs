// perception.test.mjs —— 只测纯函数：OCR 线索怎么收成能给模型看的两句。
// 不跑探针、不截屏（那两个要真桌面，靠 --l123 手工验）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenFacts, screenHints } from '../src/perception.js';

test('screenFacts：逐字拆开的碎词丢掉，像话的留下', () => {
  const got = screenFacts([
    '应 甲 缤 辑 deepseel', // 实测 OCR 在中文标题上的典型输出
    '上下文 记忆 系统 更 多',
    'VS Code 里那个报错还没修',
    '   ',
    '——',
  ]);
  assert.deepEqual(got, ['VS Code 里那个报错还没修']);
});

test('screenFacts：最多两句，每条截到 40 字', () => {
  const long = 'x'.repeat(120);
  const got = screenFacts(['第一句像话的内容', '第二句也像话的内容', '第三句不该出现', long], 2);
  assert.equal(got.length, 2);
  assert.equal(got[0], '第一句像话的内容');
  assert.ok(got.every((s) => s.length <= 40));
});

test('screenFacts：不是数组也安全，空就给空', () => {
  assert.deepEqual(screenFacts(null), []);
  assert.deepEqual(screenFacts([]), []);
  assert.deepEqual(screenFacts(['好'], 2), []); // 太短，一个字的线索没意义
});

test('screenHints：去重、最多 12 条', () => {
  const lines = Array.from({ length: 20 }, (_, i) => `第 ${i} 行内容`);
  const got = screenHints([...lines, ...lines].join('\n'));
  assert.equal(got.length, 12);
  assert.equal(new Set(got).size, 12);
});