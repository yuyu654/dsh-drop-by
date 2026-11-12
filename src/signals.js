// signals.js —— 不截屏的「她这会儿在干什么」。
//
// 只读三类结构化信号，全部是本地、只读、秒级：
//   1) 前台窗口：标题 + 进程名（L1 已经有，这里把它读成「浏览器 / 编辑器 / 终端 / 播放器 / …」）；
//   2) 浏览器当前标签页：本机 CDP 调试口（默认 9223，Edge 那个），问它在看哪个页面；
//   3) 编辑器里开着什么文件、属于哪个项目（从窗口标题里拆）。
//
// 为什么不用 OCR：Windows 系统 OCR 把中文按词块拆开、词间强制加空格，整行会变成
// 「应 甲 缤 辑 deepseel」；而 screenFacts 的过滤规则正好把这种行全丢掉。结构化信号
// 是程序本来就有的字，不存在识别误差，也不占截屏那 1 秒。
//
// 约束：
//   - 只连 127.0.0.1 的调试口，不联网、不读页面内容、不执行 JS；
//   - 调试口没开 / 没有匹配的标签页，都只算「不知道」，不报错、不重试；
//   - 任何一条失败都不影响别的信号。
import http from 'node:http';

const BROWSER_PROCS = new Set(['msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', 'msedgewebview2']);
const EDITOR_PROCS = new Set([
  'code',
  'code - insiders',
  'cursor',
  'devenv',
  'idea64',
  'pycharm64',
  'webstorm64',
  'goland64',
  'clion64',
  'rider64',
  'sublime_text',
  'notepad++',
  'zed',
  'windsurf',
]);
const TERMINAL_PROCS = new Set(['windowsterminal', 'wt', 'powershell', 'pwsh', 'cmd', 'conhost', 'mintty']);
const MEDIA_PROCS = new Set(['spotify', 'cloudmusic', 'qqmusic', 'foobar2000', 'vlc', 'mpc-hc64', 'potplayermini64', 'wmplayer']);

const APP_SUFFIXES = [
  'Microsoft Edge',
  'Google Chrome',
  'Mozilla Firefox',
  'Brave',
  'Vivaldi',
  'Opera',
  'Visual Studio Code',
  'Cursor',
  'Sublime Text',
  'Zed',
  'Windsurf',
  'Notepad++',
];
const PROFILE_SEGS = new Set(['个人', '工作', 'profile 1', 'profile 2', 'personal', 'work']);

export function cleanTitle(s) {
  return String(s || '')
    .trim()
    .replace(/^[●•*·]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripSuffixes(title) {
  let s = cleanTitle(title);
  let changed = true;
  while (changed) {
    changed = false;
    for (const app of APP_SUFFIXES) {
      const re = new RegExp(`\\s*[-–—]\\s*${app.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*\\(.*?\\))?$`, 'i');
      if (re.test(s)) {
        s = s.replace(re, '').trim();
        changed = true;
      }
    }
    const parts = s.split(/\s+[-–—]\s+/);
    if (parts.length >= 2 && PROFILE_SEGS.has(parts[parts.length - 1].toLowerCase())) {
      s = parts.slice(0, -1).join(' - ').trim();
      changed = true;
    }
  }
  return s;
}

function parseEditorTitle(title) {
  const parts = stripSuffixes(title)
    .split(/\s+[-–—]\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!parts.length) return { file: '', project: '' };
  if (parts.length === 1) return { file: parts[0].slice(0, 80), project: '' };
  return { file: parts[0].slice(0, 80), project: parts[1].slice(0, 60) };
}

export function windowInfo(sys = {}) {
  // probe() 给的是 fgName/fgTitle（驼峰），winprobe 原始字段是 fg_name/fg_title；两种都认。
  const app = String(sys.fg_name ?? sys.fgName ?? '').toLowerCase();
  const title = cleanTitle(sys.fg_title ?? sys.fgTitle);
  if (!title && !app) return null;
  let kind = 'app';
  if (BROWSER_PROCS.has(app)) kind = 'browser';
  else if (EDITOR_PROCS.has(app)) kind = 'editor';
  else if (TERMINAL_PROCS.has(app)) kind = 'terminal';
  else if (MEDIA_PROCS.has(app)) kind = 'media';
  else if (app === 'explorer') kind = 'files';

  const base = { app, kind, raw: title };
  if (kind === 'browser') return { ...base, pageTitle: stripSuffixes(title).slice(0, 90) };
  if (kind === 'editor') return { ...base, ...parseEditorTitle(title) };
  return { ...base, pageTitle: stripSuffixes(title).slice(0, 90) };
}

/** 在一堆标签页里挑「当前那个」：先用前台窗口标题去对，对不上且只有一个页面时才用它。 */
export function pickTab(pages, hint) {
  const list = (Array.isArray(pages) ? pages : []).filter(
    (p) => (p.type || 'page') === 'page' && p.url && !/^(devtools|edge|chrome|about|chrome-extension):/i.test(String(p.url))
  );
  if (!list.length) return null;
  const h = cleanTitle(hint);
  if (h) {
    const same = list.find((p) => cleanTitle(p.title) === h);
    if (same) return same;
    const near = list.find((p) => {
      const t = cleanTitle(p.title);
      return t.length >= 4 && (h.includes(t) || t.includes(h));
    });
    if (near) return near;
  }
  return list.length === 1 ? list[0] : null;
}

export function siteOf(url) {
  try {
    return new URL(String(url)).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 问本机 CDP 口要标签页列表。端口没开就是 CDP_OFF，不重试。 */
export function fetchTabs({ port = 9223, timeoutMs = 600 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let req;
    try {
      req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: Math.max(100, Number(timeoutMs) || 600) }, (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (d) => {
          buf += d;
          if (buf.length > 1_000_000) req.destroy();
        });
        res.on('end', () => {
          try {
            const j = JSON.parse(buf);
            finish({ ok: true, pages: Array.isArray(j) ? j : [] });
          } catch {
            finish({ ok: false, reason: 'CDP_BAD_JSON' });
          }
        });
      });
      req.on('timeout', () => {
        req.destroy();
        finish({ ok: false, reason: 'CDP_TIMEOUT' });
      });
      req.on('error', (e) => finish({ ok: false, reason: 'CDP_OFF', note: String(e?.code || e?.message || e).slice(0, 60) }));
    } catch (e) {
      finish({ ok: false, reason: 'CDP_OFF', note: String(e?.message || e).slice(0, 60) });
    }
  });
}

/**
 * 读一次结构化信号。tabs 可注入（测试用），不传就去问 CDP。
 * 返回 { ok, at, window, tab, tabReason }
 */
export async function readSignals({ cfg, sys, tabs = null, now = Date.now() } = {}) {
  const s = cfg?.perception?.signals || {};
  if (s.enabled === false) return { ok: false, reason: 'SIGNALS_OFF' };
  if (!sys?.ok) return { ok: false, reason: 'NO_L1' };
  const win = windowInfo(sys);
  if (!win) return { ok: false, reason: 'NO_WINDOW' };

  const out = { ok: true, at: now, window: win, tab: null };
  if (win.kind === 'browser' && s.browser !== false) {
    const port = Number(s.port) || 9223;
    const r = tabs ? { ok: true, pages: tabs } : await fetchTabs({ port, timeoutMs: Number(s.timeoutMs) || 600 });
    if (!r.ok) {
      out.tabReason = r.reason;
    } else {
      const t = pickTab(r.pages, win.pageTitle);
      if (t) out.tab = { title: cleanTitle(t.title).slice(0, 80), url: String(t.url).slice(0, 300), site: siteOf(t.url) };
      else out.tabReason = 'NO_MATCH';
    }
  }
  return out;
}

/** 把信号折成能进 prompt 的一两句话（不含屏幕内容，也不含「我怎么知道」）。 */
export function signalFacts(sig, max = 2) {
  const out = [];
  if (!sig?.ok) return out;
  const w = sig.window || {};
  if (sig.tab?.title) out.push(`她在浏览器里看「${sig.tab.title}」${sig.tab.site ? `（${sig.tab.site}）` : ''}`);
  else if (w.kind === 'browser' && w.pageTitle) out.push(`她浏览器前台是「${w.pageTitle}」`);

  if (w.kind === 'editor') {
    const file = w.file ? `「${w.file}」` : '';
    out.push(`她在编辑器里${file ? `开着${file}` : '写东西'}${w.project ? `（项目 ${w.project}）` : ''}`);
  } else if (w.kind === 'terminal') {
    out.push(`她在终端里${w.pageTitle ? `（${w.pageTitle}）` : ''}`);
  } else if (w.kind === 'media') {
    out.push(`她在放${w.pageTitle ? `「${w.pageTitle}」` : '东西'}`);
  } else if (w.kind === 'files') {
    out.push(`她在翻文件${w.pageTitle ? `（${w.pageTitle}）` : ''}`);
  } else if (w.kind === 'app' && w.pageTitle) {
    out.push(`她电脑前台是「${w.pageTitle}」`);
  }
  return out.filter(Boolean).slice(0, Math.max(1, max));
}

/**
 * 还要不要走 L3（截屏 + OCR）。
 * 结构化信号已经能说清「在干什么」时就不截屏——OCR 更慢、中文也更差。
 */
export function needL3(cfg, sys, sig) {
  if (cfg?.perception?.l3?.enabled !== true) return false;
  if (!sys?.ok) return false;
  return signalFacts(sig).length === 0;
}

/** 一行摘要，给 --why / --l123 用。 */
export function signalLine(sig) {
  if (!sig) return '没读';
  if (!sig.ok) return `没读到（${sig.reason}）`;
  const w = sig.window || {};
  const parts = [`${w.kind}「${w.pageTitle || w.raw || w.app || '-'}」`];
  if (sig.tab) parts.push(`标签「${sig.tab.title}」${sig.tab.site ? ` @${sig.tab.site}` : ''}`);
  else if (sig.tabReason) parts.push(`标签没读到（${sig.tabReason}）`);
  return parts.join(' · ');
}