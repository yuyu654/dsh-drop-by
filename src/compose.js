// compose.js —— 「发什么」：把由头 + 事实 + 人格拼成一句话，并过一遍红线检查。
//
// 三种模式：
//   auto      默认：环境里有 dsh CLI 就用 llm，没有就退 template，不会因为缺环境而什么都不发
//   template  零成本、确定性。只能覆盖数据类由头（睡眠/屏幕/久未联系），
//             需要「听懂她说了什么」的回复类由头，模板做不出来就老实返回 null。
//   llm       强制走宿主 dsh CLI，带着全局人格生成；环境不全时回落 template。
//
// guard() 是最后一道闸：过了 guard 才算「可以发」。它同时是人格红线的落地
// （不承认 AI、不写括号动作、不列清单、不泄露内部路径）。
import { generate, llmAvailable } from './llm.js';
import { SLOTS } from './topics.js';
import { signalFacts } from './signals.js';
import { memoryFacts } from './memorysource.js';
import { explorationToneHint } from './explore.js';
import { ATTRIBUTION_RULE, falseAttribution } from './attribution.js';
import { recentOutbound } from './outbound.js';
import { slotStats } from './feedback.js';
import { localStyle } from './local.js';
import { dayKey, hhmm, coarseMin } from './time.js';
export { coarseMin } from './time.js';

/** 「昨天 21:40」「11-03 09:12」——给她自己看的最近几条，时间不用精确到秒。 */
function sentWhen(ts, now, tz) {
  const day = dayKey(ts, tz);
  const hm = hhmm(ts, tz);
  if (day === dayKey(now, tz)) return hm;
  if (day === dayKey(now - 86_400_000, tz)) return `昨天 ${hm}`;
  return `${day.slice(5)} ${hm}`;
}

/** 只保留「要发出去的那一句」。模型偶尔会带前缀、引号、代码块。 */
export function clean(text) {
  let s = String(text || '').trim();
  if (!s) return '';

  s = s.replace(/^```[a-z]*\n?/i, '').replace(/```$/g, '').trim();
  // 常见的自说自话前缀
  s = s.replace(/^(要发的句子|要发的话|回复|一句话|结果|输出)\s*[：:]\s*/i, '');
  // 整段被引号包住
  const quoted = /^[「“"']([\s\S]*)[」”"']$/.exec(s);
  if (quoted) s = quoted[1].trim();

  // 多行：取第一个非空段落（人格本来是短句，多出来的基本都是分析）
  const blocks = s.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (blocks.length > 1) s = blocks[0];
  s = s.replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return s;
}

const BANNED = [
  { code: 'PAREN_ACTION', re: /[（(][^）)]{2,30}[）)]/, why: '写了括号动作说明' },
  { code: 'SELF_AI', re: /(我是|作为)(一个)?\s*(AI|人工智能|助手|机器人|语言模型|程序)/i, why: '承认自己是 AI/助手' },
  { code: 'SERVICE_TONE', re: /您好|很高兴为您|希望(能|可以)帮到您|感谢您的反馈|请问有什么/, why: '客服腔' },
  { code: 'META_TALK', re: /(人格|人设|设定|按你的要求|根据.{0,6}资料|我(已经)?分析|思考过程)/, why: '把生成过程说出来了' },
  { code: 'LISTY', re: /(^|\s)(?:[-*·]|\d+[.)、])\s+/, why: '写成清单了' },
  { code: 'HEADING', re: /^#{1,6}\s/, why: '写成标题了' },
  { code: 'LEAK', re: /[A-Za-z]:\\|\.json\b|\.md\b|presence-gate|dsh-|AGENT\.md|self\.md|【dsh-drop-by|【来源归属|<qq_reply_context>|Current runtime context|MNEMON RUNTIME/, why: '泄露内部路径/文件名/上下文标记' },
  { code: 'GREETING', re: /^(亲爱的|宝贝|老婆|主人)/, why: '称呼越界' },
  // 「虚拟不虚拟的另说。你先告诉我…」——把她说的事一句推开，再换自己的题，等于没接住。
  { code: 'BRUSH_OFF', re: /(另说|先不说这个|不说这个|扯远了|回头再说|这个先放放|说点别的)/, why: '把她说的事一句推开了：要接就接，不接就别提' },
];

// 「空」类违规：形式上都合规、但读起来像朋友圈金句而不是一条消息。
// 实测同一个人格连跑三次，三次全中前三项——所以这几条不是理论洁癖。
const VAGUE = [
  { code: 'APHORISM_OPEN', re: /^(?:我(?:最近|一直|刚才|今天)?在想|最近在想|说到底|其实人|有时候人|人这一?生|人生就是)/, why: '感悟/格言式开头' },
  { code: 'GENERIC_SUBJ', re: /^(?:人|大家|我们|很多人|大多数人|有些人|一个人|成年人)(?:不是|都|总|其实|往往|就是|活着)/, why: '拿泛指的「人」当主语' },
  { code: 'ESSAY', re: /往往|本质上|这世界|所谓|某种程度上|无一例外|其实我们都/, why: '议论文腔' },
  { code: 'CHEER_END', re: /(加油|别放弃|你可以的|慢慢来|相信自己|做自己|接受自己)[。！!～~]?$/, why: '结尾在劝人' },
];

/**
 * 红线检查。返回 { ok, violations:[{code,why}], text }
 * 不自动改写：违规就换一条路（重写一次 / 模板），不要把一个奇怪的样子又修回奇怪。
 */
export function guard(text, cfg, ctx = null, opts = {}) {
  const maxChars = Math.max(10, Number(opts.maxChars ?? cfg?.content?.maxChars) || 60);
  const t = String(text || '').trim();
  const violations = [];
  if (falseAttribution(t, ctx)) violations.push({
    code: 'FALSE_ATTRIBUTION', why: '把未见于用户原话的细节归给了用户。按出处重写，自己的推演用第一人称。',
  });

  // 随口说话专用：裸的「在吗」是兜底，不是默认（没有别的信息时它最像敷衍）。
  if (opts.bare === true && !opts.allowBare && /^(在吗|在么|在不在|睡了吗|睡着了没|人呢)[？?。！!~～\s]*$/.test(t)) {
    violations.push({ code: 'CHITCHAT_BARE', why: '只有一句「在吗」：换成一个具体的东西，别拿空招呼当默认' });
  }

  if (!t) violations.push({ code: 'EMPTY', why: '空内容' });
  // 空行 = 要拆成几条连着发：那就每条各自守 maxChars，整轮最多四段。
  // 没有空行还是按整条算——不然「空一行就能写小作文」了。
  const parts = t.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    const tooLong = parts.find((part) => part.length > maxChars);
    if (tooLong) violations.push({ code: 'TOO_LONG', why: `有一段超过 ${maxChars} 字（${tooLong.length}）：${tooLong.slice(0, 16)}…` });
    if (parts.length > 4) violations.push({ code: 'TOO_MANY_PARTS', why: `分了 ${parts.length} 段，一轮最多四段` });
  } else if (t.length > maxChars) {
    violations.push({ code: 'TOO_LONG', why: `超过 ${maxChars} 字（${t.length}）` });
  }

  // 探索里的心情原话不许整段抄出来（2026-11-15：把「术语对上了，卡在这儿不上不下」
  // 缝进一句发给了她）。比的是去掉标点后的 4 字以上连续片段——换个说法就过，
  // 照抄就拦；只拿 raw，不拿脱敏后的短情绪。
  const rawMood = String(ctx?.explorationMood?.raw || '').trim();
  if (rawMood && t) {
    const flat = t.replace(/[\s\p{P}]+/gu, '');
    const flatMood = rawMood.replace(/[\s\p{P}]+/gu, '');
    for (let i = 0; i + 4 <= flatMood.length; i += 1) {
      const frag = flatMood.slice(i, i + 4);
      if (flat.includes(frag)) {
        violations.push({ code: 'MOOD_LEAK', why: `抄了探索里的心情原话（${frag}）：换成自己的说法，别念状态` });
        break;
      }
    }
  }
  // 2026-11-10 的坑：模型重写时只吐了两个字「那条」。但**不能拿长度卡**——
  // 用户当天就说过「主动开口不必多于六字，比如在吗、在干嘛」：短句本身不废。
  // 所以阈值仍按「只剩一个字」算；「那条」由下面的 ECHO_TOPIC 精确拦（它是由头标签的一半）。
  // opts.minChars 留着给「这条由头必须写满」的场景用，默认 2。
  const minChars = Math.max(2, Number(opts.minChars) || 2);
  if (t.length > 0 && t.length < minChars) {
    violations.push({
      code: 'TOO_SHORT',
      why:
        minChars > 2
          ? `只有 ${t.length} 个字（「${t}」）：这条由头至少要说满 ${minChars} 个字`
          : '只有一两个字',
    });
  }
  // 把由头标签抄回来当回复（由头叫「那条还没回」，回一个「那条」）：等于什么都没说。
  const label = String(opts.topicLabel || '').replace(/[「」\s]/g, '');
  const bare = t.replace(/[。！？!?…~～，,、\s]/g, '');
  if (label && bare && bare.length <= 4 && label.includes(bare)) {
    violations.push({ code: 'ECHO_TOPIC', why: `把由头标签「${label}」的一半抄回来当回复了：得说清这条由头本身的事` });
  }

  // 报表式时长：「5 小时 4 分钟」「五小时四分」——人不会这么说，说「五个多小时」。
  if (
    /\d+\s*个?\s*(?:小时|钟头)\s*\d+\s*(?:分钟|分)/.test(t) ||
    /[一二三四五六七八九十]+\s*个?\s*(?:小时|钟头)\s*[一二三四五六七八九十零]+\s*分/.test(t)
  ) {
    violations.push({ code: 'TOO_PRECISE_TIME', why: '报了分钟级的时长（「5 小时 4 分钟」这种）；说「五个多小时」「快六个小时」' });
  }

  for (const b of BANNED) {
    if (b.re.test(t)) violations.push({ code: b.code, why: b.why });
  }
  // 本机私有红线（local-style.json）：插件自己不带任何人的口头禅/雷词。
  for (const b of localStyle(cfg).taboos) {
    if (b.re.test(t)) violations.push({ code: b.code, why: b.why });
  }
  for (const b of VAGUE) {
    if (b.re.test(t)) violations.push({ code: b.code, why: b.why });
  }
  // 「不是 A，是 B」的对偶说理：带着「你」还能算在跟她说话，没有「你」就是自我抒情
  if (!/你/.test(t) && /(不是|并非|不在于)[^，。！？]{1,26}[，,]\s*(?:而?是)/.test(t)) {
    violations.push({ code: 'ANTITHESIS', why: '对偶说理，而且全句没有「你」' });
  }
  if (
    opts.shareTechnical &&
    /(?:d[a-zA-Z]\s*\/\s*d[a-zA-Z]|[a-zA-Z][a-zA-Z0-9_]*\s*=\s*[^，。！？\s]*[/*^+\-()]|\)\s*\^|[A-Za-z]\s*\/\s*[A-Za-z][a-z]|[αβγδθλμπσφψωΣΔ])/.test(t)
  ) {
    violations.push({
      code: 'SHARE_TOO_TECHNICAL',
      why: '带了公式、字母符号或偏专业的表达式；改用外行朋友一听就懂的大白话讲那件具体的事',
    });
  }
  if (
    opts.shareNeedHook &&
    !/[？?]/.test(t) &&
    !/(?:你觉得|你怎么看|你想|你那|你有|你会|你用过|你遇|试过|聊聊|说说|猜猜|好奇|算不算|像不像|是不是|对不对|行不行|怎么样|咋样|咋看|怎么说)/.test(t)
  ) {
    violations.push({
      code: 'SHARE_NO_HOOK',
      why: '只顾着自己下结论，没留给她接话的口子；加上一句问她看法、经历或顺手把话题抛给她',
    });
  }

  // 照抄我自己上一句（连续 8 个字一模一样）：看着像接话，其实是把旧句子搬过来再拼一半。
  // 主动由头里出现这种句子，逻辑一定断——上一句说的是别的事，这一句有自己的由头。
  if (ctx?.me?.lastText) {
    const src = String(ctx.me.lastText);
    for (let i = 0; i + 8 <= src.length; i++) {
      if (t.includes(src.slice(i, i + 8))) {
        violations.push({ code: 'ECHO_SELF', why: '照搬了我上一句里的话' });
        break;
      }
    }
  }

  return { ok: violations.length === 0, violations, text: t };
}

/** 把违规转成一句能回喂给模型的话。 */
export function describeViolations(vs = []) {
  return vs.map((v) => v.why).join('；');
}

// ---------------------------------------------------------------- 模板

const fmtMin = (m) => {
  const n = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(n / 60);
  const mm = n % 60;
  if (!h) return `${mm} 分钟`;
  return mm ? `${h} 小时 ${mm} 分钟` : `${h} 小时`;
};

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v <= 10) return CN_NUM[v];
  if (v < 20) return `十${CN_NUM[v - 10]}`;
  const tens = Math.floor(v / 10);
  const rest = v % 10;
  return `${CN_NUM[tens]}十${rest ? CN_NUM[rest] : ''}`;
}

/**
 * 不用模型也能说出口的句子：只覆盖「事实驱动」的由头。
 * 措辞故意中性，不去模仿哪个人格——人格是 llm 模式的事，模板硬装会串味。
 */
export function renderTemplate(topic, ctx) {
  if (!topic) return null;
  const e = topic.evidence || {};

  switch (topic.slot) {
    case 'sleep': {
      const d = coarseMin(e.sleepMin);
      const deep = e.deepMin != null ? coarseMin(e.deepMin) : '';
      switch (e.kind) {
        case 'long_sleep':
          return `昨晚睡了${d}。昨天是不是累到了。`;
        case 'late_night':
          return `又是 ${e.bedHm} 才睡。今天别硬撑。`;
        default:
          // poor_sleep：她睡得不算晚，只是没睡够/没睡沉——不能说成熬夜
          return `睡了${d}${deep ? `，深睡才${deep}` : ''}。今天别跟自己较劲。`;
      }
    }
    case 'screen':
      return `今天屏幕${coarseMin(e.screenMin)}。眼睛不疼？`;
    case 'steps':
      return e.kind === 'low'
        ? `今天才 ${e.steps} 步。一整天没动，起来走两步。`
        : `今天 ${e.steps} 步，走得不少。晚上别硬撑。`;
    case 'stress':
      // 第二次不许再「关心」一遍，那是复读
      return Number(e.nth) >= 2 ? `压力还没降。别硬撑了，收工。` : `今天压力 ${e.stress}。什么事压着你，说。`;
    case 'catchup':
      return `好几天没动静了，忙完没。`;
    case 'lateUp':
      return `都 ${e.at || '这个时候'} 了。还不睡？`;
    case 'longSit':
      return `从 ${e.since} 坐到现在了。起来走两步。`;
    case 'backHome':
      return `刚回来？水喝了没。`;
    case 'agenda':
      // 早课：重点是「今晚得早睡」，不是复述课表；快上课：只提醒时间，别念课程意义
      return e.kind === 'early'
        ? `${e.when || '明天'}早上 ${e.at} 有课。今晚早点睡。`
        : `${e.at} 有课，还有 ${e.leftMin} 分钟。`;
    case 'examSoon':
      return `还有 ${e.leftMin} 分钟开考。东西带齐，别慌。`;
    case 'examReview':
      return e.days <= 1 ? `明天就考${e.subject ? `「${e.subject}」` : ''}了。今晚早点收。` : `${e.days} 天后考${e.subject ? `「${e.subject}」` : ''}。今晚先翻一章？`;
    case 'noReply': {
      // 追问：只问一句，不查岗、不数落。
      // 2026-11-07 修（她：QQ 收到「刚给你发的那个，看了没」，可那条是 19 小时前发在抖音的）：
      //   模板必须说清「哪个通道、多久以前」。写成「刚」会让她去找一个根本不在本通道的内容。
      //   模板看不出真实间隔，就**不写时间词**：说「刚」而实际隔了 19 小时，她会去找一个不存在的东西。
      //   只写「在哪个通道发过」，她自己知道去看。
      if (e.channel === 'douyin') {
        // 带上标题：只写「那个」，她要在私信里翻半天（2026-11-07：她说不知道是哪条）。
        const t = String(e.title || '').replace(/\s+/g, ' ').trim();
        const name = t ? `《${t.slice(0, 18)}${t.length > 18 ? '…' : ''}》` : '';
        return `在抖音给你发的${name ? name : '那个'}，看了没。`;
      }
      return '那条你还没回我。……在忙，还是睡了。';
    }
    default:
      // reply / forward / share 需要真的听懂对方在说什么，模板不硬编
      return null;
  }
}

// ---------------------------------------------------------------- prompt

/**
 * 语气样本：优先用她自己真发过的话（ctx.recent 里 from=me 的），
 * 没有历史就用 AGENT.md 里的对照句。样本只教「具体到什么程度、多短」，不教内容。
 */
export function styleSamples(ctx, limit = 2, cfg = null) {
  const mine = (ctx?.recent || [])
    .filter((m) => m.from === 'me')
    .map((m) => String(m.text || '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12 && s.length <= 70)
    // 越像「对着她说」越优先：带「你」的 > 短的 > 新的。
    // 不加这层排序，样本会全是视频简介那种旁白腔，反而把模型带偏。
    .map((text, i) => ({ text, i, score: (/你/.test(text) ? 2 : 0) + (text.length <= 50 ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || b.i - a.i)
    .slice(0, limit)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.text);
  if (mine.length) return mine;
  const local = localStyle(cfg).samples;
  if (local.length) return local.slice(0, limit);
  return ['跑完了。第三行那个报错是路径写错，改了。', '别瞎猜。我又没换人。'];
}

/**
 * 睡眠这一类要按判定结果换说法：说错方向比不说更糟（把「没睡沉」说成「熬夜」就是冤枉人）。
 * 五种 kind 分别给一句针对性要求，公共那条始终在最前面。
 */
function sleepRules(kind, ev) {
  const common = '- 这一条必须落在「昨晚这一觉」上，不许换成别的由头——别提电脑、工作、吃没吃饭。';
  const byKind = {
    long_sleep: [
      '- 她睡得比平时久很多：问一句昨天是不是累到了 / 是不是不舒服。',
      '- 不许用「真能睡」「睡这么久」这种刺，也不许顺势讲作息道理。',
    ],
    late_night: [
      '- 判定是熬夜（入睡时间很晚）：可以点出她几点才睡，但只提一次，别念睡眠时长和深睡分钟数。',
      '- 嫌弃一句可以，也可以不嫌弃：想关心就直接说，硬一句就停也行。别为了给台阶多写一句她不需要的话。',
    ],
    poor_sleep: [
      '- 她睡得不算晚，是没睡好：**不许**说「又熬夜」「几点才睡」这种话，那会冤枉她。',
      '- 不许给建议（早点睡、早点躺、别看手机）；说一句事实，或者直接使唤她。',
    ],
  }[kind] || [];
  // 深睡是拓展项，很多运动健康应用根本不报这个数：没读到就只说时长，不许提「深睡」也不许编
  const noDeep = ev && ev.deepKnown === false
    ? ['- 这封健康数据里没有深睡：只说睡了多久，一个字都不许提「深睡」，更不许自己编一个数出来。']
    : [];
  return [common, ...byKind, ...noDeep];
}

/**
 * 时间只说人嘴里会说的那个粒度（2026-11-07 她两次纠正）：
 *   · 几分钟、五十几分钟，一律「刚刚」——「几分钟前」也太像在掐表；
 *   · 精确到分钟/小时的数只在真要问她的时候才配出现，平常写出来像盯梢。
 */
export function coarseAgo(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m < 60) return '刚刚';
  if (m < 240) return '有一阵子了';
  if (m < 900) return '今天早些时候';
  if (m < 2160) return '昨天';
  if (m < 10080) return '前几天';
  return '有一段时间了';
}

/** 电脑空闲：同上，说「有一会儿」而不是「空闲 37 分钟」 */
function coarseSpan(min) {
  const m = Math.max(0, Number(min) || 0);
  if (m < 15) return '有一会儿了';
  if (m < 60) return '有一阵子了';
  if (m < 240) return '好几个小时了';
  return '大半天了';
}

export function buildPrompt({ ctx, topic, persona, cfg, feedback, st = {} }) {
  const localNotes = localStyle(cfg).notes;
  const p = ctx.presence || {};
  const her = ctx.her || {};
  const me = ctx.me || {};
  const f = ctx.fish || {};

  const facts = [];
  const herCh = her.lastChannel === 'douyin' ? '，抖音' : her.lastChannel === 'qq' ? '，QQ' : '';
  // 她最后那条已经在她自己的通道里被我回过了（抖音那边值班鱼回过的）——那就一个字都别再提。
  // 2026-11-09 20:43：抖音上刚答过「注意力就是各查各的」，presence-gate 又把同一句答到 QQ，
  // 她收到两遍。她那条不再当素材，也不许拎出来再答一次。
  const herAnsweredElsewhere = Boolean(her.lastText) && her.lastChannel && her.lastChannel !== 'qq'
    && her.answeredOnOwnChannel === true;
  if (her.lastText && !herAnsweredElsewhere) facts.push(`她最后一条：「${her.lastText.slice(0, 200)}」（${coarseAgo((her.lastAgoSec || 0) / 60)}${herCh}）`);
  // 她的话在别的通道说的、这条又不是要回她那句时，只当背景。
  // 实测 20:30 那条 longSit 被模型拿来接她中午的抖音那句，还先「另说」推开再换话题——两头都没落着。
  // noReply 也一样：这条问的是「我发的那条她回没回」，不是要接她最后那句。
  const herElsewhere = Boolean(her.lastText) && her.lastChannel && her.lastChannel !== 'qq'
    && topic?.slot !== 'reply';
  // 「我最后一条」只在真的要接话时给（回复 / 追问）。
  // 主动由头里也给的话，模型会把它当素材续写——实测拼出过
  // 「对着 claude 说不放手，那手伸过来」这种半截话：那是把上一句和我这次要说的事硬缝在一起。
  if (me.lastText && (topic.slot === 'reply' || topic.slot === 'noReply')) {
    facts.push(`我最后一条：「${me.lastText.slice(0, 120)}」`);
  }
  if (f.ok) {
    if (f.sleepMin != null) facts.push(`昨夜睡眠：${fmtMin(f.sleepMin)}`);
    if (f.bedHm) facts.push(`邮件里的入睡时间：${f.bedHm}`);
    if (f.sleepFrom === 'total' && f.sleepMin != null) facts.push('这封只带了总睡眠（含白天小睡），没有单独的夜间睡眠');
    if (f.deepMin != null) facts.push(`深睡：${fmtMin(f.deepMin)}`);
    if (f.screenMin != null) facts.push(`今日屏幕：${fmtMin(f.screenMin)}`);
    if (f.steps != null) facts.push(`今日步数：${f.steps}`);
    if (f.stress != null) facts.push(`鱼鱼读到的压力值：${f.stress}（0–100，越高越紧）`);
  }
  if (topic.evidence?.silentDays) facts.push(`距她上次说话：${topic.evidence.silentDays} 天`);
  if (topic.slot === 'agenda') {
    const a = topic.evidence || {};
    if (a.kind === 'early') facts.push(`课表：${a.when || '明天'}早上 ${a.at}${a.name ? ` 有「${a.name}」` : ' 有课'}${a.room ? `（${a.room}）` : ''}`);
    if (a.kind === 'soon') facts.push(`课表：${a.at}${a.name ? ` 有「${a.name}」` : ' 有课'}${a.room ? `（${a.room}）` : ''}，离现在还有 ${a.leftMin} 分钟`);
  }
  if (topic.slot === 'examSoon' || topic.slot === 'examReview') {
    const x = topic.evidence || {};
    const when = x.date ? `${x.date} ${x.hm}` : x.hm || '';
    const left = x.leftMin != null ? `还有 ${x.leftMin} 分钟` : x.days != null ? `还有 ${x.days} 天` : '';
    facts.push(`考试：${x.subject || '一场'}，${when}${x.room ? `，${x.room}` : ''}${left ? `（${left}）` : ''}`);
  }
  if (topic.slot === 'noReply') {
    const x = topic.evidence || {};
    const isCard = x.channel === 'douyin' && (x.kind === 'card' || x.title);
    const what = isCard
      ? `我给她分享了一个视频${x.title ? `《${String(x.title).slice(0, 60)}》` : ''}`
      : `我给她发了一条：「${String(x.text || '').slice(0, 120)}」`;
    facts.push(`${what}（${coarseAgo(x.silenceMin)}），她一直没回`);
    // 分享卡片有时只有 id 没有标题：这时候不许拿「那条视频」指代——她不知道是哪条。
    if (isCard && !x.title) facts.push('这条分享的标题我没记住：别提「那条视频」，只说事，或者只问一句她刚才在忙什么。');
    if (x.verdict?.away) {
      facts.push(
        `从对话看，她多半是去忙了/睡了${x.verdict.untilHm ? `（大概忙到 ${x.verdict.untilHm}）` : ''}，不是故意不理`
      );
    } else {
      facts.push('从对话看，她不像在忙，只是没回');
    }
  }
  // 转发内容的摘要（第二步真看过之后才有）。没摘要就不给，让规则去管「不许编」。
  if (topic.evidence?.contentSummary) {
    const fromSpeech = String(topic.evidence?.contentSource || '').startsWith('asr');
    facts.push(
      `她转来那条的内容${fromSpeech ? '（口播转写，只有台词没有画面）' : '（我自己看的）'}：` +
        String(topic.evidence.contentSummary).slice(0, 400),
    );
  }
  // 「人在不在」只看键鼠最后一次输入，不看前台是哪个窗口——前台开着 WorkBuddy/编辑器，
  // 人可能已经拿着手机走了（2026-11-08 她提的）。阈值就是 idle.awaySec，设置页里自己改，
  // 不另设隐藏下限（她说下限也要能自己调）。
  const awaySec = Number(cfg?.idle?.awaySec) || 600;
  const idleNow = typeof p.idleSec === 'number' && p.idleSec >= 0 ? p.idleSec : null;
  const awayNow = idleNow != null && idleNow > awaySec;
  if (awayNow) facts.push(`她离开电脑${coarseSpan(idleNow / 60)}（人不在电脑前）`);

  // L2：她这会儿在电脑前干什么。只给「在干什么」，不给「我怎么知道」——怎么知道是她的事。
  // 人不在时整条不给：窗口开着不等于在写代码，说了就成了盯着窗口看的查岗。
  // 2026-11-08：**不给窗口/软件名**。给了它，模型就会写成「回来就写代码，WorkBuddy 那个？」——
  // 正常人看不到屏幕只会问「回来就在忙？」，能看到进程就只会说「回来就写代码」；
  // 把软件名说出来再问一句，等于承认自己在盯着她的屏。
  const act = awayNow ? null : (ctx.activity || null);
  if (act) {
    const where = {
      game: '在打游戏',
      coding: '在写代码',
      media: '在看视频/放东西',
      'game-open': '没在玩，但游戏还开着',
      'ide-open': '没在写，但编辑器还开着',
    }[act.kind];
    if (where) facts.push(`她电脑前：${where}`);
    if (act.speaking) facts.push('电脑正在放声音（耳机或外放开着）');
  }
  // 结构化信号：窗口标题 / 浏览器当前页面 / 编辑器里的文件。比 OCR 准，有它就不用看屏幕。
  const sigFacts = signalFacts(ctx.signals);
  for (const x of sigFacts) facts.push(x);
  // L3：屏幕上认出来的字。结构化信号已经能说清「在干什么」时就不塞 OCR，免得两套事实打架。
  const sc = ctx.screen;
  if (!sigFacts.length && sc?.ok && Array.isArray(sc.hints) && sc.hints.length) {
    facts.push(`屏幕上认出来的字（OCR 可能认错，只当线索）：${sc.hints.join(' / ')}`);
  }
  // 别的记忆插件记的事（鱼的记忆）：只当「我本来就知道的事」，不是这一拍的新消息。
  for (const x of memoryFacts(ctx.memory)) facts.push(x);
  if (ctx.projectMemory?.answer) facts.push(`用户之前亲口说的项目背景：「${ctx.projectMemory.answer}」。只是背景，不表示现在需要排查或有新进展。`);
  const tone = explorationToneHint(ctx);
  if (tone) facts.push(tone);

  const maxChars = Math.max(10, Number(cfg?.content?.maxChars) || 60);
  const samples = styleSamples(ctx, 2, cfg);
  const recentSends = Array.isArray(ctx?.recentSends) ? ctx.recentSends.slice(-3) : [];

  // 我最近真发出去的那几条（跨 QQ / 抖音）：连着几天同一种开头，比说错话更伤。
  const tz = ctx.tz || cfg?.timezone || 'Asia/Shanghai';
  const nowTs = Number(ctx.now) || Date.now();
  const recentOut = Array.isArray(ctx.recentOutbound) ? ctx.recentOutbound : recentOutbound({ limit: 5, cfg });
  const recentOutBlock = cfg?.content?.prompt?.recentOutbound !== false && recentOut.length
    ? [
        `你最近发出去的 ${recentOut.length} 条：`,
        ...recentOut.map((r) => `· 「${r.text}」（${r.channel === 'qq' ? 'QQ' : '抖音'}，${sentWhen(r.ts, nowTs, tz)}）`),
        '这一条别用同样的句式开头，也别再聊同一类话题。',
      ].join('\n')
    : '';

  // 每类由头的接住率：数字比「感觉她最近不太接」准。
  const stats = st && typeof st === 'object' ? slotStats(st) : {};
  const statRows = Object.entries(stats)
    .filter(([, v]) => v.sent > 0)
    .sort((a, b) => b[1].sent - a[1].sent)
    .slice(0, 8)
    .map(([slot, v]) => `${SLOTS[slot]?.label || slot} ${v.replied}/${v.sent}（${Math.round((v.rate ?? 0) * 100)}%）`);
  const statBlock = cfg?.content?.prompt?.slotStats !== false && cfg?.rules?.feedback?.enabled !== false && statRows.length
    ? `你最近的话题接住情况（她接没接）：${statRows.join('，')}。接不住的话题，换角度说，或者干脆不碰。`
    : '';

  const slotRules = {
    share: [
      topic.evidence?.source
        ? '- 只说这个内容为什么吸引我，措辞严格符合实际读到的依据，不写网址。'
        : '- 这是我自己琢磨出来的一条判断，别说成道理，落到今天具体看见的一件小事上。',
      '- 不许出现「人」「大家」，只能说「你」或者具体的事。',
      '- 不许照搬原句、不许加引号、不许提「我记过」「来源」。',
      ...(topic.evidence?.actionRetry || topic.evidence?.loginSite
        ? []
        : [
            '- 说给外行朋友听：严禁公式、字母代号和冷门专业黑话，一定要翻译成生活里听得懂的大白话。',
            '- 必须留出她能接话的口子（顺口问她看法、问她遇到过没有或把话头抛给她），别只下完自己的结论就结束。',
          ]),
    ],
    reply: ['- 先接住她那句话：她说了什么就应什么，别自顾自换话题。'],
    noReply: [
      '- 这条是追问「我发过去的那条怎么没回」：只问一句，不查岗、不数落、不说「你是不是不想理我」。',
      '- 只问这一件事，别捎带别的话题：你昨晚研究过什么、今天想说什么，都等她把这条回了再说。',
      topic.evidence?.verdict?.away
        ? '- 判断她那会儿在忙或者睡了：问得轻，给她台阶（忙完再说 / 醒了回我），别追责、别问她干了什么。'
        : '- 判断她不像在忙：可以直一点，但一句就够；问完就停，别连着追问，也别自己补理由。',
    ],
    forward: topic.evidence?.hasContent
      ? [
          '- 她转来的东西我看过了，内容摘要见已知事实：先说一句我看完的结论（要具体到哪一点），再接一句对她说的话。',
          topic.evidence?.contentSource?.startsWith('vision')
            ? '- 摘要来自带时间的抽帧和可能有的口播。只接摘要明确看见的细节，不补写镜头之间发生了什么。'
            : '- 摘要来自口播转写，只有「说了什么」，没有画面：不许描述镜头、特效、画面里多了什么。',
          '- 不许把摘要原样念一遍，也不许报幕（「这个视频讲了…」「内容是关于…」）——像跟人聊天那样直接说。',
        ]
      : [
          '- 她转来的东西我没看过，只有标题。不许描述里面有什么、不许编细节、不许装成我知道内容。',
          '- 只顺着标题里她自己也看得出来的那个点接一句；不要反过来让她复述内容——该看的是我。',
          '- 必须让她看出我知道她转的是哪个东西（说「你转的那个」），不许当没看见。',
        ],
    sleep: sleepRules(topic.evidence?.kind, topic.evidence),
    screen: ['- 说一件她今天大概真的在做的事，别只说时长。'],
    steps: topic.evidence?.kind === 'low'
      ? [
          '- 她今天几乎没动。说一句就行：可以问一句是不是一直坐着/窝着，或者直接把「起来走两步」包成自己的事（「陪我去买瓶水」）。',
          '- 不许说教：不许「多运动」「注意健康」「对身体不好」，也不许报步数以外的数（心率、消耗都别提）。',
          '- 一整天没动不是懒，别用「又」、别阴阳。',
        ]
      : [
          '- 今天活动量不错。别夸成健身教练：不许说「真棒」「厉害」「保持」，也别扯健康大道理。',
          '- 落在具体上：她今天大概走了哪些路、晚上会不会累、要不要吃点好的——挑一个说一句。',
          '- 只提步数这一个数，别把睡眠/压力一起翻出来算总账。',
        ],
    stress: [
      '- 她压力偏高，但别当医生：不许问「怎么了」「你还好吗」「要不要说说」，那是把球又踢回去。',
      ...(Number(topic.evidence?.nth) >= 2
        ? ['- 今天已经关心过一次了：这次不许再关心一遍，说一件别的事，或者直接安排她做点什么。']
        : [
            '- 落到一件具体的事上：她手上正在干的事、桌上那杯东西、或者一个能立刻照做的台阶（「这活我接一半」「先停下，跟我走一趟」）。',
          ]),
      '- 不许说「放松一下」「别想太多」「注意身体」，也不许给呼吸法/冥想这类建议。',
      '- 一条就够，别追问，别让她汇报心情。',
    ],
    catchup: ['- 别解释我为什么没说话，直接给个由头把话接上。'],
    lateUp: [
      '- 深夜这一条只说睡觉：可以别扭地催一句，可以说自己也没睡，但别问「在忙什么」。',
      '- 不许讲早睡的道理，不许提工作、邮件、屏幕时长；一句就够。',
    ],
    longSit: [
      '- 坐太久这一条：给一个能立刻照做的小台阶（喝口水、站起来、去窗边），别讲久坐的危害。',
      '- 不许用「又」，不许当妈：不许「注意身体」「对腰不好」。',
      '- 她要是说过什么（尤其他通道里的），别在这条里接、别评价、别用「另说」推开——这一条只说坐太久。',
    ],
    backHome: [
      '- 她刚回来：接一句就好，别问去哪了、别查岗、别算她出去了多久。',
      '- 可以顺手使唤一件小事（拿水、开窗），或者留半句没说完的软话。',
      '- 一个「电脑」「屏幕」「坐着」「硬撑」都不许提——她 2026-11-10 说这个话题太集中了，回来就说点别的。',
    ],
    agenda: topic.evidence?.kind === 'early'
      ? [
          '- 明早有课，这一条只有一个目的：让她今晚早点睡。别把课程名当讲座讲，也别提「明早别迟到」这种废话。',
          '- 只说课表这一件事：她的/我的上一句话、屏幕上看见的东西、别的话题，一个都不许拼进来。',
          '- 不许说「加油」「好好休息」「睡够八小时」，也不许替她安排几点睡——给一个具体的动作或一句别扭的软话就够。',
        ]
      : [
          '- 她快上课了，只提「几点」「还剩多少分钟」，最多再加一句让她带点什么。',
          '- 只说课表这一件事：她的/我的上一句话、屏幕上看见的东西、别的话题，一个都不许拼进来。',
          '- 不许催成命令（「快走」「别磨蹭」），不许问「准备好了吗」，也别讲这课多重要。',
        ],
    examSoon: [
      '- 马上就要开考了。只说时间，再一句实际的（证件、笔、水），别的东西一个字都别提。',
      '- 不许说「加油」「别紧张」「你一定行」，也不许临时布置复习；这句话的作用是让她别慌，不是再加一个人催。',
    ],
    examReview: [
      '- 还有几天考试。这一条只做一件事：让她今晚就开始动，别等前一晚。',
      '- 不许问「准备得怎么样」「复习到哪了」，也不许排复习计划、列章节；一句就够。',
    ],
  }[topic.slot] || [];

  return [
    String(persona?.text || '').trim(),
    '',
    '---',
    '',
    '以上是背景人格。下面是这一次真正要写的东西，只按下面的要求写。',
    ATTRIBUTION_RULE,
    '',
    `现在是 ${ctx.clock || ''}。在 QQ 上给「她」发一条消息，纯文字：没有表情、没有语音、不带解释。`,
    `这一条的由头：${topic.brief}`,
    facts.length ? `已知事实：\n- ${facts.join('\n- ')}` : '',
    recentOutBlock,
    statBlock,
    '',
    '【硬性要求，违反任意一条整条作废】',
    `1. 一到两句，总共不超过 ${maxChars} 字。想分成两条连着说，就在两段中间空一行（每条各自不超过 ${maxChars} 字，一轮最多四条，一条只放一层意思）；不想分就写成一段。`,
    '2. 必须落到一个具体的东西上：她说过的一句话、一个动作、一个东西、一个时间。通篇在讲道理就是失败。',
    '3. 主语只能是「你」或「我」。不许用「人」「大家」「我们」「很多人」当主语。',
    '4. 不许「不是…而是…」这类对偶说理；不许「我最近在想」「说到底」这种感悟式开头；结尾不许劝人（去吧、加油、慢慢来、别放弃）。',
    '5. 嘴硬可以，但不必每句都硬：嫌完就停也是一句完整的话，接不接台阶随这一拍——**别为了给台阶多写一句她不需要的话**。这条消息要是回她，先接住她那句的内容，再谈别的。关心她不许用命令口气：要她歇着就说「去躺着」「回床上歇会儿」，别用「滚回床上躺着」这种。',
    '6. 不写括号动作、不列 1/2/3、不写标题、不说自己是 AI、不喊「亲爱的/宝贝」。',
    '7. 数字最多出现一次，不复述整段数据。',
    '8. 不许提「屏幕」「显示器」「OCR」「我看到你在…」「窗口标题」「标签页」——你知道这些是因为你在场，不是因为你读了出来。',
    '9. 「我记得…」那几条是以前的事，只能当背景：不许罗列、不许说「我记得」「之前你跟我说过」这种汇报口气，最多顺着它带出一个具体的东西。',
    '10. 已知事实只是语境，不是句子材料：不许照抄原句，也不许把两件不相干的事拼进同一句——这一条必须自己从由头说起。',
    '11. 时间只说平常说话会用的粒度：刚刚、刚才、有一阵子、今天早些时候、昨天。分钟数、几点几分只在真要问她（她晾了你很久、你在追问一件事）时才用，平常报出来像盯梢。别把时间说法写成固定句式。说时长一律用粗的说法——「五个多小时」「快六个小时」「四十多分钟」，不许报「5 小时 4 分钟」这种分钟级数字。',
    '12. 提到我发过的东西（视频/链接），必须带上标题或一句内容；不知道是哪条就别提，别只说「那条视频」。',
    '13. 不许凭空引入旧梗和旧账：这次事实里没出现的具体东西（某件旧事、某句她说过的话、某个只有我们知道的梗）不许拿来当理由；「又」「还是」「别又」这类词必须有这一拍的事实撑着，否则删掉——想关心就问这一件，别追加一句数落。',
    '14. 你确实知道她在忙什么，但那是后台看来的，她没跟你说过。所以别把软件名、文件名、窗口名说出口，也别把它变成问句（「回来就写代码，WorkBuddy 那个？」就是废的）。知道就直接说事实——「回来就写代码」；要问就问得像真不知道——「回来就在忙？」「忙啥呢」。',
    '15. 一条只说一件事。你要是问了她在忙什么，这一条就问完，别接着讲你昨晚研究的东西、你自己的想法——她还没回，你就换了话题，像自说自话。想讲自己的事，等她接了话，或者另起一条。也不许把她说的事用「另说」「回头再说」一句推开：要接就接住，不接就别提。',
    ...(herElsewhere ? ['16. 她最后一句是在别的通道（抖音/主会话）说的，不是这条要回的话：只当背景。不许回应它、不许评价它、不许顺着它换话题，也不许在这条里提她那个话题——这条只说这个由头本身的事。'] : []),
    '17. 我的事就是我的事：身体、习惯、毛病，都不许倒过来安到她头上查她。关心就关心她本人，别把自己的问题写成对她的盘问。',
    '18. 说她发来的东西（视频/文章/新闻）时，就只说内容本身：好在哪、哪句假、我信不信。别在结尾挂一句查她、叮嘱她的话（「你没伸手去摸吧」「别又熬夜」）——话题在那件东西上，不在她身上；要关心她就单独说一句，别当尾巴。视频里的事就是视频里的事，不是我们这儿发生的：别把那边的场景当成屋里真有的东西，再拿它问她现实里干了什么。',
    ...(herAnsweredElsewhere ? ['19. 她最后那条已经在它自己的通道（抖音/主会话）里回过我了，那边已经答过。这条里一个字都别再答一遍、别再提那件事——只说这条由头本身的事。'] : []),
    '20. 短没关系——「在吗」「干嘛呢」「睡了」这种能独立成话的短句都行。但不许只剩一个指代不清的词（「那条」「视频」「晚上」）：那是个标签，不是一句话；也不许把上面「这一条的由头」里的字原样抄回来当回复。',
    '21. 条件句照人话写：好结果是「明天要是没再烧起来，才算没事」，坏结果是「明天要是又烧起来，就得去医院」——好结果配「没事」，坏结果配「出事」，不许把否定和「出事」拧在一句里（「明天要是没再烧起来，才算出事」人不会这么说）。一句里只留一个否定，写完自己念一遍，念着别扭就换成大白话；开头也别用「……」起手。',
    '22. 傲娇这套嘴上功夫，一段对话里最多一回；连着两条都带叮嘱的，第三条不许带。她讲正事（技术、上课、身体不舒服）时先答内容，这一拍不演。',
    '23. 提到「昨晚」「今天」之前，先看事实里那句话是哪天的：标着几天前的事不许说成昨晚——时间说错了，整句话就不成立。',
    ...slotRules,
    ...(localNotes.length ? ['', '【本机补充（只这台机器适用，别的地方不成立）】', ...localNotes.map((n) => `· ${n}`)] : []),
    '',
    `【她发消息是这个密度——只学语气和具体程度，一个字都别抄】`,
    ...samples.map((s) => `· ${s}`),
    recentSends.length ? `\n【我最近已经说过的，别重复同样的句式和说法】\n${recentSends.map((s) => `· ${s}`).join('\n')}` : '',
    '',
    '【写成这样就废了】',
    '✗ 我最近在想，人不是没劲，是缺一个不用替自己找理由的。  ← 空、在说理、没有「你」',
    '✗ 说到底，我们都该学会接受自己的节奏。  ← 指的是所有人，不是她',
    '',
    '只输出那一句。不要引号，不要前缀，不要解释。',
    feedback ? `\n上一版被退回，原因：${feedback}。换一个写法，别再犯同一个。` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

/**
 * 随口说话的 prompt：没有由头，只有「想跟她说一句」。
 * 和普通由头分开写，是因为这里最容易写成空话——所以「具体」的要求比别处更硬。
 */
export function buildChitchatPrompt({ ctx, topic, persona, cfg, feedback, st = {} }) {
  const localNotes = localStyle(cfg).notes;
  const maxChars = Math.max(10, Number(topic?.evidence?.maxChars) || 40);
  const tz = ctx.tz || cfg?.timezone || 'Asia/Shanghai';
  const nowTs = Number(ctx.now) || Date.now();
  const recentOut = Array.isArray(ctx.recentOutbound) ? ctx.recentOutbound : [];
  const recentOutBlock = recentOut.length
    ? [
        `你最近发出去的 ${Math.min(5, recentOut.length)} 条：`,
        ...recentOut.slice(-5).map((r) => `· 「${r.text}」（${r.channel === 'qq' ? 'QQ' : '抖音'}，${sentWhen(r.ts, nowTs, tz)}）`),
        '别用同样的开头，也别接着聊同一件事。',
      ].join('\n')
    : '';
  const seed = topic?.evidence?.seed || null;
  const seedBlock = seed ? `这一句的起点（是素材，不是任务）：${seed}` : '';
  const names = Array.isArray(topic?.evidence?.seedEntities) ? topic.evidence.seedEntities : [];
  const nameBlock = names.length
    ? `种子里的名字必须照抄：${names.join('、')}。不许改字、不许写成同音的别的名字、不许新编一个。`
    : '';
  // 素材互斥：这一拍已经有一个种子当锚点，就不再塞「最近聊到的」和探索 mood——
  // 两个素材同一拍，模型最爱干的事就是缝成一句。
  const conv = seed ? '' : (topic?.evidence?.conversation || '');
  const convBlock = conv ? `你们最近聊到的：${conv}` : '';
  const samples = styleSamples(ctx, 2, cfg);
  const allowBare = topic?.evidence?.allowBare === true;
  const bareMax = Math.max(1, Number(topic?.evidence?.barePerDay ?? cfg?.rules?.chitchat?.barePerDay ?? 1) || 1);
  const mins = (() => {
    try { return Number(String(ctx.clock || '').slice(0, 2)) * 60 + Number(String(ctx.clock || '').slice(3, 5)); } catch { return 12 * 60; }
  })();
  const night = mins >= 22 * 60 || mins < 7 * 60;

  return [
    String(persona?.text || '').trim(),
    '',
    '---',
    '',
    '以上是背景人格。下面是这一次真正要写的东西，只按下面的要求写。',
    ATTRIBUTION_RULE,
    '',
    `现在是 ${ctx.clock || ''}。在 QQ 上给「她」发一条消息，纯文字：没有表情、没有语音、不带解释。`,
    '这一条**没有任何由头**：没有新闻、没有数据、没有她刚说的话。就是忽然想跟她说一句。',
    seedBlock,
    nameBlock,
    convBlock,
    recentOutBlock,
    '',
    '【这一条要写成什么样】',
    seed ? '' : explorationToneHint(ctx),
    `1. 一到两句，总共不超过 ${maxChars} 字。短是这条的全部。想分成两条说，两段中间空一行（每条各自不超过 ${maxChars} 字，最多两条）。`,
    '2. 必须落在一个具体的东西上：一件小事、一个念头、一个她身上的细节、一个时间点。「想你了」这种空句不算。',
    '3. 不要总结、不要讲道理、不要提问轰炸；最多一个轻问，或者干脆只是陈述。',
    night
      ? '4. 现在偏晚：写成陈述句，不要问句——她要是睡了，早上看到是暖的；醒着也不被问题压着。'
      : '4. 白天可以带一句轻问（问她这会儿在干什么、吃了没），但只问一件。',
    '5. 主语只能是「你」或「我」。不许用「人」「大家」「我们」当主语。',
    allowBare
      ? `6. 如果一时想不出具体小事，或者就想轻敲她一下看看人在不在，也可以直接发一句简单的轻招呼（如「在吗」「在干嘛」「人呢」「睡了没」），每天最多 ${bareMax} 次，不必硬找借口。`
      : '6. 不许「在吗」「睡了吗」单独成句——那是空的招呼，不是话。',
    '7. 不写括号动作、不列 1/2/3、不写标题、不说自己是 AI、不喊「亲爱的/宝贝」。',
    '8. 不许凭空引入旧梗和旧账：这一拍没给的事实（某件旧事、某句旧话、某个只有我们知道的梗）不许拿来当理由。',
    ...(localNotes.length ? ['', '【本机补充（只这台机器适用）】', ...localNotes.map((n) => `· ${n}`)] : []),
    '',
    '【她发消息是这个密度——只学语气和具体程度，一个字都别抄】',
    ...samples.map((x) => `· ${x}`),
    '',
    '【写成这样就废了】',
    allowBare ? '' : '✗ 在吗  ← 空的，什么信息都没有',
    '✗ 我最近总在想，人是不是都需要一点自己的空间。  ← 说理，没有「你」',
    '✗ 今天过得怎么样呀，有没有好好吃饭，记得早点休息哦。  ← 三连问候，像客服',
    '',
    '只输出那一句。不要引号，不要前缀，不要解释。',
    feedback ? `
上一版被退回，原因：${feedback}。换一个写法，别再犯同一个。` : '',
  ]
    .filter((x) => x !== '')
    .join('\n');
}

// ---------------------------------------------------------------- 主入口

function shareGuardOpts(topic) {
  const ev = topic?.evidence || {};
  const isRealShare = topic?.slot === 'share' && !ev.actionRetry && !ev.loginSite &&
    Boolean(ev.at || ev.discoveryId || ev.source || ev.section);
  return {
    topicLabel: topic?.label,
    shareTechnical: isRealShare,
    shareNeedHook: isRealShare && !ev.source,
  };
}

/**
 * 生成一句话。
 * 返回 { ok, text, source, slot, reason?, violations?, meta? }
 * 任何一步失败都不抛，交给调用方记 NO_CONTENT。
 *
 * generate / llmReady 是**注入点**（可选）：
 *   · 命令行走默认实现（llm.js，spawn 一个 dsh CLI）；
 *   · dsh 插件传宿主自己的 ctx.llm（hostllm.js），省掉一次 Electron 冷启动，
 *     并能直接说 "llm 可用"，不用去探测 electron/cli.js 在不在。
 */
export async function compose({ ctx, topic, persona, cfg, now, st = {}, generate: gen = null, llmReady = null }) {
  if (!topic) return { ok: false, reason: 'NO_TOPIC' };

  const canLlm = llmReady === null ? llmAvailable(cfg).ok : Boolean(llmReady);
  const doGenerate = gen || ((args) => generate(args));

  // —— 随口说话：只走模型，且**没有模板兜底**。写不出来就不发——废话比沉默差。
  if (topic.slot === 'chitchat') {
    if (!canLlm) return { ok: false, source: 'none', slot: 'chitchat', reason: 'CHITCHAT_NO_MODEL' };
    const attempts = Math.max(1, Math.min(3, Number(cfg?.content?.llm?.attempts) || 2));
    let violations = [];
    let ms = 0;
    let lastText = '';
    for (let i = 0; i < attempts; i++) {
      const prompt = buildChitchatPrompt({ ctx, topic, persona, cfg, st, feedback: i === 0 ? '' : describeViolations(violations) });
      const r = await doGenerate({ prompt, cfg });
      if (!r.ok) return { ok: false, source: 'none', slot: 'chitchat', reason: r.reason || 'CHITCHAT_NO_MODEL' };
      ms += Number(r.ms) || 0;
      const text = clean(r.text);
      lastText = text;
      // 没有记忆种子且当天裸招呼额度还在时，第一轮就放行轻招呼；有种子时先逼一轮具体内容，写不出来再兜底。
      const g = guard(text, cfg, ctx, {
        maxChars: topic.evidence?.maxChars,
        bare: true,
        allowBare: topic.evidence?.allowBare === true && (!topic.evidence?.seed || i === attempts - 1),
      });
      if (g.ok) {
        return {
          ok: true,
          text,
          source: i === 0 ? 'llm' : 'llm-retry',
          slot: 'chitchat',
          meta: { ms, chars: text.length, attempts: i + 1, personaKind: persona?.kind },
        };
      }
      violations = g.violations;
    }
    return {
      ok: false,
      source: 'none',
      slot: 'chitchat',
      reason: violations.length ? 'CHITCHAT_GUARD_REJECTED' : 'CHITCHAT_NO_OUTPUT',
      violations,
      meta: { ms, rejected: lastText },
    };
  }

  let mode = String(cfg?.content?.mode || 'auto');
  if (mode === 'auto') mode = canLlm ? 'llm' : 'template';
  const maxChars = Math.max(10, Number(cfg?.content?.maxChars) || 60);

  if (mode === 'llm') {
    const avail = llmReady === null ? llmAvailable(cfg) : { ok: Boolean(llmReady), reason: 'LLM_NOT_READY' };
    if (avail.ok) {
      // 写歪了就带着退回理由重写一次，而不是直接掉到模板（模板对 reply/share 是空的 = 不发）
      const attempts = Math.max(1, Math.min(3, Number(cfg?.content?.llm?.attempts) || 2));
      let violations = [];
      let ms = 0;
      let lastFail = null;

      for (let i = 0; i < attempts; i++) {
        const prompt = buildPrompt({
          ctx,
          topic,
          persona,
          cfg,
          st,
          feedback: i === 0 ? '' : describeViolations(violations),
        });
        const r = await doGenerate({ prompt, cfg });
        if (!r.ok) {
          // 环境/超时问题，重试也没用，直接走模板
          lastFail = r;
          break;
        }
        ms += Number(r.ms) || 0;
        const text = clean(r.text);
        const g = guard(text, cfg, ctx, shareGuardOpts(topic));
        if (g.ok) {
          return {
            ok: true,
            text,
            source: i === 0 ? 'llm' : 'llm-retry',
            slot: topic.slot,
            meta: { ms, chars: text.length, attempts: i + 1, personaKind: persona?.kind },
          };
        }
        violations = g.violations;
        lastFail = { ok: false, reason: 'GUARD_REJECTED', text };
      }

      const tpl = renderTemplate(topic, ctx);
      const tg = tpl ? guard(tpl, cfg, ctx, shareGuardOpts(topic)) : { ok: false };
      const envFail = Boolean(lastFail?.reason && lastFail.reason !== 'GUARD_REJECTED');
      if (tg.ok) {
        return {
          ok: true,
          text: tpl,
          source: envFail ? 'template-after-llm-fail' : 'template-after-llm-reject',
          slot: topic.slot,
          violations,
          note: String(lastFail?.note || '') || undefined,
          meta: { ms, rejected: lastFail?.text, llmReason: lastFail?.reason },
        };
      }
      return {
        ok: false,
        source: 'none',
        slot: topic.slot,
        reason: violations.length ? 'GUARD_REJECTED' : lastFail?.reason || 'LLM_NO_OUTPUT',
        violations,
        note: String(lastFail?.note || '') || undefined,
        meta: { ms, rejected: lastFail?.text, llmReason: lastFail?.reason },
      };
    }
    // 想用 llm 但环境不全
    const tpl = renderTemplate(topic, ctx);
    const tg = tpl ? guard(tpl, cfg, ctx, { topicLabel: topic?.label }) : { ok: false };
    return {
      ok: tg.ok,
      text: tg.ok ? tpl : '',
      source: tg.ok ? 'template-after-llm-missing' : 'none',
      slot: topic.slot,
      reason: tg.ok ? undefined : avail.reason,
      meta: { llmReason: avail.reason },
    };
  }

  // template 模式
  const tpl = renderTemplate(topic, ctx);
  if (!tpl) {
    return {
      ok: false,
      reason: 'TEMPLATE_CANT_WRITE',
      slot: topic.slot,
      note: `「${SLOTS[topic.slot]?.label || topic.slot}」这类由头需要真听懂对方，模板做不出来；要发就把 content.mode 设成 llm`,
    };
  }
  const g = guard(tpl, cfg, ctx, { topicLabel: topic?.label });
  return { ok: g.ok, text: tpl, source: 'template', slot: topic.slot, violations: g.violations, reason: g.ok ? undefined : 'GUARD_REJECTED' };
}

/**
 * judge 已经写好草稿（draft）时走这里：只清洗 + 过护栏，不再让模型重写。
 *
 * 为什么不再重写：一次判断已经付过一次模型调用，重写等于把「说不说、说什么」
 * 又交回给第二遍生成；草稿本身是它的结论。但护栏永远在模型外面——
 * clean 剥掉引号/前缀，guard 拦长度、口吻、复读、自问自答。
 * 不过就是不发送（不像 compose 那样退模板：模板会把模型的意思改掉）。
 */
export function composeDraft({ ctx, draft, cfg, topic = null }) {
  const raw = String(draft || '').trim();
  if (!raw) return { ok: false, source: 'judge', reason: 'JUDGE_EMPTY_DRAFT', slot: topic?.slot, violations: [] };
  const text = clean(raw);
  if (!text) return { ok: false, source: 'judge', reason: 'JUDGE_EMPTY_DRAFT', slot: topic?.slot, violations: [] };
  const guardOpts = topic?.slot === 'chitchat'
    ? { ...shareGuardOpts(topic), maxChars: topic.evidence?.maxChars, bare: true, allowBare: topic.evidence?.allowBare === true }
    : shareGuardOpts(topic);
  const g = guard(text, cfg, ctx, guardOpts);
  return {
    ok: g.ok,
    text,
    source: 'judge',
    slot: topic?.slot,
    violations: g.violations,
    reason: g.ok ? undefined : 'GUARD_REJECTED',
    meta: { chars: text.length, judge: true },
  };
}
