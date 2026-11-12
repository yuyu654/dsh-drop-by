// split.js —— 把一段回复切成「人能连着说的两三条」。
//
// 为什么需要：compose 写出来常常是两段，中间一个空行。整段一次发出去，
// QQ 里就是一大堵墙（或者一条被折成两截的气泡）；她要的是「一句一条」。
// 规则（任务书 2026-11-09）：空行优先切、单段 ≤60 字不拆、>60 按句末标点切、
// 最多 4 条；链接、引号、代码块、列表不切。切不动就原样发，绝不硬拆。
const FENCE_RE = /```[\s\S]*?```/g;
const URL_RE = /https?:\/\/[^\s，。；、）)」』"']+/g;
const QUOTE_RE = /「[^」]*」|“[^”]*”|"[^"\n]*"/g;
const LIST_LINE_RE = /^[\t ]*(?:[-*+]|\d+[.)、]|[一二三四五六七八九十]+[、.])\s+\S/gm;

const SENTENCE_END = /[。！？!?…；;]/;
const MIN_PART_CHARS = 30;
const SOFT_MAX_CHARS = 60;
const HARD_MAX_CHARS = 80;

/** 不许被切开的区间：[start, end) */
export function protectedSpans(text) {
  const spans = [];
  const add = (re, padBefore = 0, padAfter = 0) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      spans.push([Math.max(0, m.index - padBefore), m.index + m[0].length + padAfter]);
      if (m[0].length === 0) re.lastIndex += 1;
    }
  };
  add(FENCE_RE);
  add(URL_RE, 1, 1);
  add(QUOTE_RE);
  add(LIST_LINE_RE);
  return spans.sort((a, b) => a[0] - b[0]);
}

function crosses(spans, at) {
  return spans.some(([start, end]) => at > start && at < end);
}

/** 按空行分段，但代码块里的空行不算（块里的缩进/空行是代码的一部分）。 */
function splitBlankLines(text) {
  const fences = [];
  FENCE_RE.lastIndex = 0;
  let m;
  while ((m = FENCE_RE.exec(text)) !== null) fences.push([m.index, m.index + m[0].length]);
  const inFence = (at) => fences.some(([start, end]) => at > start && at < end);

  const out = [];
  let start = 0;
  const re = /\n\s*\n+/g;
  let blank;
  while ((blank = re.exec(text)) !== null) {
    if (inFence(blank.index)) continue;
    out.push(text.slice(start, blank.index));
    start = blank.index + blank[0].length;
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** 按句末标点切；只在保护区间之外、且切出来不太碎的位置切。 */
export function splitSentences(text) {
  const spans = protectedSpans(text);
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!SENTENCE_END.test(text[i])) continue;
    if (crosses(spans, i + 1)) continue;
    const piece = text.slice(start, i + 1).trim();
    if (!piece) continue;
    out.push(piece);
    start = i + 1;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out.length > 0 ? out : [text.trim()];
}

/** 把一长段按句子攒成 30–60 字的块；一条太长的句子自己成块（>80 也不硬切）。 */
function packSentences(text) {
  const sentences = splitSentences(text);
  const packs = [];
  let buf = '';
  for (const sentence of sentences) {
    if (buf && (buf.length + sentence.length > SOFT_MAX_CHARS || buf.length >= MIN_PART_CHARS)) {
      packs.push(buf);
      buf = '';
    }
    buf = buf ? `${buf}${sentence}` : sentence;
  }
  if (buf) packs.push(buf);
  return packs;
}

/**
 * 切一条回复。返回 1–maxParts 条（空输入返回 []）。
 * 空行分段优先；段本身超过 60 字再按句子拆；多出来的并进最后一条。
 */
export function splitOutgoing(text, { maxParts = 4 } = {}) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const max = Math.max(1, Math.min(4, Number(maxParts) || 4));

  const parts = [];
  for (const para of splitBlankLines(raw)) {
    if (para.length <= SOFT_MAX_CHARS || protectedSpans(para).some(([start, end]) => end - start >= para.length - 1)) {
      parts.push(para);
      continue;
    }
    for (const pack of packSentences(para)) parts.push(pack);
  }

  // 超过 maxParts：前面的单独发，后面全部并进最后一条（别拆到只剩省略号）。
  if (parts.length > max) {
    const head = parts.slice(0, max - 1);
    const tail = parts.slice(max - 1).join(' ');
    return [...head, tail].filter((p) => p.length > 0);
  }
  // 单条超过 HARD_MAX 也不硬拆：宁可一条长一点，也不把词切断。
  return parts.filter((p) => p.length > 0).slice(0, max);
}

/** 首条等多久：她刚发的话，6 秒起、按字数加，封顶 60 秒；她等得越久这里越短。 */
export function firstDelayMs({ herAt = 0, herChars = 0, now = Date.now(), rand = Math.random, minMs = 6000 } = {}) {
  const base = Math.min(60000, Math.max(minMs, minMs + 60 * (Number(herChars) || 0) + rand() * 12000));
  const target = (Number(herAt) || 0) + base;
  return Math.max(0, Math.round(target - now));
}

/** 两条之间的间隔：1.2 秒起，按字数加，封顶 5 秒。 */
export function partGapMs(chars, { rand = Math.random, minGapMs = 1200 } = {}) {
  return Math.min(5000, Math.max(minGapMs, minGapMs + 90 * (Number(chars) || 0) + rand() * 2200));
}