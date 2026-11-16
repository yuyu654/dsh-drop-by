// judge.js —— 一次模型判断：现在要不要开口？要说什么？
//
// 这一步的边界（改之前先看这里）：
//   · 它只回答「说不说、说什么」，**不负责能不能发**——静默/间隔/上限/护栏全在外面；
//   · 它可能失败（超时、坏 JSON、模型说人话），失败 = 退回原来的规则链，不等于不说；
//   · 它说 say:true 也只给出草稿，草稿照样过 clean + guard，过不了就不发。
// 所以这一层是「软决策」，硬的永远在 engine 和 compose 里。
//
// 不读文件、不写 state：快照由 snapshot.js 拼好传进来，结论由 engine 存。
import { ATTRIBUTION_RULE } from './attribution.js';

const DEFAULT_MAX_CHARS = 60;

/**
 * 判断用的 prompt：人格 + 快照 + 输出契约。
 * 结构特意是「先说要交付什么，再给材料，最后再说一遍」——只在末尾写一次 JSON 契约时，
 * 角色型人格会把这一步当成「回她一条消息」，输出人话（实测三次里两次这样）。
 */
export function judgePrompt({ snapshot, persona, maxChars = DEFAULT_MAX_CHARS } = {}) {
  const p = String(persona?.text || '').trim();
  const snap = String(snapshot || '').trim();
  const limit = Math.max(10, Number(maxChars) || DEFAULT_MAX_CHARS);
  const contract = [
    '只输出一个 JSON 对象（一行），不要代码块，不要解释，不要额外说一句话：',
    '{"say": true|false, "angle": "想说的那件事", "draft": "要发出去的那一句", "why": "为什么这么判断"}',
  ];
  return [
    p ? `下面是你要扮演的角色。draft 的口吻、句子长短、能说什么，都照它来：

${p}
` : '',
    '—— 后台判断（不是聊天）——',
    '接下来这一次，你不是在和她说话，而是在替她做一次判断：这一刻要不要主动开口？',
    '所以不要直接回她那句话，也不要把这一段当成对话继续下去。这一轮唯一的交付物是下面这个 JSON。',
    '',
    ...contract,
    '',
    '--- 以下是判断材料，不是要你回答的消息 ---',
    '',
    snap,
    '',
    '【怎么判断】',
    ATTRIBUTION_RULE,
    '· 有没有值得开口的事，你说了算——规则给的那条建议可以参考，也可以整个不用。',
    '· 没有值得开口的事就写 "say": false。宁可这一拍不说，也别硬凑一句。只有规则明确选中「那条还没回」才考虑跟进；不能自行把没回的闲聊或分享当成由头。',
    '· 电脑活动、窗口、旧项目记忆不代表她在求助。只有她近期亲口提到卡住、需要帮忙或给了同一项目的新进展，才顺势接；别主动要报错、追问进度或反复问她最近做什么项目。',
    '· 要说就具体：angle 是你想说的那件事（一句话），draft 是真正会发给她的那一句。',
    `· draft 一两句、不超过 ${limit} 字，口吻照人格来；不要罗列上面的事实，不要说「我注意到」「检测到」「根据你的数据」。`,
    '· 不要写括号里的动作，不要自称助手，不要解释这套判断。',
    '· why 是你为什么这么判断（一句话，给自己看的，不会发出去）。',
    '· 她正专注做事（写代码、上课、开会）时，说 false 不算失职；但她被同一件事缠了很久（连续两三个小时没离开、饭点过了没动、深夜还在做），可以关心一句——只在她真可能需要搭把手的时候，别拿这个当借口找话说。',
    '· 她那句要是标着「我已经在那边回过了」，就绝对不许再拿它当这一拍要说的事，也不许再答一遍——那是同一个问题答两次，她只会觉得我在复读。',
    '· draft 只许说快照里这一件事：不翻旧账、不拽只有你们两个知道的生活梗当理由。要关心就直接问她这一件，别追加一句预设立场的数落（「别又…」「又不好好…」）。',
    '· 材料里的旧话带日期（今天／昨天／N 天前）：只有标着「今天」的才能说成「今天」「刚才」，「昨天」的才是昨晚；标着更早的，不许说成昨晚、今早、刚才——要提就直接说那件事，别提时间。',
    '· 别围着「她在电脑前」转：快照里「最近发出去的几条」要是已经在说屏幕、坐着、硬撑，这一拍就换别的事——她刚说过的话、没回的那条、我自己这边的判断。同一个观察一天说一次就够，反复提会像监视。',
    '· 若要聊自己琢磨的事或分享内容（share / 我的探索近况）：先对照「她接过我哪类话」「我记得的事」看她是不是真感兴趣；明显偏门、她近期常冷处理或你自己没法翻译成日常聊天的话，就写 "say": false。',
    '· 这类 share 的 draft 严禁出现公式、字母代号、专业黑话或教科书式定论——一定译成外行朋友一听就懂的大白话，并且必须留出她能接话的口子（顺口问她看法、经历或丢个问题过去），别只讲完一句自己的结论就收尾。',
    '',
    ...contract,
    '',
    '再强调一次：这一轮要写进文件的，就是那个 JSON 对象本身（一行），',
    '不是 draft 那一句，也不是你要对她说的话。',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * 解析模型输出。任何一处不对都算判断失败（ok:false），由调用方退回规则链。
 * 不做「尽量抢救」：字段缺一个就整条不用，免得半截 JSON 变成半截话。
 */
export function parseJudge(raw) {
  const txt = String(raw ?? '').trim();
  if (!txt) return { ok: false, reason: 'JUDGE_EMPTY' };
  const m = /\{[\s\S]*\}/.exec(txt);
  if (!m) return { ok: false, reason: 'JUDGE_NOT_JSON' };
  let j = null;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return { ok: false, reason: 'JUDGE_JSON_PARSE' };
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { ok: false, reason: 'JUDGE_NOT_OBJECT' };
  if (typeof j.say !== 'boolean') return { ok: false, reason: 'JUDGE_SAY_NOT_BOOL' };
  const say = j.say;
  const angle = String(j.angle ?? '').trim().slice(0, 120);
  const draft = String(j.draft ?? '').trim().slice(0, 400);
  const why = String(j.why ?? '').trim().slice(0, 120);
  if (say && !draft) return { ok: false, reason: 'JUDGE_NO_DRAFT' };
  return { ok: true, say, angle, draft: say ? draft : '', why };
}

/**
 * 问一次模型。
 * 返回 { ok, say, angle, draft, why, ms } 或 { ok:false, reason }。
 * ok:false 的含义是「这一拍照旧按规则走」，不是「不说」。
 */
export async function judgeDecision({ snapshot, persona, cfg, generate, llmReady = null, timeoutMs = cfg?.rules?.judge?.timeoutMs ?? 90_000 } = {}) {
  if (typeof generate !== 'function') return { ok: false, reason: 'JUDGE_NO_LLM' };
  if (llmReady === false) return { ok: false, reason: 'JUDGE_LLM_NOT_READY' };
  const maxChars = Math.max(10, Number(cfg?.content?.maxChars) || DEFAULT_MAX_CHARS);
  const base = judgePrompt({ snapshot, persona, maxChars });
  const attempts = Math.max(1, Math.min(3, Number(cfg?.rules?.judge?.attempts) || 2));
  const retryable = new Set(['JUDGE_EMPTY', 'JUDGE_NOT_JSON', 'JUDGE_JSON_PARSE', 'JUDGE_NOT_OBJECT', 'JUDGE_SAY_NOT_BOOL', 'JUDGE_NO_DRAFT']);

  const t0 = Date.now();
  let raw = '';
  let last = null;
  for (let i = 0; i < attempts; i++) {
    // 第二次起把「刚才格式不对」甩在前面：角色型人格容易把判断当成回话（实测约三成），
    // 再问一次基本能纠正；模型侧网络/超时错误不重试。
    const prompt = i === 0
      ? base
      : `上一次的回答不合格（${last?.reason}）：你没有输出 JSON，而是直接写了一句话。\n` +
        '这一次只写那个 JSON 对象本身，一个多余的字都不要加。\n\n' +
        base;
    let r = null;
    try {
      r = await generate({ prompt, cfg, timeoutMs, tail: 'json', minOutputTokens: 1536 });
    } catch (e) {
      return { ok: false, reason: 'JUDGE_ERROR', note: String(e?.message || e).slice(0, 160), ms: Date.now() - t0 };
    }
    if (!r?.ok) {
      return { ok: false, reason: r?.reason || 'JUDGE_LLM_FAIL', ms: Date.now() - t0, note: String(r?.note || '').slice(0, 160), raw };
    }
    raw = String(r.text || '').slice(0, 1200);
    const p = parseJudge(r.text);
    if (p.ok) return { ...p, ms: Date.now() - t0, attempts: i + 1, raw };
    last = p;
    if (!retryable.has(p.reason)) return { ...p, ms: Date.now() - t0, attempts: i + 1, raw };
  }
  return { ...last, ms: Date.now() - t0, attempts, raw };
}
