// triggers.js —— 阶段 3：除了时钟，还有几个「本来就该开口」的时刻。
//
// 均匀的间隔本身露馅：人开口是被事情挑起的——一段活干完、刚下课、刚写下一条判断。
// 这里只回答「这一拍有没有这种事件」，**不决定发不发**：
//   静默、忙碌、离开、每日上限照样先拦；间隔要不要给事件让路，看 naturalTriggers.takeGap。
// 默认 enabled=false —— 整段不跑、连 state 都不碰，行为与加它之前完全一样。
//
// 三个事件（顺序即优先级）：
//   1) L2 归类切换：coding → media、media → coding ……「other」不算（那只是没认出来）
//   2) 课表上完一整段课之后的窗口：上午段上完一次、当天最后一节上完一次（一天最多两次）。
//      一天四五节逐节触发太密，段中间那节下课也没什么信息量。
//   3) self.md 新写条目：文件 mtime 比上次记录的新（第一次只记基线，不当事件）
import {
  agendaSource,
  parseAgenda,
  courseApplies,
  courseEnabled,
  courseSegments,
  currentWeek,
  weekdayOf,
} from './agenda.js';
import { minutesOfDayOf, dayKey, minToHm } from './time.js';

const L2_LABEL = {
  coding: '写代码',
  media: '看视频/听东西',
  game: '打游戏',
  'ide-open': '开着编辑器',
  'game-open': '开着游戏',
};

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** 给模型看的事实：最后一节是哪门、几点下课、在哪。不带语气。 */
function courseLabel(c) {
  const who = c?.name ? `最后一节「${c.name}」` : '最后一节课';
  const room = c?.room ? ` @${c.room}` : '';
  return `${who}${minToHm(c.toMin)} 下课${room}`;
}

/**
 * 这一拍有哪些自然触发时刻。
 *
 * @param {object} o
 * @param {object} o.cfg
 * @param {number} o.now
 * @param {string} o.tz
 * @param {object} o.st       state（会在这里就地更新 st.triggers，由 tick 统一落盘）
 * @param {object} [o.activity] classifyActivity() 的结果（l2）
 * @param {number} [o.selfMtimeMs] self.md 的 mtime
 * @returns {{enabled:boolean, fired:Array, gapAllowed:boolean, floorMin:number, state:object|null}}
 */
export function detectTriggers({ cfg, now, tz, st = {}, activity = null, selfMtimeMs = 0 }) {
  const nt = cfg?.rules?.naturalTriggers || {};
  const res = {
    enabled: nt.enabled === true,
    fired: [],
    // 事件拍能不能越过 minGap（默认不能：间隔地板照旧，事件只是「提前到那一秒」）
    gapAllowed: nt.takeGap === true,
    floorMin: clamp(Number(nt.floorMin ?? 20) || 20, 1, 1440),
    state: st.triggers || null,
  };
  if (!res.enabled) return res;

  st.triggers ||= {};
  const trg = st.triggers;

  // 1) L2 归类切换。只有两边都认出来了才算（other / 空 = 不知道在干什么，不当事件）
  const kind = String(activity?.kind || '');
  const prev = String(trg.lastKind || '');
  if (kind && prev && kind !== prev && prev !== 'other' && kind !== 'other') {
    res.fired.push({
      kind: 'l2',
      at: now,
      from: prev,
      to: kind,
      label: `刚把「${L2_LABEL[prev] || prev}」换成「${L2_LABEL[kind] || kind}」`,
    });
  }
  if (kind) trg.lastKind = kind;

  // 2) 课上完了：一天只给两个时刻——上午段整段上完、当天最后一节上完。
  //    段中间下课不触发；去重按段（'am' / 'pm'），旧 state 里的课程 key 直接忽略。
  const winMin = clamp(Number(nt.courseWindowMin ?? 20) || 20, 1, 60);
  const splitRaw = Number(nt.courseSplitMin ?? 720);
  const splitMin = clamp(Number.isFinite(splitRaw) ? splitRaw : 720, 0, 1440);
  const mins = minutesOfDayOf(now, tz);
  const wd = weekdayOf(now, tz);
  const day = dayKey(now, tz);
  try {
    const opts = {
      termStart: String(cfg?.content?.agenda?.termStart || ''),
      periods: String(cfg?.content?.agenda?.periods || ''),
    };
    const off = Array.isArray(cfg?.content?.agenda?.off) ? cfg.content.agenda.off : [];
    const week = currentWeek(now, tz, opts.termStart);
    const today = parseAgenda(agendaSource(cfg).text, opts).filter(
      (c) => c.weekday === wd && courseApplies(c, week) && courseEnabled(c, off),
    );
    const seg = courseSegments(today, splitMin);
    const done = trg.courseDone && trg.courseDone.day === day ? trg.courseDone : { day, keys: [] };
    const fire = (key, course, label) => {
      if (done.keys.includes(key)) return;
      if (!(mins >= course.toMin && mins < course.toMin + winMin)) return;
      done.keys = [...done.keys, key].slice(-20);
      res.fired.push({
        kind: key === 'am' ? 'course-am' : 'course-pm',
        at: now,
        atMin: course.toMin,
        name: course.name || '',
        room: course.room || '',
        label,
      });
    };
    // label 只是给模型看的事实由头（主题就是「下课了」），不是要照发的话；
    // 所以只写「哪一段完了 + 最后一节是哪节」，不替她宣布「今天的课都上完了」。
    if (seg.morning) {
      fire(
        'am',
        seg.morning,
        seg.onlyMorning
          ? `课上完了（${courseLabel(seg.morning)}）`
          : `上午的课上完了（${courseLabel(seg.morning)}）`,
      );
    }
    // 只有上午课时上面那一次就是全天的一次；不要再按下午段补一次
    if (!seg.onlyMorning && seg.last) {
      fire('pm', seg.last, `课上完了（${courseLabel(seg.last)}）`);
    }
    trg.courseDone = done;
  } catch {
    // 课表读不到：这一拍没有课上完了的事件，不影响别的触发
  }

  // 3) self.md 新写条目。第一次见到文件只记基线——否则插件一重启就会「刚写了一条」。
  const mt = Number(selfMtimeMs) || 0;
  if (mt > 0) {
    if (!trg.selfMtime) trg.selfMtime = mt;
    else if (mt > trg.selfMtime) {
      trg.selfMtime = mt;
      res.fired.push({ kind: 'self', at: now, atMs: mt, label: '刚在 self.md 里写下一条判断' });
    }
  }

  res.state = trg;
  return res;
}