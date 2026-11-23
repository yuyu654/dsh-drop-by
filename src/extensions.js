// extensions.js —— 对外开放的扩展注册中心与免代码文件投递口。
//
// 其他 DSH 插件可通过 ctx.inject(['presenceGate'], (ctx) => ...) 注册：
//   - registerExploreSource(adapter)  刷 B 站 / RSS / 番剧等外部探索源
//   - registerMoodSource(adapter)     第三方心情 / 好感度 / 精力插件
//   - registerMemorySource(adapter)   第三方长期记忆插件
//   - registerTopicProvider(provider) 自定义主动由头（自动享受全部护栏）
//
// 普通用户或外部脚本也可以直接往 data/extensions/{mood,topics}.json 写结构化 JSON，
// 无需编写插件代码。所有外部回调都包在 try/catch + 超时保护内，绝不拖垮宿主。
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './config.js';

function safePublicUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(url.hostname) || /\.(?:localhost|local|internal|test|invalid)$/i.test(url.hostname)) return null;
    return url;
  } catch { return null; }
}

const ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/i;
const BUILTIN_SLOTS = new Set([
  'reply', 'forward', 'sleep', 'stress', 'steps', 'screen', 'lateUp', 'longSit',
  'backHome', 'agenda', 'characterRest', 'examSoon', 'examReview', 'noReply',
  'share', 'catchup', 'agreement', 'projectCheckIn', 'chitchat', 'qqContinuation', 'fixed',
]);
const BUILTIN_MEMORY_IDS = new Set(['fish-memory', 'soul-md', 'auto', 'json-generic', 'markdown']);

const exploreSources = new Map();
const moodSources = new Map();
const memorySources = new Map();
const topicProviders = new Map();

function cleanLine(v, max = 200) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function validateId(id, kind) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s)) throw new Error(`${kind} id 须为 1–48 位字母、数字或 . _ -`);
  return s;
}

export function extensionsDir() {
  return path.join(path.dirname(CONFIG_PATH), 'data', 'extensions');
}

function readDropInJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(path.join(extensionsDir(), filename), 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 1. 探索源扩展

export function registerExploreSource(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('explore source 必须是对象');
  const id = validateId(adapter.id, 'explore source');
  if (typeof adapter.browse !== 'function') throw new Error(`explore source "${id}" 缺少 browse() 方法`);
  const mode = ['leisure', 'research', 'both'].includes(adapter.mode) ? adapter.mode : 'both';
  const entry = {
    id,
    label: cleanLine(adapter.label || id, 40) || id,
    mode,
    description: cleanLine(adapter.description || '', 120),
    timeoutMs: Math.max(1000, Math.min(30_000, Number(adapter.timeoutMs) || 12_000)),
    browse: adapter.browse,
  };
  exploreSources.set(id, entry);
  return () => {
    if (exploreSources.get(id) === entry) exploreSources.delete(id);
  };
}

export function listExploreSources(mode = null) {
  return [...exploreSources.values()]
    .filter((s) => !mode || s.mode === 'both' || s.mode === mode)
    .map(({ id, label, mode: m, description }) => ({ id, label, mode: m, description }));
}

export function normalizeExploreItems(raw, fallbackEvidence = '外部扩展资料') {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.items) ? raw.items : Array.isArray(raw?.sources) ? raw.sources : [];
  const out = [];
  const seen = new Set();
  for (const item of list.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const title = cleanLine(item.title || item.name || item.topic, 120);
    const content = cleanLine(item.content || item.summary || item.snippet || item.text || item.desc, 2400);
    const parsedUrl = item.url ? safePublicUrl(String(item.url)) : null;
    const url = parsedUrl ? parsedUrl.href : '';
    if (!title && !content) continue;
    const key = url || `${title}|${content.slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url,
      title: title || (parsedUrl ? parsedUrl.hostname : '外部探索内容'),
      evidence: cleanLine(item.evidence || fallbackEvidence, 40) || fallbackEvidence,
      content: content || title,
    });
    if (out.length >= 4) break;
  }
  return out;
}

export async function runExploreSource(id, { mode = 'leisure', query = '', interest = '', now = Date.now(), timeoutMs } = {}) {
  const entry = exploreSources.get(String(id || '').trim());
  if (!entry) return [];
  const ms = Math.max(1000, Math.min(60_000, Number(timeoutMs) || entry.timeoutMs || 12_000));
  const signal = AbortSignal.timeout(ms);
  let onAbort;
  try {
    const res = await Promise.race([
      Promise.resolve().then(() => entry.browse({ mode, query, interest, now, signal })),
      new Promise((resolve) => {
        onAbort = () => resolve(null);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    if (!res || res.ok === false) return [];
    return normalizeExploreItems(res, '外部扩展资料');
  } catch {
    return [];
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

// ---------------------------------------------------------------- 2. 心情扩展

export function registerMoodSource(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('mood source 必须是对象');
  const id = validateId(adapter.id, 'mood source');
  if (typeof adapter.read !== 'function') throw new Error(`mood source "${id}" 缺少 read() 方法`);
  const entry = {
    id,
    label: cleanLine(adapter.label || id, 40) || id,
    read: adapter.read,
    onMessage: typeof adapter.onMessage === 'function' ? adapter.onMessage : null,
  };
  moodSources.set(id, entry);
  return () => {
    if (moodSources.get(id) === entry) moodSources.delete(id);
  };
}

export function listRegisteredMoodSources() {
  return [...moodSources.values()].map(({ id, label, onMessage }) => ({ id, label, syncChat: Boolean(onMessage) }));
}

export function readExternalMoods({ peer = '', now = Date.now(), cfg = null, onlyId = '' } = {}) {
  const parts = [];
  const entries = onlyId ? [moodSources.get(onlyId)].filter(Boolean) : [...moodSources.values()];
  for (const entry of entries) {
    try {
      const raw = entry.read({ peer, now, cfg });
      if (!raw || typeof raw.then === 'function') continue; // read() 须为同步返回
      const text = typeof raw === 'string'
        ? cleanLine(raw, 80)
        : cleanLine(raw.moodText || raw.toneHint || raw.text, 80);
      if (text) parts.push(text);
    } catch {
      /* 第三方心情扩展失败不影响主流程 */
    }
  }
  if (!onlyId) {
    const fileMood = readDropInJson('mood.json');
    if (fileMood && typeof fileMood === 'object') {
      const updatedAt = Number(fileMood.updatedAt ?? fileMood.at) || 0;
      const ttlMin = Math.max(1, Number(fileMood.ttlMin ?? 180));
      const fresh = !updatedAt || (now >= updatedAt && now - updatedAt <= ttlMin * 60_000);
      const text = fresh ? cleanLine(fileMood.moodText || fileMood.toneHint || fileMood.text, 80) : '';
      if (text) parts.push(text);
    }
  }
  return parts.join('；').slice(0, 160);
}

function hasFreshDropInMood(now = Date.now()) {
  const fileMood = readDropInJson('mood.json');
  if (!fileMood || typeof fileMood !== 'object') return false;
  const updatedAt = Number(fileMood.updatedAt ?? fileMood.at) || 0;
  const ttlMin = Math.max(1, Number(fileMood.ttlMin ?? 180));
  const fresh = !updatedAt || (now >= updatedAt && now - updatedAt <= ttlMin * 60_000);
  return fresh && Boolean(cleanLine(fileMood.moodText || fileMood.toneHint || fileMood.text, 80));
}

export function resolveActiveMoodTargets(cfg = null, now = Date.now()) {
  const mode = String(cfg?.exploration?.moodSource || 'auto').trim() || 'auto';
  const builtinEnabled = cfg?.exploration?.portrait === true;
  const regList = listRegisteredMoodSources();
  const hasDropIn = hasFreshDropInMood(now);
  const hasExt = regList.length > 0 || hasDropIn;
  if (mode === 'builtin') {
    return { mode: 'builtin', activeKind: 'builtin', useBuiltin: builtinEnabled, useExternal: false, onlyExternalId: '' };
  }
  if (mode === 'external') {
    return { mode: 'external', activeKind: 'external', useBuiltin: false, useExternal: true, onlyExternalId: '' };
  }
  if (mode === 'merge') {
    return { mode: 'merge', activeKind: 'merge', useBuiltin: builtinEnabled, useExternal: true, onlyExternalId: '' };
  }
  if (moodSources.has(mode)) {
    return { mode, activeKind: 'external', useBuiltin: false, useExternal: true, onlyExternalId: mode };
  }
  if (hasExt) {
    return { mode: 'auto', activeKind: 'external', useBuiltin: false, useExternal: true, onlyExternalId: '' };
  }
  return { mode: 'auto', activeKind: 'builtin', useBuiltin: builtinEnabled, useExternal: false, onlyExternalId: '' };
}

export function shouldUseBuiltinEmotion(cfg = null, now = Date.now()) {
  return resolveActiveMoodTargets(cfg, now).useBuiltin;
}

export function resolveCombinedMood({ basePortrait = '', peer = '', now = Date.now(), cfg = null } = {}) {
  const targets = resolveActiveMoodTargets(cfg, now);
  if (targets.activeKind === 'builtin') return String(basePortrait || '');
  const ext = targets.useExternal ? readExternalMoods({ peer, now, cfg, onlyId: targets.onlyExternalId }) : '';
  if (targets.activeKind === 'merge') {
    return [basePortrait, ext].filter(Boolean).join('；');
  }
  if (targets.mode === 'auto') {
    return ext || String(basePortrait || '');
  }
  return ext;
}

export function inspectActiveMood({ cfg = null, peer = '', now = Date.now(), baseEmotion = {} } = {}) {
  const targets = resolveActiveMoodTargets(cfg, now);
  const regList = listRegisteredMoodSources();
  const selectedExt = targets.onlyExternalId ? regList.find((m) => m.id === targets.onlyExternalId) : null;
  const hasDropIn = hasFreshDropInMood(now);
  const extNames = selectedExt
    ? `${selectedExt.label} · ${selectedExt.id}`
    : regList.length
      ? regList.map((m) => `${m.label} · ${m.id}`).join(' + ')
      : hasDropIn
        ? 'data/extensions/mood.json'
        : '第三方心情扩展';
  const builtinTitle = 'emotion-state-portrait' + (baseEmotion?.version ? ' v' + baseEmotion.version : '');
  const activePluginLabel = targets.activeKind === 'builtin'
    ? builtinTitle
    : targets.activeKind === 'merge'
      ? `${builtinTitle} + ${extNames}`
      : (targets.mode === 'auto' ? `自动 → ${extNames}` : extNames);
  const externalLive = targets.useExternal
    ? readExternalMoods({ peer, now, cfg, onlyId: targets.onlyExternalId })
    : '';
  return {
    ...baseEmotion,
    moodSource: targets.mode,
    activeKind: targets.activeKind,
    activePluginLabel,
    externalLive,
    externalReady: Boolean(externalLive || selectedExt || regList.length || hasDropIn),
  };
}

export function notifyExternalMoodMessage({ peer = '', role = 'user', text = '', at = Date.now(), channel = '', cfg = null } = {}) {
  let entries = [...moodSources.values()];
  if (cfg) {
    const targets = resolveActiveMoodTargets(cfg, at);
    if (!targets.useExternal) return;
    if (targets.onlyExternalId) entries = [moodSources.get(targets.onlyExternalId)].filter(Boolean);
  }
  for (const entry of entries) {
    if (!entry.onMessage) continue;
    try {
      const p = entry.onMessage({ peer, role, text, at, channel });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 静默兜底 */
    }
  }
}

// ---------------------------------------------------------------- 3. 记忆扩展

export function registerMemorySource(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new Error('memory source 必须是对象');
  const id = validateId(adapter.id, 'memory source');
  if (BUILTIN_MEMORY_IDS.has(id)) throw new Error(`memory source id "${id}" 与内置适配器冲突`);
  if (typeof adapter.read !== 'function') throw new Error(`memory source "${id}" 缺少 read() 方法`);
  const entry = {
    id,
    label: cleanLine(adapter.label || id, 40) || id,
    read: adapter.read,
  };
  memorySources.set(id, entry);
  return () => {
    if (memorySources.get(id) === entry) memorySources.delete(id);
  };
}

export function getRegisteredMemorySource(id) {
  return memorySources.get(String(id || '').trim()) || null;
}

export function listRegisteredMemorySources() {
  return [...memorySources.values()].map(({ id, label }) => ({ id, label }));
}

export function readRegisteredMemorySource(id, { cfg, now = Date.now(), limit = 3 } = {}) {
  const entry = getRegisteredMemorySource(id);
  if (!entry) return null;
  try {
    const raw = entry.read({ cfg, now, limit });
    if (!raw || typeof raw.then === 'function') return { ok: false, plugin: id, reason: 'MEMORY_ASYNC_UNSUPPORTED', items: [] };
    if (raw.ok === false) return { ok: false, plugin: id, reason: raw.reason || 'MEMORY_EMPTY', items: [] };
    const list = Array.isArray(raw.items) ? raw.items : Array.isArray(raw) ? raw : [];
    const items = list
      .map((m) => {
        if (typeof m === 'string') {
          const text = cleanLine(m, 200);
          return text ? { text, at: null, day: '', category: 'event', importance: 0, tags: [] } : null;
        }
        if (!m || typeof m !== 'object') return null;
        const text = cleanLine(m.text || m.content || m.fact || m.summary, 200);
        if (!text) return null;
        const at = Number(m.at) || null;
        return {
          text,
          at,
          day: cleanLine(m.day || '', 16),
          category: cleanLine(m.category || m.kind || 'event', 32) || 'event',
          importance: Number(m.importance) || 0,
          tags: Array.isArray(m.tags) ? m.tags.slice(0, 4).map((t) => cleanLine(t, 24)).filter(Boolean) : [],
        };
      })
      .filter(Boolean)
      .slice(0, Math.max(1, Math.min(8, Number(limit) || 3)));
    if (!items.length) return { ok: false, plugin: id, resolvedPlugin: id, dir: '', files: [], reason: 'MEMORY_EMPTY', items: [] };
    const files = Array.isArray(raw.files) ? raw.files.map((f) => cleanLine(f, 60)).filter(Boolean) : [entry.label];
    return { ok: true, plugin: id, resolvedPlugin: id, dir: '', mode: 'extension', files, items };
  } catch {
    return { ok: false, plugin: id, resolvedPlugin: id, dir: '', files: [], reason: 'MEMORY_EXTENSION_ERROR', items: [] };
  }
}

// ---------------------------------------------------------------- 4. 自定义由头扩展

export function registerTopicProvider(provider) {
  if (!provider || typeof provider !== 'object') throw new Error('topic provider 必须是对象');
  const slot = validateId(provider.slot || provider.id, 'topic provider');
  if (BUILTIN_SLOTS.has(slot)) throw new Error(`topic slot "${slot}" 与内置由头冲突`);
  if (typeof provider.pick !== 'function') throw new Error(`topic provider "${slot}" 缺少 pick() 方法`);
  const tier = provider.tier === 'chat' ? 'chat' : 'event';
  const entry = {
    slot,
    label: cleanLine(provider.label || slot, 40) || slot,
    why: cleanLine(provider.why || '外部扩展提供的由头', 80),
    tier,
    pick: provider.pick,
  };
  topicProviders.set(slot, entry);
  return () => {
    if (topicProviders.get(slot) === entry) topicProviders.delete(slot);
  };
}

export function getTopicProviderMeta(slot) {
  return topicProviders.get(String(slot || '').trim()) || null;
}

export function collectExternalTopics({ ctx, cfg, now = Date.now(), st = {} } = {}) {
  const dedup = st?.content?.extTopicDedup || {};
  const out = [];
  for (const entry of topicProviders.values()) {
    try {
      const picked = entry.pick({ ctx, cfg, now, st });
      if (!picked || typeof picked !== 'object' || typeof picked.then === 'function') continue;
      const brief = cleanLine(picked.brief, 240);
      if (!brief) continue;
      const dedupKey = cleanLine(picked.dedupKey || '', 80);
      if (dedupKey && dedup[entry.slot] === dedupKey) continue;
      out.push({
        slot: entry.slot,
        label: cleanLine(picked.label || entry.label, 40) || entry.label,
        why: cleanLine(picked.why || entry.why, 80),
        tier: entry.tier,
        brief,
        evidence: {
          ...(picked.evidence && typeof picked.evidence === 'object' ? picked.evidence : {}),
          ...(dedupKey ? { dedupKey } : {}),
          external: true,
        },
      });
    } catch {
      /* 外部由头抛错不影响内置由头 */
    }
  }

  // 免代码投递：data/extensions/topics.json
  const fileTopics = readDropInJson('topics.json');
  const rows = Array.isArray(fileTopics) ? fileTopics : Array.isArray(fileTopics?.items) ? fileTopics.items : [];
  for (const row of rows.slice(0, 8)) {
    if (!row || typeof row !== 'object') continue;
    const rawSlot = String(row.slot || 'extTopic').trim();
    if (!ID_RE.test(rawSlot) || BUILTIN_SLOTS.has(rawSlot)) continue;
    const expiresAt = Number(row.expiresAt) || 0;
    if (expiresAt && now > expiresAt) continue;
    const brief = cleanLine(row.brief || row.text, 240);
    if (!brief) continue;
    const dedupKey = cleanLine(row.dedupKey || row.id || brief.slice(0, 48), 80);
    if (dedupKey && dedup[rawSlot] === dedupKey) continue;
    out.push({
      slot: rawSlot,
      label: cleanLine(row.label || rawSlot, 40) || rawSlot,
      why: cleanLine(row.why || '外部文件投递的由头', 80),
      tier: row.tier === 'chat' ? 'chat' : 'event',
      brief,
      evidence: {
        ...(row.evidence && typeof row.evidence === 'object' ? row.evidence : {}),
        dedupKey,
        external: true,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------- 状态查询与测试清理

export function listExtensions() {
  return {
    exploreSources: listExploreSources(),
    moodSources: listRegisteredMoodSources(),
    memorySources: listRegisteredMemorySources(),
    topicProviders: [...topicProviders.values()].map(({ slot, label, tier }) => ({ slot, label, tier })),
  };
}

export function clearExtensions() {
  exploreSources.clear();
  moodSources.clear();
  memorySources.clear();
  topicProviders.clear();
}
