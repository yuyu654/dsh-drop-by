// noreply.js —— 「我主动找过她，她一直没回」这条追问。
//
// 两条来源，各管各的：
//   · QQ / 主动私聊：看 feedback.pending（真发出去时记下的那条），只认「她之后一句都没说」。
//   · 抖音分享：看抖音自己的出站记录（douyinLastOutbound），有单独开关，没装抖音插件就不参与。
//
// 时间规则（都能在设置页改）：
//   1) 距我那条至少 noReplyMin 分钟没动静（默认 120）
//   2) 她最后一次说话之后至少 noReplyAfterHerMin 分钟（默认 120，防止她刚说完就被追）
//   3) 先让模型判一句「她是去忙了/睡了」还是「在回避」：
//      · 忙/睡 → 等她忙完（模型给的 until，或忙碌时段结束）之后再等 noReplyAfterBusyMin 分钟（默认 20）
//      · 不是忙 → 只要满足 2) 就可以问
// 判不准、模型没开、解析失败，一律当「不是忙」——宁可早问一句，不要凭空替她编一个理由。

import { douyinLastOutbound } from './outbound.js';
import { hhmm, hmToMin, minutesOfDayOf } from './time.js';
import { lastBusyEnd, isHoliday } from './holidays.js';

const MIN = 60_000;
export const WAIT_FOR_USER_RULE = '只等用户完成某事、说好改完发图、用户说先忙或话题已结束时，沉默或过了很久都不能当成追问的理由。只有用户明确约好提醒，或相关事项有了实际变化，才重新考虑。';
const BACKGROUND_SLOTS = new Set(['steps', 'screen', 'longSit']);
const CASUAL_SLOTS = new Set(['share', 'chitchat', 'catchup', 'backHome', 'qqContinuation']);

function lastFollowUpTime(st) {
  // 旧状态只有被追问那条的 key。反馈还能排除那次追问前积压的消息。
  const prior = /^(?:qq|douyin):(\d+)$/.exec(st?.content?.lastNoReplyFor || '');
  const pending = Array.isArray(st?.feedback?.pending) ? st.feedback.pending : [];
  return Math.max(Number(prior?.[1]) || 0, Number(st?.feedback?.slots?.noReply?.lastSentAt) || 0,
    ...pending.filter((p) => p?.slot === 'noReply').map((p) => Number(p.ts) || 0));
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function thresholdMin(cfg) {
  return Math.max(1, num(cfg?.content?.topics?.noReplyMin, 120));
}

/** "20:30" → 下一个 20:30 的时间戳（今天过了就是明天）；非法 → 0 */
export function hmStrictNext(hm, now, tz) {
  const target = hmToMin(hm);
  if (target == null || target < 0) return 0;
  const cur = minutesOfDayOf(now, tz);
  const midnight = now - cur * MIN;
  return target > cur ? midnight + target * MIN : midnight + (target + 1440) * MIN;
}

/** QQ 侧：挑最新一条够久、尚未被回应的候选。 */
export function pendingFromFeedback(st, cfg, now, herTs = null) {
  const pend = Array.isArray(st?.feedback?.pending) ? st.feedback.pending : [];
  // expect === false 的是「回她 / 接转发」：我回完一句、她看完就走，不叫「没回」，
  // 更不能拿它当追问的由头——不然最后一句是我也要追一句。
  const cutoff = Math.max(Number(herTs) || 0, lastFollowUpTime(st));
  const p = pend.filter((entry) => entry?.expect !== false && entry?.slot && entry.slot !== 'noReply' && !BACKGROUND_SLOTS.has(entry.slot) &&
    (cfg?.content?.topics?.followCasualSilence === true || !CASUAL_SLOTS.has(entry.slot)) &&
    (!cfg?.channels?.primary || (entry.channel || 'qq') === cfg.channels.primary) &&
    Number(entry.ts) > cutoff && now - Number(entry.ts) >= thresholdMin(cfg) * MIN)
    .sort((a, b) => Number(b.ts) - Number(a.ts))[0];
  if (!p) return null;
  return {
    channel: p.channel || 'qq',
    at: Number(p.ts),
    slot: String(p.slot || ''),
    text: String(p.draft || p.text || ''),
    silenceMin: Math.round((now - Number(p.ts)) / MIN),
    key: `${p.channel || 'qq'}:${Number(p.ts)}`,
  };
}

/** 抖音侧：我分享出去的那条她没接（没装抖音插件 / 关掉开关就不参与） */
export function pendingFromDouyin({ cfg, now, herTs, lastOut = null, herOnDouyin = 0 }) {
  const t = cfg?.content?.topics || {};
  if (t.noReplyDouyin === false) return null;
  if (cfg?.sources?.douyin?.enabled !== true) return null;
  const out = lastOut || douyinLastOutbound({ cfg });
  const ts = Number(out?.ts) || 0;
  if (!ts) return null;
  // 她之后说过话就不算没回 —— 但「之后」必须把**抖音那条时间线**算进来：
  // 只看 QQ 的 herTs 时，她在抖音回过、QQ 又早没说话，就会被当成没回（2026-11-07 她收到的那句追问）。
  const herDy = Number(herOnDouyin) || 0;
  if (Math.max(Number(herTs) || 0, herDy) > ts) return null;
  if (now - ts < thresholdMin(cfg) * MIN) return null;
  // 分享卡片的消息文本就是视频标题：带着它，追问时才说得出「哪条」
  // （之前这里写死 text: ''，模型只能写「那条视频」，她根本不知道是哪条）。
  const isCard = out?.kind === 'card';
  return {
    channel: 'douyin',
    at: ts,
    slot: 'share',
    text: isCard ? '' : String(out?.text || ''),
    title: isCard ? String(out?.text || '') : '',
    item: out?.item || null,
    kind: out?.kind || null,
    silenceMin: Math.round((now - ts) / MIN),
    key: `douyin:${ts}`,
  };
}

/** 两条来源里挑最近的一条（离现在越近越值得问） */
export function pickNoReply({ st, cfg, now, herTs = null, douyinOut = null, herOnDouyin = 0 }) {
  const cutoff = lastFollowUpTime(st);
  const list = [
    pendingFromFeedback(st, cfg, now, herTs),
    !cfg?.channels?.primary && cfg?.content?.topics?.followCasualSilence === true
      ? pendingFromDouyin({ cfg, now, herTs, lastOut: douyinOut, herOnDouyin }) : null,
  ].filter((candidate) => candidate && candidate.at > cutoff);
  if (!list.length) return null;
  return list.sort((a, b) => b.at - a.at)[0];
}

/**
 * 时间窗判定。cand.verdict 是模型那次的判断（可能为 null）。
 * 返回 { ok, why?, dueAt? }。
 */
export function noReplyDue({ cand, cfg, now, herTs = null, tz }) {
  if (cand?.verdict?.followUp === false) return { ok: false, why: '没有可核对的提醒约定' };
  const t = cfg?.content?.topics || {};
  const afterHerMin = Math.max(0, num(t.noReplyAfterHerMin, 120));
  const afterBusyMin = Math.max(0, num(t.noReplyAfterBusyMin, 20));

  if (herTs && now - herTs < afterHerMin * MIN) {
    const left = Math.ceil((afterHerMin * MIN - (now - herTs)) / MIN);
    return { ok: false, why: `她 ${Math.round((now - herTs) / MIN)} 分钟前才说过话，还要再等 ${left} 分钟` };
  }

  const v = cand?.verdict || null;
  if (v && v.away) {
    let due = 0;
    let src = '';
    if (v.untilHm) {
      // 以「我发出去那一刻」为参照算她忙到几点：模型看到的是当时的对话，
      // 21:30 指的是我发消息之后的那个 21:30，不是「下一个 21:30」。
      const ref = Number(cand.at) || now;
      due = Math.max(due, hmStrictNext(v.untilHm, ref, tz) + afterBusyMin * MIN);
      src = `她大概忙到 ${v.untilHm}`;
    }
    const busyEnd = lastBusyEnd(now, cfg);
    if (busyEnd) {
      const d2 = busyEnd + afterBusyMin * MIN;
      if (d2 > due) {
        due = d2;
        src = '忙碌时段结束';
      }
    }
    if (due > now) {
      return {
        ok: false,
        why: `${src || '判断她在忙'}，${afterBusyMin} 分钟后才可以问（还有 ${Math.ceil((due - now) / MIN)} 分钟）`,
        dueAt: due,
      };
    }
  }
  return { ok: true };
}

/** 给模型看的判断材料：只给对话和时段，不给截图，不下结论 */
export function judgePrompt({ cand, ctx, cfg, now, tz }) {
  const her = ctx?.her || {};
  const herTs = Number(her.lastTs) || 0;
  const lines = [];
  const what =
    cand.kind === 'card'
      ? `分享了一条视频：${String(cand.title || '').slice(0, 120)}`
      : `发了一条消息：『${String(cand.text || '').slice(0, 120)}』`;
  lines.push(
    `现在 ${hhmm(now, tz)}。我在 ${hhmm(cand.at, tz)} ${what}，到现在 ${cand.silenceMin} 分钟没回。`
  );
  if (herTs) {
    lines.push(
      `她最后一条消息是 ${hhmm(herTs, tz)}（${Math.round((now - herTs) / MIN)} 分钟前）：『${String(
        her.lastText || ''
      ).slice(0, 200)}』`
    );
  } else {
    lines.push('她今天还没说过话。');
  }
  const recent = Array.isArray(ctx?.recent) ? ctx.recent.slice(-6) : [];
  if (recent.length) {
    const body = recent
      .map((r) => `· ${r.from === 'her' ? '她' : '我'}：${String(r.text || '').slice(0, 80)}`)
      .join('\n');
    lines.push(`最近的对话：\n${body}`);
  }
  const busy = isHoliday(now, cfg) ? [] : (Array.isArray(cfg?.busyHours) ? cfg.busyHours : []);
  if (busy.length) {
    const txt = busy.map((w) => (Array.isArray(w) ? w.join('-') : String(w))).join('、');
    lines.push(`她平时这些时段忙：${txt}`);
  }
  lines.push(
    '',
    WAIT_FOR_USER_RULE,
    'followUp 仅在用户亲口明确要求就这件事在当前时刻或条件下提醒，且对应约定仍然有效时为 true。quote 必须逐字引用那段用户原话。未明确同意、事项已完成、目标时间未到或有歧义，一律 false。',
    'away 表示有迹象显示她此刻在忙或睡了。只凭未回无法推断她在回避。',
    '只看上面这些和现在的时间；判不准就写 false，别替她编理由。',
    '只输出一行 JSON，不要别的字：',
    '{"away": false, "until": null, "why": "没有在忙的证据", "followUp": false, "quote": ""}',
    'away=false 时 until 必须是 null。'
  );
  return lines.join('\n');
}

/**
 * 让模型判一次。generate 走 engine 注进来的那个（命令行走 dsh 子进程）。
 * 解析失败或没有有效约定时，调度器不会把它列入追问候选。
 */
export async function judgeAway({ cand, ctx, cfg, now, tz, generate, llmReady = null }) {
  if (llmReady === false || typeof generate !== 'function') {
    return { away: false, untilHm: null, why: '', judge: 'off' };
  }
  try {
    const r = await generate({ prompt: judgePrompt({ cand, ctx, cfg, now, tz }), cfg, timeoutMs: cfg?.content?.topics?.noReplyJudgeTimeoutMs ?? 90_000, reasoningEffort: 'off', tag: 'noreply-judge' });
    if (!r?.ok) return { away: false, untilHm: null, why: '', judge: 'error', reason: String(r?.reason || '') };
    const m = /\{[\s\S]*\}/.exec(String(r.text || ''));
    if (!m) return { away: false, untilHm: null, why: '', judge: 'bad', reason: 'NOT_JSON' };
    let j = null;
    try {
      j = JSON.parse(m[0]);
    } catch {
      return { away: false, untilHm: null, why: '', judge: 'bad', reason: 'JSON_PARSE' };
    }
    const away = j?.away === true;
    const hm = /^(\d{1,2}):(\d{2})$/.exec(String(j?.until ?? '').trim());
    const untilHm = away && hm ? `${String(Number(hm[1])).padStart(2, '0')}:${hm[2]}` : null;
    const quote = typeof j?.quote === 'string' ? j.quote.trim() : '';
    const userLines = [ctx?.her?.lastText, ...(ctx?.recent || []).filter((r) => r.from === 'her').map((r) => r.text)];
    const followUp = j?.followUp === true && quote.length >= 4 &&
      userLines.some((line) => typeof line === 'string' && line.includes(quote));
    return { away, untilHm, followUp, ...(followUp ? { quote } : {}), why: String(j?.why || '').slice(0, 20), judge: 'llm' };
  } catch (e) {
    return { away: false, untilHm: null, why: '', judge: 'error', reason: String(e?.message || e).slice(0, 160) };
  }
}
