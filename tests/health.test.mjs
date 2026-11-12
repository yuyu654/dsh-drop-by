// health.test.mjs —— 阶段 5.1：绿/黄/红三分支。全部依赖用 deps 注入，不碰真端口/真插件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, healthLines, agoText } from '../src/health.js';

const NOW = Date.parse('2026-11-06T14:00:00+08:00');
const cfg = { sources: { phone: { staleHours: 36 } }, perception: { signals: { port: 9223 } } };

function deps(over = {}) {
  return {
    readLatest: () => ({ subject: '睡眠日报', dateTs: NOW - 20 * 60_000 }),
    readQQ: () => ({ ok: true, file: 'qq-history.json', turns: 8 }),
    probePort: async () => ({ ok: true }),
    findWhisper: () => ({ ok: true, hit: 'whisper.exe' }),
    readMemory: () => ({ ok: true, plugin: 'fish-memory', items: [{}, {}] }),
    ...over,
  };
}

test('全绿：5 项都 ok，没有红', async () => {
  const res = await checkHealth({ cfg, now: NOW, deps: deps() });
  assert.equal(res.ok, true);
  assert.equal(res.bad, 0);
  assert.equal(res.items.length, 5);
  assert.deepEqual(res.items.map((i) => i.level), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.match(healthLines(res).at(-1), /全绿/);
});

test('鱼鱼邮件：过旧=黄，读不到=红', async () => {
  const old = await checkHealth({ cfg, now: NOW, deps: deps({ readLatest: () => ({ dateTs: NOW - 40 * 3600_000 }) }) });
  assert.equal(old.items[0].level, 'warn');
  assert.match(old.items[0].detail, /超过 36 小时/);
  assert.equal(old.bad, 0);

  const none = await checkHealth({ cfg, now: NOW, deps: deps({ readLatest: () => null }) });
  assert.equal(none.items[0].level, 'bad');
  assert.equal(none.bad, 1);
});

test('QQ 记录读不到 / 端口不通 / whisper 不在 → 红（抖音真启用时）', async () => {
  const res = await checkHealth({
    cfg: { ...cfg, channels: { douyin: { enabled: true } } },
    now: NOW,
    deps: deps({
      readQQ: () => ({ ok: false, file: 'qq-history.json', error: '文件不存在' }),
      probePort: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      findWhisper: () => ({ ok: false, checked: ['whisper'] }),
      readMemory: () => ({ ok: false, reason: 'MEMORY_EMPTY', dir: '/m' }),
    }),
  });
  assert.equal(res.items.filter((i) => i.level === 'bad').length, 4);
  assert.equal(res.ok, false);
  const lines = healthLines(res);
  assert.match(lines.join('\n'), /✘ QQ 出站记录/);
  assert.match(lines.join('\n'), /✘ 抖音 Edge/);
  assert.match(lines.join('\n'), /✘ whisper/);
  assert.match(lines.at(-1), /先把红的修掉/);
});

test('抖音没启用 + 端口没开 → 黄，不吓人', async () => {
  const res = await checkHealth({
    cfg,
    now: NOW,
    deps: deps({
      probePort: async () => ({ ok: false, error: 'ECONNREFUSED' }),
      // 其余都正常，只剩抖音这一项
      readQQ: () => ({ ok: true, file: 'qq-history.json', turns: 8 }),
      findWhisper: () => ({ ok: true, hit: 'whisper.exe' }),
      readMemory: () => ({ ok: true, items: [{}] }),
    }),
  });
  const dy = res.items.find((i) => i.key === 'douyin');
  assert.equal(dy.level, 'warn');
  assert.match(dy.detail, /抖音没启用/);
  assert.equal(res.bad, 0);
  assert.match(healthLines(res).join('\n'), /! 抖音 Edge/);
});

test('探测抛异常，抖音启用时归红、没启用时归黄', async () => {
  const boom = deps({ probePort: async () => { throw new Error('boom'); } });
  const on = await checkHealth({ cfg: { ...cfg, channels: { douyin: { enabled: true } } }, now: NOW, deps: boom });
  assert.equal(on.items.find((i) => i.key === 'douyin').level, 'bad');
  assert.match(on.items.find((i) => i.key === 'douyin').detail, /boom/);
  const off = await checkHealth({ cfg, now: NOW, deps: boom });
  assert.equal(off.items.find((i) => i.key === 'douyin').level, 'warn');
});

test('记忆插件关着 → 黄，不算红', async () => {
  const res = await checkHealth({ cfg: { ...cfg, sources: { ...cfg.sources, memory: { enabled: false } } }, now: NOW, deps: deps() });
  assert.equal(res.items.find((i) => i.key === 'memory').level, 'warn');
  assert.equal(res.bad, 0);
});

test('agoText：分钟 / 小时 / 天', () => {
  assert.equal(agoText(30_000), '刚刚');
  assert.equal(agoText(20 * 60_000), '20 分钟前');
  assert.equal(agoText(5 * 3600_000), '5 小时前');
  assert.equal(agoText(3 * 86400_000), '3 天前');
});