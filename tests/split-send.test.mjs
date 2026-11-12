// split-send.test.mjs —— 2026-11-09 她：一句一条地发，别把两段塞进一个气泡。
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitOutgoing, firstDelayMs, partGapMs } from '../src/split.js';

test('一段就一条，不硬拆', () => {
  assert.deepEqual(splitOutgoing('嗯，我在。'), ['嗯，我在。']);
});

test('空行分两段 → 两条，空行不留在正文里', () => {
  const parts = splitOutgoing('行，那我去看看。\n\n不过你也别熬太晚。');
  assert.deepEqual(parts, ['行，那我去看看。', '不过你也别熬太晚。']);
});

test('一长段按句切，每条不超过 80 字，内容不丢', () => {
  const text =
    '这个动画讲得挺清楚，注意力说白了就是各查各的再按相关度加权，没什么神秘的。真要动手，坑全在工程上，显存、对齐、量化一个都跑不掉。我建议你先别急着上模型，把整个链路跑通一遍再谈效果。';
  const parts = splitOutgoing(text);
  assert.ok(parts.length >= 2 && parts.length <= 4, `切成了 ${parts.length} 条`);
  for (const part of parts) assert.ok(part.length <= 80, `有一条 ${part.length} 字：${part}`);
  assert.equal(parts.join('').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
});

test('60 字以内不拆', () => {
  const text = '行，我知道了，你先把这个放到一边，等我这边处理完再说，别自己瞎搞。';
  assert.deepEqual(splitOutgoing(text), [text]);
});

test('链接不被切断', () => {
  const text = '这个你看了吗 https://www.douyin.com/video/123 讲得还挺细。后面那段也不错，可以接着看。';
  for (const part of splitOutgoing(text)) {
    if (part.includes('https://')) assert.match(part, /https:\/\/www\.douyin\.com\/video\/123/);
  }
});

test('六段 → 四条，后三段并进最后一条', () => {
  const parts = splitOutgoing(['一', '二', '三', '四', '五', '六'].join('\n\n'));
  assert.equal(parts.length, 4);
  assert.equal(parts[0], '一');
  assert.match(parts[3], /四 五 六/);
});

test('引号里的句子不被切开', () => {
  const text = '你那句「你不睡我就不睡」有点吓人。下次别这么说了，我真会当真的。';
  for (const part of splitOutgoing(text)) {
    if (part.includes('「')) assert.match(part, /「你不睡我就不睡」/);
  }
});

test('代码块整块留在同一条', () => {
  const text = '改好了。\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n你重启一下就行。';
  const withCode = splitOutgoing(text).filter((part) => part.includes('```'));
  assert.equal(withCode.length, 1);
  assert.match(withCode[0], /const a = 1\n\nconst b = 2/);
});

test('空输入不出条', () => {
  assert.deepEqual(splitOutgoing(''), []);
  assert.deepEqual(splitOutgoing('  \n '), []);
});

test('首条延迟：她刚说完 → 从她那句算起至少 6 秒；她已经等很久 → 立刻发', () => {
  const now = 1_700_000_000_000;
  const wait = firstDelayMs({ herAt: now - 1000, herChars: 6, now, rand: () => 0 });
  assert.ok(1000 + wait >= 6000, `只隔了 ${1000 + wait}ms`);
  assert.equal(firstDelayMs({ herAt: now - 120000, herChars: 6, now, rand: () => 0 }), 0);
});

test('条间隔：1.2 秒起、随字数加、封顶 5 秒', () => {
  assert.ok(partGapMs(1, { rand: () => 0 }) >= 1200);
  assert.ok(partGapMs(40, { rand: () => 0 }) > partGapMs(1, { rand: () => 0 }));
  assert.equal(partGapMs(100, { rand: () => 1 }), 5000);
});