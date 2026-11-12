// memorysource.test.mjs —— 从别的记忆插件（鱼的记忆）读记忆：选文件、去重、过滤、进 prompt。
// 全部用临时目录，不碰真的 ~/.dsh/fish-memory。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readMemory, listSessions, memoryFacts, memoryLine, memoryDir, MEMORY_PLUGINS } from '../src/memorysource.js';
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