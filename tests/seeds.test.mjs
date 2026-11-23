// seeds.test.mjs —— 随口说话的起点：记忆里挑一条、去重、隐私过滤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryPool, personaPool, pickSeed, seedId, conversationLine, rememberSeed } from '../src/seeds.js';
import { noteChitchatSent } from '../src/chitchat.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 7, 12, 0); // 北京 20:00
const DAY = 86_400_000;

function tmpMem(memories) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-seed-'));
  fs.writeFileSync(
    path.join(dir, 'session-abc.json'),
    JSON.stringify({ session: 'abc', memories }),
    'utf8'
  );
  return dir;
}

const cfgOf = (dir, chitchat = {}) => ({
  timezone: TZ,
  sources: { memory: { enabled: true, plugin: 'fish-memory', dir, max: 8, maxAgeDays: 3650 } },
  rules: { chitchat: { enabled: true, seedDays: 30, seedSkipPrivate: true, ...chitchat } },
});

const memOf = (text, at = NOW - 3 * DAY, extra = {}) => ({
  id: text.slice(0, 8),
  text,
  at: new Date(at).toISOString(),
  category: 'event',
  importance: 0.5,
  ...extra,
});

test('记忆种子池：太老的、我自己标了「不给她看」的、带路径或系统规则元信息的都不进来', () => {
  const dir = tmpMem([
    memOf('她今天说想学电机仿真'),
    memOf('这条不给她看：我其实有点慌', NOW - 2 * DAY),
    memOf('很久以前的一件小事', NOW - 40 * DAY),
    memOf('规则：自主探索每 3 轮里做一次并写进 C:\\Users\\sonetto\\notes.md', NOW - DAY),
    memOf('真奈给我定了官方形象参考图：银白长发', NOW - DAY),
  ]);
  const { pool, why } = memoryPool({ cfg: cfgOf(dir), now: NOW });
  assert.equal(pool.length, 1);
  assert.match(pool[0].text, /电机仿真/);
  assert.equal(why, null);
});

test('seedSkipPrivate=false 才把我瞒着她的事算进来（默认不算）', () => {
  const dir = tmpMem([memOf('这条不给她看：怕她为难', NOW - DAY)]);
  assert.equal(memoryPool({ cfg: cfgOf(dir), now: NOW }).pool.length, 0);
  const loose = memoryPool({ cfg: cfgOf(dir, { seedSkipPrivate: false }), now: NOW });
  assert.equal(loose.pool.length, 1);
});

test('pickSeed：最近 3 次用过的跳过；池子用空就不硬凑', () => {
  const dir = tmpMem([memOf('她昨天说想学电机仿真'), memOf('周三去图书馆借了两本书')]);
  const cfg = cfgOf(dir);
  const first = pickSeed({ cfg, now: NOW, st: {}, rnd: () => 0 });
  assert.ok(first.seed);
  const used = first.seed.id;

  const st = { chitchat: { day: '2026-11-07', count: 0, recentSeeds: [used] } };
  const second = pickSeed({ cfg, now: NOW, st, rnd: () => 0 });
  assert.ok(second.seed);
  assert.notEqual(second.seed.id, used);

  // 两条都用过 → 这一拍没有种子
  st.chitchat.recentSeeds = [first.seed.id, second.seed.id];
  const third = pickSeed({ cfg, now: NOW, st, rnd: () => 0 });
  assert.equal(third.seed, null);
  assert.equal(third.why, 'SEED_ALL_USED');
});

test('seedId 稳定：同样的文字永远是同一个 id（跨进程也一样）', () => {
  assert.equal(seedId('m', '同一句话'), seedId('m', '同一句话'));
  assert.notEqual(seedId('m', '同一句话'), seedId('m', '另一句话'));
});

test('发出去之后才记种子；环形只留 3 条', () => {
  const st = {};
  noteChitchatSent(st, NOW, TZ, '睡了没', 'm:aaa');
  noteChitchatSent(st, NOW, TZ, '还没睡', 'm:bbb');
  noteChitchatSent(st, NOW, TZ, '空调开太低', 'm:ccc');
  noteChitchatSent(st, NOW, TZ, '明早叫你', 'm:ddd');
  assert.deepEqual(st.chitchat.recentSeeds, ['m:bbb', 'm:ccc', 'm:ddd']);
});

test('reply 只是留痕：没给 seedId 就不动环', () => {
  const st = { chitchat: { day: '2026-11-07', count: 0, recentSeeds: ['m:x'] } };
  noteChitchatSent(st, NOW, TZ, '在吗');
  assert.deepEqual(st.chitchat.recentSeeds, ['m:x']);
});

test('对话种子：她 6 小时内说过才用；太久就退到最近两轮', () => {
  const fresh = conversationLine({ her: { lastText: '今天好累', lastAgoSec: 20 * 60 } });
  assert.match(fresh, /她 20 分钟前说：「今天好累」/);
  const stale = conversationLine({ her: { lastText: '昨晚那句', lastAgoSec: 20 * 3600 }, turns: [] });
  assert.equal(stale, '');
  const turns = conversationLine({
    her: { lastText: '昨晚那句', lastAgoSec: 20 * 3600 },
    turns: [{ who: 'her', text: '你几点回' }, { who: 'me', text: '马上' }],
  });
  assert.match(turns, /她：你几点回 \/ 我：马上/);
});

test('rememberSeed 是 noteChitchatSent 的简写，只写环', () => {
  const st = { chitchat: { day: '2026-11-07', count: 1, recentSeeds: ['m:a'] } };
  rememberSeed(st, 'm:b');
  assert.deepEqual(st.chitchat.recentSeeds, ['m:a', 'm:b']);
  assert.equal(st.chitchat.count, 1);
});

test('personaPool 从人设提取角色自身生活/毛病/偏好种子，且 pickSeed 会与记忆轮替', () => {
  const persona = {
    ok: true,
    text: [
      '## 我是谁',
      '- 我 = 示例角色：女，大三。',
      '- 天生胃不好：紧张、熬夜就容易犯。犯的时候嘴硬只说「没事」。',
      '- 明知胃不好还是爱喝冰饮料，常让人顺手带一杯。',
      '## 说话方式',
      '- 短：一到三句，不许说爱喝冰饮的套话。',
      '## 对方是什么样的人',
      '- 体寒怕冷，手总是凉的。',
    ].join('\n'),
  };
  const pPool = personaPool({ persona });
  assert.equal(pPool.length, 2);
  assert.equal(pPool.every((s) => s.kind === 'persona' && s.id.startsWith('p:')), true);
  assert.match(pPool[0].text, /胃不好/);
  assert.match(pPool[1].text, /冰饮料/);

  const dir = tmpMem([memOf('昨天去实验室调试板子')]);
  const cfg = cfgOf(dir);
  const first = pickSeed({ cfg, persona, now: NOW, st: {}, rnd: () => 0 });
  assert.equal(first.seed?.kind, 'persona');
  const st = { chitchat: { day: '2026-11-07', count: 1, recentSeeds: [first.seed.id] } };
  const second = pickSeed({ cfg, persona, now: NOW, st, rnd: () => 0 });
  assert.equal(second.seed?.kind, 'memory');
});

test('memoryPool 过滤 CCF-C/论文/拆功能点等项目焦虑记忆，pickSeed 对最近刚提过的饮料种子去重', () => {
  const dir = tmpMem([
    memOf('真奈想独立投一篇 CCF-C，想从插件里拆一个功能点做研究又怕赛道太挤'),
    memOf('昨天买到一家挺好的桂花乌龙'),
  ]);
  const cfg = cfgOf(dir);
  const { pool } = memoryPool({ cfg, now: NOW });
  assert.equal(pool.length, 1);
  assert.match(pool[0].text, /桂花乌龙/);

  const persona = {
    ok: true,
    text: [
      '## 我是谁',
      '- 明知胃不好还是爱喝冰饮料，常让「你」顺手带一杯。',
      '- 喜欢看推理小说和漫画。',
    ].join('\n'),
  };
  const picked = pickSeed({
    cfg: cfgOf(tmpMem([])),
    persona,
    now: NOW,
    st: { content: { recentSends: ['中午了，吃了没？顺手给我带杯饮料嘛~'] } },
    rnd: () => 0,
  });
  assert.match(picked.seed?.text || '', /推理小说/);
});