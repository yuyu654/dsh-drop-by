// shadow.js —— 阶段 4：judge 预演（shadow）。
//
// 护栏拦下的拍子也把快照丢给模型判一次，**只记不发**，攒真实数据看它的判断分布。
// 两个硬规矩：
//   1) 必须随机采样——被拦的拍子一天上百，不能每次都烧一次模型调用；
//   2) 结果只进 state.judgeShadow，**绝不碰 feedback / pending / slots**：
//      她根本没收到，记进接住率就是假数据。
import { buildSnapshot } from './snapshot.js';
import { judgeDecision } from './judge.js';
import { dayKey } from './time.js';

const SKIP_BURN = new Set(['GLOBAL_QUIET', 'PLUGIN_DISABLED', 'DATA_UNAVAILABLE', 'BUSY_HOURS', 'CHARACTER_ASLEEP', 'USER_WINDING_DOWN', 'CONTENT_DISABLED']);

/** 这一拍该不该拿去预演（纯判定，方便单测）。 */
export function shadowEligible(cfg, reason) {
  if (cfg?.rules?.judge?.shadow !== true) return false;
  if (cfg?.rules?.judge?.enabled !== true) return false;
  return !SKIP_BURN.has(String(reason || ''));
}

export function shadowRate(cfg) {
  const r = Number(cfg?.rules?.judge?.shadowSampleRate ?? 0.25);
  if (!Number.isFinite(r)) return 0.25;
  return Math.max(0, Math.min(1, r));
}

/**
 * 跑一次预演（调用方已经确认 eligible + 采样命中）。
 * random 可注入，测试才能确定地命中/不命中。
 */
export async function runShadow({ cfg, now, tz, st = {}, ctx, persona = null, generate, llmReady = null, blockedBy = '', topic = null }) {
  const snapshot = buildSnapshot({ ctx, topic, cfg, st, now, tz });
  const v = await judgeDecision({ snapshot, persona, cfg, generate, llmReady });
  const day = dayKey(now, tz);
  const prev = st.judgeShadow && st.judgeShadow.day === day ? st.judgeShadow : null;
  const sh = prev || { day, asked: 0, sayTrue: 0, sayFalse: 0, parseFail: 0, last: null };
  sh.asked += 1;
  if (!v?.ok) sh.parseFail += 1;
  else if (v.say === true) sh.sayTrue += 1;
  else sh.sayFalse += 1;
  sh.last = {
    at: now,
    blockedBy,
    say: v?.ok ? v.say : null,
    angle: v?.angle || '',
    why: v?.why || '',
    fallback: !v?.ok,
    reason: v?.ok ? '' : v?.reason || '',
  };
  st.judgeShadow = sh;
  return sh.last;
}

/** --why 的一行。没预演过返回空串。 */
export function shadowLine(st, cfg) {
  if (cfg?.rules?.judge?.shadow !== true) return '';
  const sh = st?.judgeShadow;
  if (!sh || !Number(sh.asked)) return 'judge 预演（今日）：还没问过';
  return `judge 预演（今日）：问 ${sh.asked} 次，会说 ${sh.sayTrue} / 不说 ${sh.sayFalse}，解析失败 ${sh.parseFail}`;
}