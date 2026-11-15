// settings-groups.test.mjs —— 设置页的分组、折叠、以及「父开关关着就不显示子项」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { listForUi, explorationItemsForUi, SCHEMA, GROUP_ORDER, FOLDABLE_GROUPS } from '../src/settings.js';

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

test('首屏日常组保持精简清爽（其余组分类折叠）', () => {
  const groups = listForUi(cfg());
  const daily = groups.find((g) => g.name === '日常');
  assert.ok(daily && !daily.foldable, '日常组常驻展开');
  assert.ok(daily.items.length <= 15, `日常首屏 ${daily.items.length} 行，保持清爽`);
  for (const name of ['决定TA粘不粘人', '节奏', '说什么', '数据从哪来', '课表与考试', '高级']) {
    assert.ok(FOLDABLE_GROUPS.has(name), `${name} 组默认折叠`);
    const g = groups.find((x) => x.name === name);
    assert.ok(g.foldable, `${name} 应该是折叠卡片`);
    assert.ok(g.summary, `${name} 应该带概括人话摘要`);
  }
  const stickyPaths = groups.find((x) => x.name === '决定TA粘不粘人').items.map((i) => i.path);
  for (const p of ['rules.dailyCap', 'rules.minGapMin', 'rules.adaptiveGap', 'rules.qqContinuation', 'rules.feedback.enabled', 'rules.judge.enabled', 'rules.chitchat.enabled', 'rules.gapByTier.enabled', 'rules.naturalTriggers.enabled']) {
    assert.ok(stickyPaths.includes(p), `决定TA粘不粘人组里要有 ${p}`);
  }
  const expItems = explorationItemsForUi(cfg());
  assert.deepEqual(
    expItems.map((i) => i.path),
    ['exploration.auto', 'exploration.intervalMinutes', 'exploration.offPeakOnly', 'exploration.nextTopic', 'exploration.interest', 'exploration.offerShare']
  );
  for (const p of expItems.map((i) => i.path)) {
    assert.ok(!daily.items.some((i) => i.path === p), `日常里不再重复出现 ${p}`);
  }
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

test('数据从哪来：展示情绪插件名称与实时检测状态', () => {
  const prevHome = process.env.PG_DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-settings-emo-'));
  try {
    process.env.PG_DSH_HOME = home;
    const c1 = cfg();
    c1.exploration.portrait = true;
    const g1 = listForUi(c1).find((x) => x.name === '数据从哪来');
    assert.match(g1.summary, /QQ情绪/);
    const item1 = g1.items.find((i) => i.path === 'exploration.portrait');
    assert.ok(item1, '数据从哪来组里要有延续 QQ 聊天的心情');
    assert.match(item1.label, /情绪插件/);
    assert.match(item1.hint, /emotion-state-portrait/);
    assert.match(item1.hint, /｜检测：没装 emotion-state-portrait/);

    const dir = path.join(home, 'profiles', 'desktop', 'node_modules', 'emotion-state-portrait');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'emotion-state-portrait', version: '1.0.5' }));
    fs.writeFileSync(path.join(dir, 'qq-emotion.mjs'), 'export default {};');

    const g2 = listForUi(c1).find((x) => x.name === '数据从哪来');
    const item2 = g2.items.find((i) => i.path === 'exploration.portrait');
    assert.match(item2.hint, /｜检测：已装 emotion-state-portrait（v1\.0\.5）/);
  } finally {
    if (prevHome === undefined) delete process.env.PG_DSH_HOME;
    else process.env.PG_DSH_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
