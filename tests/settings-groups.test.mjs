// settings-groups.test.mjs —— 设置页的分组、折叠、以及「父开关关着就不显示子项」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { listForUi, SCHEMA, GROUP_ORDER, FOLDABLE_GROUPS } from '../src/settings.js';

const cfg = () => loadConfig({ env: { DSH_HOME: 'C:/Users/you/.dsh', PG_NO_CREDENTIALS: '1' }, fresh: true });
const flat = (c) => listForUi(c).flatMap((g) => g.items);
const has = (c, p) => flat(c).some((i) => i.path === p);

test('分组：日常在最前，高级在最后；高级折起来并写明「平时不用动」', () => {
  const groups = listForUi(cfg());
  assert.deepEqual(groups.map((g) => g.name), GROUP_ORDER);
  assert.equal(GROUP_ORDER[0], '日常');
  assert.equal(GROUP_ORDER.at(-1), '高级');
  assert.ok(FOLDABLE_GROUPS.has('高级'));
  const adv = groups.find((g) => g.name === '高级');
  assert.equal(adv.foldable, true);
  assert.match(adv.summary, /平时不用动/);
});

test('首屏（不含两个折起来的组）不超过 50 行', () => {
  const groups = listForUi(cfg());
  const first = groups.filter((g) => !g.foldable).flatMap((g) => g.items);
  assert.ok(first.length <= 50, `首屏 ${first.length} 行，太多了`);
  assert.ok(first.length >= 35, `首屏只剩 ${first.length} 行，常用的被藏掉了`);
});

test('父开关关着：judge 关了，它的子项不显示；开回来就回来', () => {
  const off = cfg();
  off.rules.judge.enabled = false;
  assert.ok(has(off, 'rules.judge.enabled'), '父开关本身要留着');
  for (const p of ['rules.judge.attempts', 'rules.judge.shadow', 'rules.judge.shadowSampleRate', 'rules.presenceSignal.enabled']) {
    assert.ok(!has(off, p), `judge 关着不该显示 ${p}`);
  }
  const on = cfg();
  on.rules.judge.enabled = true;
  for (const p of ['rules.judge.attempts', 'rules.judge.shadow', 'rules.presenceSignal.enabled']) {
    assert.ok(has(on, p), `judge 开着要显示 ${p}`);
  }
});

test('由头关掉一类，它的阈值一起藏起来（其他类不受影响）', () => {
  const c = cfg();
  c.content.topics.sleep = false;
  for (const p of ['content.topics.sleepShortMin', 'content.topics.sleepDeepShortMin', 'content.topics.sleepLongMin', 'content.topics.sleepLateBed']) {
    assert.ok(!has(c, p), `睡眠关着不该显示 ${p}`);
  }
  assert.ok(has(c, 'content.topics.stressHighMin'), '压力那一类还在，阈值不能被误藏');
  assert.ok(has(c, 'content.topics.sleep'), '由头开关本身要留着（关着也能开回来）');
});

test('默认开的父开关：配置里没写也当开着，子项照常显示', () => {
  const c = cfg();
  delete c.sources.phone.enabled;
  assert.ok(has(c, 'sources.phone.staleHours'));
  c.sources.phone.enabled = false;
  assert.ok(!has(c, 'sources.phone.staleHours'));
});

test('藏起来的子项只是不显示，SCHEMA 和配置都还在', () => {
  const c = cfg();
  c.rules.gapByTier.enabled = false;
  assert.ok(SCHEMA.some((s) => s.path === 'rules.gapByTier.eventMin'));
  assert.ok(!has(c, 'rules.gapByTier.eventMin'));
  c.rules.gapByTier.enabled = true;
  assert.ok(has(c, 'rules.gapByTier.eventMin'));
});
test('日常板块上面那条注释：说清哪些功能可能踩反作弊，并给「玩的时候先关」', () => {
  const g = listForUi(cfg()).find((x) => x.name === '日常');
  assert.ok(g.note, '日常组要有注释');
  assert.match(g.note, /反作弊/);
  assert.match(g.note, /看屏幕（OCR）/);
  assert.match(g.note, /看窗口和网页/);
  assert.match(g.note, /抖音/);
  assert.match(g.note, /键鼠空闲不受影响/);
  // 别组不跟着长注释
  assert.equal(listForUi(cfg()).find((x) => x.name === '节奏').note, undefined);
});
