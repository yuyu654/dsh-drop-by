import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRssXml, createBuiltinExploreSources, syncBuiltinExploreFeeds } from '../src/explore-feeds.js';
import { listExploreSources } from '../src/extensions.js';
import { recordExplorationMemory, recallExplorationMemories } from '../src/exploration-memory.js';
import { syncExplorationToMemory } from '../src/memorysource.js';
import { noteSent, settle } from '../src/feedback.js';
import { applyChange, listForUi } from '../src/settings.js';
import { loadConfig } from '../src/config.js';

test('parseRssXml：支持 RSS 2.0 与 Atom 格式并过滤非公网链接', () => {
  const rss = `
    <rss><channel>
      <item>
        <title><![CDATA[独立游戏关卡拆解 &amp; 设计]]></title>
        <link>https://example.com/level-design</link>
        <description><![CDATA[<p>用引导线替代文字教程。</p>]]></description>
      </item>
      <item>
        <title>内网条目</title>
        <link>http://127.0.0.1/secret</link>
        <description>不应暴露内网链接</description>
      </item>
    </channel></rss>`;
  const items = parseRssXml(rss, 5);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '独立游戏关卡拆解 & 设计');
  assert.equal(items[0].url, 'https://example.com/level-design');
  assert.match(items[0].summary, /引导线/);
  assert.equal(items[1].url, undefined);

  const atom = `<feed><entry><title>Atom 新篇</title><link href="https://blog.example.org/post-1"/><summary>简短摘要</summary></entry></feed>`;
  const aItems = parseRssXml(atom, 5);
  assert.equal(aItems.length, 1);
  assert.equal(aItems[0].url, 'https://blog.example.org/post-1');
});

test('builtinFeeds：Bangumi / GitHub / B站热榜 / RSS 适配器与动态注册卸载', async () => {
  const fakeFetch = async (url) => {
    const u = String(url);
    if (u.includes('api.bgm.tv/calendar')) {
      return {
        ok: true,
        async json() {
          return [{
            weekday: { id: 2, cn: '星期二' },
            items: [{ id: 123, name_cn: '某部高分新番', rating: { score: 8.5 }, air_date: '2026-10-01', summary: '轻松日常番' }],
          }];
        },
      };
    }
    if (u.includes('api.github.com/search/repositories')) {
      return {
        ok: true,
        async json() {
          return { items: [{ full_name: 'org/cool-relay', language: 'Rust', stargazers_count: 1200, description: '反时限保护算法库', html_url: 'https://github.com/org/cool-relay' }] };
        },
      };
    }
    if (u.includes('api.bilibili.com')) {
      return {
        ok: true,
        async json() {
          return { data: { list: [{ title: '拆解机械键盘轴体', bvid: 'BV1xx411c7mD', owner: { name: '硬件UP' }, tname: '数码', desc: '手感对比' }] } };
        },
      };
    }
    return {
      ok: true,
      async text() {
        return '<rss><channel><item><title>订阅快讯</title><link>https://news.example.com/1</link><description>测试内容</description></item></channel></rss>';
      },
    };
  };

  const sources = createBuiltinExploreSources({
    getConfig: () => ({ exploration: { builtinFeeds: true, rssUrls: 'https://news.example.com/rss.xml' } }),
    fetchImpl: fakeFetch,
  });
  const byId = Object.fromEntries(sources.map((s) => [s.id, s]));

  const bgm = await byId['builtin-bangumi'].browse({ query: '新番', now: Date.parse('2026-11-24T12:00:00+08:00') });
  assert.equal(bgm.ok, true);
  assert.equal(bgm.items[0].title, '某部高分新番');

  const gh = await byId['builtin-github'].browse({ query: '反时限' });
  assert.equal(gh.ok, true);
  assert.equal(gh.items[0].title, 'org/cool-relay');

  const bili = await byId['builtin-bilibili-hot'].browse({ query: '键盘' });
  assert.equal(bili.ok, true);
  assert.match(bili.items[0].url, /BV1xx411c7mD/);

  const rss = await byId['builtin-rss'].browse({ query: '快讯' });
  assert.equal(rss.ok, true);
  assert.equal(rss.items[0].title, '订阅快讯');

  // 动态注册与关闭卸载
  const countOn = syncBuiltinExploreFeeds({ exploration: { builtinFeeds: true, rssUrls: 'https://news.example.com/rss.xml' } }, { fetchImpl: fakeFetch });
  assert.equal(countOn, 4);
  assert.ok(listExploreSources().some((s) => s.id === 'builtin-bangumi'));

  const countOff = syncBuiltinExploreFeeds({ exploration: { builtinFeeds: false } });
  assert.equal(countOff, 0);
  assert.equal(listExploreSources().some((s) => s.id === 'builtin-bangumi'), false);
});

test('exploration-memory：支持字符 2-gram 简称召回与同义别名召回，无关查询不误命中', () => {
  const now = Date.parse('2026-11-24T19:00:00+08:00');
  let mem = [];
  mem = recordExplorationMemory(mem, {
    mode: 'research',
    topic: '《“哆哆嗦嗦”逃离你》第001话',
    progress: '社恐设计师艾栩在例会上靠PPT蒙混过关',
    at: now,
  }, { now });
  mem = recordExplorationMemory(mem, {
    mode: 'leisure',
    topic: '十月高分新番日历',
    progress: '看到一部节奏轻快的日常番剧',
    at: now,
  }, { now });

  // 简称（2-gram 重合）：「哆嗦逃离」命中「《“哆哆嗦嗦”逃离你》」
  const hitAbbr = recallExplorationMemories(mem, { query: '哆嗦逃离', now, requireMatch: true });
  assert.equal(hitAbbr.length, 1);
  assert.match(hitAbbr[0].topic, /哆哆嗦嗦/);

  // 同义别名：「追番」命中「新番/番剧」
  const hitAlias = recallExplorationMemories(mem, { query: '最近想追番', now, requireMatch: true });
  assert.equal(hitAlias.length, 1);
  assert.match(hitAlias[0].topic, /新番/);

  // 完全无关查询不误命中
  const miss = recallExplorationMemories(mem, { query: '量子力学波函数', now, requireMatch: true });
  assert.equal(miss.length, 0);
});

test('syncExplorationToMemory：聊热的分享自动去重沉淀到 fish-memory 工作区文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-sync-mem-'));
  const wsFile = path.join(tmpDir, 'ws_demo.json');
  fs.writeFileSync(wsFile, JSON.stringify({ memories: [], deleted: [] }, null, 2), 'utf8');
  try {
    const cfg = {
      sources: { memory: { enabled: true, plugin: 'fish-memory', dir: tmpDir } },
      exploration: { syncToSharedMemory: true },
    };
    const now = Date.parse('2026-11-24T19:00:00+08:00');
    const st = {};
    noteSent(st, 'share', now, '刚翻到反时限保护的一个开源实现，思路挺干净的。');
    settle(st, now + 5 * 60_000, now + 6 * 60_000, '真的假的，回头我也看看！', { tz: 'Asia/Shanghai', cfg });

    const saved = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
    assert.equal(saved.memories.length, 1);
    assert.match(saved.memories[0].text, /反时限保护/);
    assert.ok(saved.memories[0].tags.includes('探索发现'));

    // 再次同步同内容自动去重
    const dup = syncExplorationToMemory({ cfg, text: '刚翻到反时限保护的一个开源实现，思路挺干净的。', now });
    assert.equal(dup.ok, true);
    assert.equal(dup.added, 0);
    assert.equal(dup.skipped, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('设置项：builtinFeeds / rssUrls / syncToSharedMemory 支持保存与回显', () => {
  const base = loadConfig();
  const c1 = applyChange(base, 'exploration.builtinFeeds', true);
  assert.equal(c1.ok, true);
  const c2 = applyChange(c1.cfg, 'exploration.rssUrls', 'https://example.com/feed.xml');
  assert.equal(c2.ok, true);
  const c3 = applyChange(c2.cfg, 'exploration.syncToSharedMemory', true);
  assert.equal(c3.ok, true);

  const items = listForUi(c3.cfg).flatMap((g) => g.items || []);
  assert.equal(items.find((x) => x.path === 'exploration.builtinFeeds')?.value, true);
  assert.equal(items.find((x) => x.path === 'exploration.rssUrls')?.value, 'https://example.com/feed.xml');
  assert.equal(items.find((x) => x.path === 'exploration.syncToSharedMemory')?.value, true);
});

test('安全试跑（syncMemory=false）结算已回复的探索分享时不写入 fish-memory', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-preview-mem-'));
  const memFile = path.join(tmpDir, 'mem.json');
  fs.writeFileSync(memFile, JSON.stringify({ items: [] }), 'utf8');
  try {
    const cfg = {
      timezone: 'Asia/Shanghai',
      memory: { enabled: true, file: memFile },
      exploration: { syncToSharedMemory: true },
    };
    const st = {};
    const t0 = Date.parse('2026-11-24T12:00:00+08:00');
    noteSent(st, 'share', t0, '试跑不应落库的探索分享内容，测试隔离。');
    const replied = settle(st, t0 + 5 * 60_000, t0 + 6 * 60_000, '挺有意思的', {
      tz: 'Asia/Shanghai',
      cfg,
      syncMemory: false,
    });
    assert.equal(replied, 1);
    const saved = JSON.parse(fs.readFileSync(memFile, 'utf8'));
    assert.equal(saved.items.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
