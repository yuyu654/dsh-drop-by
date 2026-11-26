import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyExplorationTarget, resolveExplorationTarget, setExplorationWorkSource } from '../src/explore/exploration-target.js';

test('ordinary research and an explicit topic skip work lookup', async () => {
  const lookup = async () => assert.fail('ordinary topics must skip the work catalog');
  for (const input of ['主题：三体', '只查分布式事务', '鱼鱼插件', '研究《三体》的叙事手法', '最近想了解独立游戏的关卡设计']) {
    const result = await resolveExplorationTarget(input, { lookup, workSources: '三体 | B漫' });
    assert.equal(result.kind, 'topic', input);
    assert.deepEqual(result.hosts, []);
  }
  assert.equal(classifyExplorationTarget('主题：三体').title, '三体');
});

test('explicit sources override saved titles and identify the work independently of a chapter', () => {
  const result = classifyExplorationTarget(
    '继续读《三体》第2章 https://books.example.org/books/3body/2',
    '三体 ｜ B漫',
  );
  assert.deepEqual(result, {
    input: '继续读《三体》第2章 https://books.example.org/books/3body/2',
    title: '三体', kind: 'work',
    hosts: ['books.example.org'], url: 'https://books.example.org/books/3body/2',
  });
  assert.deepEqual(classifyExplorationTarget('哔哩哔哩漫画：“哆哆嗦嗦”逃离你').hosts, ['manga.bilibili.com']);
  assert.equal(classifyExplorationTarget('继续读三体第二章').title, '三体');
});

test('a bare saved title resolves only its matching source mapping', async () => {
  const lookup = async () => assert.fail('an approved source must skip the work catalog');
  const result = await resolveExplorationTarget('三体', {
    workSources: '三体2 | https://example.com/other\n《三体》｜ https://books.example.org/3body',
    lookup,
  });
  assert.equal(result.kind, 'work');
  assert.equal(result.url, 'https://books.example.org/3body');
  assert.deepEqual(result.hosts, ['books.example.org']);
});

test('plain titles keep their words when they also look like reading or research phrases', () => {
  for (const title of ['看不见的城市', '软件架构']) {
    const result = classifyExplorationTarget(title, title + ' | B漫');
    assert.equal(result.title, title);
    assert.equal(result.kind, 'work');
  }
});

test('invalid explicit URLs and metadata domains do not give a work a reading source', () => {
  for (const input of ['《三体》 https://127.0.0.1/book', '作品：三体 https://bgm.tv/subject/12']) {
    const result = classifyExplorationTarget(input);
    assert.equal(result.reason, 'WORK_SOURCE_REQUIRED');
    assert.deepEqual(result.hosts, []);
    assert.equal(result.url, undefined);
  }
});

test('a catalog match requires an exact title on a trusted work landing page', async () => {
  const controller = new AbortController();
  const result = await resolveExplorationTarget('哆哆嗦嗦逃离你', {
    signal: controller.signal,
    lookup: async (title, { signal }) => {
      assert.equal(title, '哆哆嗦嗦逃离你');
      assert.equal(signal, controller.signal);
      return [
        { url: 'https://manga.bilibili.com/detail/mc38', title: '详解哆哆嗦嗦逃离你', snippet: '哆哆嗦嗦逃离你' },
        { url: 'https://manga.bilibili.com/blackboard/other', title: '哆哆嗦嗦逃离你', snippet: '' },
        { url: 'https://manga.bilibili.com.example.org/detail/mc39', title: '哆哆嗦嗦逃离你', snippet: '' },
        { url: 'https://manga.bilibili.com/m/detail/mc38749?from=search', title: '“哆哆嗦嗦”逃离你_哔哩哔哩漫画', snippet: '' },
        { url: 'https://manga.bilibili.com/detail/mc38749', title: '《哆哆嗦嗦逃离你》', snippet: '' },
      ];
    },
  });
  assert.equal(result.kind, 'work');
  assert.equal(result.url, 'https://manga.bilibili.com/detail/mc38749');
});

test('an exact metadata match identifies a work that still needs a reading source', async () => {
  const result = await resolveExplorationTarget('三体', {
    lookup: async () => [{ url: 'https://bgm.tv/subject/123', title: '三体 | Bangumi 番组计划', snippet: '三体' }],
  });
  assert.equal(result.kind, 'work');
  assert.equal(result.reason, 'WORK_SOURCE_REQUIRED');
  assert.deepEqual(result.hosts, []);
  assert.equal(result.url, undefined);
});

test('multiple official matches offer choices without approving any source', async () => {
  const result = await resolveExplorationTarget('作品：三体', {
    lookup: async () => [1, 2].map((id) => ({
      url: `https://manga.bilibili.com/detail/mc${id}`,
      title: '三体_哔哩哔哩漫画',
      snippet: '',
    })),
  });
  assert.equal(result.kind, 'ambiguous');
  assert.equal(result.reason, 'TOPIC_AMBIGUOUS');
  assert.deepEqual(result.hosts, []);
  assert.equal(result.url, undefined);
  assert.deepEqual(result.candidates.map(({ url }) => url), [
    'https://manga.bilibili.com/detail/mc1',
    'https://manga.bilibili.com/detail/mc2',
  ]);
});

test('multiple requested works stay unresolved without selecting the first', async () => {
  const result = await resolveExplorationTarget('《三体》和《球状闪电》', {
    lookup: async () => [{ url: 'https://manga.bilibili.com/detail/mc1', title: '三体', snippet: '' }],
  });
  assert.equal(result.kind, 'ambiguous');
  assert.deepEqual(result.hosts, []);
});

test('lookup failures preserve the unresolved distinction between bare and explicit works', async () => {
  const lookup = async () => { throw new Error('catalog unavailable'); };
  assert.equal((await resolveExplorationTarget('三体', { lookup })).reason, 'TOPIC_AMBIGUOUS');
  assert.equal((await resolveExplorationTarget('作品：三体', { lookup })).reason, 'WORK_SOURCE_REQUIRED');
});

test('updating a mapped source replaces just that title and preserves other lines', () => {
  const sources = '三体2 | https://example.com/other\r\n《三体》｜ B漫\r\n三体：旧值\r\n# 保留备注';
  assert.equal(setExplorationWorkSource(sources, '三体', 'https://example.org/read'), [
    '三体2 | https://example.com/other', '三体 | https://example.org/read', '# 保留备注',
  ].join('\r\n'));
  assert.equal(setExplorationWorkSource('', '三体', 'https://example.org/read'), '三体 | https://example.org/read');
  assert.equal(setExplorationWorkSource(sources, '三体', 'https://example.org/read\n三体2 | B漫'), sources);
});

test('named platform prefix still inherits matching saved workSources URL instead of dropping it', () => {
  const workSources = '哆哆嗦嗦逃离你 | https://manga.bilibili.com/detail/mc38749?from=manga_search';
  const sameHost = classifyExplorationTarget('哔哩哔哩漫画：“哆哆嗦嗦”逃离你', workSources);
  assert.equal(sameHost.kind, 'work');
  assert.deepEqual(sameHost.hosts, ['manga.bilibili.com']);
  assert.equal(sameHost.url, 'https://manga.bilibili.com/detail/mc38749?from=manga_search');

  const otherHost = classifyExplorationTarget('知乎：“哆哆嗦嗦”逃离你', workSources);
  assert.equal(otherHost.kind, 'work');
  assert.equal(otherHost.url, undefined);
});

test('built-in novel and manga platform prefixes map to their official domains', () => {
  const cases = [
    ['起点：诡秘之主', '诡秘之主', 'qidian.com'],
    ['晋江：天官赐福', '天官赐福', 'jjwxc.net'],
    ['番茄小说：十日终焉', '十日终焉', 'fanqienovel.com'],
    ['腾讯动漫：狐妖小红娘', '狐妖小红娘', 'ac.qq.com'],
    ['快看漫画：偷偷藏不住', '偷偷藏不住', 'kuaikanmanhua.com'],
  ];
  for (const [input, title, host] of cases) {
    const res = classifyExplorationTarget(input);
    assert.equal(res.kind, 'work', input);
    assert.equal(res.title, title, input);
    assert.deepEqual(res.hosts, [host], input);
  }
});
