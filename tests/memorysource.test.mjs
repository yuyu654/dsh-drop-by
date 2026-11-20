// memorysource.test.mjs —— 从别的记忆插件（鱼的记忆）读记忆：选文件、去重、过滤、进 prompt。
// 全部用临时目录，不碰真的 ~/.dsh/fish-memory。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemory, listSessions, memoryFacts, memoryLine, memoryDir, MEMORY_PLUGINS, inspectMemory, mergeMemorySessions, restoreMemoryBackup } from '../src/memorysource.js';
import { buildPrompt } from '../src/compose.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mem-'));

function writeSession(id, memories, extra = {}) {
  const file = path.join(dir, `session-${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 2, memories, deleted: [], traces: [], ...extra }));
  const t = new Date(Date.now() - id.length * 1000);
  fs.utimesSync(file, t, t); // 改 mtime：id 越长越旧
  return file;
}

const cfgOf = (memory = {}) => ({
  sources: { memory: { enabled: true, plugin: 'fish-memory', dir, max: 3, maxAgeDays: 120, ...memory } },
});

const at = (d) => new Date(d).toISOString();

writeSession('old', [
  { id: 'a1', text: 'ta 让我叫她「奈宝」。', at: at('2026-10-30T10:00:00Z'), category: 'event', importance: 0.5 },
]);
writeSession('new', [
  { id: 'b1', text: 'ta 在意跑 DSH 的花费，能省则省。', at: at('2026-11-01T03:00:00Z'), category: 'event', importance: 0.5 },
  { id: 'b2', text: 'ta 的毕业设计方向是电机结构设计仿真。', at: at('2026-10-29T08:00:00Z'), category: 'stable_profile', importance: 1 },
  { id: 'b3', text: 'ta 不喜欢被说成九型人格 4 号。', at: at('2026-10-29T09:00:00Z'), category: 'event', importance: 0.5 },
  { id: 'b4', text: '这条已经删了。', at: at('2026-11-02T00:00:00Z'), category: 'event', importance: 0.5 },
  // 和 b2 是同一件事，只改了一点措辞：指纹相同，只留一条
  { id: 'b5', text: 'ta 的毕设方向：电机结构设计仿真。', at: at('2026-10-29T10:00:00Z'), category: 'event', importance: 0.5 },
  // 太老、又不重要：不该被带
  { id: 'b6', text: '很久以前的一件小事。', at: at('2025-01-01T00:00:00Z'), category: 'event', importance: 0.2 },
]);

fs.writeFileSync(
  path.join(dir, 'session-new.json'),
  JSON.stringify({
    version: 2,
    memories: JSON.parse(fs.readFileSync(path.join(dir, 'session-new.json'), 'utf8')).memories,
    deleted: [{ id: 'b4' }, 'b6-x'],
    traces: [],
  }),
);

test('listSessions：只认 session-*.json，按最近改过排', () => {
  const list = listSessions(dir);
  assert.equal(list.length, 2);
  assert.equal(list[0].session, 'new');
  assert.equal(list[1].session, 'old');
});

test('readMemory：默认取最近改过的那一份，长期事实排前面', () => {
  const mem = readMemory({ cfg: cfgOf() });
  assert.equal(mem.ok, true);
  assert.equal(mem.mode, 'newest');
  assert.deepEqual(mem.files, ['session-new.json']);
  assert.equal(mem.items[0].category, 'stable_profile');
  // b1 是 11-01 的事件，排在另外两条 10-29 的事件前
  assert.match(mem.items[1].text, /花费/);
});

test('readMemory：同一条（措辞略变）只留一次；太老又不要紧的丢掉', () => {
  const mem = readMemory({ cfg: cfgOf({ max: 8 }) });
  const texts = mem.items.map((x) => x.text).join('\n');
  assert.equal((texts.match(/电机结构设计/g) || []).length, 1);
  assert.doesNotMatch(texts, /很久以前/);
});

test('readMemory：指定会话前缀 / all 合并', () => {
  const one = readMemory({ cfg: cfgOf({ session: 'old' }) });
  assert.deepEqual(one.files, ['session-old.json']);
  assert.match(one.items[0].text, /奈宝/);

  const all = readMemory({ cfg: cfgOf({ session: 'all', max: 8 }) });
  assert.equal(all.mode, 'all');
  assert.equal(all.files.length, 2);
  assert.ok(all.items.some((x) => /奈宝/.test(x.text)));
});

test('readMemory：关着 / 不认识的插件 / 空目录 / 会话找不到', () => {
  assert.equal(readMemory({ cfg: cfgOf({ enabled: false }) }).reason, 'MEMORY_OFF');
  assert.equal(readMemory({ cfg: cfgOf({ plugin: 'nope' }) }).reason, 'MEMORY_PLUGIN_UNKNOWN');
  assert.equal(readMemory({ cfg: cfgOf({ dir: path.join(dir, 'none') }) }).reason, 'MEMORY_EMPTY');
  assert.equal(readMemory({ cfg: cfgOf({ session: 'zzz' }) }).reason, 'MEMORY_SESSION_NOT_FOUND');
});

test('memoryDir：配置里写了就用它；没写走插件自己的默认目录', () => {
  assert.equal(memoryDir(cfgOf()), dir);
  const d = memoryDir({ sources: { memory: { plugin: 'fish-memory' } } });
  assert.ok(d.endsWith(path.join('.dsh', 'fish-memory')) || d.endsWith('fish-memory'));
  assert.equal(memoryDir({ sources: { memory: { plugin: 'nope' } } }), null);
  assert.ok(MEMORY_PLUGINS['fish-memory']);
});

test('memoryFacts / memoryLine：带日期的那几句 + 一行摘要', () => {
  const mem = readMemory({ cfg: cfgOf() });
  const facts = memoryFacts(mem);
  assert.ok(facts.length >= 1 && facts.length <= 3);
  assert.match(facts[0], /^我记得（\d{4}-\d{2}-\d{2}）：/);
  assert.match(memoryLine(mem), /fish-memory \d+ 条/);
  assert.equal(memoryLine({ ok: false, reason: 'MEMORY_OFF' }), '没读到（关着）');
});

test('buildPrompt：记忆进了「已知事实」，但要求当背景、不许罗列', () => {
  const mem = readMemory({ cfg: cfgOf() });
  const p = buildPrompt({
    ctx: { clock: '20:00', memory: mem, recent: [], her: {}, me: {}, fish: { ok: false } },
    topic: { slot: 'share', brief: '随手说一句', label: 'share' },
    persona: { text: '人格' },
    cfg: { content: { maxChars: 60 } },
  });
  assert.match(p, /我记得（\d{4}-\d{2}-\d{2}）：/);
  assert.match(p, /只能当背景/);
});

test('workspace mode：同时识别 ws_*.json 与 session-*.json，跳过空工作区文件并按文本去重', (t) => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mem-ws-'));
  t.after(() => fs.rmSync(wsDir, { recursive: true, force: true }));
  const writeRaw = (fileName, memories, ageSec) => {
    const file = path.join(wsDir, fileName);
    fs.writeFileSync(file, JSON.stringify({ version: 2, memories, deleted: [], traces: [] }));
    const ts = new Date(Date.now() - ageSec * 1000);
    fs.utimesSync(file, ts, ts);
    return file;
  };
  const recent = new Date().toISOString();
  writeRaw('ws_--empty--.json', [], 1); // 最新但是空的，应跳过
  writeRaw('ws_--work--.json', [
    { id: 'w1', text: '在当前工作区里调试 presence-gate', category: 'event', at: recent, importance: 0.7 },
    { id: 'w2', text: '对方不喜欢冷淡的机器感', category: 'stable_profile', at: recent, importance: 0.9 },
  ], 5);
  writeRaw('ws_--other--.json', [
    { id: 'w3', text: '另一个工作区的冷门记录', category: 'event', at: recent, importance: 0.5 },
  ], 20);
  writeRaw('session-549f.json', [
    { id: 's1', text: '对方不喜欢冷淡的机器感', category: 'stable_profile', at: recent, importance: 0.9 },
    { id: 's2', text: '会话里聊到周末去吃烤肉', category: 'event', at: recent, importance: 0.6 },
  ], 10);

  const list = listSessions(wsDir);
  assert.equal(list.length, 4);
  assert.equal(list[0].kind, 'workspace');
  assert.equal(list.find((x) => x.name === 'session-549f.json')?.kind, 'session');

  const cfgWs = (extra = {}) => ({ sources: { memory: { enabled: true, plugin: 'fish-memory', dir: wsDir, max: 8, ...extra } } });

  // 默认留空：跳过 ws_--empty--.json，读取最新有记忆的 ws_--work--.json + session-549f.json，并去重
  const defMem = readMemory({ cfg: cfgWs() });
  assert.equal(defMem.ok, true);
  assert.deepEqual(defMem.files, ['ws_--work--.json', 'session-549f.json']);
  assert.equal(defMem.items.filter((i) => i.text.includes('冷淡的机器感')).length, 1);
  assert.ok(defMem.items.some((i) => i.text.includes('调试 presence-gate')));
  assert.ok(defMem.items.some((i) => i.text.includes('去吃烤肉')));
  assert.equal(defMem.items.some((i) => i.text.includes('另一个工作区的冷门记录')), false);

  // 按 ws_ 前缀锁定工作区文件
  const locked = readMemory({ cfg: cfgWs({ session: 'ws_--other' }) });
  assert.deepEqual(locked.files, ['ws_--other--.json']);
  assert.equal(locked.items[0].text, '另一个工作区的冷门记录');

  // all 合并全部工作区与会话文件并去重
  const merged = readMemory({ cfg: cfgWs({ session: 'all' }) });
  assert.equal(merged.files.length, 4);
  assert.equal(merged.items.filter((i) => i.text.includes('冷淡的机器感')).length, 1);
  assert.equal(merged.items.length, 4);
});

test('inspectMemory & mergeMemorySessions：只增不删地将历史会话并入目标工作区并备份', (t) => {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mem-merge-'));
  t.after(() => fs.rmSync(wsDir, { recursive: true, force: true }));
  const nowIso = new Date().toISOString();
  fs.writeFileSync(path.join(wsDir, 'ws_--main--.json'), JSON.stringify({
    version: 2,
    memories: [
      { id: 'w1', text: '不喜欢半夜被查岗', category: 'stable_profile', at: nowIso, importance: 0.9 },
    ],
    deleted: ['del-1'],
    traces: [],
  }));
  fs.writeFileSync(path.join(wsDir, 'session-old.json'), JSON.stringify({
    version: 2,
    memories: [
      { id: 's-dup', text: '不喜欢半夜被查岗！', category: 'stable_profile', at: nowIso, importance: 0.9 },
      { id: 'del-1', text: '已被删掉的条目不该再并入', category: 'event', at: nowIso, importance: 0.5 },
      { id: 's-new', text: '平时喜欢喝无糖乌龙茶', category: 'stable_profile', at: nowIso, importance: 0.85 },
    ],
    deleted: [],
    traces: [],
  }));
  const cfg = { sources: { memory: { enabled: true, plugin: 'fish-memory', dir: wsDir, max: 5 } } };

  const info = inspectMemory({ cfg });
  assert.equal(info.defaultTarget, 'ws_--main--.json');
  assert.equal(info.mergeTarget, 'ws_--main--.json');
  assert.equal(info.mergeableSessions, 1);
  assert.deepEqual(info.mergePreview, { target: 'ws_--main--.json', added: 1, skipped: 2 });
  assert.deepEqual(info.active.files, ['ws_--main--.json', 'session-old.json']);

  // dryRun 只预演统计，不写目标文件、不建备份
  const dry = mergeMemorySessions({ cfg, dryRun: true });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun, true);
  assert.equal(dry.added, 1);
  assert.equal(fs.existsSync(path.join(wsDir, 'ws_--main--.json.bak-before-merge')), false);

  const merged = mergeMemorySessions({ cfg });
  assert.equal(merged.ok, true);
  assert.equal(merged.dryRun, false);
  assert.equal(merged.target, 'ws_--main--.json');
  assert.equal(merged.added, 1);
  assert.equal(merged.skipped, 2);
  assert.equal(merged.totalAfter, 2);
  assert.equal(fs.existsSync(path.join(wsDir, 'ws_--main--.json.bak-before-merge')), true);

  // 原 session-old.json 丝毫未动，第二次合并幂等
  const srcRaw = JSON.parse(fs.readFileSync(path.join(wsDir, 'session-old.json'), 'utf8'));
  assert.equal(srcRaw.memories.length, 3);
  const second = mergeMemorySessions({ cfg });
  assert.equal(second.ok, true);
  assert.equal(second.added, 0);

  // 可从 .bak-before-merge 恢复并支持只挑指定 session 文件并入
  const restored = restoreMemoryBackup({ cfg, targetFile: 'ws_--main--.json' });
  assert.equal(restored.ok, true);
  assert.equal(restored.totalRestored, 1);
  assert.equal(fs.existsSync(path.join(wsDir, 'ws_--main--.json.bak-before-merge')), false);

  fs.writeFileSync(path.join(wsDir, 'session-other.json'), JSON.stringify({
    version: 2,
    memories: [{ id: 's-other', text: '另一条未勾选的会话记忆', category: 'event', at: nowIso, importance: 0.7 }],
    deleted: [],
  }));
  const selective = mergeMemorySessions({ cfg, targetFile: 'ws_--main--.json', sourceFiles: ['session-old.json'] });
  assert.equal(selective.ok, true);
  assert.deepEqual(selective.selectedSessions, ['session-old.json']);
  assert.equal(selective.added, 1);
  assert.equal(selective.totalAfter, 2);
});

test('多插件适配：json-generic 支持多种结构与 JSONL，markdown 支持笔记目录，auto 自动识别且非 fish-memory 禁用合并', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-mem-multi-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nowSec = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();

  // 1. json-generic 目录：包装对象 + JSONL + 字段别名
  const jsonDir = path.join(root, 'json-plugin');
  fs.mkdirSync(jsonDir, { recursive: true });
  fs.writeFileSync(path.join(jsonDir, 'facts.json'), JSON.stringify({
    facts: [
      { id: 'f1', content: '喜欢深夜写代码时喝冰美式', type: 'preference', score: 9, created_at: nowSec },
      { id: 'f2', content: '已归档条目', type: 'event', archived: true, created_at: nowSec },
      { id: 'f3', fact: '周三晚上要上选修课', kind: 'event', timestamp: nowIso },
    ],
    deleted: ['f4'],
  }));
  fs.writeFileSync(path.join(jsonDir, 'stream.jsonl'), [
    JSON.stringify({ summary: '昨天顺手修好了定时器测试', ts: nowSec }),
    '{bad json line',
    JSON.stringify({ memory: '已经删掉的记录', deleted: true }),
  ].join('\n'));

  const jsonCfg = { sources: { memory: { enabled: true, plugin: 'json-generic', dir: jsonDir, max: 6 } } };
  const jsonMem = readMemory({ cfg: jsonCfg });
  assert.equal(jsonMem.ok, true);
  assert.equal(jsonMem.resolvedPlugin, 'json-generic');
  assert.equal(jsonMem.items[0].category, 'stable_profile');
  assert.match(jsonMem.items[0].text, /冰美式/);
  assert.ok(jsonMem.items.some((i) => /选修课/.test(i.text)));
  assert.ok(jsonMem.items.some((i) => /定时器测试/.test(i.text)));
  assert.equal(jsonMem.items.some((i) => /已归档|已经删掉/.test(i.text)), false);

  // 非 fish-memory 不允许 merge/restore，也不篡改外部文件
  const jsonInspect = inspectMemory({ cfg: jsonCfg });
  assert.equal(jsonInspect.supportsMerge, false);
  assert.equal(jsonInspect.mergePreview, null);
  assert.equal(mergeMemorySessions({ cfg: jsonCfg }).reason, 'MERGE_NOT_SUPPORTED');
  assert.equal(restoreMemoryBackup({ cfg: jsonCfg }).reason, 'MERGE_NOT_SUPPORTED');

  // 2. auto 自动识别单文件与目录
  const singleJsonl = path.join(jsonDir, 'stream.jsonl');
  const autoSingle = readMemory({ cfg: { sources: { memory: { enabled: true, plugin: 'auto', dir: singleJsonl, max: 4 } } } });
  assert.equal(autoSingle.ok, true);
  assert.equal(autoSingle.resolvedPlugin, 'json-generic');
  assert.match(memoryLine(autoSingle), /auto→json-generic/);

  // 3. markdown 目录与单文件
  const mdDir = path.join(root, 'md-notes');
  fs.mkdirSync(mdDir, { recursive: true });
  fs.writeFileSync(path.join(mdDir, '2026-11-16.md'), [
    '---',
    'title: notes',
    '---',
    '## 长期偏好',
    '- 讨厌说教腔，喜欢直来直去的回答',
    '## 2026-11-16',
    '- [11-16] 晚上刚把电感参数算清楚',
    '```js',
    'const ignored = "代码块里的内容不算记忆";',
    '```',
  ].join('\n'));
  const mdCfg = { sources: { memory: { enabled: true, plugin: 'auto', dir: mdDir, max: 5 } } };
  const mdMem = readMemory({ cfg: mdCfg });
  assert.equal(mdMem.ok, true);
  assert.equal(mdMem.resolvedPlugin, 'markdown');
  assert.equal(mdMem.items[0].category, 'stable_profile');
  assert.match(mdMem.items[0].text, /直来直去/);
  assert.ok(mdMem.items.some((i) => i.day === '2026-11-16' && /电感参数/.test(i.text)));
  assert.equal(mdMem.items.some((i) => /代码块/.test(i.text)), false);
});

test('dsh-soul-md 适配：支持 layered 目录（core.md + topics/*.md）、HH:mm 标题和注释过滤', (t) => {
  const prevHome = process.env.PG_DSH_HOME;
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-soul-home-'));
  t.after(() => {
    if (prevHome === undefined) delete process.env.PG_DSH_HOME;
    else process.env.PG_DSH_HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });
  process.env.PG_DSH_HOME = fakeHome;

  const soulRoot = path.join(fakeHome, 'soul-md', 'memory');
  const topicsDir = path.join(soulRoot, 'Kira', 'topics');
  fs.mkdirSync(topicsDir, { recursive: true });
  fs.writeFileSync(path.join(soulRoot, 'Kira', 'core.md'), [
    '<!-- internal note -->',
    '## 2026-11-17 18:20 — 用户偏好',
    '- 平时喜欢喝冰美式，讨厌说教腔',
  ].join('\n'));
  fs.writeFileSync(path.join(topicsDir, 'motor-sim.md'), [
    '## 2026-11-17 18:25 — motor-sim',
    '已完成电机热仿真第一阶段边界条件确认',
  ].join('\n'));

  const soulCfg = { sources: { memory: { enabled: true, plugin: 'soul-md', max: 5 } } };
  const mem = readMemory({ cfg: soulCfg });
  assert.equal(mem.ok, true);
  assert.equal(mem.resolvedPlugin, 'soul-md');
  assert.ok(mem.files.includes('Kira/core.md'));
  assert.ok(mem.files.includes('Kira/topics/motor-sim.md'));
  assert.equal(mem.items[0].category, 'stable_profile');
  assert.match(mem.items[0].text, /冰美式/);
  assert.ok(mem.items.some((i) => /电机热仿真/.test(i.text) && i.day === '2026-11-17'));
  assert.equal(mem.items.some((i) => /internal note/.test(i.text)), false);

  // auto 在没有 fish-memory 时也能自动识别 soul-md/memory
  const autoMem = readMemory({ cfg: { sources: { memory: { enabled: true, plugin: 'auto', max: 5 } } } });
  assert.equal(autoMem.ok, true);
  assert.equal(autoMem.resolvedPlugin, 'soul-md');
});