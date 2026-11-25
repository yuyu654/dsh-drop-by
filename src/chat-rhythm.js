// chat-rhythm.js —— 对话节律（开场接话点轮换 + 收尾信号识别 + 热聊热度闸）。
// 纯函数模块，无磁盘 IO，供 explore / compose / qq-continuation / qq-reply / engine 共用。
import { detectBusySpeech, extractBusyUntilMs } from './receptivity.js';

const MIN = 60_000;
const DAY = 86_400_000;

const finiteInt = (value, fallback, min, max) =>
  Number.isFinite(Number(value)) && value !== '' && value !== null
    ? Math.min(max, Math.max(min, Math.trunc(Number(value))))
    : fallback;

const norm = (text) => String(text || '').normalize('NFKC').trim();
const contentLen = (text) => norm(text).replace(/\[[^\]]{1,12}\]/gu, '').replace(/[\p{P}\p{S}\s]+/gu, '').length;
const hasQuestion = (text) => /[?？]/u.test(String(text || ''));

const THIRD_PERSON_RE = /(?:他|她|别人|同学|朋友|老师|老板|同事|室友).{0,4}(?:先|去|说)/u;
const EXPLICIT_CLOSE_RE = /(?:^|(?:我|那我?|好了|行那?)?(?:先)?)(?:去忙|忙去|先忙|先睡|去睡|睡觉去|睡觉了|准备睡|晚安|拜拜|先撤|先走|先这样|回头聊|回头再聊|下次聊|下次再聊|明天聊|改天聊|不聊了|先挂了|下线|上课去了|开会去了|吃饭去了|洗澡去了|洗漱去了|干活去了|学习去了)(?:[了啦呀啊哈哦嘛呢吧~！!。.\s]*$|[，,。！!~])/iu;
const PLACEHOLDER_ONLY_RE = /^(?:\[[^\]]{1,12}\]|\s)+$/u;
const MINIMAL_WORDS_RE = /^(?:嗯+|哦+|噢+|喔+|好+|好的|好呀|好啊|好哦|好哒|行|行吧|可以|中|对+|是的|确实|哈哈+|呵呵+|嘿嘿+|笑死|乐|草|牛|强|6+|ok+|okk+|收到|了解|懂了|知道了|是吗|真假|真的假的|原来如此|这样啊|哦这样|没了|没事|拜拜|晚安|早|早安)+$/iu;

export const REPLY_PACING_RULE =
  '接话点只用在主动开场；进入日常对话后跟着对方节奏走：对方问就答，不追问新题，每条回复最多一个问句，不要硬把没讲完的探索知识点一次塞完。';

export const OPENING_SELF_CHECK =
  '写完前在心里默检两句：① 假设对方正忙，5 秒内能不能轻松回一句（如“真的假的”“哈哈”或一句话）？如果只能回“哦/嗯”或要组织很长一段字，就换个角度重写；② 如果对方这会儿想安静，这句会不会让人觉得必须应付？';

export const CLOSING_EXPLICIT_HINT =
  '【收尾提示】对方刚发了要去忙或准备结束的消息。简短自然地应一句收尾（不超过 15 字，如“好呀，你先忙”），严禁抛新问题、严禁追问或展开新话题。不要输出“不发送”之类的占位字样。';

export const CLOSING_SOFT_HINT =
  '【收尾提示】对方最近几条回复明显变短或变慢，可能想先结束这轮对话。顺势简短收尾（一句轻回应即可），不带问句、不追问、不硬把没说完的内容补完。不要输出“不发送”之类的占位字样。';

export function isExplicitClose(text) {
  const raw = norm(text);
  if (!raw || raw.length > 24 || hasQuestion(raw) || THIRD_PERSON_RE.test(raw)) return false;
  return EXPLICIT_CLOSE_RE.test(raw);
}

export function isMinimalReply(text) {
  const raw = norm(text);
  if (!raw || hasQuestion(raw)) return false;
  if (PLACEHOLDER_ONLY_RE.test(raw)) return true;
  const clean = raw.replace(/\[[^\]]{1,12}\]/gu, '').replace(/[\p{P}\p{S}\s]+/gu, '');
  if (!clean) return true;
  return clean.length <= 4 && MINIMAL_WORDS_RE.test(clean);
}

function normalizeTurns(turns = []) {
  return (Array.isArray(turns) ? turns : []).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    if (item.incoming || item.outgoing) {
      const out = [];
      if (item.incoming?.text) out.push({ who: 'her', text: String(item.incoming.text), ts: Number(item.incoming.ts) || 0 });
      if (item.outgoing?.text) out.push({ who: 'me', text: String(item.outgoing.text), ts: Number(item.outgoing.lastAt || item.outgoing.firstAt) || 0 });
      return out;
    }
    const who = item.who || item.from;
    if ((who !== 'her' && who !== 'me') || typeof item.text !== 'string' || !item.text.trim()) return [];
    return [{ who, text: item.text, ts: Number(item.ts) || 0 }];
  });
}

/**
 * 纯代码识别用户是否正在收尾或离开。
 * 返回 { windingDown, explicit, reasons, lastUserTs, hint }。
 */
export function detectWindDownSignals(turns = []) {
  const list = normalizeTurns(turns);
  const her = list.filter((m) => m.who === 'her');
  const lastHer = her.at(-1);
  if (!lastHer) return { windingDown: false, explicit: false, reasons: [], lastUserTs: 0, hint: '' };

  const reasons = [];
  const explicit = isExplicitClose(lastHer.text);
  if (explicit) reasons.push('explicit_close');
  const busySpeech = !explicit && detectBusySpeech(lastHer.text);
  if (busySpeech) reasons.push('busy_speech');

  const lastMin = isMinimalReply(lastHer.text);
  const lastLen = contentLen(lastHer.text);

  // 1) 连续 2 条敷衍/极短回应
  const prevHer = her.at(-2);
  const prev2Her = her.at(-3);
  if (lastMin && prevHer && isMinimalReply(prevHer.text)) {
    reasons.push('short_fade');
  } else if (
    // 2) 最近 3 条明显递减：长句 -> 变短 -> 极短无问号
    prev2Her && prevHer && !hasQuestion(lastHer.text) &&
    contentLen(prev2Her.text) >= 10 &&
    contentLen(prevHer.text) < contentLen(prev2Her.text) &&
    lastLen <= 4 && lastLen <= contentLen(prevHer.text) &&
    (lastMin || lastLen <= 2)
  ) {
    reasons.push('short_fade');
  } else if (lastMin && lastLen <= 4) {
    // 3) 角色上一条刚问了问题，但用户只回极短敷衍词（没接问题）
    const lastIdx = list.lastIndexOf(lastHer);
    const prevMe = list.slice(0, lastIdx).reverse().find((m) => m.who === 'me');
    if (prevMe && hasQuestion(prevMe.text)) reasons.push('unanswered_question');
  }

  // 4) 节奏明显变慢：前一次 <= 2 分钟，这次 >= 10 分钟，且最后一条短且无问号
  if (
    prev2Her && prevHer && !hasQuestion(lastHer.text) && lastLen <= 6 &&
    prev2Her.ts > 0 && prevHer.ts > prev2Her.ts && lastHer.ts > prevHer.ts
  ) {
    const prevGap = prevHer.ts - prev2Her.ts;
    const lastGap = lastHer.ts - prevHer.ts;
    if (prevGap <= 2 * MIN && lastGap >= 10 * MIN) reasons.push('slowing_down');
  }

  const windingDown = reasons.length > 0;
  const hint = (explicit || busySpeech) ? CLOSING_EXPLICIT_HINT : windingDown ? CLOSING_SOFT_HINT : '';
  return { windingDown, explicit: explicit || busySpeech, busySpeech, reasons, lastUserTs: lastHer.ts || 0, lastUserText: lastHer.text, hint };
}

/** 检测到收尾信号后，主动开口进入可配冷却期（只拦主动，不拦用户重新开口后的回复）。 */
export function closingCooldownActive(turns, cfg, now = Date.now()) {
  const min = finiteInt(cfg?.rules?.closingCooldownMin, 120, 0, 720);
  const signals = detectWindDownSignals(turns);
  if (min <= 0 || !signals.windingDown || !signals.lastUserTs || now < signals.lastUserTs) {
    return { active: false, remainMin: 0, signals };
  }
  const elapsed = now - signals.lastUserTs;
  const explicitUntil = signals.busySpeech
    ? extractBusyUntilMs(signals.lastUserText, signals.lastUserTs, cfg?.timezone || 'Asia/Shanghai')
    : 0;
  const limitMs = explicitUntil > signals.lastUserTs ? (explicitUntil - signals.lastUserTs) : min * MIN;
  if (elapsed >= limitMs) return { active: false, remainMin: 0, signals };
  return { active: true, remainMin: Math.max(1, Math.ceil((limitMs - elapsed) / MIN)), signals };
}

/**
 * 热聊自然补话的代码层热度闸：
 * 仅在用户近期回复有实质内容、未出现收尾或敷衍趋势时放行。
 */
export function isHotChat(turns = [], cfg = {}) {
  const list = normalizeTurns(turns);
  const her = list.filter((m) => m.who === 'her');
  if (!her.length) return false;
  if (detectWindDownSignals(list).windingDown) return false;
  const minChars = finiteInt(cfg?.rules?.qqTiming?.hotMinChars, 6, 0, 40);
  const latest = her.at(-1);
  if (isMinimalReply(latest.text)) return false;
  if (minChars <= 0) return true;
  const latestLen = contentLen(latest.text);
  if (her.length < 2) return latestLen >= minChars;
  const prev = her.at(-2);
  const avgLen = (latestLen + contentLen(prev.text)) / 2;
  return latestLen >= minChars && avgLen >= minChars;
}

// ------------------------------------------------------------ 探索开场接话点轮换

export const SHARE_HOOKS = [
  {
    style: 'self_reveal',
    label: '随口感想',
    guide: '用「随口感想」角度：用第一人称自然说一句刚看到的细节或自己的反应即可，不必刻意加问句。',
  },
  {
    style: 'take_side',
    label: '直说偏好',
    guide: '用「直说偏好」角度：直接表态自己偏向哪种做法或看点，自然收住，不要写“你站哪派”“你是…派还是…派”。',
  },
  {
    style: 'ask_expert',
    label: '顺口求证',
    guide: '用「顺口求证」角度：真有拿不准的生活/专业小细节再顺口问一句，不要为了凑互动硬编问题。',
  },
  {
    style: 'user_life',
    label: '日常联想',
    guide: '用「日常联想」角度：只围绕你刚看到的东西本身说感受或反差，不要硬拐到问“你那个掉了没/堵了没”。',
  },
  {
    style: 'mini_proposal',
    label: '随口一提',
    guide: '用「随口一提」角度：简短记一个想试试或刚发现的点子，像跟熟人随手甩一句话。',
  },
  {
    style: 'guess',
    label: '抛反差',
    limited: true,
    guide: '用「抛反差」角度：说出最意外或反直觉的那一点就行，禁止用“你猜…随便猜一个”这类出题腔。',
  },
  {
    style: 'tease',
    label: '点睛一句',
    limited: true,
    guide: '用「点睛一句」角度：挑最荒诞、最好笑或最有味道的半句吐槽出来，不要卖关子让人追问。',
  },
];

export const LIGHT_NOTE_HOOK = {
  style: 'light_note',
  label: '轻分享',
  guide: '现在偏晚或临近休息：写成轻松的陈述句分享，不要带问句，让对方看了会心一笑、不回也不尴尬。',
};

/**
 * 按近期历史轮换推荐一个开场接话点。
 * 偏晚/临睡直接用无压力轻分享；平时避开最近 2 次用过的类型，且「抛反差/点睛一句」7 天内各最多 1 次。
 */
export function pickShareHook(history = [], { now = Date.now(), night = false } = {}) {
  if (night) {
    return { ...LIGHT_NOTE_HOOK, prompt: `${LIGHT_NOTE_HOOK.guide} ${OPENING_SELF_CHECK}` };
  }
  const rows = (Array.isArray(history) ? history : []).filter((x) => x && typeof x.style === 'string');
  const recentStyles = new Set(rows.slice(-2).map((x) => x.style));
  const weekCutoff = now - 7 * DAY;
  const recentLimited = new Set(
    rows.filter((x) => (Number(x.at) || 0) >= weekCutoff).slice(-6).map((x) => x.style),
  );
  let pool = SHARE_HOOKS.filter((h) => !recentStyles.has(h.style) && (!h.limited || !recentLimited.has(h.style)));
  if (!pool.length) pool = SHARE_HOOKS.filter((h) => !h.limited);
  // 优先选最久未用过的角度，避免死板循环或重复
  const lastUsed = new Map();
  rows.forEach((row, idx) => lastUsed.set(row.style, idx));
  pool.sort((a, b) => (lastUsed.get(a.style) ?? -1) - (lastUsed.get(b.style) ?? -1));
  const picked = pool[0];
  return {
    ...picked,
    prompt: `本轮 share ${picked.guide} 用正常熟人聊天口吻直接说完，禁止套用“你站哪派”“你是…派还是…派”“你猜…随便猜一个”“你那边是不是也这样”“你那个掉了没/堵了没”等机器话术。${OPENING_SELF_CHECK}`,
  };
}

export function recordShareHook(history = [], style, now = Date.now()) {
  if (!style) return Array.isArray(history) ? history.slice(-12) : [];
  const rows = Array.isArray(history) ? history.filter((x) => x && typeof x.style === 'string') : [];
  return [...rows, { style, at: now }].slice(-12);
}
