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

const DAY = 86_400_000;

// 判断收在 private.js 里（与 context.js 的 self.md 标记同一套），
// 单独成模块是为了 seeds 不必依赖 douyin 目录，也不会两边规则漂移。
import { PRIVATE_MARK as PRIVATE } from './private.js';

/** 稳定短 id（同样的文字永远同一个 id），用来做「最近用过」的去重环。 */
export function seedId(kind, text) {
  let h = 2166136261 >>> 0;
  for (const ch of String(text || '')) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${kind}:${h.toString(36)}`;
}

/**
 * 记忆种子池。返回 { pool, why }。
 * 过滤顺序：太老（seedDays）→ 我自己标了不给她看的 → 空文本。
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
    pool.push({ id: seedId('m', text), kind: 'memory', text: text.slice(0, 80), day: it.day || '' });
  }
  return { pool, why: pool.length ? null : 'MEMORY_SEED_EMPTY' };
}

/**
 * 挑一个这一拍可用的种子。
 *   · 先排除最近 3 次用过的（state.chitchat.recentSeeds，环形 3）；
 *   · 随机取一个；rnd 可注入（测试用），默认 Math.random；
 *   · 池子被用空 → 返回 null（这一拍没有种子，不硬凑）。
 */
export function pickSeed({ cfg, now = Date.now(), st = {}, tz = 'Asia/Shanghai', seedDays = null, rnd = Math.random } = {}) {
  const c = cfg?.rules?.chitchat || {};
  const days = seedDays ?? Number(c.seedDays ?? 30);
  const { pool, why } = memoryPool({ cfg, now, seedDays: days });
  const ring = Array.isArray(st?.chitchat?.recentSeeds) ? st.chitchat.recentSeeds.slice(-3).map(String) : [];
  const fresh = pool.filter((s) => !ring.includes(s.id));
  if (!fresh.length) return { seed: null, why: pool.length ? 'SEED_ALL_USED' : why, poolSize: pool.length };
  const i = Math.min(fresh.length - 1, Math.max(0, Math.floor(Number(rnd()) * fresh.length)));
  return { seed: fresh[i], why: null, poolSize: pool.length };
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