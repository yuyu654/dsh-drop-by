// topics.js —— 这一次到底「有没有由头」。
//
// 这是「要不要发」的第二层判断（第一层是 decide 的时机/配额闸）：
// **没有由头就不发**。到点必发是最招人烦的一种自动化，所以每个 slot 都带硬条件，
// 条件不满足就返回 null，run.js 会记 NO_TOPIC 并且**不消耗当日配额**。
//
// 纯函数：不读文件、不看时钟（now 由外面传），方便单测。
import { minutesOfDayOf, healthDay, hmToMin, minToHm, dayKey, hhmm, coarseMin } from './time.js';
import { coldSlots } from './feedback.js';
import { parseAgenda, agendaSource, nextCourse, currentWeek } from './agenda.js';
import { examsSource, parseExams, reviewDue, soonDue, dayDiff } from './exams.js';
import { noReplyDue } from './noreply.js';

// tier：阶段 1 的间隔分档（显式常量，不在运行时猜）。
//   reply = 回她/接转发/追问（默认 5 分钟）
//   event = 事件类：刚回来、深夜、久坐、self.md 新写入（默认 60 分钟）
//   chat  = 其余闲聊类（默认 240 分钟）
export const SLOTS = {
  reply: { label: '回她', why: '她说了话，我还没回', tier: 'reply' },
  forward: { label: '接住她发来的东西', why: '她转来一条内容，没人应', tier: 'reply' },
  sleep: { label: '拿睡眠说事', why: '昨夜睡得不对，早上问一句', tier: 'chat' },
  stress: { label: '她压力偏高', why: '鱼鱼读到压力超过阈值，主动关心一句', tier: 'chat' },
  steps: { label: '拿今天的步数说事', why: '18 点后收到新数据：今天几乎没动，或者活动量不错', tier: 'chat' },
  screen: { label: '拿屏幕时间说事', why: '今天用得太多，晚上提一句', tier: 'chat' },
  lateUp: { label: '深夜了还没睡', why: '夜里她还亮着屏幕，人在电脑前', tier: 'event' },
  longSit: { label: '坐太久了', why: '连着几小时没离开电脑', tier: 'event' },
  backHome: { label: '她刚回来', why: '离开一阵子，刚回到电脑前', tier: 'event' },
  agenda: { label: '按课表说事', why: '明早有早八，或者下一节快开始了', tier: 'chat' },
  examSoon: { label: '考试快到了', why: '考前几十分钟，说一句比考前一周发十条复习计划有用', tier: 'chat' },
  examReview: { label: '该复习了', why: '考前一周提醒一次，别到前一晚才想起来', tier: 'chat' },
  noReply: { label: '那条还没回', why: '我主动找过她，隔了很久没动静——问一句，别在猜里待着', tier: 'reply' },
  share: { label: '抛个我自己的判断', why: '我有新想法，还没跟人说过', tier: 'event' },
  catchup: { label: '隔太久了', why: '好几天没说话，找个由头', tier: 'chat' },
  // 随口说话：没有由头本身就是要说的事。优先级永远最低（别的由头挑得出来就不上）。
  chitchat: { label: '随口说一句', why: '没什么事，就是想跟她说一句', tier: 'chat' },
};

/** 阶段 1：由头 → 间隔档。没登记的 slot 一律按 chat（最保守）。 */
export function tierOfSlot(slot) {
  return SLOTS[slot]?.tier || 'chat';
}

/**
 * 「哪来哪回」：reply / forward 是**答她那句话**的由头，只在她那条来自发送通道时才成立。
 * 现在的发送只有 QQ 一条路；她在抖音或主会话说的话，拿到 QQ 上回就是答非所问
 * （她会以为我在回别的事）。其它由头（课表、邮件、抛判断……）跟通道无关，照旧。
 *
 * 通道未知（老记录没有 channel 字段）时放行，保持加这道闸之前的行为。
 */
export function answerableOn(slot, channel, sendChannel = 'qq') {
  if (slot !== 'reply' && slot !== 'forward') return true;
  const from = String(channel || '');
  if (!from) return true;
  return from === sendChannel;
}

const DAY_MIN = 24 * 60;
const H = 60;

/** 她发来的是「转发内容」还是「一句话」：带话题标签或链接就算转发。 */
export function looksForwarded(text) {
  const t = String(text || '');
  return /#\S/.test(t) || /https?:\/\//i.test(t) || t.length > 120;
}

/**
 * 昨夜这一觉「出了什么问题」——只在两种情况下算由头：
 *   1) 睡不够：默认要求「时长短 **且** 深睡也少（< shortMin 且 < deepShortMin）」
 *      → 再看起床时间反推的入睡点，区分「熬夜」还是「单纯没睡好」
 *      **深睡是拓展项**：不是每个运动健康应用都给这个字段，读不到时只看时长
 *      （「没读到」不等于「这一觉没问题」，也不能因此瞎猜深睡少）
 *   2) 睡得太多（> longMin）→ 问一句昨天是不是累到了
 * 其余（时长正常、只是深睡少、短但深睡够）都不发——早上不该每天都有话说。
 *
 * 三个阈值都是用户可改的（--sleep-set），代码里不留魔法数字。
 *
 * 返回 { kind, sleepMin, deepMin, deepKnown, wakeHm, bedHm, bedMin, bedFrom, lateBed, bedUnknown } 或 null。
 * bedFrom: 'direct'（邮件里给了入睡时间）/ 'inferred'（起床 − 睡眠反推）/ null（都读不到）。
 * kind: 'late_night' | 'poor_sleep' | 'long_sleep'
 */
/**
 * 入睡点：邮件直接给了就用（direct），否则拿「起床 − 睡眠」反推（inferred）。
 * 这是纯计算，不看阈值——--why 想显示「反推出来是几点」时也能用。
 * 返回 { bedHm, bedMin, bedFrom }（都拿不到时三项为 null）。
 */
export function bedTimeOf(fish) {
  const wakeMin = hmToMin(fish?.wakeHm);
  const sleepMin = Number(fish?.sleepMin);
  const direct = hmToMin(fish?.bedHm);
  const canInfer = wakeMin != null && Number.isFinite(sleepMin) && sleepMin > 0;
  const inferred = canInfer ? ((wakeMin - sleepMin) % 1440 + 1440) % 1440 : null;
  const bedMin = direct ?? inferred;
  return {
    bedHm: bedMin == null ? null : minToHm(bedMin),
    bedMin,
    bedFrom: direct != null ? 'direct' : inferred != null ? 'inferred' : null,
  };
}

export function classifySleep(fish, cfg) {
  const t = cfg?.content?.topics || {};
  const sleepMin = Number(fish?.sleepMin);
  if (!Number.isFinite(sleepMin) || sleepMin <= 0) return null;

  const shortMin = Number(t.sleepShortMin ?? 420); // 睡少：默认 7 小时
  const deepShortMin = Number(t.sleepDeepShortMin ?? 120); // 深睡少：默认 2 小时
  const longMin = Number(t.sleepLongMin ?? 570); // 睡多：默认 9.5 小时

  const deepMin = Number.isFinite(Number(fish?.deepMin)) && fish?.deepMin != null ? Number(fish.deepMin) : null;
  const deepKnown = deepMin != null; // 深睡读没读到，决定「睡不够」怎么判
  // 这个时长是「夜间睡眠」还是退回来的「总睡眠」：备注用，不影响算法
  const sleepSrc = fish?.sleepFrom || null;
  const wakeHm = fish?.wakeHm || null;
  // 入睡时间优先用邮件里直接给的（App 新增了字段，但大概率读不到）；
  // 没有才拿「起床 − 夜间睡眠」反推（总睡眠只是最后退路，见 fishparse 的 sleepFrom）。
  // 反推出来的是**入睡点**不是躺下的时间，躺下到睡着那一段本来就不算睡眠，
  // 所以真正的躺下点永远比它早。
  const { bedHm, bedMin, bedFrom } = bedTimeOf(fish);

  // 睡得太多：跟深睡无关，直接问累不累
  if (sleepMin > longMin) {
    return { kind: 'long_sleep', sleepMin, sleepSrc, deepMin, deepKnown, wakeHm, bedHm, bedMin, bedFrom, lateBed: false, bedUnknown: bedMin == null };
  }

  // 睡不够：时长短是硬条件；深睡只有「读到了并且够」才能否掉它
  if (sleepMin >= shortMin) return null;
  if (deepKnown && deepMin >= deepShortMin) return null;

  if (bedMin == null) {
    // 邮件没给入睡时间、也没有起床时间：反推不了，保守归到「没睡好」，绝不误判成熬夜
    return { kind: 'poor_sleep', sleepMin, sleepSrc, deepMin, deepKnown, wakeHm: null, bedHm: null, bedMin: null, bedFrom: null, lateBed: false, bedUnknown: true };
  }

  // 把一天平移成「12:00 为 0」的连续轴：22:00→600，00:30→750，03:00→900。
  // 这样跨零点比较不会翻车。
  const rel = (m) => ((m - 12 * 60) % 1440 + 1440) % 1440;
  // 注意：这里的 bedMin 是「入睡点」——邮件里直接给了「入睡时间」就用它（bedFrom='direct'），
// 没给才拿「起床 − 夜间睡眠」反推（bedFrom='inferred'）。反推值是估算，
// 且躺下到睡着那一段本来就不算睡眠，所以真正的躺下点永远比 bedMin 早。
// 定熬夜线时别按「几点躺下」来，先定自己觉得晚的点，
// 再加上最近几晚的平均清醒时长（例如规定 23:30 算晚、每晚躺 40 分钟才睡着，
// 线应落在 00:10 左右）；否则会把「其实按时躺下了、只是入睡慢」误判成熬夜。
  const lateBedMin = hmToMin(String(t.sleepLateBed ?? '00:30')) ?? 30;
  const bedRel = rel(bedMin);
  const lateRel = rel(lateBedMin);
  // 06:00 之后才入睡（rel 超过 1080）基本是白天补觉或数据异常，不当熬夜
  const lateBed = bedRel > lateRel && bedRel < 1080;

  return { kind: lateBed ? 'late_night' : 'poor_sleep', sleepMin, sleepSrc, deepMin, deepKnown, wakeHm, bedHm, bedMin, bedFrom, lateBed, bedUnknown: false };
}

/**
 * 真看了视频之后，把摘要接回由头。
 * 必须在 compose 之前：brief 由「只有一行标题」换成「内容是……」，模型才写得出具体的话。
 */
export function withForwardContent(topic, viewed) {
  if (!topic || topic.slot !== 'forward' || !viewed?.ok || !viewed.summary) return topic;
  const head = topic.evidence?.herText || '';
  return {
    ...topic,
    evidence: {
      ...topic.evidence,
      hasContent: true,
      contentSummary: viewed.summary,
      contentSource: viewed.source || 'asr',
      contentDurSec: Number(viewed.durSec) || null,
    },
    brief: viewed.source?.startsWith('vision')
      ? `她转来一条内容。抽帧观察${viewed.source === 'vision+asr' ? '（含口播）' : ''}：${viewed.summary}`
      : `她转来一条内容：「${head}」。口播摘要（没有画面）：${viewed.summary}`,
  };
}

/**
 * 鱼鱼数据过期了吗（数据断供防呆）。
 * App → SMTP → IMAP 任何一环断了，这边只会安静地 NO_TOPIC；但更糟的是拿两周前的睡眠数据问「昨晚睡得好吗」。
 * dateTs 缺失/为 0 时视为新鲜：宁可照旧，也别因为邮件头读不到就把四类由头全停。
 * 返回 { stale, ageHours, limitHours }。
 */
export function fishStale(fish, cfg, now) {
  const limitHours = Math.max(6, Number(cfg?.sources?.phone?.staleHours ?? 36));
  // 这个检查本身也有总闸：关掉就一律当新鲜（阈值还留着，想临时恢复不用重填）。
  if (cfg?.sources?.phone?.staleGuard === false) return { stale: false, ageHours: null, limitHours };
  const ts = Number(fish?.dateTs) || 0;
  if (!ts || !fish?.ok) return { stale: false, ageHours: null, limitHours };
  const ageHours = (now - ts) / 3_600_000;
  return { stale: ageHours > limitHours, ageHours, limitHours };
}

/**
 * 挑由头。返回 { slot, label, why, evidence, brief } 或 null。
 * brief 是给模板/模型看的一句话素材，全是事实，不含形容词。
 */
function pickTopicRaw(ctx, cfg, now, st = {}) {
  const t = cfg?.content?.topics || {};
  const on = (k) => t[k] !== false;
  // 手机端总闸：关掉时睡眠/压力/屏幕这三类数据一律不参与判定（数据只可能来自手机 App 发的邮件）。
  const phoneOn = cfg?.sources?.phone?.enabled !== false;
  const used = st?.content || {};
  // 这一拍明确不要的由头（engine 在「转发内容读不到」时会跳过 forward 再挑一次）
  const skip = new Set(Array.isArray(st?.skipSlots) ? st.skipSlots : []);

  const fish = ctx.fish || { ok: false };
  // 数据过期 = 和「手机端总闸关着」同等地位：睡眠/压力/步数/屏幕四类都不再当由头。
  const staleInfo = fishStale(fish, cfg, now);
  const phoneData = phoneOn && !staleInfo.stale;
  const her = ctx.her || {};
  const me = ctx.me || {};
  const tz = ctx.tz || cfg?.timezone;
  const mins = minutesOfDayOf(now, tz);
  const gapHerMin = her.lastTs ? (now - her.lastTs) / 60000 : null;
  const gapMeMin = me.lastTs ? (now - me.lastTs) / 60000 : null;
  const unanswered = Boolean(her.lastTs) && (!me.lastTs || her.lastTs > me.lastTs);

  // 人在不在电脑前：三类只看电脑的由头和「快上课了」都要它
  const pc = st?.pc || {};
  const awaySec = Number(cfg?.idle?.awaySec ?? 600);
  const idleNow = ctx?.presence?.idleSec;
  const here = typeof idleNow === 'number' && idleNow >= 0 && idleNow <= awaySec;

  // 之前发出去她老不接的由头，压几天（见 src/feedback.js）
  const cold = coldSlots(st, cfg, now);
  const ok = (k) => !cold.has(k);

  // 1) 她说了话，我还没回
  if (on('reply') && unanswered && her.lastText) {
    if (t.replyMaxAgeMin == null || gapHerMin <= Number(t.replyMaxAgeMin)) {
      const linkItem = /(?:^|[\s(（「【])https?:\/\/(?:www\.)?douyin\.com\/video\/(\d{6,30})(?![\w-])/i.exec(her.lastText)?.[1];
      const item = linkItem || her.lastItem ||
        (!her.lastChannel && her.lastItem === undefined ? her.forwardItem || ctx.forwardItem : null) || null;
      const fwd = Boolean(item) || looksForwarded(her.lastText);
      if (fwd && on('forward') && !skip.has('forward')) {
        const head = her.lastText.slice(0, 160);
        // 内容摘要由第二步（真去看：下载 + 抽帧/转写）填进来。有摘要才敢说「我看过了」，
        // 没有就只能承认只看见标题，否则模型会照着标题编内容。
        const got = her.forwardSummary || ctx.forward?.summary || null;
        return {
          slot: 'forward',
          label: SLOTS.forward.label,
          why: SLOTS.forward.why,
          evidence: {
            herText: head,
            herAgoMin: Math.round(gapHerMin),
            item,
            hasContent: Boolean(got),
            contentSummary: got || null,
          },
          brief: got
            ? `她转来一条内容：「${head}」。这条我看过了，内容是：${got}`
            : `她转来一条内容：「${head}」。我手里只有这一行标题，没看过里面的内容。`,
        };
      }
      if (!fwd) {
        return {
          slot: 'reply',
          label: SLOTS.reply.label,
          why: SLOTS.reply.why,
          evidence: { herText: her.lastText.slice(0, 160), herAgoMin: Math.round(gapHerMin) },
          brief: `她刚才说：「${her.lastText.slice(0, 160)}」（${Math.round(gapHerMin)} 分钟前），等我回。`,
        };
      }
    }
  }

  // 1.65) 考试：快考了（按分钟算窗口）比「该复习了」（按天算）更急，所以排在课表前面。
  //       它只吃设置页那份考试表（或 data/exams.txt），和手机数据无关。
  if (on('examSoon') || on('examReview')) {
    const src = examsSource(cfg);
    if (src.text.trim()) {
      const list = parseExams(src.text, { tz, now });
      if (on('examSoon') && ok('examSoon')) {
        const e = soonDue(list, now, Number(t.examSoonMin ?? 60));
        if (e && used.lastExamSoon !== e.key) {
          const left = Math.max(1, Math.round((e.at - now) / 60_000));
          return {
            slot: 'examSoon',
            label: SLOTS.examSoon.label,
            why: SLOTS.examSoon.why,
            evidence: { key: e.key, subject: e.subject, room: e.room, hm: e.hm, date: e.date, leftMin: left },
            brief: `${e.subject ? `「${e.subject}」` : '一场考试'}${e.room ? `（${e.room}）` : ''} ${e.hm} 开考，还有 ${left} 分钟。`,
          };
        }
      }
      if (on('examReview') && ok('examReview')) {
        const e = reviewDue(list, now, tz, Number(t.examReviewDays ?? 7));
        if (e && used.lastExamReview !== e.key) {
          const dd = dayDiff(e, now, tz);
          return {
            slot: 'examReview',
            label: SLOTS.examReview.label,
            why: SLOTS.examReview.why,
            evidence: { key: e.key, subject: e.subject, room: e.room, hm: e.hm, date: e.date, days: dd },
            brief: `还有 ${dd} 天考${e.subject ? `「${e.subject}」` : '试'}（${e.date} ${e.hm}${e.room ? `，${e.room}` : ''}），该开始复习了。`,
          };
        }
      }
    }
  }

  // 1.7) 课表：唯一往前看的由头。明早有课 → 今晚催睡；下一节快开始了 → 提一句。
  //      它不吃手机邮件，只吃设置页那份课表（或 data/agenda.txt）。
  if (on('agenda') && ok('agenda')) {
    const src = agendaSource(cfg);
    const agendaOpts = {
      termStart: String(cfg.content?.agenda?.termStart || ''),
      periods: String(cfg.content?.agenda?.periods || ''),
      off: Array.isArray(cfg.content?.agenda?.off) ? cfg.content.agenda.off : [],
    };
    const courses = parseAgenda(src.text, agendaOpts);
    if (courses.length) {
      const soonMin = Math.max(5, Number(t.agendaSoonMin ?? 20));
      const nc = nextCourse(src.text, now, tz, agendaOpts);
      // a) 明天早上有早课：今晚提一次，跨零点算同一晚
      const earlyHour = Number(t.agendaEarlyBeforeHour ?? 9);
      const fromHour = Number(t.agendaTomorrowHour ?? 21);
      const inWindow = mins >= fromHour * 60 || mins < 120;
      if (inWindow && nc && nc.inDays <= 1 && nc.fromMin < earlyHour * 60) {
        const night = nightKeyOf(now, tz);
        if (used.lastAgendaNight !== night) {
          const when = nc.inDays === 0 ? '今天' : '明天';
          return {
            slot: 'agenda',
            label: SLOTS.agenda.label,
            why: SLOTS.agenda.why,
            evidence: { kind: 'early', at: minToHm(nc.fromMin), name: nc.name, when, nightKey: night },
            brief: `${when}早上 ${minToHm(nc.fromMin)} 有${nc.name ? `「${nc.name}」` : '课'}，八点前就得起。`,
          };
        }
      }
      // b) 下一节课在 soonMin 分钟内开始：这时提才有用，晚了就是马后炮
      if (nc && nc.inDays === 0 && nc.offsetMin - mins <= soonMin && nc.offsetMin - mins >= 5 && here) {
        const key = `${dayKey(now, tz)}:${nc.fromMin}`;
        if (used.lastAgendaSoon !== key) {
          return {
            slot: 'agenda',
            label: SLOTS.agenda.label,
            why: SLOTS.agenda.why,
            evidence: { kind: 'soon', at: minToHm(nc.fromMin), name: nc.name, leftMin: nc.offsetMin - mins, key },
            brief: `${minToHm(nc.fromMin)} 有${nc.name ? `「${nc.name}」` : '课'}，还有 ${nc.offsetMin - mins} 分钟。`,
          };
        }
      }
    }
  }

  // 1.8) 追问：我主动发过去的那条，她一直没回。
  //      候选和「她是去忙了还是没打算回」的判断都在 engine 里做（ctx.noReply），
  //      这里只按时间窗放行——模型判忙的要等她忙完（或忙碌时段结束）再加 noReplyAfterBusyMin。
  if (on('noReply') && ok('noReply') && ctx.noReply && used.lastNoReplyFor !== ctx.noReply.key) {
    const due = noReplyDue({ cand: ctx.noReply, cfg, now, herTs: her.lastTs, tz });
    if (due.ok) {
      const c = ctx.noReply;
      const atTxt = hhmm(c.at, tz);
      const away = Boolean(c.verdict?.away);
      const said = String(c.text || '').trim();
      const what =
        c.channel === 'douyin'
          ? `我在 ${atTxt} 给她分享了个视频${c.title ? `《${String(c.title).slice(0, 60)}》` : ''}，到现在没动静。`
          : said
            ? `我在 ${atTxt} 找她说的那句「${said.slice(0, 80)}」，到现在没回。`
            : `我在 ${atTxt} 给她发了条消息，到现在没回。`;
      return {
        slot: 'noReply',
        label: SLOTS.noReply.label,
        why: SLOTS.noReply.why,
        evidence: {
          key: c.key,
          channel: c.channel,
          at: c.at,
          silenceMin: c.silenceMin,
          text: c.text,
          title: c.title || '',
          item: c.item || null,
          kind: c.kind || null,
          verdict: c.verdict || null,
        },
        brief: what + (away ? '（从对话看，她那会儿多半在忙或睡了）' : ''),
      };
    }
  }

  // 2) 睡眠：只有「昨夜刚醒」那几个小时里有意义，隔天翻旧账很难听。
  //    一天只触发一次，而且「一天」以早上 7 点（北京时间）为界——
  //    07:00 之前算前一天，所以凌晨那几拍不会把同一条数据用两遍。
  const morningFrom = Number(t.sleepFromHour ?? 7);
  const morningTo = Number(t.sleepToHour ?? 10.5);
  const sleepMaxAgeH = Number(t.sleepMaxAgeH ?? 14);
  const dayStart = Number(t.sleepDayStartHour ?? 7);
  const sleepDay = healthDay(now, tz, dayStart);
  if (phoneData && on('sleep') && ok('sleep') && fish.ok && mins >= morningFrom * H && mins <= morningTo * H) {
    const c = classifySleep(fish, cfg);
    // 邮件必须属于「这一个健康日」——按**邮件自己的日期**算，不能按「什么时候抓到的」算。
    // 2026-11-10 踩过的坑：昨天 19:16 那封被今天早上抓回来，fetchedAt 刷新成今天，
    // 于是昨天「睡眠 11.2h」被当成昨夜的数据问出去。07:00 前抓到的（比如 06:30 醒）
    // 给 6 小时余量，否则起床早的人会整天都没数据可用。
    const mailTs = Number(fish.dateTs) || 0;
    const dataDay = mailTs
      ? healthDay(mailTs, tz, dayStart)
      : fish.fetchedAt
        ? healthDay(fish.fetchedAt, tz, dayStart)
        : null;
    const freshEnough = mailTs
      ? now - mailTs <= 6 * 60 * 60_000
      : fish.ageMin != null && fish.ageMin <= 360;
    const dayOk = dataDay == null ? true : dataDay === sleepDay || freshEnough;
    const ageOk = fish.ageMin == null || fish.ageMin <= sleepMaxAgeH * H;
    // 只有总睡眠（含白天小睡）时不提「昨晚睡了多久」——总睡眠不是昨夜那一觉，
    // 拿它说「睡了十一个多钟头」就是编。宁可这一句不发。
    const nightKnown = c && c.sleepSrc !== 'total';
    if (nightKnown && dayOk && ageOk && used.lastSleepFor !== sleepDay) {
      // 给她看的时长说粗的（「六个多小时」），别把「7 小时 12 分钟」喂进句子
      const dur = coarseMin(c.sleepMin);
      // 深睡是拓展项：应用不提供时字段是空的，这时只说时长，别写「深睡才 -」
      const deepTxt = c.deepKnown ? `，深睡才${coarseMin(c.deepMin)}` : '（这封没带深睡，只看时长）';
      // 只拿到总睡眠时说明一句：总睡眠含白天小睡，通常 ≥ 夜间睡眠，别把它当「昨夜那一觉」精确值
      const totalOnly = c.sleepSrc === 'total' ? '（这封没带夜间睡眠，用的是总睡眠）' : '';
      let brief = '';
      const bedTxt =
        c.bedFrom === 'direct'
          ? `入睡 ${c.bedHm}（邮件里直接给的）`
          : `起床 ${c.wakeHm}，反推入睡是 ${c.bedHm}`;
      if (c.kind === 'long_sleep') {
        brief =
          `她昨夜睡了 ${dur}${totalOnly}` +
          (c.deepKnown ? `（深睡${coarseMin(c.deepMin)}）` : '') +
          `，比平时长很多。可能是昨天累到了。`;
      } else if (c.kind === 'late_night') {
        brief = `她昨夜只睡了 ${dur}${deepTxt}${totalOnly}；${bedTxt}——是熬夜，不是睡不着。`;
      } else {
        brief =
          `她昨夜只睡了 ${dur}${deepTxt}${totalOnly}` +
          (c.bedHm
            ? `；${bedTxt}，睡得不算晚，是没睡好。`
            : '；入睡时间没读到，判断不了是不是熬夜。');
      }
      return {
        slot: 'sleep',
        label: SLOTS.sleep.label,
        why: SLOTS.sleep.why,
        evidence: {
          kind: c.kind,
          sleepMin: c.sleepMin,
          sleepSrc: c.sleepSrc,
          deepMin: c.deepMin,
          deepKnown: c.deepKnown,
          remMin: fish.remMin ?? null,
          wakeHm: c.wakeHm,
          bedHm: c.bedHm,
          bedFrom: c.bedFrom,
          lateBed: c.lateBed,
          bedUnknown: c.bedUnknown,
          day: sleepDay,
        },
        brief,
      };
    }
  }

  // 3) 压力：读到「压力 > 阈值」就关心一句。
  //    这里最容易变成骚扰源，所以三道闸一起上：
  //      · 时段（默认 09:00–22:00）：深夜收到「你压力好大」只会让人更烦；
  //      · 新鲜度（默认 12h）：压力是当日的瞬时值，隔夜的数说明不了今天；
  //      · 次数（stressDailyMax，默认 1）+ 最小间隔（stressMinGapMin，默认 180 分钟）。
  //    同一天要发第二次，还要求压力没比上一次低——否则就是把同一句话说两遍。
  const stressFrom = Number(t.stressFromHour ?? 9);
  const stressTo = Number(t.stressToHour ?? 22);
  const stressHigh = Number(t.stressHighMin ?? 59);
  const stressMax = Math.max(1, Math.min(6, Number(t.stressDailyMax ?? 1)));
  const stressVal = fish.stress == null ? null : Number(fish.stress);
  if (
    phoneData &&
    on('stress') && ok('stress') &&
    fish.ok &&
    Number.isFinite(stressVal) &&
    stressVal > stressHigh &&
    mins >= stressFrom * H &&
    mins <= stressTo * H &&
    (fish.ageMin == null || fish.ageMin <= Number(t.stressMaxAgeH ?? 12) * H)
  ) {
    const stressDay = healthDay(now, tz, dayStart);
    const sentToday = used.stressDay === stressDay ? Number(used.stressCount) || 0 : 0;
    const lastAt = Number(used.lastStressAt) || 0;
    const gapOk = !lastAt || now - lastAt >= Number(t.stressMinGapMin ?? 180) * 60000;
    const prevVal = Number.isFinite(Number(used.lastStressValue)) ? Number(used.lastStressValue) : null;
    const notDropping = prevVal == null || stressVal >= prevVal;

    if (sentToday < stressMax && gapOk && notDropping) {
      const nth = sentToday + 1;
      return {
        slot: 'stress',
        label: SLOTS.stress.label,
        why: SLOTS.stress.why,
        evidence: {
          stress: stressVal,
          threshold: stressHigh,
          date: fish.date,
          day: stressDay,
          nth,
          max: stressMax,
          agoMin: fish.ageMin ?? null,
        },
        brief:
          nth === 1
            ? `鱼鱼读到她的压力是 ${stressVal}（阈值 ${stressHigh}，越高越紧）。她可能自己都没提，别等她开口。`
            : `她的压力还是 ${stressVal}，比上次没降。今天已经关心过一次了，这次别重复关心。`,
      };
    }
  }

  // 4) 步数：18 点以后「新收到的那封邮件」里，今天一共走了多少。
  //    两头都算由头：不到 lowMax（默认 2000）= 一整天几乎没动；超过 highMin（默认 8000）= 活动量好。
  //    中间那一段（2000~8000）什么都不发——「今天走了四千步」不值得专门找她。
  //    一天只发一次；数据必须是新到的（stepsMaxAgeMin，默认 120 分钟），
  //    否则晚上 22 点拿中午 12 点的步数说事，等于把白天的话拖到晚上重播一遍。
  const stepsFrom = Number(t.stepsFromHour ?? 18);
  const stepsLow = Number(t.stepsLowMax ?? 2000);
  const stepsHigh = Number(t.stepsHighMin ?? 8000);
  const stepsMaxAgeMin = Number(t.stepsMaxAgeMin ?? 120);
  const stepsVal = fish.steps == null ? null : Number(fish.steps);
  if (
    phoneData &&
    on('steps') && ok('steps') &&
    fish.ok &&
    Number.isFinite(stepsVal) &&
    stepsLow < stepsHigh &&
    mins >= stepsFrom * H &&
    (fish.ageMin == null || fish.ageMin <= stepsMaxAgeMin)
  ) {
    const stepsDay = healthDay(now, tz, dayStart);
    const kind = stepsVal < stepsLow ? 'low' : stepsVal > stepsHigh ? 'high' : null;
    if (kind && used.lastStepsFor !== stepsDay) {
      return {
        slot: 'steps',
        label: SLOTS.steps.label,
        why: SLOTS.steps.why,
        evidence: {
          kind,
          steps: stepsVal,
          lowMax: stepsLow,
          highMin: stepsHigh,
          date: fish.date,
          day: stepsDay,
          agoMin: fish.ageMin ?? null,
        },
        brief:
          kind === 'low'
            ? `鱼鱼读到她的步数只有 ${stepsVal}（不到 ${stepsLow} 步），今天几乎没怎么动。`
            : `鱼鱼读到她的步数 ${stepsVal}（超过 ${stepsHigh} 步），今天活动量不错。`,
      };
    }
  }

  // 5) 屏幕时间：晚上提，白天提像查岗
  const screenFrom = Number(t.screenFromHour ?? 21);
  if (
    phoneData &&
    on('screen') && ok('screen') &&
    fish.ok &&
    fish.screenMin != null &&
    mins >= screenFrom * H &&
    fish.ageMin != null &&
    fish.ageMin <= sleepMaxAgeH * H &&
    fish.screenMin >= Number(t.screenHeavyMin ?? 480) &&
    used.lastScreenFor !== `${fish.date}:${dayRank(now, ctx.tz)}`
  ) {
    return {
      slot: 'screen',
      label: SLOTS.screen.label,
      why: SLOTS.screen.why,
      evidence: { screenMin: fish.screenMin, date: fish.date },
      brief: `她今天屏幕${coarseMin(fish.screenMin)}。`,
    };
  }

  // 5.5) 只看电脑的三个由头。
  //      睡眠/压力/步数/屏幕四类全靠手机 App 发的邮件，手机端一关就全灭；
  //      这三类只吃本机探针，是「不接手机」时的主要来源，所以不跟 fish.ok 挂钩。
  // a) 深夜了还亮着：一个晚上只提一次（跨零点算同一晚）
  const lateFrom = Number(t.lateFromHour ?? 23);
  const lateTo = Number(t.lateToHour ?? 2);
  if (on('lateUp') && ok('lateUp') && here && !unanswered && isLateNight(mins, lateFrom, lateTo)) {
    const night = nightKeyOf(now, tz);
    if (used.lastLateUpFor !== night) {
      return {
        slot: 'lateUp',
        label: SLOTS.lateUp.label,
        why: SLOTS.lateUp.why,
        evidence: { at: ctx.clock || '', nightKey: night, fromHour: lateFrom },
        brief: `现在 ${ctx.clock || '这个点'}，她那边屏幕还亮着、鼠标键盘还在动——今晚没打算早睡。`,
      };
    }
  }

  // b) 坐太久了：连续在电脑前，中间没真正离开过
  const longSitH = Number(t.longSitHours ?? 3);
  if (on('longSit') && ok('longSit') && here && pc.activeSince && now - pc.activeSince >= longSitH * 3_600_000) {
    const day = dayKey(now, tz);
    if (used.lastLongSitFor !== day) {
      const since = hhmm(pc.activeSince, tz);
      const sat = fmtMin((now - pc.activeSince) / 60_000);
      return {
        slot: 'longSit',
        label: SLOTS.longSit.label,
        why: SLOTS.longSit.why,
        evidence: { since, day, satMin: Math.round((now - pc.activeSince) / 60_000) },
        brief: `她从 ${since} 一直坐到 ${hhmm(now, tz)}，已经 ${sat}，中间几乎没离开过。`,
      };
    }
  }

  // c) 刚回来：离开够久，又回来了
  //    她 2026-11-10 说「话题都太集中在我看电脑这件事上」：这一类最少隔 backCooldownMin（默认 2 小时）才再用一次，
  //    brief 里也不再写「电脑前」——那是给模型递话头。
  const backMin = Number(t.backAfterMin ?? 30);
  const backCool = now - (Number(used.lastBackSendAt) || 0) >= Number(t.backCooldownMin ?? 120) * 60_000;
  if (on('backHome') && ok('backHome') && backCool && pc.lastReturnAt && used.lastBackAt !== pc.lastReturnAt) {
    const justBack = now - pc.lastReturnAt <= 20 * 60_000;
    const awayLong = Number(pc.lastAwayMs) >= backMin * 60_000;
    // 她刚说过话就别用「刚回来」再开一次场，那是自说自话
    const herQuiet = gapHerMin == null || gapHerMin >= 120;
    if (justBack && awayLong && herQuiet) {
      const awayMin = Math.round(Number(pc.lastAwayMs) / 60_000);
      return {
        slot: 'backHome',
        label: SLOTS.backHome.label,
        why: SLOTS.backHome.why,
        evidence: { returnAt: pc.lastReturnAt, awayMin, at: hhmm(pc.lastReturnAt, tz) },
        brief: `她出去了 ${fmtMin(awayMin)}，${hhmm(pc.lastReturnAt, tz)} 刚回来。`,
      };
    }
  }

  // 6) 我自己的判断：self.md 最后一条，隔一天才复用
  const shareGapH = Number(t.shareGapH ?? 24);
  if (
    on('share') && ok('share') &&
    ctx.self &&
    String(ctx.self.line || '').length >= Number(t.shareMinChars ?? 40) &&
    (!used.lastShareAt || now - used.lastShareAt >= shareGapH * 3_600_000) &&
    (!used.lastShareLine || used.lastShareLine !== ctx.self.line.slice(0, 80))
  ) {
    return {
      slot: 'share',
      label: SLOTS.share.label,
      why: SLOTS.share.why,
      evidence: { section: ctx.self.section, at: ctx.self.at, chars: ctx.self.chars },
      // 别把原文整段塞进去：模型会照抄，而且这是我的内部判断。
      // 只给 80 字、且明确要「落到具体」，否则模型会把它再抽象成一句格言。
      brief: `我私下记过一条判断（${ctx.self.section || '想法'}）：「${ctx.self.line.slice(0, 80)}」。这是我的判断，只能说给她听，不能照搬原句、不能加引号、不能总结成一般道理。`,
    };
  }

  // 7) 好几天没说话：只在真断了的时候用
  const idleDays = Number(t.catchupDays ?? 2);
  if (on('catchup') && ok('catchup') && gapHerMin != null && gapHerMin >= idleDays * DAY_MIN * 1 && !unanswered) {
    return {
      slot: 'catchup',
      label: SLOTS.catchup.label,
      why: SLOTS.catchup.why,
      evidence: { silentDays: +(gapHerMin / DAY_MIN).toFixed(1) },
      brief: `上次她说话是 ${(gapHerMin / DAY_MIN).toFixed(1)} 天前。`,
    };
  }

  return null;
}

/** 她 2026-11-10："话题都太集中在我看电脑这件事上"。同一类由头别连着来，
 *  「屏幕/久坐/硬撑」这类一天也别连着占四条。 */
const SCREEN_WORDS = /电脑|屏幕|坐着|坐到|一直坐|久坐|硬撑/;

export function pickTopic(ctx, cfg, now, st = {}) {
  const pick = pickTopicRaw(ctx, cfg, now, st);
  if (!pick) return pick;
  const used = st?.content || {};
  const recent = Array.isArray(used.recentSends) ? used.recentSends : [];
  const slots = Array.isArray(used.recentSlots) ? used.recentSlots : [];
  if (SCREEN_WORDS.test(String(pick.brief || ''))) {
    const hits = recent.slice(-4).filter((x) => SCREEN_WORDS.test(String(x))).length;
    // 最近四条里已经有两句在说她坐在屏幕前：这一拍别再说，换别的由头或干脆不说
    if (hits >= 2) return null;
  }
  const lastTwo = slots.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === pick.slot && lastTwo[1] === pick.slot) return null;
  return pick;
}
/** 为什么没挑到：给日志和 --why 用，避免只看到一句 NO_TOPIC。 */
export function explainNoTopic(ctx, cfg, now, st = {}) {
  const t = cfg?.content?.topics || {};
  const fish = ctx.fish || { ok: false };
  const her = ctx.her || {};
  const me = ctx.me || {};
  const tz = ctx.tz || cfg?.timezone;
  const mins = minutesOfDayOf(now, tz);
  const reasons = [];

  const unanswered = Boolean(her.lastTs) && (!me.lastTs || her.lastTs > me.lastTs);
  if (!unanswered) reasons.push('她没在等我回（她最后一条早于我最后一条，或没有记录）');
  if (!fish.ok) reasons.push('没有鱼鱼数据（邮箱没开 / 还没收到 FISH 邮件）');
  else {
    const staleInfo = fishStale(fish, cfg, now);
    if (staleInfo.stale) {
      reasons.push(
        `鱼鱼数据 ${Math.round(staleInfo.ageHours)} 小时没更新（超过 ${staleInfo.limitHours} 小时），睡眠/压力/步数/屏幕先不用`,
      );
    }
    const dayStart = Number(t.sleepDayStartHour ?? 7);
    const sleepDay = healthDay(now, tz, dayStart);
    const c = classifySleep(fish, cfg);
    if (fish.sleepMin == null) reasons.push('鱼鱼摘要里没读到睡眠时长（要看含「夜间睡眠：」的睡眠详情行）');
    if (mins < Number(t.sleepFromHour ?? 7) || mins > Number(t.sleepToHour ?? 10.5)) {
      reasons.push('现在不在早上那一档，睡眠话题过期');
    } else if (st?.content?.lastSleepFor === sleepDay) {
      reasons.push(`这个健康日（${sleepDay} 07:00 起算）已经说过睡眠了，一天只发一次`);
    } else if (!c) {
      const shortMin = Number(t.sleepShortMin ?? 420);
      const deepShort = Number(t.sleepDeepShortMin ?? 120);
      const longMin = Number(t.sleepLongMin ?? 570);
      reasons.push(
        `睡眠不构成由头：${fmtMin(fish.sleepMin)}` +
          (fish.deepMin != null ? ` / 深睡 ${fmtMin(fish.deepMin)}` : ' / 深睡未读到') +
          `（睡短于 ${fmtMin(shortMin)} 就判；深睡读到才一起看，或睡过 ${fmtMin(longMin)}）`,
      );
    }
  }
  if (!ctx.self) reasons.push('self.md 里没有可用的判断');
  if (fish.ok) {
    const stressVal = fish.stress == null ? null : Number(fish.stress);
    const high = Number(t.stressHighMin ?? 59);
    const max = Math.max(1, Math.min(6, Number(t.stressDailyMax ?? 1)));
    const dayStart = Number(t.sleepDayStartHour ?? 7);
    const day = healthDay(now, tz, dayStart);
    const sentToday = st?.content?.stressDay === day ? Number(st?.content?.stressCount) || 0 : 0;
    if (t.stress === false) reasons.push('压力由头已关闭（content.topics.stress=false）');
    else if (stressVal == null) reasons.push('鱼鱼摘要里没读到压力值');
    else if (!(stressVal > high)) reasons.push(`压力 ${stressVal} 没超过阈值 ${high}`);
    else if (mins < Number(t.stressFromHour ?? 9) || mins > Number(t.stressToHour ?? 22)) {
      reasons.push('现在不在压力时段内');
    } else if (sentToday >= max) reasons.push(`今天的压力已经说过 ${sentToday} 次（上限 ${max}）`);
    else if (st?.content?.lastStressAt && now - Number(st.content.lastStressAt) < Number(t.stressMinGapMin ?? 180) * 60000) {
      reasons.push(`距上次压力话题不足 ${Number(t.stressMinGapMin ?? 180)} 分钟`);
    }
    // 步数：18 点以后那一条，两头才算由头
    const stepsVal = fish.steps == null ? null : Number(fish.steps);
    const stepsFrom = Number(t.stepsFromHour ?? 18);
    const stepsLow = Number(t.stepsLowMax ?? 2000);
    const stepsHigh = Number(t.stepsHighMin ?? 8000);
    if (t.steps === false) reasons.push('步数由头已关闭（content.topics.steps=false）');
    else if (stepsVal == null) reasons.push('鱼鱼摘要里没读到步数');
    else if (mins < stepsFrom * H) reasons.push(`步数要 ${stepsFrom} 点以后才看（现在还没到）`);
    else if (fish.ageMin != null && fish.ageMin > Number(t.stepsMaxAgeMin ?? 120)) {
      reasons.push(`这封邮件是 ${fish.ageMin} 分钟前的，步数不当成「刚接到的」用`);
    } else if (stepsVal >= stepsLow && stepsVal <= stepsHigh) {
      reasons.push(`步数 ${stepsVal} 在 ${stepsLow}–${stepsHigh} 之间，今天这个由头不成立`);
    }
  }
  // 电脑侧那三类：不接手机 App 时它们是主力，所以「为什么这次没用上」也得说清
  const pc = st?.pc || {};
  const awaySec = Number(cfg?.idle?.awaySec ?? 600);
  const idleNow = ctx?.presence?.idleSec;
  const here = typeof idleNow === 'number' && idleNow >= 0 && idleNow <= awaySec;
  if (!here) {
    reasons.push('电脑那边没人（空闲超过阈值，或探针读不到）：深夜/坐太久/刚回来这三类都不算');
  } else {
    if (t.lateUp === false) reasons.push('「深夜了还没睡」这一类关着');
    else if (st?.content?.lastLateUpFor === nightKeyOf(now, tz)) reasons.push('这一晚已经提过她还没睡');
    else if (!isLateNight(mins, Number(t.lateFromHour ?? 23), Number(t.lateToHour ?? 2))) {
      reasons.push(`现在不在深夜档（默认 ${Number(t.lateFromHour ?? 23)} 点–${Number(t.lateToHour ?? 2)} 点）`);
    }
    if (t.longSit === false) reasons.push('「坐太久了」这一类关着');
    else if (!pc.activeSince) reasons.push('还没记到一段连续坐着的时间（刚回来或刚开机）');
    else if (st?.content?.lastLongSitFor === dayKey(now, tz)) reasons.push('今天已经说过坐太久了');
    else reasons.push(`连续坐了 ${Math.round((now - pc.activeSince) / 60_000)} 分钟（到 ${Number(t.longSitHours ?? 3)} 小时才算）`);
    if (t.backHome === false) reasons.push('「她刚回来」这一类关着');
    else if (!pc.lastReturnAt) reasons.push('还没记到她离开过又回来');
  }
  // 课表：填了才谈得上不成立
  {
    const a = agendaSource(cfg);
    const list = parseAgenda(a.text);
    if (t.agenda === false) reasons.push('课表由头已关闭（content.topics.agenda=false）');
    else if (!list.length) reasons.push('课表还没填（设置页「课表与考试」）');
    else {
      const termStart = String(cfg.content?.agenda?.termStart || '');
      const week = currentWeek(now, tz, termStart);
      const nc = nextCourse(a.text, now, tz, { termStart });
      if (week && list.some((c) => c.weeks)) reasons.push(`现在是第 ${week} 周（开学 ${termStart}）`);
      else if (!termStart && list.some((c) => c.weeks)) reasons.push('没填开学日期，带周次的课暂时当每周都上');
      if (!nc) reasons.push('接下来 7 天没有要上的课（周次过滤后）');
      else {
        const wd = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'][nc.weekday];
        if (nc.inDays === 0) reasons.push(`下一节是今天 ${minToHm(nc.fromMin)}，还有 ${nc.offsetMin - mins} 分钟（${Number(t.agendaSoonMin ?? 45)} 分钟内才提）`);
        else if (nc.inDays === 1) reasons.push(`下一节是明天（${wd}）${minToHm(nc.fromMin)}，${Number(t.agendaTomorrowHour ?? 21)} 点后才提；${Number(t.agendaEarlyBeforeHour ?? 9)} 点前的才算早课`);
        else reasons.push(`下一节在 ${nc.inDays} 天后（${wd} ${minToHm(nc.fromMin)}），还早`);
      }
    }
  }
  // 追问：我发过去的那条她一直没回
  if (t.noReply === false) reasons.push('「那条还没回」这一类关着（content.topics.noReply=false）');
  else if (!ctx.noReply) reasons.push('没有「我发过去、她一直没回」的那条（她之后说过话，或者还没到间隔）');
  else {
    const due = noReplyDue({ cand: ctx.noReply, cfg, now, herTs: ctx.her?.lastTs, tz });
    if (!due.ok) reasons.push(`追问还不到时候：${due.why}`);
    else reasons.push('这条之前已经问过了（同一条只问一次）');
  }
  // 被反馈闭环压住的由头：说出来，否则「为什么今天这么安静」查不到原因
  {
    const cold = coldSlots(st, cfg, now);
    if (cold.size) reasons.push(`这些之前发出去她没接，先压几天：${[...cold].join('、')}`);
  }

  return reasons;
}

function fmtMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(n / 60);
  const mm = n % 60;
  if (!h) return `${mm} 分钟`;
  return mm ? `${h} 小时 ${mm} 分钟` : `${h} 小时`;
}

/** from=23、to=2 这种跨零点的深夜档；from < to 时按普通区间算。 */
function isLateNight(mins, from, to) {
  const a = from * 60;
  const b = to * 60;
  if (a === b) return false;
  return a > b ? mins >= a || mins < b : mins >= a && mins < b;
}

/** 「这一晚」的键：凌晨 4 点前算前一晚，跨零点也只提一次。 */
function nightKeyOf(now, tz) {
  return dayKey(now - 4 * 3_600_000, tz);
}

/** 当天的序号，用来区分「今天这条屏幕数据有没有用过」。 */
function dayRank(now, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Shanghai' }).format(new Date(now));
}
