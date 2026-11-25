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

export const PERSONA_FACT_RULE = '人设只提供口吻、偏好和表达习惯。已发生的动作、当下的身体状态、物品和约定都要有本轮候选或对话事实支撑。之前发出去但没有事实依据的描述不能当成后来追问的依据。可以说喜好、想法和感受。';

const DEFAULT_MAX_CHARS = 60;

/**
 * 判断用的 prompt：人格 + 快照 + 输出契约。
 * 结构特意是「先说要交付什么，再给材料，最后再说一遍」——只在末尾写一次 JSON 契约时，
 * 角色型人格会把这一步当成「回她一条消息」，输出人话（实测三次里两次这样）。
 */
export function judgePrompt({ snapshot, persona, candidates = [], maxChars = DEFAULT_MAX_CHARS } = {}) {
  const p = String(persona?.text || '').trim();
  const snap = String(snapshot || '').trim();
  const limit = Math.max(10, Number(maxChars) || DEFAULT_MAX_CHARS);
  const idField = candidates.length ? '"candidateId": "选中的候选 ID；不说时为空", ' : '';
  const contract = [
    '只输出一个 JSON 对象（一行），不要代码块，不要解释，不要额外说一句话：',
    `{"say": true|false, ${idField}"angle": "想说的那件事", "draft": "要发出去的那一句", "why": "为什么这么判断"}`,
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
    PERSONA_FACT_RULE,
    ...(candidates.length ? [
      '从下列候选选一条或保持沉默。say=true 时 candidateId 必须是原样 ID，angle 和 draft 只围绕该候选，不串题或新增由头。',
      '优先考虑快过期的明确提醒与有证据的新发现。普通设备活动、身体数据只是弱信号。出现明确等待、结束或取消的事项，不能因沉默就续问。',
      '若选换源请示，只询问这份资料能否换来源。若选有来源的分享，写为什么想分享，按实际证据表述，正文不写网址并遵守候选要求。',
      JSON.stringify(candidates),
    ] : ['当前准备预演或接话，已有具体由头就围绕它。']),
    '· 这是多端聊天（QQ / 抖音手机与电脑都能收到）：不要仅仅因为「她不在电脑前」「电脑锁屏」或「没检测到电脑动静」就写 "say": false——不在电脑前只是不提桌面状态，照常可以正常开口聊天或问候。',
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
    '· 别围着「她在电脑前」转：快照里「最近发出去的几条」要是已经在说屏幕、坐着、硬撑，就选另一个合格候选或保持沉默。同一个观察反复提会像监视。',
    '· 若要聊自己琢磨的事或分享内容（share / 我的探索近况）：先对照「她接过我哪类话」「我记得的事」看她是不是真感兴趣；明显偏门、她近期常冷处理或你自己没法翻译成日常聊天的话，就写 "say": false。',
    '· share 用能听懂的大白话讲具体的新发现、反例或为什么偏爱它。允许讲完就停，只有自然能接话时再抛问题。禁止套用“你站哪派”“你是…派还是…派”“你猜…随便猜一个”“你那个掉了没”等模板互动话术。',
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
export function parseJudge(raw, candidates = []) {
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
  if (say && candidates.length && !candidates.some(({ id }) => id === j.candidateId)) {
    return { ok: false, reason: 'JUDGE_INVALID_CANDIDATE' };
  }
  return { ok: true, say, angle, draft: say ? draft : '', why,
    ...(say && candidates.length ? { candidateId: j.candidateId } : {}) };
}

/**
 * 问一次模型。
 * 返回 { ok, say, angle, draft, why, ms } 或 { ok:false, reason }。
 * ok:false 的含义是「这一拍照旧按规则走」，不是「不说」。
 */
export async function judgeDecision({ snapshot, persona, candidates = [], cfg, generate, llmReady = null, timeoutMs = cfg?.rules?.judge?.timeoutMs ?? 90_000 } = {}) {
  if (typeof generate !== 'function') return { ok: false, reason: 'JUDGE_NO_LLM' };
  if (llmReady === false) return { ok: false, reason: 'JUDGE_LLM_NOT_READY' };
  const maxChars = Math.max(10, Number(cfg?.content?.maxChars) || DEFAULT_MAX_CHARS);
  const base = judgePrompt({ snapshot, persona, candidates, maxChars });
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
      r = await generate({ prompt, cfg, timeoutMs, tail: 'json', minOutputTokens: 1536, reasoningEffort: 'low', tag: 'proactive-judge' });
    } catch (e) {
      return { ok: false, reason: 'JUDGE_ERROR', note: String(e?.message || e).slice(0, 160), ms: Date.now() - t0 };
    }
    if (!r?.ok) {
      return { ok: false, reason: r?.reason || 'JUDGE_LLM_FAIL', ms: Date.now() - t0, note: String(r?.note || '').slice(0, 160), raw };
    }
    raw = String(r.text || '').slice(0, 1200);
    const p = parseJudge(r.text, candidates);
    if (p.ok) return { ...p, ms: Date.now() - t0, attempts: i + 1, raw };
    last = p;
    if (!retryable.has(p.reason)) return { ...p, ms: Date.now() - t0, attempts: i + 1, raw };
  }
  return { ...last, ms: Date.now() - t0, attempts, raw };
}
