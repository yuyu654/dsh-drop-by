import { createHash } from 'node:crypto';
import { CURIOSITY_DEFAULTS } from '../settings/config.js';
import { readChatData, writeChatData } from '../channels/douyin-im.js';

const FILE = 'exploration-feedback';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const topicKey = (text) => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const settings = cfg => ({ ...CURIOSITY_DEFAULTS, ...cfg?.exploration?.feedback });
const inRange = (value, min, max, fallback) => Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
const cap = opts => inRange(opts.maxCandidates, 1, 12, CURIOSITY_DEFAULTS.maxCandidates);
const warm = opts => inRange(opts.warmMin, 1, 180, CURIOSITY_DEFAULTS.warmMin) * 60_000;
const ttl = opts => inRange(opts.keepDays, 1, 30, CURIOSITY_DEFAULTS.keepDays) * 86_400_000;

function cleanTitle(text) {
  if (typeof text !== 'string') return '';
  const topic = text.replace(/\s+/g, ' ').trim();
  if (topic.length > 72 || topicKey(topic).length < 3 ||
      /https?:|www\.|(?:[A-Z]:[\\/])|[<>]|\d{7,}|密码|验证码|口令|账号|api[_ -]?key|(?:复制|打开).{0,9}(?:抖音|链接)|私聊|本地路径/iu.test(topic)) return '';
  if (/^(?:分享|转发|视频|视频卡片|抖音视频|链接|网页|文章|转发视频|看看这个)$/u.test(topic)) return '';
  return topic;
}

// Only accept a short caption accompanying a supported public link or an actual video card.
export function forwardCuriosity(text, { item, title } = {}) {
  const raw = typeof text === 'string' ? text.trim() : '';
  const supported = raw.match(/https?:\/\/(?:[a-z0-9-]+\.)*(?:douyin\.com|bilibili\.com|b23\.tv|zhihu\.com|xiaohongshu\.com|xhslink\.com|youtube\.com|youtu\.be)\/[^\s，。】]+/iu);
  const card = /\[(?:卡片消息|合并转发|视频)\]/u;
  if (!item && !supported && !card.test(raw)) return null;
  const caption = raw.replace(/https?:\/\/[^\s，。】]+/giu, '').replace(card, '').split(/\r?\n/).find(line => cleanTitle(line.replace(/^[【《]|[】》]$/gu, '')));
  const topic = cleanTitle(title) || cleanTitle(caption?.replace(/^[【《]|[】》]$/gu, ''));
  return topic ? { id: hash(item || supported?.[0] || topic), title: topic } : null;
}

function read(opts, now) {
  let old;
  try { old = readChatData(FILE); } catch { old = {}; }
  const fresh = (key, age) => (Array.isArray(old?.[key]) ? old[key] : []).filter(row =>
    Number.isFinite(row?.at) && row.at <= now && row.at + age > now);
  return {
    choices: fresh('choices', ttl(opts)),
    candidates: fresh('candidates', ttl(opts)).slice(0, cap(opts)),
    seeds: fresh('seeds', warm(opts)),
    shares: fresh('shares', warm(opts)),
    hidden: fresh('hidden', ttl(opts)),
  };
}

function write(state, opts) {
  const trim = (rows, n) => rows.sort((a, b) => b.at - a.at).slice(0, n);
  const max = cap(opts);
  writeChatData(FILE, {
    choices: trim(state.choices, max),
    candidates: trim(state.candidates, max),
    seeds: trim(state.seeds, max * 2),
    shares: trim(state.shares, max * 2),
    hidden: trim(state.hidden, max * 3),
  });
}

function currentEntries(status, opts, now) {
  return ['thread', 'leisure', 'light'].flatMap(kind => {
    const value = status?.[kind];
    const topic = cleanTitle(value?.topic);
    if (!topic || !Number.isFinite(value?.at) || value.at > now || value.at + ttl(opts) <= now) return [];
    return [{ id: hash(['entry', kind, topicKey(topic)]), kind, topic, at: value.at }];
  });
}

export function explorationFeedbackForUi(status, cfg, now = Date.now()) {
  const opts = settings(cfg);
  const state = read(opts, now);
  return {
    enabled: opts.enabled !== false,
    entries: currentEntries(status, opts, now).map(entry => ({
      ...entry, action: state.choices.find(choice => choice.key === topicKey(entry.topic))?.action || '',
    })),
    candidates: state.candidates.map(({ id, topic, source, at }) => ({ id, topic, source, at })),
  };
}

export function applyExplorationFeedback({ action, id, cfg, status, now = Date.now() }) {
  const opts = settings(cfg);
  const state = read(opts, now);
  if (action === 'delete') {
    const candidate = state.candidates.find(row => row.id === id);
    if (!candidate) return false;
    state.candidates = state.candidates.filter(row => row.id !== id);
    state.hidden = [{ key: candidate.key, at: now }, ...state.hidden.filter(row => row.key !== candidate.key)];
    write(state, opts);
    return true;
  }
  if (opts.enabled === false || !['more', 'change', 'pause', 'clear'].includes(action)) return false;
  const entry = currentEntries(status, opts, now).find(row => row.id === id);
  if (!entry) return false;
  if (action === 'clear') {
    const key = topicKey(entry.topic);
    state.choices = state.choices.filter(row => row.key !== key);
    write(state, opts);
    return true;
  }
  saveChoice(state, opts, { topic: entry.topic, action, at: now });
  return true;
}

function saveChoice(state, opts, choice) {
  const key = topicKey(choice.topic);
  state.choices = [{ ...choice, key }, ...state.choices.filter(row => row.key !== key)];
  write(state, opts);
}

// An explicit private-chat request also works when passive curiosity feedback is off.
export function recordExplorationDirection({ cfg, action, topic, now = Date.now() }) {
  if (!['change', 'pause'].includes(action) || typeof topic !== 'string' ||
      topic.length > 120 || topicKey(topic).length < 2) return false;
  const opts = settings(cfg);
  saveChoice(read(opts, now), opts, { topic, action, at: now, explicit: true });
  return true;
}

export function explorationFeedbackHints(cfg, status, now = Date.now()) {
  const opts = settings(cfg);
  const state = read(opts, now);
  const avoid = state.choices.filter(row => row.action !== 'more' && (opts.enabled !== false || row.explicit))
    .map(row => row.topic);
  if (opts.enabled === false) return { prefer: '', avoid };
  const active = new Set(currentEntries(status, opts, now).map(entry => topicKey(entry.topic)));
  const more = state.choices.find(row => active.has(row.key) && row.action === 'more' && !row.usedAt);
  if (more) return { prefer: more.topic, avoid, choice: more.key };
  const blocked = new Set(avoid.map(topicKey));
  const candidate = state.candidates.find(row => !row.usedAt && !blocked.has(row.key));
  return { prefer: candidate?.topic || '', avoid, ...(candidate ? { candidate: candidate.id } : {}) };
}

export function consumeExplorationFeedback(cfg, hint, now = Date.now()) {
  if (!hint?.choice && !hint?.candidate) return;
  const opts = settings(cfg);
  if (opts.enabled === false) return;
  const state = read(opts, now);
  const row = hint.choice ? state.choices.find(x => x.key === hint.choice && x.action === 'more')
    : state.candidates.find(x => x.id === hint.candidate);
  if (!row || row.usedAt) return;
  row.usedAt = now;
  write(state, opts);
}

function setSeed(state, { peer, channel, id, topic, at, source, score }) {
  const key = topicKey(topic);
  const seed = { peer: String(peer), channel, id: hash([source, id || key, at]), key, topic, at, source, score };
  state.seeds = [seed, ...state.seeds.filter(row => row.peer !== seed.peer || row.channel !== channel)];
  return seed;
}

export function rememberExplorationShare({ cfg, peer, channel, id, topic, at }) {
  const opts = settings(cfg);
  topic = cleanTitle(topic);
  if (!topic || !peer || !Number.isFinite(at)) return;
  const state = read(opts, at);
  const sameChat = row => row.peer === String(peer) && row.channel === channel;
  state.shares = [{ peer: String(peer), channel, topic, at }, ...state.shares.filter(row => !sameChat(row))];
  if (opts.enabled !== false) setSeed(state, { peer, channel, id, topic, at, source: 'share', score: 0 });
  write(state, opts);
}

export function recentSharedExplorationTopic({ cfg, peer, channel, now = Date.now() }) {
  const state = read(settings(cfg), now);
  const sameChat = row => row.peer === String(peer) && row.channel === channel;
  return state.shares.find(sameChat)?.topic || state.seeds.find(row => row.source === 'share' && sameChat(row))?.topic || '';
}

function related(topic, text) {
  const message = topicKey(text);
  const title = topicKey(topic);
  if (message.length < 6) return false;
  if (message.includes(title)) return true;
  const size = Math.min(title.length, 3);
  for (let i = 0; i + size <= title.length; i++) {
    if (message.includes(title.slice(i, i + size))) return true;
  }
  return /(?:这(?:篇|部|个视频|段)|那(?:篇|部|个视频|段)).{0,12}(?:有意思|挺好|看懂|还想看|为什么|怎么|想了解)/u.test(String(text));
}

export function observeCuriosity({ cfg, peer, channel, text, at, forward, now = Date.now() }) {
  const opts = settings(cfg);
  if (opts.enabled === false || !peer || !['qq', 'douyin'].includes(channel) || !Number.isFinite(at) ||
      at > now || now - at >= warm(opts)) return false;
  const state = read(opts, now);
  let seed = state.seeds.find(row => row.peer === String(peer) && row.channel === channel);
  const title = cleanTitle(forward?.title);
  if (title) {
    const id = hash(['forward', forward?.id || topicKey(title), at]);
    if (!seed || (id !== seed.id && at > seed.at)) {
      setSeed(state, { peer, channel, id: forward?.id, topic: title, at, source: 'forward', score: 1 });
      write(state, opts);
    }
    return false;
  }
  if (!seed || at <= seed.at || at <= (seed.lastAt || 0) || seed.score >= 2 || !related(seed.topic, text)) return false;
  const wording = hash(topicKey(text));
  if (seed.wording === wording) return false;
  seed.lastAt = at;
  seed.wording = wording;
  seed.score++;
  if (seed.score >= 2 && !state.hidden.some(row => row.key === seed.key) && !state.candidates.some(row => row.key === seed.key)) {
    state.candidates.unshift({ id: hash(['candidate', seed.key]), key: seed.key, topic: seed.topic, source: seed.source, at });
  }
  write(state, opts);
  return seed.score >= 2;
}

export function topicInExplorationFeedback(topic, list) {
  const key = topicKey(topic);
  return Boolean(key && Array.isArray(list) && list.some(item => {
    const other = topicKey(item);
    return (key.length >= 2 && key === other) ||
      (other.length >= 3 && (key.includes(other) || (key.length >= 3 && other.includes(key))));
  }));
}
