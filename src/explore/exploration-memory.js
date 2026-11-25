/**
 * exploration-memory.js —— 深度自主探索的内置记忆模块。
 *
 * 注：鉴于不同外部记忆插件间的适配性差异，深度探索采用内置记忆机制；其遗忘衰减、
 * 召回强化与标签归类借鉴了插件「鱼的记忆（dsh-fish-memory）」的设计思路，并非原创，特此致谢。
 * 本插件仅作免费开源与个人学习交流，不用于任何商业及盈利用途，如有不妥请联系移除。
 *
 * 约定：
 * - 轻量化探索（light）：不写入本记忆库，只保留本轮槽位。
 * - 深度探索（deep，含 research / leisure）：每轮有效进展写入记忆库，
 *   固定带「我自己的事」标签；聊到或下一轮续追命中时刷新强化时间，
 *   长期不提且重要度低的条目随时间衰减并在超出容量上限时优先淘汰。
 */
import { createHash } from 'node:crypto';

export const SELF_MEMORY_TAG = '我自己的事';
const DAY_MS = 86_400_000;
const DEFAULT_HALF_LIFE_DAYS = 14;
const DEFAULT_MAX_ITEMS = 40;

const line = (v, n) => typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, n) : '';

const STOP_WORDS = new Set([
  '最近', '关于', '继续', '一下', '这个', '那个', '什么', '怎么', '为什么', '有没有',
  '可以', '觉得', '好像', '感觉', '知道', '看看', '漫画', '视频', '网页', '正文',
  '摘要', '简介', '探索', '进展', '问题', '内容', '作品', '故事', '今天', '昨天',
]);

// 轻量同义/领域别名组：用于口语简称与跨词召回
const SYNONYM_GROUPS = [
  ['番剧', '新番', '动画', '动漫', '追番', 'bangumi'],
  ['漫画', 'b漫', '哔哩哔哩漫画', '追漫', '连载', '单话'],
  ['游戏', '独立游戏', '关卡', 'steam', '电游', '玩法'],
  ['小说', '网文', '轻小说', '连载小说'],
  ['开源', 'github', '代码', '仓库', '编程', '开发', '项目'],
  ['视频', 'up主', 'b站', '哔哩哔哩', '热榜', '抖音'],
  ['电路', '保护', '过流', '反时限', '电机', '变换器', '电力'],
];

const SYNONYM_LOOKUP = new Map();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) {
    const k = word.toLowerCase();
    const set = SYNONYM_LOOKUP.get(k) || new Set();
    for (const peer of group) {
      if (peer.toLowerCase() !== k) set.add(peer.toLowerCase());
    }
    SYNONYM_LOOKUP.set(k, set);
  }
}

function charBigrams(text) {
  const clean = String(text || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  const out = new Set();
  for (let i = 0; i + 2 <= clean.length; i += 1) {
    out.add(clean.slice(i, i + 2));
  }
  return out;
}

function expandAliases(terms = [], rawQuery = '') {
  const out = new Set();
  const base = `${rawQuery || ''} ${terms.join(' ')}`.normalize('NFKC').toLowerCase();
  for (const [k, peers] of SYNONYM_LOOKUP) {
    if (base.includes(k)) {
      for (const p of peers) out.add(p);
    }
  }
  return [...out];
}

function bigramOverlap(queryText, targetText) {
  const qSet = charBigrams(queryText);
  if (qSet.size < 2) return 0;
  const tSet = charBigrams(targetText);
  if (!tSet.size) return 0;
  let inter = 0;
  for (const bg of qSet) {
    if (tSet.has(bg)) inter += 1;
  }
  return inter / qSet.size;
}

/** 从中文/英文文本提取用于召回与打标签的关键词。 */
export function extractMemoryTerms(text, limit = 12) {
  const plain = line(String(text || ''), 300).normalize('NFKC').toLowerCase().replace(/[“”‘’"'`]/gu, '');
  if (!plain) return [];
  const terms = [];
  const seen = new Set();
  const add = (term) => {
    const t = String(term || '').trim();
    if (t.length < 2 || STOP_WORDS.has(t) || seen.has(t)) return;
    seen.add(t);
    terms.push(t);
  };
  for (const m of plain.matchAll(/《([^》]{2,30})》/gu)) add(m[1]);
  const tokens = plain.match(/[\p{Script=Han}]{2,12}|[a-z0-9]+(?:[._-][a-z0-9]+)*/gu) || [];
  for (const tok of tokens) {
    add(tok);
    // 对较长的中文短语补充 2~3 字片段，方便口语追问命中书名/人名
    if (/^\p{Script=Han}+$/u.test(tok) && tok.length > 4) {
      for (let i = 0; i + 3 <= tok.length && terms.length < limit * 2; i += 2) {
        add(tok.slice(i, i + 3));
      }
    }
  }
  return terms.slice(0, limit);
}

function buildTags(entry) {
  const tags = [SELF_MEMORY_TAG];
  const seen = new Set(tags);
  const push = (t) => {
    const clean = line(t, 24);
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    tags.push(clean);
  };
  if (Array.isArray(entry?.tags)) {
    for (const t of entry.tags) push(t);
  }
  if (entry?.mode === 'research') push('研究');
  else if (entry?.mode === 'leisure') push('休闲');
  for (const term of extractMemoryTerms(entry?.topic, 4)) {
    if (tags.length >= 5) break;
    push(term);
  }
  return tags;
}

function makeMemoryId(topic, text, at) {
  const norm = `${topic || ''}|${text || ''}|${at || 0}`.normalize('NFKC');
  return 'em_' + createHash('sha256').update(norm).digest('hex').slice(0, 12);
}

function initialImportance(entry) {
  const explicit = Number(entry?.importance);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(1, Math.max(0.2, explicit));
  const ev = String(entry?.evidence || entry?.progressSource?.evidence || '');
  if (/正文|画面|口播|字幕/.test(ev)) return 0.7;
  if (/摘要/.test(ev)) return 0.55;
  return 0.5;
}

/** 计算单条探索记忆在 now 时刻的综合权重（基础重要度 × 遗忘衰减 + 查询相关性）。 */
export function scoreExplorationMemory(item, { now = Date.now(), query = '', halfLifeDays = DEFAULT_HALF_LIFE_DAYS } = {}) {
  if (!item || typeof item !== 'object') return 0;
  const anchor = Number(item.reinforcedAt) || Number(item.at) || now;
  const ageDays = Math.max(0, (now - anchor) / DAY_MS);
  const hl = Math.max(1, Number(halfLifeDays) || DEFAULT_HALF_LIFE_DAYS);
  const decay = Math.pow(0.5, ageDays / hl);
  const baseImportance = Math.min(1, Math.max(0.2, Number(item.importance) || 0.5));
  const hitsBoost = Math.min(0.25, (Number(item.hits) || 0) * 0.05);
  let relevance = 0;
  const qTerms = extractMemoryTerms(query, 10);
  const rawQuery = String(query || '').normalize('NFKC').trim();
  if (qTerms.length || rawQuery.length >= 2) {
    const haystack = `${item.topic || ''} ${item.text || ''} ${item.next || ''} ${item.checkpoint || ''} ${(item.tags || []).join(' ')}`
      .normalize('NFKC')
      .toLowerCase();
    let matched = 0;
    for (const term of qTerms) {
      if (haystack.includes(term)) matched += 1;
    }
    if (matched > 0) {
      relevance = 0.65 + Math.min(0.85, (matched / Math.max(1, qTerms.length)) * 0.85);
    } else {
      // 1) 字符 2-gram 重合（支持简称/省略字，如「哆嗦逃离」命中「哆哆嗦嗦逃离你」）
      const bg = Math.max(
        bigramOverlap(rawQuery, item.topic || ''),
        bigramOverlap(rawQuery, haystack) * 0.85,
      );
      if (bg >= 0.34) {
        relevance = Math.max(relevance, 0.45 + Math.min(0.45, bg * 0.6));
      }
      // 2) 同义/领域别名扩展（如「追番」命中「番剧/新番」）
      const aliases = expandAliases(qTerms, rawQuery);
      if (aliases.length && aliases.some((a) => haystack.includes(a))) {
        relevance = Math.max(relevance, 0.42);
      }
    }
  }
  return {
    score: (baseImportance + hitsBoost) * decay + relevance,
    decay,
    matched: relevance > 0,
  };
}

function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const topic = line(raw.topic, 80);
  const text = line(raw.text || raw.progress || raw.summary, 180);
  if (!topic || !text) return null;
  const at = Number(raw.at) || Date.now();
  const reinforcedAt = Number(raw.reinforcedAt) || null;
  const mode = raw.mode === 'research' || raw.mode === 'leisure' ? raw.mode : 'research';
  const next = line(raw.next, 120);
  const checkpoint = line(raw.checkpoint, 100);
  const evidence = line(raw.evidence || raw.progressSource?.evidence, 32);
  const sourceTitle = line(raw.sourceTitle || raw.progressSource?.title, 100);
  const rawUrl = String(raw.sourceUrl || raw.progressSource?.url || raw.sources?.[0]?.url || '').trim();
  const sourceUrl = /^https?:\/\/[^\s"'<>]{4,500}$/i.test(rawUrl) ? rawUrl : '';
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : makeMemoryId(topic, text, at),
    mode,
    topic,
    text,
    ...(next ? { next } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    tags: buildTags({ ...raw, mode, topic }),
    importance: initialImportance({ ...raw, evidence }),
    at,
    reinforcedAt,
    hits: Math.max(0, Math.trunc(Number(raw.hits) || 0)),
    ...(evidence ? { evidence } : {}),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

/**
 * 写入一条深度探索记忆（带去重强化与按衰减分数淘汰）。
 * 轻量化探索（mode === 'light'）不会写入。
 */
export function recordExplorationMemory(existing = [], entry, { now = Date.now(), maxItems = DEFAULT_MAX_ITEMS, halfLifeDays = DEFAULT_HALF_LIFE_DAYS } = {}) {
  const list = (Array.isArray(existing) ? existing : []).map(normalizeRecord).filter(Boolean);
  if (!entry || entry.mode === 'light') return list;
  const candidate = normalizeRecord({ ...entry, at: Number(entry.at) || now });
  if (!candidate) return list;

  const normText = (s) => String(s || '').normalize('NFKC').replace(/[\p{P}\s]+/gu, '').toLowerCase();
  const sameIdx = list.findIndex((item) =>
    normText(item.topic) === normText(candidate.topic) && normText(item.text) === normText(candidate.text),
  );
  if (sameIdx >= 0) {
    const prev = list[sameIdx];
    list[sameIdx] = {
      ...prev,
      ...candidate,
      id: prev.id,
      at: prev.at,
      reinforcedAt: now,
      hits: prev.hits + 1,
      importance: Math.min(1, Number((Math.max(prev.importance, candidate.importance) + 0.05).toFixed(3))),
    };
  } else {
    list.push(candidate);
  }

  const cap = Math.max(5, Math.trunc(Number(maxItems) || DEFAULT_MAX_ITEMS));
  if (list.length <= cap) return list.sort((a, b) => a.at - b.at);

  const scored = list.map((item) => ({
    item,
    rank: scoreExplorationMemory(item, { now, halfLifeDays }).score,
  }));
  scored.sort((a, b) => b.rank - a.rank || b.item.at - a.item.at);
  return scored.slice(0, cap).map((x) => x.item).sort((a, b) => a.at - b.at);
}

/** 对命中的记忆做强化（刷新 reinforcedAt、增加 hits 与 importance）。 */
export function reinforceExplorationMemories(existing = [], ids = [], now = Date.now()) {
  const idSet = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
  if (!idSet.size) return Array.isArray(existing) ? existing : [];
  return (Array.isArray(existing) ? existing : []).map((raw) => {
    const item = normalizeRecord(raw);
    if (!item) return null;
    if (!idSet.has(item.id)) return item;
    return {
      ...item,
      reinforcedAt: now,
      hits: item.hits + 1,
      importance: Math.min(1, Number((item.importance + 0.05).toFixed(3))),
    };
  }).filter(Boolean);
}

/**
 * 召回最相关的深度探索记忆：
 * - 有 query 时优先召回关键词命中的条目，再按遗忘衰减权重排序；
 * - 过滤与 excludeTexts 完全重复的条目，避免与当前活跃槽位重复占用提示词。
 */
export function recallExplorationMemories(existing = [], {
  query = '',
  now = Date.now(),
  limit = 3,
  halfLifeDays = DEFAULT_HALF_LIFE_DAYS,
  minScore = 0.12,
  excludeTexts = [],
  requireMatch = false,
} = {}) {
  const list = (Array.isArray(existing) ? existing : []).map(normalizeRecord).filter(Boolean);
  if (!list.length || limit <= 0) return [];
  const norm = (s) => String(s || '').normalize('NFKC').replace(/[\p{P}\s]+/gu, '').toLowerCase();
  const excluded = new Set((Array.isArray(excludeTexts) ? excludeTexts : []).map(norm).filter(Boolean));
  const ranked = [];
  for (const item of list) {
    if (excluded.has(norm(item.text))) continue;
    const { score, matched } = scoreExplorationMemory(item, { now, query, halfLifeDays });
    if (requireMatch && !matched) continue;
    if (score < minScore) continue;
    ranked.push({ item, score, matched });
  }
  ranked.sort((a, b) => Number(b.matched) - Number(a.matched) || b.score - a.score || b.item.at - a.item.at);
  return ranked.slice(0, limit).map((x) => x.item);
}

/** 将召回的记忆压缩成适合喂给浏览器 Agent 或规划器的简短前情提示。 */
export function formatMemoryHint(memories = [], activeEntry = null) {
  const lines = [];
  if (activeEntry?.topic && (activeEntry.progress || activeEntry.next || activeEntry.checkpoint)) {
    const parts = [
      `上次进度（${activeEntry.topic}）：${activeEntry.progress || ''}`,
      activeEntry.checkpoint ? `已看到：${activeEntry.checkpoint}` : '',
      activeEntry.next ? `计划接着看：${activeEntry.next}` : '',
    ].filter(Boolean);
    lines.push(parts.join('；'));
  }
  for (const m of Array.isArray(memories) ? memories.slice(0, 3) : []) {
    const text = [m.topic, m.text, m.next ? `下一步：${m.next}` : ''].filter(Boolean).join(' — ');
    if (text && !lines.some((l) => l.includes(m.text.slice(0, 24)))) lines.push(text);
  }
  return lines.join('\n').slice(0, 600);
}
