// snapshot.js —— 把「此刻处境」打包成一份给模型看的纯文本。
//
// 为什么单独一个文件：阶段 2 想让模型自己判断「现在要不要开口、说什么」，
// 那就得先把它能知道的事摊在一张纸上——判定用的材料和写句子用的材料是同一份，
// 但拼装方式和 compose 的 prompt 不一样（这里只有事实，没有写作指令）。
//
// 只读、纯函数、不叫模型：给定假 ctx / state，能单测每一段在不在。
// 末段「规则建议」是 pickTopic 的结果，**降级成 hint**：模型可以参考，也可以不用。
import { agendaSource, coursesOn, nextCourse, currentWeek, weekdayOf } from './agenda.js';
import { examsSource, parseExams, dayDiff } from './exams.js';
import { signalFacts } from './signals.js';
import { slotStats, recentPairs } from './feedback.js';
import { dayKey, hhmm, minutesOfDayOf, minToHm } from './time.js';
import { SLOTS } from './topics.js';

const DAY = 86_400_000;
const WEEK = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

/** 分钟数 → 「1 小时 20 分钟」，用于睡眠这类。 */
function fmtMin(min) {
  const n = Math.max(0, Math.round(Number(min) || 0));
  const h = Math.floor(n / 60);
  const m = n % 60;
  if (!h) return `${m} 分钟`;
  return m ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

/** 一天里的时段，给人看的。 */
export function periodOf(now, tz) {
  const mins = minutesOfDayOf(now, tz);
  if (mins < 5 * 60) return '深夜';
  if (mins < 8 * 60) return '清早';
  if (mins < 11 * 60) return '上午';
  if (mins < 13 * 60) return '中午';
  if (mins < 17 * 60) return '下午';
  if (mins < 19 * 60) return '傍晚';
  if (mins < 23 * 60) return '晚上';
  return '深夜';
}

/** 多久以前 → 「刚刚 / 23 分钟前 / 3 小时前 / 2 天前」。 */
export function agoText(sec) {
  const s = Number(sec);
  if (!Number.isFinite(s) || s < 0) return '';
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

const ACT_WHERE = {
  game: '在打游戏',
  coding: '在写代码',
  media: '在看视频/放东西',
  'game-open': '没在玩，但游戏还开着',
  'ide-open': '没在写，但编辑器还开着',
};

/**
 * 拼一份快照。
 * ctx / st / topic 都按现有结构吃，缺哪块就整段省略——宁可少一段，也不写「未知」占位。
 * 返回纯文本：段落之间空一行，段落内部一行一条。
 */
export function buildSnapshot({ ctx = {}, topic = null, cfg = {}, st = {}, now = Date.now(), tz } = {}) {
  const zone = tz || ctx.tz || cfg?.timezone || 'Asia/Shanghai';
  const clock = ctx.clock || hhmm(now, zone);
  const wd = WEEK[weekdayOf(now, zone)] || '';
  const blocks = [];

  // —— 现在
  blocks.push([`现在：${dayKey(now, zone)} ${wd} ${clock}（${periodOf(now, zone)}）`]);

  // —— 这一拍为什么轮到我了（阶段 3 的自然触发；没有就整段不出现）
  if (ctx.trigger?.label) blocks.push([`刚发生：${ctx.trigger.label}。`]);

  // —— 她 / 我 最后说的话（只说人话，不解释「怎么知道的」）
  const her = ctx.her || {};
  const me = ctx.me || {};
  const dialog = [];
  // 她那条已经在它自己的通道回过我了（抖音值班鱼答过的），就别再把它摆成「这一拍要说的事」——
  // 2026-11-09 20:43 judge 就是看了这句，挑成「接住她发来的动画」，然后在 QQ 上又答了一遍。
  const herAnswered = Boolean(her.lastText) && her.answeredOnOwnChannel === true;
  if (her.lastText) {
    const chTag = her.lastChannel === 'douyin' ? '，抖音' : her.lastChannel === 'qq' ? '，QQ' : '';
    const answeredTag = herAnswered ? '，我已经在那边回过了——别再答一遍，也别拿它当这一拍的事' : '';
    dialog.push(`她最后一条：「${String(her.lastText).slice(0, 160)}」（${agoText(her.lastAgoSec) || '时间不明'}${chTag}${answeredTag}）`);
  }
  if (me.lastText) dialog.push(`我最后一条：「${String(me.lastText).slice(0, 120)}」（${agoText(me.lastAgoSec) || '时间不明'}）`);
  if (dialog.length) blocks.push(dialog);

  // —— 阶段 1.2：她的在场，写成「两种事实描述」，交给模型判断要不要等
  //    只在 presenceSignal 开着（且 judge 开着）时出现；关着时快照与 0.13 逐字一致。
  if (cfg?.rules?.presenceSignal?.enabled === true && cfg?.rules?.judge?.enabled === true) {
    const awaySec = Number(cfg?.idle?.awaySec ?? 600) || 600;
    const idle = Number(ctx.presence?.idleSec);
    const herAgoSec = Number(her.lastAgoSec);
    // 她最近 30 分钟在手机/QQ 说过话 → 先按「可能在」写（比「电脑判定不在」更有用）
    if (Number.isFinite(herAgoSec) && herAgoSec >= 0 && herAgoSec <= 30 * 60) {
      blocks.push([`她的在场：她 ${agoText(herAgoSec)}在手机上说过话（可能在）。`]);
    } else if (Number.isFinite(idle) && idle > awaySec) {
      const herAgo = her.lastAgoSec == null ? null : agoText(her.lastAgoSec);
      blocks.push([
        `她的在场：电脑判定不在（${fmtMin(Math.round(idle / 60))}没碰电脑），${herAgo ? `她最后一次说话在 ${herAgo}` : '最近没读到她在任何通道说过话'}（手机情况未知）。`,
        '不确定她什么时候看得到——要说就说不要求马上回应的话。',
      ]);
    }
  }

  // —— 她在电脑前干什么：L2 归类 + 结构化信号 + 离开/回来
  const pcLines = [];
  const act = ctx.activity || null;
  if (act) {
    const where = ACT_WHERE[act.kind];
    const fg = String(act.fgTitle || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (where) pcLines.push(`她电脑前：${where}${fg ? `（窗口「${fg}」）` : ''}`);
    else if (fg) pcLines.push(`她电脑前台窗口：「${fg}」`);
    if (act.speaking) pcLines.push('电脑正在放声音');
  }
  for (const x of signalFacts(ctx.signals)) pcLines.push(x);
  const idleSec = Number(ctx.presence?.idleSec);
  if (Number.isFinite(idleSec) && idleSec >= 0) {
    pcLines.push(idleSec < 120 ? '她现在就在电脑前（刚有动静）' : `她 ${fmtMin(Math.round(idleSec / 60))}没碰电脑`);
  }
  const pc = st?.pc || {};
  if (pc.lastReturnAt && now - Number(pc.lastReturnAt) <= 30 * 60_000) {
    pcLines.push(`她出去过 ${fmtMin(Math.round(Number(pc.lastAwayMs || 0) / 60_000))}，${hhmm(Number(pc.lastReturnAt), zone)} 刚回到电脑前`);
  }
  if (pcLines.length) blocks.push(pcLines);

  // —— 她的身体数据（鱼鱼），带「多久前取回的」——数据老了就不该当新鲜事问
  const f = ctx.fish || {};
  if (f.ok) {
    const fishLines = [];
    const age = Number.isFinite(Number(f.ageMin)) ? `（${fmtMin(Number(f.ageMin))}前取回）` : '';
    fishLines.push(`她的身体数据${age}：`);
    if (f.sleepMin != null) fishLines.push(`· 昨夜睡眠 ${fmtMin(f.sleepMin)}${f.deepMin != null ? `（深睡 ${fmtMin(f.deepMin)}）` : ''}`);
    if (f.bedHm) fishLines.push(`· 邮件里的入睡时间 ${f.bedHm}`);
    if (f.stress != null) fishLines.push(`· 压力 ${f.stress}`);
    if (f.steps != null) fishLines.push(`· 今日步数 ${f.steps}`);
    if (f.screenMin != null) fishLines.push(`· 今日屏幕 ${fmtMin(f.screenMin)}`);
    if (fishLines.length > 1) blocks.push(fishLines);
  }

  // —— 课表 / 考试
  const agenda = [];
  try {
    const src = agendaSource(cfg);
    if (src.text.trim()) {
      const week = currentWeek(now, zone, cfg?.content?.agenda?.termStart);
      const today = coursesOn(src.text, weekdayOf(now, zone), { week, off: cfg?.content?.agenda?.off });
      if (today.length) {
        agenda.push(`今天有课：${today.map((c) => `${minToHm(c.fromMin)}-${minToHm(c.toMin)}${c.name ? `「${c.name}」` : ''}`).join('、')}`);
      }
      const nc = nextCourse(src.text, now, zone, { termStart: cfg?.content?.agenda?.termStart, off: cfg?.content?.agenda?.off });
      if (nc) {
        const when = nc.inDays === 0 ? '今天' : nc.inDays === 1 ? '明天' : `${nc.inDays} 天后`;
        agenda.push(`下一节：${when} ${minToHm(nc.fromMin)}${nc.name ? `「${nc.name}」` : ''}`);
      }
    }
  } catch {
    /* 课表读不到就整段省掉 */
  }
  try {
    const es = examsSource(cfg);
    if (es.text.trim()) {
      const list = parseExams(es.text, { tz: zone, now });
      const next = list.filter((e) => e.at > now).sort((a, b) => a.at - b.at).slice(0, 2);
      for (const e of next) {
        const dd = dayDiff(e, now, zone);
        agenda.push(`考试：${e.subject || '一场考试'} ${e.date} ${e.hm}${e.room ? `（${e.room}）` : ''}，还有 ${dd} 天`);
      }
    }
  } catch {
    /* 考试表读不到就省掉 */
  }
  if (agenda.length) blocks.push(agenda);

  // —— 我私下记过的判断（self.md 最新一条，非私密）
  if (ctx.self?.line) {
    const line = String(ctx.self.line);
    blocks.push([`我私下记过一条判断（${ctx.self.section || '想法'}）：「${line.length > 160 ? `${line.slice(0, 160)}…` : line}」`]);
  }

  // —— 阶段 3：我们刚才聊到哪（双方原文，旧的在前）
  const turns = Array.isArray(ctx.dialogueTurns) ? ctx.dialogueTurns : [];
  if (turns.length) {
    blocks.push(['最近聊到哪（旧的在前）：', ...turns.map((t) => `${t.who === 'her' ? '她' : '我'}：${String(t.text || '').slice(0, 80)}`)]);
  }

  // —— 我最近真发出去的几条（跨通道）
  const recentOut = Array.isArray(ctx.recentOutbound) ? ctx.recentOutbound.slice(0, 5) : [];
  if (recentOut.length) {
    blocks.push([
      '我最近发出去的：',
      ...recentOut.map((r) => `· 「${String(r.text).slice(0, 80)}」（${r.channel === 'qq' ? 'QQ' : '抖音'}，${agoText((now - Number(r.ts || 0)) / 1000)}）`),
    ]);
  }

  // —— 阶段 2：最近的对话配对（我拿什么开口 → 她怎么回）
  //    每类最近 2 条；一对都没有就整段省略。
  if (st && typeof st === 'object') {
    const pairLines = [];
    for (const slot of Object.keys(SLOTS)) {
      for (const p of recentPairs(st, slot, 2)) {
        if (!p.myDraft) continue;
        const lat = Math.max(0, Number(p.latencyMin) || 0);
        const latText = lat <= 1 ? '马上' : lat < 60 ? `过了 ${lat} 分钟` : `过了 ${Math.round(lat / 60)} 小时`;
        // 判定在 feedback.classify 里做过，这里只翻成人话；别用延迟猜「没接住」——
        // 晚上发、第二天早上回是正常的，猜错会把语气带偏。
        const kind = p.kind || (lat <= 45 ? 'hit' : lat <= 240 ? 'late' : 'stray');
        const tag = kind === 'hit' ? '（接住了）' : kind === 'stray' ? '（隔了很久才回）' : '';
        const reply = p.herReply ? `回「${p.herReply}」` : '（原文没读到）';
        pairLines.push(`· ${SLOTS[slot]?.label || slot}：「${p.myDraft}」→ 她${latText}${reply}${tag}`);
      }
    }
    if (pairLines.length) blocks.push(['你最近的对话配对：', ...pairLines]);
  }

  // —— 每类由头她接住的比例
  if (st && typeof st === 'object' && cfg?.rules?.feedback?.enabled !== false) {
    const stats = slotStats(st);
    const rows = Object.entries(stats)
      .filter(([, s]) => Number(s.sent) > 0)
      .sort((a, b) => Number(b[1].sent) - Number(a[1].sent))
      .slice(0, 8)
      .map(([slot, s]) => `· ${SLOTS[slot]?.label || slot} ${s.replied}/${s.sent}${s.sent ? `（${Math.round((Number(s.replied) / Number(s.sent)) * 100)}%）` : ''}`);
    if (rows.length) blocks.push(['她接过我哪类话：', ...rows]);
  }

  // —— 别的记忆插件里记着的事（读不到就整段省略）
  const mem = Array.isArray(ctx.memory?.items) ? ctx.memory.items : [];
  if (mem.length) {
    blocks.push([
      '我记得的事（只当背景，不要背出来）：',
      ...mem.slice(0, 5).map((m) => `· ${String(m.text || '').slice(0, 120)}${m.day ? `（${m.day}）` : ''}`),
    ]);
  }

  // —— 规则建议（降级成 hint）
  if (topic?.slot === 'chitchat') {
    // 随口说话跟别的由头不一样：这一拍没有任何数据在推着我说，
    // 所以要把这件事说清楚，judge 才不会假装自己在接某件事。
    blocks.push([
      '规则建议（可参考也可不用）：这一拍没有任何数据由头。这是一次「随口说话」的候选——' +
        '没有新闻、没有她刚说的话、没有一条数据。要不要说、说什么，你自己判。',
    ]);
  } else if (topic) {
    blocks.push([`规则建议（可参考也可不用）：${topic.label || topic.slot}——${String(topic.brief || topic.why || '').slice(0, 160)}`]);
  } else {
    blocks.push(['规则建议（可参考也可不用）：这一拍规则没挑出由头']);
  }

  return blocks.map((b) => b.filter(Boolean).join('\n')).join('\n\n');
}