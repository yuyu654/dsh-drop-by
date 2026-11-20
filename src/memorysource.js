// memorysource.js —— 从外部记忆插件读取记忆（只读，绝不改动外部插件格式不兼容的文件）。
//
// 支持多适配器：
//   - fish-memory   鱼的记忆（dsh-fish-memory：ws_*.json / session-*.json，支持合并与回滚）
//   - auto          自动探测（按自定义目录或 DSH 目录自动识别 fish-memory / json-generic / markdown）
//   - json-generic  通用 JSON / JSONL 记忆文件或目录
//   - markdown      Markdown 记忆/笔记文件或目录
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './detect.js';

const DAY = 24 * 60 * 60 * 1000;
const SKIP_JSON_FILES = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'config.json', 'state.json']);

function memoryCfg(cfg) {
  return cfg?.sources?.memory || {};
}

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function readRawJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseTimestamp(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (raw <= 0) return null;
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? n * 1000 : n;
  }
  const ts = Date.parse(s);
  return Number.isFinite(ts) ? ts : null;
}

function normalizeImportance(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1 && n <= 10) return Math.min(1, n / 10);
  if (n > 10) return Math.min(1, n / 100);
  return n;
}

function normalizeCategory(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'event';
  if (/^(?:stable_profile|stable|profile|persona|preference|long_term|user_profile)$/i.test(s)) {
    return 'stable_profile';
  }
  return s;
}

function fmtDay(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---- fish-memory 解析 ------------------------------------------------------

function readFishEntries(file) {
  const j = readRawJson(file);
  if (!j || typeof j !== 'object') return null;
  const memories = Array.isArray(j.memories) ? j.memories : [];
  const deleted = new Set((Array.isArray(j.deleted) ? j.deleted : []).map((d) => (typeof d === 'string' ? d : d?.id)).filter(Boolean));
  const items = [];
  for (const m of memories) {
    if (!m || !m.text || deleted.has(m.id)) continue;
    const ts = parseTimestamp(m.at ?? m.createdAt);
    items.push({
      id: m.id ?? null,
      text: String(m.text).slice(0, 200),
      at: ts,
      day: ts ? fmtDay(ts) : '',
      category: m.category || 'event',
      importance: Number(m.importance) || 0,
      tags: Array.isArray(m.tags) ? m.tags.slice(0, 4).map(String) : [],
    });
  }
  return items;
}

function readFishRawActive(file) {
  const raw = readRawJson(file);
  if (!raw || typeof raw !== 'object') return [];
  const memories = Array.isArray(raw.memories) ? raw.memories : [];
  const deleted = new Set((Array.isArray(raw.deleted) ? raw.deleted : []).map((d) => (typeof d === 'string' ? d : d?.id)).filter(Boolean));
  return memories.filter((m) => m && m.text && !deleted.has(m.id));
}

// ---- 通用 JSON / JSONL 解析 ------------------------------------------------

function mapGenericItem(m, deletedSet) {
  if (m == null) return null;
  if (typeof m === 'string') {
    const text = m.trim();
    return text ? { id: null, text: text.slice(0, 200), at: null, day: '', category: 'event', importance: 0, tags: [] } : null;
  }
  if (typeof m !== 'object' || Array.isArray(m)) return null;
  if (m.deleted === true || m.archived === true || m.enabled === false) return null;
  const id = m.id ?? m.key ?? m.uid ?? null;
  if (id != null && deletedSet.has(id)) return null;
  const rawText = m.text ?? m.content ?? m.fact ?? m.summary ?? m.memory ?? m.note ?? m.value ?? m.title;
  const text = String(rawText ?? '').trim();
  if (!text) return null;
  const ts = parseTimestamp(m.at ?? m.createdAt ?? m.created_at ?? m.updatedAt ?? m.updated_at ?? m.timestamp ?? m.ts ?? m.time ?? m.date);
  const rawTags = Array.isArray(m.tags) ? m.tags : (Array.isArray(m.labels) ? m.labels : (Array.isArray(m.keywords) ? m.keywords : []));
  return {
    id,
    text: text.slice(0, 200),
    at: ts,
    day: ts ? fmtDay(ts) : '',
    category: normalizeCategory(m.category ?? m.type ?? m.kind),
    importance: normalizeImportance(m.importance ?? m.score ?? m.weight),
    tags: rawTags.slice(0, 4).map((x) => String(x || '').trim()).filter(Boolean),
  };
}

function extractGenericRecords(raw) {
  if (Array.isArray(raw)) return { list: raw, deleted: new Set() };
  if (!raw || typeof raw !== 'object') return { list: [], deleted: new Set() };
  const deleted = new Set((Array.isArray(raw.deleted) ? raw.deleted : []).map((d) => (typeof d === 'string' ? d : d?.id)).filter(Boolean));
  for (const key of ['memories', 'items', 'facts', 'records', 'entries', 'notes', 'data', 'list']) {
    if (Array.isArray(raw[key])) return { list: raw[key], deleted };
  }
  if (raw.text || raw.content || raw.fact || raw.summary || raw.memory) {
    return { list: [raw], deleted };
  }
  return { list: [], deleted };
}

function readGenericJsonItems(file) {
  let rawText = '';
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const trimmed = rawText.trim();
  if (!trimmed) return [];

  if (!file.toLowerCase().endsWith('.jsonl')) {
    try {
      const parsed = JSON.parse(trimmed);
      const { list, deleted } = extractGenericRecords(parsed);
      return list.map((m) => mapGenericItem(m, deleted)).filter(Boolean);
    } catch {
      /* 若非整包 JSON，尝试按 JSONL 逐行解析 */
    }
  }

  const items = [];
  const emptyDel = new Set();
  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) || (parsed && typeof parsed === 'object' && ['memories', 'items', 'facts', 'records', 'entries'].some((k) => Array.isArray(parsed[k])))) {
        const { list, deleted } = extractGenericRecords(parsed);
        for (const m of list) {
          const item = mapGenericItem(m, deleted);
          if (item) items.push(item);
        }
      } else {
        const item = mapGenericItem(parsed, emptyDel);
        if (item) items.push(item);
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  return items;
}

// ---- Markdown 解析 ---------------------------------------------------------

const MD_STABLE_HEADING = /长期|画像|偏好|喜好|习惯|约定|设定|profile|stable|preference/iu;

function readMarkdownItems(file, { defaultStable = false } = {}) {
  let rawText = '';
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const baseDateMatch = path.basename(file).match(/(\d{4}-\d{2}-\d{2})/);
  let currentDate = baseDateMatch ? baseDateMatch[1] : '';
  let currentTime = '';
  let heading = '';
  let inCode = false;
  let inComment = false;
  const lines = rawText.split(/\r?\n/);

  // 跳过顶部 YAML frontmatter
  let startIdx = 0;
  if (lines[0]?.trim() === '---') {
    const endIdx = lines.slice(1).findIndex((l) => l.trim() === '---');
    if (endIdx >= 0) startIdx = endIdx + 2;
  }

  const items = [];
  for (let i = startIdx; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (/^```/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inComment || t.startsWith('<!--')) {
      inComment = !t.includes('-->');
      continue;
    }
    if (inCode || !t || t.startsWith('|') || t.startsWith('>') || /^[-*_]{3,}$/.test(t)) continue;
    if (/^#{1,6}\s+/.test(t)) {
      heading = t.replace(/^#{1,6}\s+/, '').trim();
      const dm = heading.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?/);
      if (dm) {
        currentDate = dm[1];
        currentTime = dm[2] || '';
      }
      continue;
    }

    let body = t
      .replace(/^[-*·]\s+/, '')
      .replace(/^\d+[.、]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .trim();

    let lineDate = currentDate;
    let lineTime = currentTime;
    const prefixDate = body.match(/^\[(\d{4}-\d{2}-\d{2}|\d{2}-\d{2})\]\s*(.+)$/) || body.match(/^(\d{4}-\d{2}-\d{2})\s*[:：\-]\s*(.+)$/);
    if (prefixDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(prefixDate[1])) {
        lineDate = prefixDate[1];
      } else if (currentDate && /^\d{2}-\d{2}$/.test(prefixDate[1])) {
        lineDate = `${currentDate.slice(0, 4)}-${prefixDate[1]}`;
      }
      lineTime = '';
      body = prefixDate[2].trim();
    }

    body = body.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\s+/g, ' ').trim();
    if (body.length < 4) continue;

    const ts = lineDate ? parseTimestamp(`${lineDate}T${lineTime || '12:00'}:00`) : null;
    const stable = MD_STABLE_HEADING.test(heading) || (defaultStable && !lineDate);
    items.push({
      id: null,
      text: body.slice(0, 200),
      at: ts,
      day: ts ? fmtDay(ts) : '',
      category: stable ? 'stable_profile' : 'event',
      importance: stable ? 0.85 : (defaultStable ? 0.7 : 0.5),
      tags: heading && !/^\d{4}-\d{2}-\d{2}/.test(heading) ? [heading.slice(0, 24)] : [],
    });
  }
  return items;
}

// ---- 文件列举 --------------------------------------------------------------

function listDirectoryFiles(targetPath, filterFn, kindFn = () => 'memory') {
  if (!targetPath) return [];
  const st = statSafe(targetPath);
  if (!st) return [];
  if (st.isFile()) {
    const name = path.basename(targetPath);
    const meta = filterFn(name);
    if (!meta) return [];
    return [{
      file: targetPath,
      name,
      id: name.replace(/\.[^.]+$/, ''),
      kind: kindFn(name, meta),
      session: meta.session || name.replace(/\.[^.]+$/, ''),
      mtime: st.mtimeMs,
      bytes: st.size,
    }];
  }
  if (!st.isDirectory()) return [];

  let names = [];
  try {
    names = fs.readdirSync(targetPath);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const meta = filterFn(name);
    if (!meta) continue;
    const file = path.join(targetPath, name);
    const fst = statSafe(file);
    if (!fst || !fst.isFile()) continue;
    out.push({
      file,
      name,
      id: name.replace(/\.[^.]+$/, ''),
      kind: kindFn(name, meta),
      session: meta.session || name.replace(/\.[^.]+$/, ''),
      mtime: fst.mtimeMs,
      bytes: fst.size,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const fishMatch = /^(session-|ws_)(.+)\.json$/;
function listFishFiles(dir) {
  return listDirectoryFiles(
    dir,
    (name) => {
      const m = name.match(fishMatch);
      return m ? { prefix: m[1], session: m[2] } : null;
    },
    (_name, meta) => (meta.prefix === 'ws_' ? 'workspace' : 'session'),
  );
}

function listGenericJsonFiles(dir) {
  return listDirectoryFiles(dir, (name) => {
    const low = name.toLowerCase();
    if (name.startsWith('.') || low.includes('.bak') || SKIP_JSON_FILES.has(low)) return null;
    if (!low.endsWith('.json') && !low.endsWith('.jsonl')) return null;
    return { session: name.replace(/\.(?:json|jsonl)$/i, '') };
  });
}

function listMarkdownFiles(dir, { recursive = true, maxDepth = 3 } = {}) {
  if (!dir) return [];
  const st = statSafe(dir);
  if (!st) return [];
  if (st.isFile()) {
    return listDirectoryFiles(dir, (name) => {
      const low = name.toLowerCase();
      if (name.startsWith('.') || low.includes('.bak') || !low.endsWith('.md')) return null;
      return { session: name.replace(/\.md$/i, '') };
    });
  }
  if (!st.isDirectory()) return [];

  const out = [];
  const walk = (curDir, relPrefix, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(curDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const full = path.join(curDir, ent.name);
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (recursive && depth < maxDepth) walk(full, rel, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      const low = ent.name.toLowerCase();
      if (low.includes('.bak') || !low.endsWith('.md')) continue;
      const fst = statSafe(full);
      if (!fst) continue;
      const id = rel.replace(/\.md$/i, '');
      const isTopic = /(?:^|\/)topics\//i.test(rel);
      out.push({
        file: full,
        name: rel,
        id,
        kind: isTopic ? 'topic' : 'core',
        session: id,
        mtime: fst.mtimeMs,
        bytes: fst.size,
      });
    }
  };
  walk(dir, '', 0);
  return out.sort((a, b) => b.mtime - a.mtime);
}

function listSoulMdFiles(dir) {
  return listMarkdownFiles(dir, { recursive: true, maxDepth: 3 });
}

function readSoulMdItems(file) {
  const isCore = !/(?:^|[\\/])topics[\\/]/i.test(file);
  return readMarkdownItems(file, { defaultStable: isCore });
}

function looksLikeFishJson(file) {
  const j = readRawJson(file);
  return Boolean(j && typeof j === 'object' && Array.isArray(j.memories));
}

function autoCandidateDirs(home) {
  const fixed = [
    path.join(home, 'fish-memory'),
    path.join(home, 'soul-md', 'memory'),
    path.join(home, 'mnemon'),
    path.join(home, 'memory'),
  ];
  const extra = [];
  try {
    for (const ent of fs.readdirSync(home, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (['fish-memory', 'soul-md', 'mnemon', 'memory', 'douyin-duty', 'presence-gate', 'dsh-drop-by', 'qq-bridge', 'autonomy', 'profiles', 'logs'].includes(ent.name)) continue;
      if (/mem|note/i.test(ent.name)) extra.push(path.join(home, ent.name));
    }
  } catch {
    /* 忽略不可读根目录 */
  }
  return [...fixed, ...extra];
}

function isSoulMdLayout(dir, files) {
  return /[\\/]soul-md[\\/]memory$/i.test(String(dir || '')) ||
    files.some((f) => /(?:^|\/)(?:core\.md|topics\/.+\.md)$/i.test(f.name));
}

function resolveAutoDirAndAdapter(cfg, home = dshHome()) {
  const explicit = String(memoryCfg(cfg).dir || '').trim();
  if (explicit) {
    const st = statSafe(explicit);
    if (st?.isFile()) {
      const low = explicit.toLowerCase();
      if (low.endsWith('.md')) return { plugin: 'markdown', dir: explicit };
      if (fishMatch.test(path.basename(explicit)) || looksLikeFishJson(explicit)) {
        return { plugin: 'fish-memory', dir: explicit };
      }
      return { plugin: 'json-generic', dir: explicit };
    }
    if (listFishFiles(explicit).length) return { plugin: 'fish-memory', dir: explicit };
    if (listGenericJsonFiles(explicit).length) return { plugin: 'json-generic', dir: explicit };
    const mdFiles = listMarkdownFiles(explicit);
    if (mdFiles.length) return { plugin: isSoulMdLayout(explicit, mdFiles) ? 'soul-md' : 'markdown', dir: explicit };
    return { plugin: 'json-generic', dir: explicit };
  }

  for (const dir of autoCandidateDirs(home)) {
    if (!statSafe(dir)) continue;
    if (listFishFiles(dir).length) return { plugin: 'fish-memory', dir };
    if (listGenericJsonFiles(dir).length) return { plugin: 'json-generic', dir };
    const mdFiles = listMarkdownFiles(dir);
    if (mdFiles.length) return { plugin: isSoulMdLayout(dir, mdFiles) ? 'soul-md' : 'markdown', dir };
  }
  return { plugin: 'fish-memory', dir: path.join(home, 'fish-memory') };
}

/** 支持的记忆插件适配器。 */
export const MEMORY_PLUGINS = {
  'fish-memory': {
    id: 'fish-memory',
    label: '鱼的记忆（dsh-fish-memory）',
    supportsMerge: true,
    dir: () => path.join(dshHome(), 'fish-memory'),
    match: fishMatch,
    list: listFishFiles,
    readItems: readFishEntries,
  },
  'soul-md': {
    id: 'soul-md',
    label: 'Soul.md 记忆（dsh-soul-md）',
    supportsMerge: false,
    dir: () => path.join(dshHome(), 'soul-md', 'memory'),
    list: listSoulMdFiles,
    readItems: readSoulMdItems,
  },
  auto: {
    id: 'auto',
    label: '自动识别记忆插件',
    supportsMerge: false,
    dir: (cfg) => resolveAutoDirAndAdapter(cfg).dir,
    list: (dir, cfg) => {
      const target = resolveAutoDirAndAdapter(cfg || { sources: { memory: { dir } } });
      return (MEMORY_PLUGINS[target.plugin]?.list || listFishFiles)(dir || target.dir);
    },
    readItems: readGenericJsonItems,
  },
  'json-generic': {
    id: 'json-generic',
    label: '通用 JSON / JSONL 记忆',
    supportsMerge: false,
    dir: () => {
      const home = dshHome();
      for (const name of ['mnemon', 'memory']) {
        const d = path.join(home, name);
        if (statSafe(d)) return d;
      }
      return path.join(home, 'memory');
    },
    list: listGenericJsonFiles,
    readItems: readGenericJsonItems,
  },
  markdown: {
    id: 'markdown',
    label: 'Markdown 笔记目录',
    supportsMerge: false,
    dir: () => path.join(dshHome(), 'memory'),
    list: listMarkdownFiles,
    readItems: readMarkdownItems,
  },
};

export function resolveMemoryAdapter(cfg, { home = dshHome() } = {}) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  if (!MEMORY_PLUGINS[plugin]) return null;
  if (plugin === 'auto') {
    const resolved = resolveAutoDirAndAdapter(cfg, home);
    const adapter = MEMORY_PLUGINS[resolved.plugin] || MEMORY_PLUGINS['fish-memory'];
    return { configured: 'auto', resolved: adapter.id, adapter, dir: resolved.dir };
  }
  const adapter = MEMORY_PLUGINS[plugin];
  const dir = c.dir ? String(c.dir) : adapter.dir(cfg);
  return { configured: plugin, resolved: adapter.id, adapter, dir };
}

/** 这个插件该去哪个目录找（配置里写了 dir 就用它，测试靠这个指临时目录）。 */
export function memoryDir(cfg) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  if (!MEMORY_PLUGINS[plugin]) return null;
  if (c.dir) return String(c.dir);
  return MEMORY_PLUGINS[plugin].dir(cfg);
}

/** 目录里有哪些会话/记忆文件，按「最近改过」排。 */
export function listSessions(dir, plugin = 'fish-memory', cfg = null) {
  if (plugin === 'auto') {
    const resolved = resolveAutoDirAndAdapter({ ...cfg, sources: { ...(cfg?.sources || {}), memory: { ...(cfg?.sources?.memory || {}), dir: dir || cfg?.sources?.memory?.dir || '' } } });
    return MEMORY_PLUGINS[resolved.plugin].list(dir || resolved.dir);
  }
  const p = MEMORY_PLUGINS[plugin];
  if (!p) return [];
  return p.list(dir, cfg);
}

/** 去重：只留字（不认标点空白），用双字重合度比。同样的意思换个说法（毕业设计/毕设）也算同一条。 */
const norm = (text) =>
  String(text || '')
    .replace(/[\s，。、,.;；:：!！?？「」『』"“”'‘’（）()\-—…·]/g, '')
    .toLowerCase();

function bigrams(s) {
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 两条记忆是不是同一件事：双字重合占「较短那条」的比例 ≥ 0.55。 */
export function similarMemory(a, b) {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const A = bigrams(na);
  const B = bigrams(nb);
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size) >= 0.55;
}

function pickMemoryFiles(sessions, want, loadOne, resolvedPlugin) {
  const hasMemories = (s) => {
    const d = loadOne(s.file);
    return Boolean(d && d.length > 0);
  };
  if (want === 'all') return { mode: 'all', picked: sessions };
  if (want) {
    const hit = sessions.filter((s) => s.session.startsWith(want) || s.id?.startsWith(want) || s.name.startsWith(want));
    if (!hit.length) return { mode: 'session', picked: [], notFound: true };
    return { mode: 'session', picked: hit };
  }
  if (resolvedPlugin === 'fish-memory') {
    const wsFiles = sessions.filter((s) => s.kind === 'workspace');
    if (wsFiles.length) {
      const sessFiles = sessions.filter((s) => s.kind !== 'workspace');
      const newestWs = wsFiles.find(hasMemories) || wsFiles[0];
      const newestSess = sessFiles.find(hasMemories) || null;
      return { mode: 'newest', picked: [newestWs, newestSess].filter(Boolean) };
    }
    return { mode: 'newest', picked: sessions.slice(0, 1) };
  }
  const nonEmpty = sessions.filter(hasMemories);
  return { mode: 'newest', picked: (nonEmpty.length ? nonEmpty : sessions).slice(0, 2) };
}

/**
 * 读一次记忆。返回：
 *   { ok, plugin, resolvedPlugin, dir, mode, files, items:[{text, at, day, category, importance, tags}], reason }
 */
export function readMemory({ cfg, now = Date.now() } = {}) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  if (c.enabled === false) return { ok: false, plugin, reason: 'MEMORY_OFF', items: [] };
  const resolved = resolveMemoryAdapter(cfg);
  if (!resolved) return { ok: false, plugin, reason: 'MEMORY_PLUGIN_UNKNOWN', items: [] };

  const { adapter, resolved: resolvedPlugin, dir } = resolved;
  const sessions = adapter.list(dir, cfg);
  if (!sessions.length) return { ok: false, plugin, resolvedPlugin, dir, reason: 'MEMORY_EMPTY', items: [] };

  const parsedCache = new Map();
  const loadOne = (file) => {
    if (!parsedCache.has(file)) parsedCache.set(file, adapter.readItems(file));
    return parsedCache.get(file);
  };

  const want = String(c.session || '').trim();
  const sel = pickMemoryFiles(sessions, want, loadOne, resolvedPlugin);
  if (sel.notFound) return { ok: false, plugin, resolvedPlugin, dir, reason: 'MEMORY_SESSION_NOT_FOUND', items: [] };
  const picked = sel.picked;
  const mode = sel.mode;

  const max = Math.min(8, Math.max(1, Number(c.max) || 3));
  const maxAgeDays = Math.min(3650, Math.max(1, Number(c.maxAgeDays) || 120));
  const horizon = now - maxAgeDays * DAY;

  const items = [];
  for (const s of picked) {
    const entries = loadOne(s.file);
    if (!entries) continue;
    for (const m of entries) {
      if (!m || !m.text) continue;
      const stable = m.category === 'stable_profile';
      if (!stable && Number.isFinite(m.at) && m.at < horizon && Number(m.importance || 0) < 0.8) continue;
      items.push({
        text: m.text,
        at: m.at ?? null,
        day: m.day || '',
        category: m.category || 'event',
        importance: Number(m.importance) || 0,
        tags: Array.isArray(m.tags) ? m.tags : [],
      });
    }
  }

  items.sort((a, b) => {
    const sa = a.category === 'stable_profile' ? 1 : 0;
    const sb = b.category === 'stable_profile' ? 1 : 0;
    if (sa !== sb) return sb - sa;
    if (sa === 1 && a.importance !== b.importance) return b.importance - a.importance;
    return (b.at || 0) - (a.at || 0);
  });

  const kept = [];
  for (const it of items) {
    if (kept.some((k) => similarMemory(k.text, it.text))) continue;
    kept.push(it);
  }

  return { ok: true, plugin, resolvedPlugin, dir, mode, files: picked.map((s) => s.name), items: kept.slice(0, max) };
}

/** 折成能进 prompt 的几句。不带「记忆插件」这种说法——她听的是话，不是系统名。 */
export function memoryFacts(mem, max = 3) {
  if (!mem?.ok) return [];
  return mem.items.slice(0, Math.max(1, max)).map((it) => `我记得${it.day ? `（${it.day}）` : ''}：${it.text}`);
}

/** 一行摘要，给 --why / --memory 用。 */
export function memoryLine(mem) {
  if (!mem) return '没读';
  if (!mem.ok) {
    const why = {
      MEMORY_OFF: '关着',
      MEMORY_PLUGIN_UNKNOWN: `不认识的记忆插件「${mem.plugin}」`,
      MEMORY_EMPTY: '还没有记录',
      MEMORY_SESSION_NOT_FOUND: '找不到这个会话的记忆',
    }[mem.reason];
    return `没读到（${why || mem.reason}）`;
  }
  const n = mem.items.length;
  const tag = mem.resolvedPlugin && mem.resolvedPlugin !== mem.plugin ? `${mem.plugin}→${mem.resolvedPlugin}` : mem.plugin;
  return `${tag} ${n} 条（${mem.files.join(', ')}）`;
}

/** 给设置页与工具返回可用文件、当前生效文件及合并预览。 */
export function inspectMemory({ cfg, now = Date.now() } = {}) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  const resolved = resolveMemoryAdapter(cfg);
  const adapter = resolved?.adapter || null;
  const resolvedPlugin = resolved?.resolved || plugin;
  const dir = resolved?.dir || '';
  const supportsMerge = Boolean(adapter?.supportsMerge);
  const sessions = adapter ? adapter.list(dir, cfg) : [];
  const files = sessions.map((s) => {
    const entries = adapter.readItems(s.file) || [];
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      session: s.session,
      mtime: s.mtime,
      bytes: s.bytes,
      count: entries.length,
      stableCount: entries.filter((m) => m.category === 'stable_profile').length,
      sample: entries.slice(-2).map((m) => String(m.text).replace(/\s+/g, ' ').trim().slice(0, 38)).filter(Boolean),
      hasBackup: supportsMerge && s.kind === 'workspace' && fs.existsSync(`${s.file}.bak-before-merge`),
    };
  });
  const mem = readMemory({ cfg, now });
  const wsFiles = supportsMerge ? files.filter((f) => f.kind === 'workspace') : [];
  const defaultTarget = (wsFiles.find((f) => f.count > 0) || wsFiles[0] || null)?.name || '';
  const selectedWs = wsFiles.find((f) => f.name === c.session || f.id === c.session) || null;
  const mergeTarget = selectedWs?.name || defaultTarget;
  const mergeableSessions = supportsMerge ? files.filter((f) => f.kind === 'session' && f.count > 0).length : 0;
  const preview = supportsMerge && mergeTarget && mergeableSessions > 0
    ? mergeMemorySessions({ cfg, targetFile: mergeTarget, dryRun: true })
    : null;
  return {
    ok: true,
    enabled: c.enabled !== false,
    plugin,
    resolvedPlugin,
    label: adapter?.label || plugin,
    supportsMerge,
    dir: dir || '',
    sessionSetting: String(c.session || '').trim(),
    active: {
      ok: Boolean(mem.ok),
      mode: mem.mode || '',
      files: Array.isArray(mem.files) ? mem.files : [],
      count: Array.isArray(mem.items) ? mem.items.length : 0,
      reason: mem.reason || '',
    },
    files,
    defaultTarget,
    mergeTarget,
    mergeableSessions,
    mergePreview: preview?.ok ? { target: preview.target, added: preview.added, skipped: preview.skipped } : null,
  };
}

export function detectMemory(cfg) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  if (c.enabled === false) return { ready: false, plugin, note: '记忆读取已关' };
  const resolved = resolveMemoryAdapter(cfg);
  if (!resolved) return { ready: false, plugin, note: `未识别的记忆插件「${plugin}」` };
  const { adapter, resolved: resolvedPlugin, dir } = resolved;
  const files = adapter.list(dir, cfg);
  if (!files.length) {
    return { ready: false, plugin, resolvedPlugin, note: `${adapter.label}（未找到记忆文件）` };
  }
  const tag = plugin === 'auto' ? `自动命中 ${adapter.label}` : adapter.label;
  return { ready: true, plugin, resolvedPlugin, count: files.length, note: `${tag}（${files.length} 份）` };
}

/**
 * 只增不删地把指定（或全部）历史 session-*.json 里的有效记忆合并进目标工作区 ws_*.json（仅支持 fish-memory）。
 */
export function mergeMemorySessions({ cfg, targetFile = '', sourceFiles = null, backup = true, dryRun = false } = {}) {
  const resolved = resolveMemoryAdapter(cfg);
  if (!resolved?.adapter?.supportsMerge) {
    return { ok: false, reason: 'MERGE_NOT_SUPPORTED', added: 0, skipped: 0 };
  }
  const dir = resolved.dir;
  const sessions = listFishFiles(dir);
  const wsFiles = sessions.filter((s) => s.kind === 'workspace');
  if (!wsFiles.length) return { ok: false, reason: 'NO_WORKSPACE_FILE', added: 0, skipped: 0 };

  const want = String(targetFile || '').trim();
  let target = null;
  if (want) {
    target = wsFiles.find((s) => s.name === want || s.id === want || s.file === want) || null;
    if (!target) return { ok: false, reason: 'TARGET_WORKSPACE_NOT_FOUND', added: 0, skipped: 0 };
  } else {
    target = wsFiles.find((s) => readFishRawActive(s.file).length > 0) || wsFiles[0];
  }

  const targetRaw = readRawJson(target.file);
  if (!targetRaw || typeof targetRaw !== 'object') {
    return { ok: false, reason: 'INVALID_TARGET_FILE', added: 0, skipped: 0 };
  }

  const baseList = Array.isArray(targetRaw.memories) ? targetRaw.memories.slice() : [];
  const deletedIds = new Set((Array.isArray(targetRaw.deleted) ? targetRaw.deleted : []).map((d) => (typeof d === 'string' ? d : d?.id)).filter(Boolean));
  const existingIds = new Set(baseList.map((m) => m?.id).filter(Boolean));
  const existingTexts = baseList.filter((m) => m?.text && !deletedIds.has(m.id)).map((m) => String(m.text));

  const allSess = sessions.filter((s) => s.kind === 'session');
  const filterSet = Array.isArray(sourceFiles) ? new Set(sourceFiles.map((x) => String(x || '').trim()).filter(Boolean)) : null;
  const sessFiles = filterSet
    ? allSess.filter((s) => filterSet.has(s.name) || filterSet.has(s.id) || filterSet.has(s.session))
    : allSess;

  let added = 0;
  let skipped = 0;
  for (const src of sessFiles) {
    const entries = readFishRawActive(src.file);
    for (const m of entries) {
      if ((m.id && (existingIds.has(m.id) || deletedIds.has(m.id))) ||
          existingTexts.some((t) => similarMemory(t, m.text))) {
        skipped += 1;
        continue;
      }
      baseList.push(structuredClone(m));
      if (m.id) existingIds.add(m.id);
      existingTexts.push(String(m.text));
      added += 1;
    }
  }

  if (added > 0 && !dryRun) {
    if (backup && !fs.existsSync(`${target.file}.bak-before-merge`)) {
      fs.copyFileSync(target.file, `${target.file}.bak-before-merge`);
    }
    const tmp = `${target.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ ...targetRaw, memories: baseList }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target.file);
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    target: target.name,
    targetFile: target.file,
    scannedSessions: sessFiles.length,
    selectedSessions: sessFiles.map((s) => s.name),
    added,
    skipped,
    totalAfter: baseList.length,
  };
}

/** 若存在 .bak-before-merge，将目标工作区记忆回滚到最近一次合并前的状态（仅支持 fish-memory）。 */
export function restoreMemoryBackup({ cfg, targetFile = '' } = {}) {
  const resolved = resolveMemoryAdapter(cfg);
  if (!resolved?.adapter?.supportsMerge) return { ok: false, reason: 'MERGE_NOT_SUPPORTED' };
  const dir = resolved.dir;
  const sessions = listFishFiles(dir);
  const wsFiles = sessions.filter((s) => s.kind === 'workspace');
  const want = String(targetFile || '').trim();
  const target = want
    ? wsFiles.find((s) => s.name === want || s.id === want || s.file === want) || null
    : wsFiles.find((s) => fs.existsSync(`${s.file}.bak-before-merge`)) || null;
  if (!target) return { ok: false, reason: 'TARGET_WORKSPACE_NOT_FOUND' };
  const bak = `${target.file}.bak-before-merge`;
  if (!fs.existsSync(bak)) return { ok: false, reason: 'NO_BACKUP_FOUND', target: target.name };
  const bakRaw = readRawJson(bak);
  if (!bakRaw || typeof bakRaw !== 'object') return { ok: false, reason: 'INVALID_BACKUP_FILE', target: target.name };
  const tmp = `${target.file}.${process.pid}.restore.tmp`;
  fs.copyFileSync(bak, tmp);
  fs.renameSync(tmp, target.file);
  fs.unlinkSync(bak);
  return {
    ok: true,
    target: target.name,
    targetFile: target.file,
    totalRestored: readFishRawActive(target.file).length,
  };
}
