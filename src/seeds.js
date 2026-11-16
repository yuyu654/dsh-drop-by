// seeds.js —— 随口说话的「起点」：记忆里的一条，或者最近聊到的那句。
//
// 为什么要有种子：没有由头的时候，最容易写出来的就是「在吗」「想你了」这种空话。
// 给一个具体的东西当起点（我私下记过的一条判断、她最近说过的一句话），话才有落点。
//
// 两条纪律：
//   · 种子是素材，不是任务——prompt 里明确写「这一句的起点（是素材，不是任务）」，
//     不许照着念、不许加引号复述；
//   · 我自己标了「不给她看」的条目**绝不拿来当种子**（那是瞒着她的东西，
//     拿去搭话等于自己拆自己的台）。方向别搞反：是我不给她看，不是她瞒着我。
import { readMemory } from './memorysource.js';
import { localStyle } from './local.js';

const DAY = 86_400_000;

// 判断收在 private.js 里（与 context.js 的 self.md 标记同一套），
// 单独成模块是为了 seeds 不必依赖 douyin 目录，也不会两边规则漂移。
import { PRIVATE_MARK as PRIVATE } from './private.js';

/**
 * 种子里的专有名词：书名/引号里的话直接从原文取，人名来自 local-style.json 的 names
 * （人名属于本机私有内容，不写死在插件里）。
 * 用途只有一个：写进 prompt，要求「这些名字照抄，不许改字、不许编」。
 */
export function seedEntities(text, cfg) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/《([^》]{1,30})》/g)) out.add(`《${m[1]}》`);
  for (const m of s.matchAll(/「([^」]{1,20})」/g)) out.add(m[1]);
  for (const n of localStyle(cfg).names) if (n && s.includes(n)) out.add(n);
  return [...out].slice(0, 6);
}

/** 稳定短 id（同样的文字永远同一个 id），用来做「最近用过」的去重环。 */
export function seedId(kind, text) {
  let h = 2166136261 >>> 0;
  for (const ch of String(text || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${kind}:${h.toString(36)}`;
}

const MEMORY_META = /(?:[A-Za-z]:\\|\/Users\/|\/home\/|\.(?:json|jsonl|mjs|js|py|md|txt)\b|规则[:：]|参考图|官方形象|自主探索每|配置项|prompt|AGENT\.md|persona\.md)/iu;

/**
 * 记忆种子池。返回 { pool, why }。
 * 过滤顺序：太老（seedDays）→ 我自己标了不给她看的 → 路径/规则/设定等元信息 → 空文本。
 */
export function memoryPool({ cfg, now = Date.now(), seedDays = 30 } = {}) {
  const c = cfg?.rules?.chitchat || {};
  const days = Math.max(1, Math.min(365, Number(seedDays) || 30));
  const mem = readMemory({ cfg, now });
  if (!mem?.ok) return { pool: [], why: mem?.reason || 'MEMORY_EMPTY' };
  const skipPrivate = c.seedSkipPrivate !== false;
  const horizon = now - days * DAY;
  const pool = [];
  for (const it of mem.items || []) {
    const text = String(it?.text || '').trim();
    if (!text) continue;
    if (it.at && it.at < horizon) continue;
    if (skipPrivate && PRIVATE.test(text)) continue;
    if (MEMORY_META.test(text)) continue;
    pool.push({ id: seedId('m', text), kind: 'memory', text: text.slice(0, 80), day: it.day || '', entities: seedEntities(text, cfg) });
  }
  return { pool, why: pool.length ? null : 'MEMORY_SEED_EMPTY' };
}

/**
 * 角色人设里的自身生活/习惯/偏好种子池。
 * 作用：让随口说话不只是翻记忆或围着用户转，也能从「我」自己的体质、嘴馋、毛病和爱好自然开口。
 */
const SKIP_PERSONA_SECTION = /说话方式|工作模式|什么时候|角色对照|是什么样的人|关于(?:对方|用户)|对你[（(]|发语音|示例|禁忌|底线|原则|边界|规则|规范|写法/u;
const PREFER_PERSONA_SECTION = /我是谁|关于我|个人设定|人设|习惯|日常|喜好|偏好|体质|生活|性格/u;
const PERSONA_META_OR_RULE = /[「」]?(?:我|你)\s*=|提示词|不许|禁用|禁止|不得|不承认|不写括号|别在|别总|别老|别问|不带|不骂|不拿|^台阶[:：]|node\s|\.mjs|https?:\/\//iu;
const PERSONA_TRAIT_CUE = /胃|体|睡|熬夜|犯|吃|喝|甜|冰|咖啡|奶茶|茶|零食|喜欢|爱|讨厌|怕|常让|顺手|嘴硬|习惯|偏好|爱好|兴趣|日常|看番|二创|二次元|游戏|音乐|画|折腾/u;

export function personaPool({ persona, cfg } = {}) {
  const raw = typeof persona === 'string' ? persona : persona?.text;
  const text = String(raw || '').trim();
  if (!text) return [];
  const skipPrivate = cfg?.rules?.chitchat?.seedSkipPrivate !== false;
  const pool = [];
  const seen = new Set();
  let heading = '';
  let inCode = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const t = rawLine.trim();
    if (/^```/.test(t)) {
      inCode = !inCode;
      continue;
    }
    if (inCode || !t || t.startsWith('|') || t.startsWith('>')) continue;
    if (/^#{1,6}\s+/.test(t)) {
      heading = t.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }
    if (heading && SKIP_PERSONA_SECTION.test(heading)) continue;
    const isBullet = /^[-*·]\s+/.test(t) || /^\d+[.、]\s+/.test(t);
    if (!isBullet && !PREFER_PERSONA_SECTION.test(heading)) continue;
    const clean = t
      .replace(/^[-*·]\s+/, '')
      .replace(/^\d+[.、]\s+/, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length < 6 || PERSONA_META_OR_RULE.test(clean)) continue;
    if (skipPrivate && PRIVATE.test(clean)) continue;
    if (!PERSONA_TRAIT_CUE.test(clean)) continue;
    const clipped = clean.slice(0, 80);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    const entities = seedEntities(clipped, cfg).filter((w) => !['你', '我', '他', '她', '它'].includes(w));
    pool.push({ id: seedId('p', clipped), kind: 'persona', text: clipped, day: '', entities });
  }
  return pool;
}

/**
 * 挑一个这一拍可用的种子。
 *   · 同时看记忆种子池与角色人设自身生活种子池（传了 persona 才提取）；
 *   · 先排除最近 3 次用过的（state.chitchat.recentSeeds，环形 3）；
 *   · 两者都有新鲜种子时按「上次类型轮替 + 随机」抽取，避免记忆条数多就把角色自己淹没；
 *   · 池子被用空 → 返回 null（这一拍没有种子，不硬凑）。
 */
export function pickSeed({ cfg, persona = null, now = Date.now(), st = {}, tz = 'Asia/Shanghai', seedDays = null, rnd = Math.random } = {}) {
  const c = cfg?.rules?.chitchat || {};
  const days = seedDays ?? Number(c.seedDays ?? 30);
  const { pool: memPool, why } = memoryPool({ cfg, now, seedDays: days });
  const pPool = personaPool({ persona, cfg });
  const ring = Array.isArray(st?.chitchat?.recentSeeds) ? st.chitchat.recentSeeds.slice(-3).map(String) : [];
  const memFresh = memPool.filter((s) => !ring.includes(s.id));
  const personaFresh = pPool.filter((s) => !ring.includes(s.id));

  let chosenPool = [];
  if (personaFresh.length && memFresh.length) {
    const lastId = ring.at(-1) || '';
    const preferPersona = !lastId.startsWith('p:');
    chosenPool = preferPersona ? personaFresh : memFresh;
  } else {
    chosenPool = personaFresh.length ? personaFresh : memFresh;
  }

  const totalPoolSize = memPool.length + pPool.length;
  if (!chosenPool.length) {
    return { seed: null, why: totalPoolSize ? 'SEED_ALL_USED' : why, poolSize: totalPoolSize };
  }
  const i = Math.min(chosenPool.length - 1, Math.max(0, Math.floor(Number(rnd()) * chosenPool.length)));
  return { seed: chosenPool[i], why: null, poolSize: totalPoolSize };
}

/**
 * 对话种子：她最近说了什么（6 小时内），否则退到「你们刚聊到哪」。
 * 只给一句话，别把整段对话塞进去。
 */
export function conversationLine(ctx, { withinHours = 6 } = {}) {
  const her = ctx?.her || {};
  const ago = Number(her.lastAgoSec);
  if (her.lastText && Number.isFinite(ago) && ago >= 0 && ago <= withinHours * 3600) {
    const mins = Math.round(ago / 60);
    const when = mins < 60 ? `${Math.max(1, mins)} 分钟前` : `${Math.round(mins / 60)} 小时前`;
    return `她 ${when}说：「${String(her.lastText).slice(0, 80)}」`;
  }
  const turns = Array.isArray(ctx?.turns) ? ctx.turns.slice(-2) : [];
  if (turns.length) {
    return turns.map((t) => `${t.who === 'her' ? '她' : '我'}：${String(t.text || '').slice(0, 60)}`).join(' / ');
  }
  return '';
}

/** 发出去之后把种子记进去重环（环形 3，只有真发了才记）。 */
export function rememberSeed(st, seedIdStr) {
  const id = String(seedIdStr || '').trim();
  if (!id) return st;
  const cur = st.chitchat && typeof st.chitchat === 'object' ? st.chitchat : {};
  const ring = Array.isArray(cur.recentSeeds) ? cur.recentSeeds.slice(-2).map(String) : [];
  st.chitchat = { ...cur, recentSeeds: [...ring, id].slice(-3) };
  return st;
}