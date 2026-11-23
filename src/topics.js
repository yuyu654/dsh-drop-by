// topics.js —— 这一次到底「有没有由头」。
//
// 这是「要不要发」的第二层判断（第一层是 decide 的时机/配额闸）：
// **没有由头就不发**。到点必发是最招人烦的一种自动化，所以每个 slot 都带硬条件，
// 条件不满足就返回 null，run.js 会记 NO_TOPIC 并且**不消耗当日配额**。
//
// 纯函数：不读文件、不看时钟（now 由外面传），方便单测。
import { minutesOfDayOf, healthDay, hmToMin, minToHm, dayKey, hhmm, coarseMin } from './time.js';
import { coldSlots, topicPreferenceMode } from './feedback.js';
import { parseAgenda, agendaSource, nextCourse, currentWeek } from './agenda.js';
import { examsSource, parseExams, reviewDue, soonDue, dayDiff } from './exams.js';
import { noReplyDue } from './noreply.js';
import { wellnessCooldown } from './decide.js';
import { characterRestCue, characterRestGreeted } from './character-rest.js';
import { collectExternalTopics, getTopicProviderMeta } from './extensions.js';

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
  characterRest: { label: '角色睡前或刚醒', why: '角色快到入睡时间，或刚醒来不久，顺口打声招呼', tier: 'event' },
  examSoon: { label: '考试快到了', why: '考前几十分钟，说一句比考前一周发十条复习计划有用', tier: 'chat' },
  examReview: { label: '该复习了', why: '考前一周提醒一次，别到前一晚才想起来', tier: 'chat' },
  noReply: { label: '那条还没回', why: '我主动找过她，隔了很久没动静——问一句，别在猜里待着', tier: 'reply' },
  share: { label: '抛个我自己的判断', why: '我有新想法，还没跟人说过', tier: 'event' },
  catchup: { label: '隔太久了', why: '好几天没说话，找个由头', tier: 'chat' },
  agreement: { label: '约定小本本', why: '已记下的事项到了跟进时间', tier: 'event' },
  projectCheckIn: { label: '聊聊最近在忙的项目', why: '只主动问一次，不催回复', tier: 'chat' },
  // 随口说话：遵守独立的时段与额度，可与其他由头一起交给模型。
  chitchat: { label: '随口说一句', why: '没什么事，就是想跟她说一句', tier: 'chat' },
};

/** 阶段 1：由头 → 间隔档。没登记的 slot 一律按 chat（最保守）。 */
export function tierOfSlot(slot) {
  return SLOTS[slot]?.tier || getTopicProviderMeta(slot)?.tier || 'chat';
}

/**
 * 「哪来哪回」：reply / forward 是**答她那句话**的由头，只在她那条来自发送通道时才成立。
 * 现在的发送只有 QQ 一条路；她在抖音或主会话说的话，拿到 QQ 上回就是答非所问
 * （她会以为我在回别的事）。其它由头（课表、邮件、抛判断……）跟通道无关，照旧。
 *
 * 通道未知（老记录没有 channel 字段）时放行，保持加这道闸之前的行为。
 */
export function agreementTopic(item) {
  return { slot: 'agreement', ...SLOTS.agreement, brief: '跟进已核验的时间约定',
    evidence: { topic: item.title, dueAt: item.dueAt } };
}

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
 * 优先按邮件日期算，旧缓存只有收取时间时用收取时间。全无时间戳时保留旧行为。
 * 返回 { stale, ageHours, limitHours }。
 */
export function fishStale(fish, cfg, now) {
  const limitHours = Math.max(6, Number(cfg?.sources?.phone?.staleHours ?? 36) || 36);
  const fetchedAt = fish?.fetchedAt;
  const ts = Number(fish?.dateTs) || Number(fetchedAt) || Date.parse(fetchedAt || '') || 0;
  if (!ts || !fish?.ok) return { stale: false, ageHours: null, limitHours };
  const ageHours = (now - ts) / 3_600_000;
  return { stale: cfg?.sources?.phone?.staleGuard !== false && ageHours > limitHours, ageHours, limitHours };
}

/**
 * 挑由头。返回 { slot, label, why, evidence, brief } 或 null。
 * brief 是给模板/模型看的一句话素材，全是事实，不含形容词。
 */
function* topicOptions(ctx, cfg, now, st = {}, misses) {
  const t = cfg?.content?.topics || {};
  const on = (k) => t[k] !== false;
  const when = (slot, passes, reason) => {
    if (!passes) misses?.set(slot, reason);
    return passes;
  };
  // 手机端总闸关闭后，睡眠、压力、步数和屏幕数据都不参与选题。
  const phoneOn = cfg?.sources?.phone?.enabled !== false;
  const used = st?.content || {};
  // 这一拍明确不要的由头（engine 在「转发内容读不到」时会跳过 forward 再挑一次）
  const skip = new Set(Array.isArray(st?.skipSlots) ? st.skipSlots : []);

  const fish = ctx.fish || { ok: false };
  // 数据过期 = 和「手机端总闸关着」同等地位：睡眠/压力/步数/屏幕四类都不再当由头。
  const staleInfo = fishStale(fish, cfg, now);
  const phoneData = (slot) => when(slot, phoneOn, 'phone_disabled') &&
    when(slot, fish.ok, cfg?.sources?.phone?.staleGuard === false ? 'no_data' : 'fish_missing') &&
    when(slot, !staleInfo.stale, 'fish_stale');
  const her = ctx.her || {};
  const me = ctx.me || {};
  const tz = ctx.tz || cfg?.timezone;
  const mins = minutesOfDayOf(now, tz);
  const gapHerMin = her.lastTs ? (now - her.lastTs) / 60000 : null;
  const gapMeMin = me.lastTs ? (now - me.lastTs) / 60000 : null;
  const unanswered = Boolean(her.lastTs) && (!me.lastTs || her.lastTs > me.lastTs);

  // 部分电脑与课表由头要求人正好在电脑前。
  const pc = st?.pc || {};
  const awaySec = Number(cfg?.idle?.awaySec ?? 600);
  const idleNow = ctx?.presence?.idleSec;
  const here = typeof idleNow === 'number' && idleNow >= 0 && idleNow <= awaySec;

  // 1) 她说了话，我还没回
  if (on('reply') && unanswered && her.lastText) {
    if (when('reply', t.replyMaxAgeMin == null || gapHerMin <= Number(t.replyMaxAgeMin), 'out_of_window')) {
      const linkItem = /(?:^|[\s(（「【])https?:\/\/(?:www\.)?douyin\.com\/video\/(\d{6,30})(?![\w-])/i.exec(her.lastText)?.[1];
      const item = linkItem || her.lastItem ||
        (!her.lastChannel && her.lastItem === undefined ? her.forwardItem || ctx.forwardItem : null) || null;
      const fwd = Boolean(item) || looksForwarded(her.lastText);
      if (fwd && on('forward') && !skip.has('forward')) {
        const head = her.lastText.slice(0, 160);
        // 内容摘要由第二步（真去看：下载 + 抽帧/转写）填进来。有摘要才敢说「我看过了」，
        // 没有就只能承认只看见标题，否则模型会照着标题编内容。
        const got = her.forwardSummary || ctx.forward?.summary || null;
        yield {
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
      if (!fwd && !skip.has('reply')) {
        yield {
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
      if (on('examSoon')) {
        const e = soonDue(list, now, Number(t.examSoonMin ?? 60));
        if (when('examSoon', e, 'out_of_window') && when('examSoon', used.lastExamSoon !== e.key, 'already_used')) {
          const left = Math.max(1, Math.round((e.at - now) / 60_000));
          yield {
            slot: 'examSoon',
            label: SLOTS.examSoon.label,
            why: SLOTS.examSoon.why,
            evidence: { key: e.key, subject: e.subject, room: e.room, hm: e.hm, date: e.date, leftMin: left },
            brief: `${e.subject ? `「${e.subject}」` : '一场考试'}${e.room ? `（${e.room}）` : ''} ${e.hm} 开考，还有 ${left} 分钟。`,
          };
        }
      }
      if (on('examReview')) {
        const e = reviewDue(list, now, tz, Number(t.examReviewDays ?? 7));
        if (when('examReview', e, 'out_of_window') && when('examReview', used.lastExamReview !== e.key, 'already_used')) {
          const dd = dayDiff(e, now, tz);
          yield {
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
  if (on('agenda')) {
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
      const inWindow = mins >= fromHour * 60 || mins < Number(t.agendaTomorrowUntilHour ?? 2) * 60;
      let alreadyUsed = false;
      let yielded = false;
      if (inWindow && nc && nc.inDays <= 1 && nc.fromMin < earlyHour * 60) {
        const night = nightKeyOf(now, tz);
        alreadyUsed = used.lastAgendaNight === night;
        if (!alreadyUsed) {
          const when = nc.inDays === 0 ? '今天' : '明天';
          yielded = true;
          yield {
            slot: 'agenda',
            label: SLOTS.agenda.label,
            why: SLOTS.agenda.why,
            evidence: { kind: 'early', at: minToHm(nc.fromMin), name: nc.name, when, nightKey: night },
            brief: `${when}早上 ${minToHm(nc.fromMin)} 有${nc.name ? `「${nc.name}」` : '课'}，八点前就得起。`,
          };
        }
      }
      // b) 下一节课在 soonMin 分钟内开始：这时提才有用，晚了就是马后炮
      if (nc && nc.inDays === 0 && nc.offsetMin - mins <= soonMin && nc.offsetMin - mins >= Number(t.agendaSoonMinLead ?? 5) && here) {
        const key = `${dayKey(now, tz)}:${nc.fromMin}`;
        alreadyUsed ||= used.lastAgendaSoon === key;
        if (used.lastAgendaSoon !== key) {
          yielded = true;
          yield {
            slot: 'agenda',
            label: SLOTS.agenda.label,
            why: SLOTS.agenda.why,
            evidence: { kind: 'soon', at: minToHm(nc.fromMin), name: nc.name, leftMin: nc.offsetMin - mins, key },
            brief: `${minToHm(nc.fromMin)} 有${nc.name ? `「${nc.name}」` : '课'}，还有 ${nc.offsetMin - mins} 分钟。`,
          };
        }
      }
      if (!yielded) when('agenda', false, alreadyUsed ? 'already_used' : 'out_of_window');
    }
  }

  // 有可核对的新发现时优先分享，先让她的话和紧急日程。
  const share = on('share') && when('share', !unanswered, 'reply_pending') && shareTopic(ctx, t, used, now, when);
  const earlyShare = share && (ctx.self.discoveryId || ctx.self.actionRetry);
  if (earlyShare) yield share;

  // 1.8) 追问：我主动发过去的那条，她一直没回。
  //      engine 先核对用户约定及忙碌状态，再将合格的待跟进事项放入 ctx.noReply。
  //      这里只按时间窗放行——模型判忙的要等她忙完（或忙碌时段结束）再加 noReplyAfterBusyMin。
  if (on('noReply') && ctx.noReply && when('noReply', used.lastNoReplyFor !== ctx.noReply.key, 'already_used')) {
    const due = noReplyDue({ cand: ctx.noReply, cfg, now, herTs: her.lastTs, tz });
    if (when('noReply', due.ok, 'out_of_window')) {
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
      yield {
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
        brief: c.verdict?.quote
          ? `有明确约定，用户原话：「${c.verdict.quote}」。按约提醒这件事，别问她为什么没回。我之前说的是：「${said.slice(0, 80)}」。`
          : what + (away ? '（从对话看，她那会儿多半在忙或睡了）' : ''),
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
  if (on('sleep') && phoneData('sleep') && when('sleep', mins >= morningFrom * H && mins <= morningTo * H, 'out_of_window')) {
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
      ? now - mailTs <= Number(t.sleepSameDayGraceMin ?? 360) * 60_000
      : fish.ageMin != null && fish.ageMin <= Number(t.sleepSameDayGraceMin ?? 360);
    const dayOk = dataDay == null ? true : dataDay === sleepDay || freshEnough;
    const ageOk = fish.ageMin == null || fish.ageMin <= sleepMaxAgeH * H;
    // 只有总睡眠（含白天小睡）时不提「昨晚睡了多久」——总睡眠不是昨夜那一觉，
    // 拿它说「睡了十一个多钟头」就是编。宁可这一句不发。
    const nightKnown = c && c.sleepSrc !== 'total';
    if (when('sleep', nightKnown, fish.sleepMin == null ? 'no_data' : 'condition_not_met') &&
        when('sleep', dayOk && ageOk, 'out_of_window') && when('sleep', used.lastSleepFor !== sleepDay, 'already_used')) {
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
      yield {
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
    on('stress') && phoneData('stress') &&
    Number.isFinite(stressVal) &&
    when('stress', stressVal > stressHigh, 'condition_not_met') &&
    when('stress', mins >= stressFrom * H && mins <= stressTo * H, 'out_of_window') &&
    when('stress', fish.ageMin == null || fish.ageMin <= Number(t.stressMaxAgeH ?? 12) * H, 'out_of_window')
  ) {
    const stressDay = healthDay(now, tz, dayStart);
    const sentToday = used.stressDay === stressDay ? Number(used.stressCount) || 0 : 0;
    const lastAt = Number(used.lastStressAt) || 0;
    const gapOk = !lastAt || now - lastAt >= Number(t.stressMinGapMin ?? 180) * 60000;
    const prevVal = Number.isFinite(Number(used.lastStressValue)) ? Number(used.lastStressValue) : null;
    const notDropping = prevVal == null || stressVal >= prevVal;

    if (when('stress', sentToday < stressMax, 'already_used') && when('stress', gapOk, 'cooldown') &&
        when('stress', notDropping, 'condition_not_met')) {
      const nth = sentToday + 1;
      yield {
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

  // 角色作息由头：实际入睡前 N 分钟、醒来后 N 分钟各最多一次。
  if (on('characterRest') && when('characterRest', !unanswered, 'reply_pending')) {
    const cue = characterRestCue(cfg, now);
    if (when('characterRest', Boolean(cue), 'out_of_window')) {
      const usedKey = cue.kind === 'bed' ? used.lastCharacterBedFor : used.lastCharacterWakeFor;
      const alreadyGreeted = characterRestGreeted(ctx, cue.kind, cfg, now);
      if (when('characterRest', usedKey !== cue.key && !alreadyGreeted, 'already_used')) {
        yield {
          slot: 'characterRest',
          label: SLOTS.characterRest.label,
          why: cue.kind === 'bed' ? '角色快到今晚的入睡时间了，顺口打声招呼准备去睡' : '角色刚醒来不久，顺口打声招呼',
          evidence: {
            kind: cue.kind,
            key: cue.key,
            day: cue.day,
            ...(cue.kind === 'bed' ? { leftMin: cue.leftMin, at: cue.bedHm } : { sinceMin: cue.sinceMin, at: cue.wakeHm }),
          },
          brief: cue.kind === 'bed'
            ? `角色还有约 ${cue.leftMin} 分钟就到今晚的入睡时间（${cue.bedHm}），准备去睡了，顺口简短说一句晚安或收尾的话。`
            : `角色刚醒来${cue.sinceMin > 0 ? `约 ${cue.sinceMin} 分钟` : '没多久'}（今早 ${cue.wakeHm} 醒），顺口简短打个早安招呼。`,
        };
      }
    }
  }

  // 本机探针提供的由头不依赖手机邮件。
  // a) 深夜了还亮着：一个晚上只提一次（跨零点算同一晚）
  const lateFrom = Number(t.lateFromHour ?? 23);
  const lateTo = Number(t.lateToHour ?? 2);
  if (on('lateUp') && here && when('lateUp', !unanswered, 'reply_pending') &&
      when('lateUp', isLateNight(mins, lateFrom, lateTo), 'out_of_window')) {
    const night = nightKeyOf(now, tz);
    if (when('lateUp', used.lastLateUpFor !== night, 'already_used')) {
      yield {
        slot: 'lateUp',
        label: SLOTS.lateUp.label,
        why: SLOTS.lateUp.why,
        evidence: { at: ctx.clock || '', nightKey: night, fromHour: lateFrom },
        brief: `现在 ${ctx.clock || '这个点'}，她那边屏幕还亮着、鼠标键盘还在动——今晚没打算早睡。`,
      };
    }
  }

  // c) 刚回来：离开够久，又回来了
  //    她 2026-11-10 说「话题都太集中在我看电脑这件事上」：这一类最少隔 backCooldownMin（默认 2 小时）才再用一次，
  //    brief 里也不再写「电脑前」——那是给模型递话头。
  const backMin = Number(t.backAfterMin ?? 30);
  const backCool = now - (Number(used.lastBackSendAt) || 0) >= Number(t.backCooldownMin ?? 120) * 60_000;
  if (on('backHome') && when('backHome', backCool, 'cooldown') && pc.lastReturnAt &&
      when('backHome', used.lastBackAt !== pc.lastReturnAt, 'already_used')) {
    const justBack = now - pc.lastReturnAt <= Number(t.backRecentMin ?? 20) * 60_000;
    const awayLong = Number(pc.lastAwayMs) >= backMin * 60_000;
    // 她刚说过话就别用「刚回来」再开一次场，那是自说自话
    const herQuiet = gapHerMin == null || gapHerMin >= Number(t.backUserQuietMin ?? 120);
    if (when('backHome', justBack, 'out_of_window') && when('backHome', awayLong, 'condition_not_met') &&
        when('backHome', herQuiet, 'cooldown')) {
      const awayMin = Math.round(Number(pc.lastAwayMs) / 60_000);
      yield {
        slot: 'backHome',
        label: SLOTS.backHome.label,
        why: SLOTS.backHome.why,
        evidence: { returnAt: pc.lastReturnAt, awayMin, at: hhmm(pc.lastReturnAt, tz) },
        brief: `设备在约 ${fmtMin(awayMin)} 无交互后恢复活动，不能据此推断她出门或办了什么。`,
      };
    }
  }

  if (share && !earlyShare) yield share;

  // 7) 好几天没说话：只在真断了的时候用
  const idleDays = Number(t.catchupDays ?? 2);
  if (on('catchup') && gapHerMin != null &&
      when('catchup', gapHerMin >= idleDays * DAY_MIN, 'cooldown') && when('catchup', !unanswered, 'reply_pending')) {
    yield {
      slot: 'catchup',
      label: SLOTS.catchup.label,
      why: SLOTS.catchup.why,
      evidence: { silentDays: +(gapHerMin / DAY_MIN).toFixed(1) },
      brief: `上次她说话是 ${(gapHerMin / DAY_MIN).toFixed(1)} 天前。`,
    };
  }

  // 步数、屏幕和久坐放在最后，只在明显超出日常时考虑。
  const wellnessBlock = unanswered ? 'reply_pending' : wellnessCooldown(st, now, tz, cfg) ? 'cooldown' : '';
  const wellnessOk = (slot) => when(slot, !wellnessBlock, wellnessBlock);
  const stepsFrom = Number(t.stepsFromHour ?? 18);
  const stepsLow = Math.min(600, Number(t.stepsLowMax ?? 600));
  const stepsHigh = Math.max(16000, Number(t.stepsHighMin ?? 16000));
  const stepsMaxAgeMin = Number(t.stepsMaxAgeMin ?? 120);
  const stepsVal = fish.steps == null ? null : Number(fish.steps);
  if (
    on('steps') && phoneData('steps') && wellnessOk('steps') &&
    Number.isFinite(stepsVal) &&
    when('steps', stepsLow < stepsHigh, 'condition_not_met') &&
    when('steps', mins >= stepsFrom * H, 'out_of_window') &&
    when('steps', fish.ageMin != null && fish.ageMin >= 0 && fish.ageMin <= stepsMaxAgeMin, 'out_of_window')
  ) {
    const stepsDay = healthDay(now, tz, dayStart);
    const kind = stepsVal < stepsLow ? 'low' : stepsVal > stepsHigh ? 'high' : null;
    if (when('steps', kind, 'condition_not_met') && when('steps', used.lastStepsFor !== stepsDay, 'already_used')) {
      yield {
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
        brief: kind === 'low' ? '邮件记录的步数偏少，可能有漏记。' : '邮件记录的步数明显比普通活动量多。',
      };
    }
  }

  // 屏幕时间只在晚上考虑。
  const screenFrom = Number(t.screenFromHour ?? 21);
  if (
    on('screen') && phoneData('screen') && wellnessOk('screen') &&
    fish.screenMin != null &&
    when('screen', mins >= screenFrom * H, 'out_of_window') &&
    when('screen', fish.ageMin != null && fish.ageMin >= 0 && fish.ageMin <= Number(t.screenMaxAgeH ?? sleepMaxAgeH) * H, 'out_of_window') &&
    when('screen', fish.screenMin >= Number(t.screenHeavyMin ?? 720), 'condition_not_met') &&
    when('screen', used.lastScreenFor !== `${fish.date}:${dayRank(now, ctx.tz)}`, 'already_used')
  ) {
    yield {
      slot: 'screen',
      label: SLOTS.screen.label,
      why: SLOTS.screen.why,
      evidence: { screenMin: fish.screenMin, date: fish.date },
      brief: '邮件记录的屏幕时间偏长，当作背景，别直接报数字。',
    };
  }

  // 连续活跃只代表探针有信号，不能断定用户一直坐着。
  const longSitH = Number(t.longSitHours ?? 5);
  if (on('longSit') && wellnessOk('longSit') && here && pc.activeSince &&
      when('longSit', now - pc.activeSince >= longSitH * 3_600_000, 'condition_not_met')) {
    const day = dayKey(now, tz);
    if (when('longSit', used.lastLongSitFor !== day, 'already_used')) {
      const since = hhmm(pc.activeSince, tz);
      yield {
        slot: 'longSit',
        label: SLOTS.longSit.label,
        why: SLOTS.longSit.why,
        evidence: { since, day, satMin: Math.round((now - pc.activeSince) / 60_000) },
        brief: '电脑连续活跃了较长时间，实际坐了多久未知。',
      };
    }
  }

  return;
}

/** 她 2026-11-10："话题都太集中在我看电脑这件事上"。同一类由头别连着来，
 *  「屏幕/久坐/硬撑」这类一天也别连着占四条。 */
function shareTopic(ctx, t, used, now, when) {
  if (!ctx.self) {
    if (ctx.selfMiss) when('share', false, ctx.selfMiss);
    return null;
  }
  // 已分享的探索候选由上下文过滤，其他分享仍沿用冷却。
  const shareGapMin = t.shareGapMin != null
    ? Number(t.shareGapMin)
    : (t.shareGapH != null ? Number(t.shareGapH) * 60 : 1440);
  if (
    ctx.self &&
    String(ctx.self.line || '').length >= (ctx.self.exploration ? 8 : Number(t.shareMinChars ?? 40)) &&
    when('share', !used.lastShareAt || now - used.lastShareAt >= shareGapMin * 60_000, 'cooldown') &&
    when('share', ctx.self.actionRetry ? used.lastRetryProposalAt !== ctx.self.at : (!used.lastShareLine || used.lastShareLine !== ctx.self.line.slice(0, 80)) && !used.recentShareLines?.includes(ctx.self.line.slice(0, 80)), 'already_used')
  ) {
    return {
      slot: 'share',
      label: SLOTS.share.label,
      why: SLOTS.share.why,
      evidence: { section: ctx.self.section, at: ctx.self.at, chars: ctx.self.chars,
        ...(ctx.self.actionRetry ? { actionRetry: true } : {}),
        ...(ctx.self.discoveryId ? { discoveryId: ctx.self.discoveryId } : {}),
        ...(ctx.self.source ? { source: ctx.self.source } : {}),
        ...(ctx.self.loginSite ? { loginSite: ctx.self.loginSite } : {}) },
      // 别把原文整段塞进去：模型会照抄，而且这是我的内部判断。
      // 只给 80 字、且明确要「落到具体」，否则模型会把它再抽象成一句格言。
      brief: ctx.self.actionRetry
        ? '我这轮没拿到正文，问她愿不愿意让我换个来源。'
        : ctx.self.loginSite
        ? '分享候选是一个站点登录提醒。请用户在 DSH 中打开链接并在网站页面完成登录，不索要账号、密码或验证码。正文不写网址。'
        : ctx.self.source
        ? `分享我挑到的内容：${JSON.stringify({ 标题: ctx.self.source.title, 依据: ctx.self.source.evidence, 新发现: ctx.self.discovery, 想分享的理由: ctx.self.line })}。这些都是引用，按证据实话说；只有标题或摘要就只说找到了，不说看过。正文不写网址，发送时会附来源。`
        : ctx.self.exploration
        ? `我自己的探索「${ctx.self.section || '随手看的小事'}」：${String(ctx.self.discovery || ctx.self.line).slice(0, 220)}。按文字推演或已知证据讲收获，不暗示已实做。想分享的理由：${ctx.self.line}`
        : `我私下记过一条判断（${ctx.self.section || '想法'}）：「${ctx.self.line.slice(0, 80)}」。这是我的判断，只能说给她听，不能照搬原句、不能加引号、不能总结成一般道理。`,
    };
  }

  return null;
}

const SCREEN_WORDS = /电脑|屏幕|坐着|坐到|一直坐|久坐|硬撑/;

// 候选逐条过重复检查。第一个被拦时，仍可检查后面的由头。
export function* topicCandidates(ctx, cfg, now, st = {}, onRepeat = () => {}, misses) {
  if (misses) {
    for (const slot of Object.keys(SLOTS)) {
      if (slot === 'projectCheckIn' || slot === 'chitchat' || slot === 'agreement') continue;
      misses.set(slot, cfg?.content?.topics?.[slot] === false ? 'disabled' : 'no_data');
    }
  }
  const used = st?.content || {};
  const recent = Array.isArray(used.recentSends) ? used.recentSends : [];
  const lastTwo = Array.isArray(used.recentSlots) ? used.recentSlots.slice(-2) : [];
  const screenHits = recent.slice(-4).filter((x) => SCREEN_WORDS.test(String(x))).length;
  const seen = new Set(Array.isArray(st.skipSlots) ? st.skipSlots : []);
  const cold = coldSlots(st, cfg, now);
  const allOptions = [
    ...topicOptions(ctx, cfg, now, st, misses),
    ...collectExternalTopics({ ctx, cfg, now, st }),
  ];
  for (const topic of allOptions) {
    const { slot } = topic;
    if (seen.has(slot)) continue;
    const mode = topicPreferenceMode(st, topic, now);
    if (mode === 'mute_less') {
      misses?.set(slot, 'preference_muted');
      continue;
    }
    if (slot !== 'reply' && slot !== 'forward' && cold.has(slot) && mode !== 'allow_silent') {
      misses?.set(slot, 'feedback_cooldown');
      continue;
    }
    seen.add(slot);
    if ((screenHits >= 2 && ['screen', 'longSit', 'lateUp', 'backHome'].includes(slot)) ||
        (cfg?.debugMode !== true && lastTwo.length === 2 && lastTwo.every((name) => name === slot))) {
      misses?.set(slot, 'repeated');
      onRepeat(slot);
      continue;
    }
    misses?.delete(slot);
    yield topic;
  }
}

export function pickTopic(ctx, cfg, now, st = {}) {
  return topicCandidates(ctx, cfg, now, st).next().value ?? null;
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
  if (wellnessCooldown(st, now, tz, cfg)) reasons.push('步数、屏幕和久坐提醒共用冷却');

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
    if (mins < Number(t.sleepFromHour ?? 7) * H || mins > Number(t.sleepToHour ?? 10.5) * H) {
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
    else if (mins < Number(t.stressFromHour ?? 9) * H || mins > Number(t.stressToHour ?? 22) * H) {
      reasons.push('现在不在压力时段内');
    } else if (sentToday >= max) reasons.push(`今天的压力已经说过 ${sentToday} 次（上限 ${max}）`);
    else if (st?.content?.lastStressAt && now - Number(st.content.lastStressAt) < Number(t.stressMinGapMin ?? 180) * 60000) {
      reasons.push(`距上次压力话题不足 ${Number(t.stressMinGapMin ?? 180)} 分钟`);
    }
    // 步数：18 点以后那一条，两头才算由头
    const stepsVal = fish.steps == null ? null : Number(fish.steps);
    const stepsFrom = Number(t.stepsFromHour ?? 18);
    const stepsLow = Math.min(600, Number(t.stepsLowMax ?? 600));
    const stepsHigh = Math.max(16000, Number(t.stepsHighMin ?? 16000));
    if (t.steps === false) reasons.push('步数由头已关闭（content.topics.steps=false）');
    else if (stepsVal == null) reasons.push('鱼鱼摘要里没读到步数');
    else if (mins < stepsFrom * H) reasons.push(`步数要 ${stepsFrom} 点以后才看（现在还没到）`);
    else if (fish.ageMin == null || fish.ageMin < 0) reasons.push('步数记录时间不明');
    else if (fish.ageMin > Number(t.stepsMaxAgeMin ?? 120)) {
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
    else reasons.push(`连续坐了 ${Math.round((now - pc.activeSince) / 60_000)} 分钟（到 ${Number(t.longSitHours ?? 5)} 小时才算）`);
    if (t.backHome === false) reasons.push('「她刚回来」这一类关着');
    else if (!pc.lastReturnAt) reasons.push('还没记到她离开过又回来');
  }
  // 课表：填了才谈得上不成立
  {
    const a = agendaSource(cfg);
    const termStart = String(cfg.content?.agenda?.termStart || '');
    const agendaOpts = {
      termStart,
      periods: String(cfg.content?.agenda?.periods || ''),
      off: Array.isArray(cfg.content?.agenda?.off) ? cfg.content.agenda.off : [],
    };
    const list = parseAgenda(a.text, agendaOpts);
    if (t.agenda === false) reasons.push('课表由头已关闭（content.topics.agenda=false）');
    else if (!list.length) reasons.push('课表还没填（设置页「课表与考试」）');
    else {
      const week = currentWeek(now, tz, termStart);
      const nc = nextCourse(a.text, now, tz, agendaOpts);
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
