// chitchat-density.test.mjs —— 阶段 4：密度（接得好才多说）与熔断（连着被晾就闭嘴）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { densityTarget, chitchatGate, noteChitchatSent } from '../src/decision/chitchat.js';
import { settle } from '../src/decision/feedback.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 7, 4, 0); // 北京 12:00
const H = 3600_000;

const cfgOf = (chitchat = {}) => ({
  timezone: TZ,
  rules: { judge: { enabled: true }, replyCooldownMin: 5, chitchat: { enabled: true, perDay: 3, ...chitchat } },
  feedback: {},
});

const ctxOf = () => ({ her: { lastTs: 0 } });

function dayKeyAgo(days) {
  return new Date(NOW - days * 86_400_000).toLocaleDateString('sv-SE', { timeZone: TZ });
}

test('密度：样本不足按基线 1 条，不拿两三条猜她脾气', () => {
  const st = { chitchat: { days: { [dayKeyAgo(1)]: { sent: 3, replied: 3 } } } };
  const d = densityTarget(st, NOW, TZ);
  assert.equal(d.perDay, 1);
  assert.equal(d.rate, null);
});

test('密度：近 7 天接住率 >70% 放到配置上限，<30% 压回 1 条，7 天前的账不算', () => {
  const good = { chitchat: { days: { [dayKeyAgo(2)]: { sent: 10, replied: 8 } } } };
  assert.equal(densityTarget(good, NOW, TZ, cfgOf()).perDay, 3);

  const cold = { chitchat: { days: { [dayKeyAgo(2)]: { sent: 10, replied: 2 } } } };
  assert.equal(densityTarget(cold, NOW, TZ).perDay, 1);

  const stale = { chitchat: { days: { [dayKeyAgo(9)]: { sent: 10, replied: 10 } } } };
  assert.equal(densityTarget(stale, NOW, TZ).perDay, 1);
});

test('闸门按密度算钱：基线 1 条，发过一条今天就没了', () => {
  const cfg = cfgOf();
  const st = { chitchat: { day: dayKeyAgo(0), count: 1 } };
  const g = chitchatGate({ cfg, now: NOW, st, ctx: ctxOf(), tz: TZ });
  assert.equal(g.reason, 'NO_CHITCHAT_BUDGET');
  assert.match(g.why, /只有 0 条样本，每天生效上限 1 条/);
});

test('熔断：连着 3 条被晾满 12 小时 → 停 48 小时', () => {
  const st = { feedback: { pending: [] } };
  for (let i = 0; i < 3; i += 1) {
    st.feedback.pending.push({ slot: 'chitchat', ts: NOW - (13 + i) * H, draft: '随口一句', sentAt: NOW - (13 + i) * H });
  }
  // 她这会儿终于说话了：三条都判成没接住
  settle(st, NOW, NOW, '嗯', { tz: TZ });
  assert.ok(Number(st.chitchat.cooldownUntil) > NOW, '应该进入冷却');
  assert.equal(st.chitchat.ignored, 0);

  const g = chitchatGate({ cfg: cfgOf(), now: NOW, st, ctx: ctxOf(), tz: TZ });
  assert.equal(g.reason, 'NO_CHITCHAT_COOLDOWN');
});

test('熔断可以被一次接住清零', () => {
  const st = { feedback: { pending: [] } };
  st.feedback.pending.push({ slot: 'chitchat', ts: NOW - 13 * H, draft: '随口一句' });
  settle(st, NOW, NOW, '嗯', { tz: TZ });
  assert.equal(st.chitchat.ignored, 1);
  st.feedback.pending.push({ slot: 'chitchat', ts: NOW - 2 * 60_000, draft: '又一句' });
  settle(st, NOW, NOW + 5 * 60_000, '知道了', { tz: TZ });
  assert.equal(st.chitchat.ignored, 0);
});
test('测试期发的随口话不进密度样本（她没回不算没接住）', () => {
  const st = {};
  noteChitchatSent(st, NOW, TZ, '睡了没', 'm:x', { test: true });
  assert.equal(st.chitchat.days, undefined);
  noteChitchatSent(st, NOW, TZ, '睡了没', 'm:x');
  assert.equal(st.chitchat.days[dayKeyAgo(0)].sent, 1);
});
