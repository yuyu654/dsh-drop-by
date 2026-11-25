import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBusySpeech,
  extractBusyUntilMs,
  classifyMissCensor,
  updateReceptivity,
  scoreReceptivity,
} from '../src/receptivity.js';
import { detectWindDownSignals, closingCooldownActive } from '../src/chat-rhythm.js';
import { noteSent, settle, sweep } from '../src/feedback.js';
import { applyChange, listForUi } from '../src/settings.js';
import { loadConfig } from '../src/config.js';

test('receptivity：识别进行时在忙/上课/开会口语，排除问句与第三人称', () => {
  assert.equal(detectBusySpeech('我在上课呢'), true);
  assert.equal(detectBusySpeech('正在开会，晚点回你'), true);
  assert.equal(detectBusySpeech('忙着呢'), true);
  assert.equal(detectBusySpeech('开会到四点'), true);
  assert.equal(detectBusySpeech('我开会到晚上十点'), true);
  assert.equal(detectBusySpeech('我晚上十点前都在开会'), true);
  assert.equal(detectBusySpeech('在开会，到四点'), true);
  assert.equal(detectBusySpeech('明天晚上十点前都在开会'), false);
  assert.equal(detectBusySpeech('你在上课吗？'), false);
  assert.equal(detectBusySpeech('同学在上课'), false);
  assert.equal(detectBusySpeech('今天天气不错'), false);
});

test('receptivity：从忙碌说明提取结束时间并接入 closingCooldownActive', () => {
  // 2026-11-24 14:00:00+08:00
  const base = Date.parse('2026-11-24T14:00:00+08:00');
  const until = extractBusyUntilMs('在开会到四点', base, 'Asia/Shanghai');
  assert.equal(until, Date.parse('2026-11-24T16:00:00+08:00'));

  // 2026-11-24 20:00:00+08:00：「我开会到晚上十点」与「我晚上十点前都在开会」均应提取到 22:00 并触发冷静期
  const eve = Date.parse('2026-11-24T20:00:00+08:00');
  const tenPm = Date.parse('2026-11-24T22:00:00+08:00');
  assert.equal(extractBusyUntilMs('我开会到晚上十点', eve, 'Asia/Shanghai'), tenPm);
  assert.equal(extractBusyUntilMs('我晚上十点前都在开会', eve, 'Asia/Shanghai'), tenPm);
  for (const phrase of ['我开会到晚上十点', '我晚上十点前都在开会']) {
    const t = [{ who: 'her', text: phrase, ts: eve }];
    assert.equal(detectWindDownSignals(t).busySpeech, true, phrase);
    const cd = closingCooldownActive(t, { timezone: 'Asia/Shanghai', rules: { closingCooldownMin: 45 } }, eve + 90 * 60_000);
    assert.equal(cd.active, true, phrase);
    assert.equal(cd.remainMin, 30, phrase);
  }

  const half = extractBusyUntilMs('在忙，半小时后回你', base, 'Asia/Shanghai');
  assert.equal(half, base + 30 * 60_000);

  const turns = [{ who: 'her', text: '在开会到四点', ts: base }];
  const signals = detectWindDownSignals(turns);
  assert.equal(signals.windingDown, true);
  assert.equal(signals.busySpeech, true);

  // 15:30 仍在 16:00 之前 → 冷静期生效
  const active = closingCooldownActive(turns, { timezone: 'Asia/Shanghai', rules: { closingCooldownMin: 120 } }, base + 90 * 60_000);
  assert.equal(active.active, true);
  assert.equal(active.remainMin, 30);

  // 16:05 过了 16:00 → 冷静期解除
  const done = closingCooldownActive(turns, { timezone: 'Asia/Shanghai', rules: { closingCooldownMin: 120 } }, base + 125 * 60_000);
  assert.equal(done.active, false);
});

test('receptivity：睡着/上课/忙碌/在忙口语/锁屏离开的未回判为右删失，不扣分；没配课表也能正常运行', () => {
  const sendTs = Date.parse('2026-11-24T10:00:00+08:00'); // 周二 10:00
  const endTs = sendTs + 240 * 60_000;
  const pending = { slot: 'chitchat', ts: sendTs, ctx: { bucket: 'casual', period: 'morning', activity: 'active' } };

  // 1. 夜间窗口不公平 → 删失
  assert.equal(classifyMissCensor({ pending, now: endTs, fair: false }).reason, 'outside_fair_window');

  // 2. 用户亲口说了在忙 → 删失
  assert.equal(classifyMissCensor({ pending, now: endTs, fair: true, userBusySpeech: true }).reason, 'user_busy_speech');

  // 3. 配了课表且窗口覆盖上课时间 → 删失
  const cfgWithAgenda = { content: { agenda: { text: '周二 10:00-11:40 电机学' } } };
  assert.equal(classifyMissCensor({ pending, now: endTs, fair: true, cfg: cfgWithAgenda, windowEndTs: endTs }).reason, 'busy_or_class_window');

  // 4. 没配课表也没配 busyHours，但全程锁屏/离开电脑 → 删失
  const awayPending = { ...pending, ctx: { bucket: 'casual', period: 'morning', activity: 'away' } };
  assert.equal(classifyMissCensor({ pending: awayPending, now: endTs, fair: true, cfg: {}, locked: true }).reason, 'away_or_locked');

  // 5. 没配课表、人在电脑前活跃且一直没理 → 有效忽略（非删失）
  const activeMiss = classifyMissCensor({ pending, now: endTs, fair: true, cfg: {}, idleSec: 5, locked: false });
  assert.equal(activeMiss.censored, false);
  assert.equal(activeMiss.reason, 'active_ignore');
});

test('receptivity：删失跳过权重更新；有效负反馈压低分数并在 gate 模式拦截低分非紧急话题', () => {
  const st = {};
  const sendTs = Date.parse('2026-11-24T15:00:00+08:00');
  const pending = { slot: 'chitchat', ts: sendTs, ctx: { bucket: 'casual', period: 'afternoon', activity: 'focus' } };

  // 删失更新不增加 samples，也不降低分数
  const before = scoreReceptivity({ st, slot: 'chitchat', now: sendTs, activity: { kind: 'coding' }, idleSec: 5 });
  updateReceptivity(st, pending, 'miss', { censored: true, censorReason: 'busy_or_class_window', now: sendTs });
  updateReceptivity(st, pending, 'busy_reply', { now: sendTs });
  assert.equal(st.receptivity.samples, 0);
  assert.equal(st.receptivity.censoredCount, 2);
  const afterCensor = scoreReceptivity({ st, slot: 'chitchat', now: sendTs, activity: { kind: 'coding' }, idleSec: 5 });
  assert.equal(afterCensor.score, before.score);

  // 连续有效忽略（写代码专注时段 + 闲聊）拉低得分
  for (let i = 0; i < 12; i += 1) {
    updateReceptivity(st, pending, 'miss', { censored: false, now: sendTs + i * 1000 });
  }
  assert.equal(st.receptivity.samples, 12);

  // gate 模式且样本达标 → 拦截 chitchat
  const gateCfg = { rules: { receptivity: { mode: 'gate', threshold: 0.35, minSamples: 10 } } };
  const blocked = scoreReceptivity({ st, slot: 'chitchat', now: sendTs, cfg: gateCfg, activity: { kind: 'coding' }, idleSec: 5 });
  assert.equal(blocked.ready, true);
  assert.ok(blocked.score < 0.35, `expected score < 0.35, got ${blocked.score}`);
  assert.equal(blocked.wouldBlock, true);

  // 紧急由头（agreement / reply）绝不拦截
  const urgent = scoreReceptivity({ st, slot: 'agreement', now: sendTs, cfg: gateCfg, activity: { kind: 'coding' }, idleSec: 5 });
  assert.equal(urgent.exempt, true);
  assert.equal(urgent.wouldBlock, false);

  // 提高 minSamples 超过当前样本数 → 冷启动不拦截
  const coldCfg = { rules: { receptivity: { mode: 'gate', threshold: 0.35, minSamples: 20 } } };
  const cold = scoreReceptivity({ st, slot: 'chitchat', now: sendTs, cfg: coldCfg, activity: { kind: 'coding' }, idleSec: 5 });
  assert.equal(cold.ready, false);
  assert.equal(cold.wouldBlock, false);
});

test('receptivity：feedback.settle 收到“在上课呢”记为删失不扣分，sweep 结合锁屏判删失', () => {
  const st = {};
  const t0 = Date.parse('2026-11-24T10:00:00+08:00');
  noteSent(st, 'chitchat', t0, '在干嘛呢', { ctx: { bucket: 'casual', period: 'morning', activity: 'away' } });
  // 10 分钟后用户回复「在上课呢」→ 记为 busy_reply（删失，不污染样本）
  settle(st, t0 + 10 * 60_000, t0 + 11 * 60_000, '在上课呢', { tz: 'Asia/Shanghai', cfg: {} });
  assert.equal(st.receptivity.censoredCount, 1);
  assert.equal(st.receptivity.censorReasons.user_busy_speech, 1);

  // 再发一条离开电脑状态下的消息，4 小时后锁屏无人应 → sweep 记为 away_or_locked 删失
  noteSent(st, 'share', t0 + 20 * 60_000, '刚看到个好玩的事', { ctx: { bucket: 'casual', period: 'morning', activity: 'away' } });
  sweep(st, t0 + 300 * 60_000, { tz: 'Asia/Shanghai', cfg: {}, canJudge: true, locked: true });
  assert.equal(st.receptivity.censorReasons.away_or_locked, 1);
  assert.equal(st.receptivity.samples, 0);
});

test('receptivity：设置项可保存、回显并影响运行结果', () => {
  const base = loadConfig();
  const c1 = applyChange(base, 'rules.receptivity.mode', 'gate');
  assert.equal(c1.ok, true);
  const c2 = applyChange(c1.cfg, 'rules.receptivity.threshold', 0.45);
  assert.equal(c2.ok, true);
  const c3 = applyChange(c2.cfg, 'rules.receptivity.minSamples', 5);
  assert.equal(c3.ok, true);

  const groups = listForUi(c3.cfg);
  const items = groups.flatMap((g) => g.items || []);
  assert.equal(items.find((x) => x.path === 'rules.receptivity.mode')?.value, 'gate');
  assert.equal(items.find((x) => x.path === 'rules.receptivity.threshold')?.value, 0.45);
  assert.equal(items.find((x) => x.path === 'rules.receptivity.minSamples')?.value, 5);
});
