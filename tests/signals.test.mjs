// signals.test.mjs —— 不截屏的结构化信号：标题解析、标签页匹配、事实生成、进 prompt。
// 全部不联网：CDP 那一路用注入的 pages 代替。
import test from 'node:test';
import assert from 'node:assert/strict';
import { windowInfo, pickTab, siteOf, readSignals, signalFacts, signalLine, cleanTitle, needL3 } from '../src/perception/signals.js';
import { buildPrompt } from '../src/decision/compose.js';

const cfgOf = (signals = {}) => ({ perception: { signals: { enabled: true, browser: true, port: 9223, ...signals } } });

test('windowInfo：Edge 标题去掉「个人 - Microsoft Edge」，只留页面名', () => {
  const w = windowInfo({ fg_name: 'msedge', fg_title: '控制台首页 - 个人 - Microsoft Edge' });
  assert.equal(w.kind, 'browser');
  assert.equal(w.pageTitle, '控制台首页');
});

test('windowInfo：编辑器标题拆出文件与项目', () => {
  const w = windowInfo({ fg_name: 'code', fg_title: 'train.py - rvc - Visual Studio Code' });
  assert.equal(w.kind, 'editor');
  assert.equal(w.file, 'train.py');
  assert.equal(w.project, 'rvc');
});

test('windowInfo：未命名文件的 ● 前缀要清掉', () => {
  const w = windowInfo({ fg_name: 'code', fg_title: '● 未命名-1 - Visual Studio Code' });
  assert.equal(w.file, '未命名-1');
  assert.equal(w.project, '');
});

test('windowInfo：终端、播放器、普通应用都认得', () => {
  assert.equal(windowInfo({ fg_name: 'windowsterminal', fg_title: 'PowerShell' }).kind, 'terminal');
  assert.equal(windowInfo({ fg_name: 'spotify', fg_title: 'Spotify Premium' }).kind, 'media');
  assert.equal(windowInfo({ fg_name: 'workbuddy', fg_title: 'WorkBuddy' }).kind, 'app');
  assert.equal(windowInfo({ fg_name: '', fg_title: '' }), null);
});

test('cleanTitle：压空格、去项目符号', () => {
  assert.equal(cleanTitle('  ●   a   b  '), 'a b');
});

test('pickTab：按前台标题对上那一个', () => {
  const pages = [
    { type: 'page', title: '控制台首页', url: 'https://home.console.aliyun.com/x' },
    { type: 'page', title: '另一个页面', url: 'https://example.com/' },
    { type: 'page', title: 'DevTools', url: 'devtools://devtools/bundled/x' },
  ];
  const t = pickTab(pages, '控制台首页');
  assert.equal(t.title, '控制台首页');
});

test('pickTab：对不上且不止一个就不猜；只有一个页面才用它', () => {
  const many = [
    { type: 'page', title: '甲页面', url: 'https://a.com/' },
    { type: 'page', title: '乙页面', url: 'https://b.com/' },
  ];
  assert.equal(pickTab(many, '完全对不上的窗口标题'), null);
  assert.equal(pickTab([many[0]], '对不上').title, '甲页面');
  assert.equal(pickTab([], 'x'), null);
});

test('siteOf：去掉 www，非法 url 返回空串', () => {
  assert.equal(siteOf('https://www.bilibili.com/video/BV1'), 'bilibili.com');
  assert.equal(siteOf('not a url'), '');
});

test('windowInfo：probe() 的驼峰字段（fgName/fgTitle）也认', () => {
  const w = windowInfo({ fgName: 'Code', fgTitle: 'train.py - rvc - Visual Studio Code' });
  assert.equal(w.kind, 'editor');
  assert.equal(w.file, 'train.py');
  assert.equal(w.project, 'rvc');
});

test('needL3：信号说清了就不截屏；没信号/L3 关着就按原样', () => {
  const cfgOn = { perception: { l3: { enabled: true } } };
  const sys = { ok: true, fgName: 'msedge', fgTitle: '论文 - 个人 - Microsoft Edge' };
  const sig = { ok: true, window: { kind: 'browser', pageTitle: '论文' }, tab: { title: '论文', site: 'arxiv.org' } };
  assert.equal(needL3(cfgOn, sys, sig), false);
  assert.equal(needL3(cfgOn, sys, { ok: false, reason: 'NO_WINDOW' }), true);
  assert.equal(needL3({ perception: { l3: { enabled: false } } }, sys, null), false);
  assert.equal(needL3(cfgOn, { ok: false }, sig), false);
});

test('readSignals：probe() 的驼峰字段也能读', async () => {
  const sig = await readSignals({
    cfg: cfgOf(),
    sys: { ok: true, fgName: 'msedge', fgTitle: '论文 - 个人 - Microsoft Edge' },
    tabs: [{ type: 'page', title: '论文', url: 'https://arxiv.org/abs/1234' }],
  });
  assert.equal(sig.ok, true);
  assert.equal(sig.tab.site, 'arxiv.org');
});

test('readSignals：浏览器 → 带出当前页面；都可注入', async () => {
  const sys = { ok: true, fg_name: 'msedge', fg_title: '论文 - 个人 - Microsoft Edge' };
  const sig = await readSignals({
    cfg: cfgOf(),
    sys,
    tabs: [{ type: 'page', title: '论文', url: 'https://arxiv.org/abs/1234' }],
    now: 1000,
  });
  assert.equal(sig.ok, true);
  assert.equal(sig.window.kind, 'browser');
  assert.equal(sig.tab.site, 'arxiv.org');
  assert.equal(sig.at, 1000);
});

test('readSignals：关掉、没 L1、非浏览器都不碰 CDP', async () => {
  assert.equal((await readSignals({ cfg: cfgOf({ enabled: false }), sys: { ok: true } })).reason, 'SIGNALS_OFF');
  assert.equal((await readSignals({ cfg: cfgOf(), sys: { ok: false } })).reason, 'NO_L1');
  const sig = await readSignals({ cfg: cfgOf(), sys: { ok: true, fg_name: 'code', fg_title: 'a.py' }, tabs: [] });
  assert.equal(sig.ok, true);
  assert.equal(sig.tab, null);
});

test('signalFacts：浏览器/编辑器各一句，最多两句', () => {
  const b = signalFacts({
    ok: true,
    window: { kind: 'browser', pageTitle: '论文' },
    tab: { title: '论文', site: 'arxiv.org' },
  });
  assert.match(b[0], /浏览器里看「论文」（arxiv\.org）/);

  const e = signalFacts({ ok: true, window: { kind: 'editor', file: 'train.py', project: 'rvc' } });
  assert.match(e[0], /编辑器里开着「train\.py」（项目 rvc）/);

  assert.deepEqual(signalFacts({ ok: false }), []);
  const two = signalFacts(
    { ok: true, window: { kind: 'browser', pageTitle: 'p' }, tab: { title: 't', site: 's' } },
    1
  );
  assert.equal(two.length, 1);
});

test('signalLine：给 --l123 的一行摘要', () => {
  assert.match(signalLine({ ok: false, reason: 'CDP_OFF' }), /CDP_OFF/);
  const line = signalLine({
    ok: true,
    window: { kind: 'browser', pageTitle: '论文', raw: '论文' },
    tab: { title: '论文', site: 'arxiv.org' },
  });
  assert.match(line, /browser/);
  assert.match(line, /arxiv\.org/);
});

test('buildPrompt：结构化信号会进「已知事实」，且比 OCR 优先', () => {
  const ctx = {
    tz: 'Asia/Shanghai',
    clock: '15:00',
    presence: { idleSec: 60 },
    her: { lastTs: null, lastText: '', lastAgoSec: 600 },
    me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
    fish: { ok: false },
    recent: [],
    signals: { ok: true, window: { kind: 'editor', file: 'train.py', project: 'rvc' }, tab: null },
    screen: { ok: true, hints: ['应 甲 缤 辑'] },
  };
  const p = buildPrompt({
    ctx,
    topic: { slot: 'share', label: 'share', why: '', evidence: {}, brief: 'x' },
    persona: '人格',
    cfg: { content: { maxChars: 60, topics: {} } },
  });
  assert.match(p, /编辑器里开着\s*「train\.py」/);
  assert.doesNotMatch(p, /应 甲 缤 辑/);
});