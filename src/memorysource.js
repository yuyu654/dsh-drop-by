// memorysource.js —— 从「别的记忆插件」里读记忆。
//
// 为什么要有这个：presence-gate 自己只有 self.md（我写的），而会话里的长期记忆
// 是记忆插件在管（比如 dsh-fish-memory）。要说起「她十月说过的话」，就得去那份库里拿。
//
// 只读，不写、不删、不改别人的文件；读不到就如实标原因（没装 / 没记录 / 关着）。
// 「选哪个插件」是配置里的 sources.memory.plugin，内置只支持 fish-memory，别的名字当没装。
// 用别的记忆插件时不用改判定逻辑：在下面的 MEMORY_PLUGINS 里加一项（会给你的大肥鱼加），其余代码不用动。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome } from './detect.js';

/** 支持的记忆插件。加新插件就在这儿加一项，其余代码不用动。 */
export const MEMORY_PLUGINS = {
  'fish-memory': {
    label: '鱼的记忆（dsh-fish-memory）',
    dir: () => path.join(dshHome(), 'fish-memory'),
    // 一个会话一个文件：session-<id>.json
    match: /^session-(.+)\.json$/,
  },
};

const DAY = 24 * 60 * 60 * 1000;

function memoryCfg(cfg) {
  return cfg?.sources?.memory || {};
}

/** 这个插件该去哪个目录找（配置里写了 dir 就用它，测试靠这个指临时目录）。 */
export function memoryDir(cfg) {
  const c = memoryCfg(cfg);
  if (c.dir) return String(c.dir);
  const p = MEMORY_PLUGINS[c.plugin || 'fish-memory'];
  return p ? p.dir() : null;
}

/** 目录里有哪些会话，按「最近改过」排。 */
export function listSessions(dir, plugin = 'fish-memory') {
  const p = MEMORY_PLUGINS[plugin];
  if (!p) return [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = name.match(p.match);
    if (!m) continue;
    const file = path.join(dir, name);
    let st = null;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    out.push({ file, name, session: m[1], mtime: st.mtimeMs, bytes: st.size });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function readOne(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      memories: Array.isArray(j?.memories) ? j.memories : [],
      deleted: new Set((Array.isArray(j?.deleted) ? j.deleted : []).map((d) => (typeof d === 'string' ? d : d?.id)).filter(Boolean)),
    };
  } catch {
    return null;
  }
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

/** 两条记忆是不是同一件事：双字重合占「较短那条」的比例 ≥ 0.55。
 *  为什么不用对称的 Jaccard：真的重复条目常常是「短的那条被长的那条包住」（一条带规则、一条不带），
 *  对称算分会因为长度差被稀释。实测重复写法 0.59，不同的事 0.14。 */
export function similarMemory(a, b) {
  const A = bigrams(norm(a));
  const B = bigrams(norm(b));
  if (!A.size || !B.size) return false;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size) >= 0.55;
}

function fmtDay(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 读一次记忆。返回：
 *   { ok, plugin, dir, mode, files, items:[{text, at, day, category, importance, tags}], reason }
 * 排序：长期画像（stable_profile）先、事件按时间倒序；同一条（指纹相同）只留一次。
 * 太老的事件（超过 maxAgeDays）不再带——记忆插件一共就没几条，带一堆半年前的旧事反而吵。
 */
export function readMemory({ cfg, now = Date.now() } = {}) {
  const c = memoryCfg(cfg);
  const plugin = String(c.plugin || 'fish-memory');
  if (c.enabled === false) return { ok: false, plugin, reason: 'MEMORY_OFF', items: [] };
  const p = MEMORY_PLUGINS[plugin];
  if (!p) return { ok: false, plugin, reason: 'MEMORY_PLUGIN_UNKNOWN', items: [] };

  const dir = memoryDir(cfg);
  const sessions = listSessions(dir, plugin);
  if (!sessions.length) return { ok: false, plugin, dir, reason: 'MEMORY_EMPTY', items: [] };

  // 选哪一份：session 填了就用那份（支持 id 前缀），填 all 就全合并，留空 = 最近改过的那份。
  const want = String(c.session || '').trim();
  let picked = sessions;
  let mode = 'newest';
  if (want === 'all') {
    mode = 'all';
  } else if (want) {
    const hit = sessions.filter((s) => s.session.startsWith(want));
    if (!hit.length) return { ok: false, plugin, dir, reason: 'MEMORY_SESSION_NOT_FOUND', items: [] };
    picked = hit;
    mode = 'session';
  } else {
    picked = sessions.slice(0, 1);
  }

  const max = Math.min(8, Math.max(1, Number(c.max) || 3));
  const maxAgeDays = Math.min(3650, Math.max(1, Number(c.maxAgeDays) || 120));
  const horizon = now - maxAgeDays * DAY;

  const items = [];
  for (const s of picked) {
    const data = readOne(s.file);
    if (!data) continue;
    for (const m of data.memories) {
      if (!m || !m.text || data.deleted.has(m.id)) continue;
      const ts = Date.parse(m.at || m.createdAt || '');
      const stable = m.category === 'stable_profile';
      // 长期事实不看过没过期；事件太老就不带了，除非它被标得很重要
      if (!stable && Number.isFinite(ts) && ts < horizon && Number(m.importance || 0) < 0.8) continue;
      items.push({
        text: String(m.text).slice(0, 200),
        at: Number.isFinite(ts) ? ts : null,
        day: Number.isFinite(ts) ? fmtDay(ts) : '',
        category: m.category || 'event',
        importance: Number(m.importance) || 0,
        tags: Array.isArray(m.tags) ? m.tags.slice(0, 4) : [],
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

  // 排完再去重：长期画像先留下，同一件事换个说法只算一条。
  const kept = [];
  for (const it of items) {
    if (kept.some((k) => similarMemory(k.text, it.text))) continue;
    kept.push(it);
  }

  return { ok: true, plugin, dir, mode, files: picked.map((s) => s.name), items: kept.slice(0, max) };
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
  return `${mem.plugin} ${n} 条（${mem.files.join(', ')}）`;
}