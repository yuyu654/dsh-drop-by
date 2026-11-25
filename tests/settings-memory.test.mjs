// settings-memory.test.mjs —— 「用哪个记忆插件」这一项的说明里要把「怎么接别的插件」写出来。
//
// 为什么要有这条：内置只适配了鱼的记忆（fish-memory），但用户可能用别的记忆插件。
// 这一项的 hint 要说清：还能接，让用户自己的大肥鱼在 src/memorysource.js 里加一条适配。
// （选项仍然只列内置的那一个，不在设置页里让用户手填插件名——名字对不上只会静默读不到。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listForUi, SCHEMA } from '../src/settings/settings.js';
import { MEMORY_PLUGINS } from '../src/decision/memorysource.js';

const cfg = () => ({
  enabled: true,
  rules: { judge: { enabled: false } },
  sources: { phone: { enabled: false }, memory: { enabled: true, plugin: 'fish-memory' } },
  content: { enabled: true, topics: {} },
});

test('记忆插件选项列的是内置适配，fish-memory / auto / json-generic / markdown 在里头', () => {
  const spec = SCHEMA.find((s) => s.path === 'sources.memory.plugin');
  assert.ok(spec, '设置页要有这一项');
  for (const id of ['fish-memory', 'soul-md', 'auto', 'json-generic', 'markdown']) {
    assert.ok(spec.options.some(([k]) => k === id), `缺少选项 ${id}`);
  }
  // 选项里的 id 必须真有适配，不然选了也是静默读不到
  for (const [id] of spec.options) assert.ok(MEMORY_PLUGINS[id], `${id} 没在 MEMORY_PLUGINS 里`);
  const dirSpec = SCHEMA.find((s) => s.path === 'sources.memory.dir');
  assert.ok(dirSpec && dirSpec.group === '数据从哪来', '设置页要有自定义记忆目录/文件入口');
});

test('这一项的提示里写清楚：换插件找自己的大肥鱼加适配', () => {
  const groups = listForUi(cfg());
  const item = groups.flatMap((g) => g.items).find((i) => i.path === 'sources.memory.plugin');
  assert.ok(item, '开着记忆时这一项要出现');
  assert.match(item.hint, /鱼/);
  assert.match(item.hint, /大肥鱼/);
  assert.match(item.hint, /memorysource\.js/);

  const srcGroup = groups.find((g) => g.name === '数据从哪来');
  const enabledIdx = srcGroup.items.findIndex((i) => i.path === 'sources.memory.enabled');
  const pluginIdx = srcGroup.items.findIndex((i) => i.path === 'sources.memory.plugin');
  assert.ok(enabledIdx >= 0 && pluginIdx === enabledIdx + 1, '用哪个记忆插件要紧跟在读记忆插件的记忆下面');
  assert.match(srcGroup.items[enabledIdx].hint, /下面这个记忆插件/);
});