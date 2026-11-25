// private.test.mjs —— 「别拿出去用」的自我标记，不许写死某个人的名字。
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVATE_MARK, isPrivate } from '../src/settings/private.js';

test('private：任何人的「不给 XX 看」都算', () => {
  assert.equal(isPrivate('这条不给她看：我其实有点慌'), true);
  assert.equal(isPrivate('这条不给小明看'), true);
  assert.equal(isPrivate('不能给室友看'), true);
});

test('private：别的自我标记也认（太贴 / 自己消化 / 别让她看到 / 内部）', () => {
  for (const t of ['太贴了', '自己消化吧', '别让她看到', '别给她看到', '内部判断']) {
    assert.equal(isPrivate(t), true, t);
  }
});

test('private：普通句子不误伤', () => {
  for (const t of ['今天她心情不错', '记得买奶茶', '她说想去看电影', '看了三集动画']) {
    assert.equal(isPrivate(t), false, t);
  }
});

test('private：正则不带具体人名', () => {
  assert.equal(/张三|李四|某某/.test(String(PRIVATE_MARK)), false);
});