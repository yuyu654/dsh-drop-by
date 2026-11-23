import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-settings-search-'));
const cfgPath = path.join(dir, 'config.json');
const prevCfg = process.env.PG_CONFIG_PATH;
process.env.PG_CONFIG_PATH = cfgPath;
test.after(() => {
  if (prevCfg === undefined) delete process.env.PG_CONFIG_PATH;
  else process.env.PG_CONFIG_PATH = prevCfg;
  fs.rmSync(dir, { recursive: true, force: true });
});

const { loadConfig } = await import('../src/config.js');
const {
  listForUi, explorationItemsForUi, channelItemsForUi, hiddenItemsForSearch,
  applyChange, SEARCH_TAGS,
} = await import('../src/settings.js');
const { pickTopic } = await import('../src/topics.js');

test('两条主动分享间隔改用分钟：默认 1440 分钟、兼容旧 shareGapH、非默认值运行时生效', () => {
  // 全新默认：1440 分钟（24 小时）
  fs.rmSync(cfgPath, { force: true });
  const fresh = loadConfig();
  assert.equal(fresh.content.topics.shareGapMin, 1440);

  // 旧配置只写了 shareGapH: 6 -> 升级自动折算为 360 分钟
  fs.writeFileSync(cfgPath, JSON.stringify({ content: { topics: { shareGapH: 6 } } }));
  const upgraded = loadConfig();
  assert.equal(upgraded.content.topics.shareGapMin, 360);

  // 通过 settings 写入非默认值（30 分钟）并清理旧字段
  const changed = applyChange(upgraded, 'content.topics.shareGapMin', 30);
  assert.equal(changed.ok, true);
  assert.equal(changed.value, 30);
  assert.equal(changed.cfg.content.topics.shareGapMin, 30);
  assert.equal(Object.hasOwn(changed.cfg.content.topics, 'shareGapH'), false);

  // 运行时效果：刚分享 20 分钟前在 30 分钟门槛下被拦，35 分钟前放行
  const now = Date.parse('2026-11-22T15:00:00+08:00');
  const ctx = { self: { line: '这是一条足够长的自主探索分享测试内容，超过四十个字用来验证冷却时间是否按分钟生效。', exploration: true } };
  const blocked = pickTopic(ctx, changed.cfg, now, { content: { lastShareAt: now - 20 * 60_000 } });
  assert.equal(blocked?.slot, undefined);
  const passed = pickTopic(ctx, changed.cfg, now, { content: { lastShareAt: now - 35 * 60_000 } });
  assert.equal(passed?.slot, 'share');
});

test('所有时间相关设置项都在注释中明确标出单位，且全部设置项都带有效搜索关键词', () => {
  fs.rmSync(cfgPath, { force: true });
  const cfg = loadConfig();
  const validTagIds = new Set(SEARCH_TAGS.map((t) => t.id));
  assert.equal(SEARCH_TAGS.length, 9);

  const allItems = [
    ...channelItemsForUi(cfg),
    ...explorationItemsForUi(cfg),
    ...listForUi(cfg).flatMap((g) => g.items),
    ...hiddenItemsForSearch(cfg),
  ];
  assert.ok(allItems.length > 200);

  const timeUnits = new Set(['秒', '毫秒', '分钟', '小时', '天', '点', '时:分', '毫秒/字', '分钟（从 0 点算）']);
  for (const item of allItems) {
    assert.ok(Array.isArray(item.tags) && item.tags.length > 0, `${item.path} 缺少搜索关键词`);
    for (const id of item.tags) assert.ok(validTagIds.has(id), `${item.path} 包含未知关键词 ${id}`);
    if (timeUnits.has(item.unit)) {
      const core = item.unit === '分钟（从 0 点算）' ? '分钟' : item.unit;
      assert.ok(String(item.hint || '').includes(core), `${item.path}（${item.label}）的注释缺少单位「${core}」：${item.hint}`);
    }
  }
});
