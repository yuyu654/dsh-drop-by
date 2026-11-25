// shadow.test.mjs —— 阶段 4：judge 预演。
// 两条底线要证明：① 护栏拦下的拍子也能被问一次；② 结果只进 state.judgeShadow，
// 绝不碰 feedback / pending（她根本没收到，记进接住率就是假数据）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-shadow-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'secrets.json');
process.env.PG_DSH_HOME = dir;
fs.mkdirSync(process.env.PG_LOG_DIR, { recursive: true });

const { loadConfig, saveConfig, loadState } = await import('../src/settings/config.js');
const { tick: engineTick } = await import('../src/decision/engine.js');
const tick = (options) => engineTick({ ...options, probeSystem: async () => ({ idle_ms: 0 }) });
const { shadowEligible, shadowRate, runShadow, shadowLine } = await import('../src/decision/shadow.js');
const { recordDay } = await import('../src/settings/retention.js');
const NOW = Date.parse('2026-11-22T12:00:00+08:00');
const TODAY = recordDay(NOW, 'Asia/Shanghai', loadConfig());

function writeConfig(patch = {}) {
  const cfg = loadConfig();
  const base = {
    ...cfg,
    dryRun: false, // shadow 不跑 dryRun：本来就不发，还烧调用
    quietHours: [],
    busyHours: [],
    timezone: 'Asia/Shanghai',
    send: { enabled: false, requireConfirm: true },
    perception: { ...cfg.perception, l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    content: { ...cfg.content, mode: 'llm', agenda: { text: '' }, exams: { text: '' } },
    rules: {
      ...cfg.rules,
      judge: { enabled: true, attempts: 1, shadow: true, shadowSampleRate: 0.25 },
      minGapMin: 240,
      dailyCap: 10,
      replyCooldownMin: 0,
    },
    channels: {
      ...cfg.channels,
      primary: 'qq',
      qq: { ...cfg.channels.qq, read: false, send: false },
      main: { ...cfg.channels.main, enabled: false, read: false, send: false },
      douyin: { ...cfg.channels.douyin, enabled: false, read: false, send: false },
    },
    sources: { ...cfg.sources, phone: { ...cfg.sources.phone, enabled: false }, memory: { ...cfg.sources.memory, enabled: false } },
    mail: { ...cfg.mail, enabled: false },
  };
  const merged = { ...base, ...patch };
  saveConfig(merged);
  return merged;
}

beforeEach(t => {
  t.mock.method(Date, 'now', () => NOW);
  // 刚发过一条 → 这一拍必被 GAP_TOO_SHORT 拦下，正好让 shadow 有活干。
  // 必须带上 day 和 TODAY 一致，否则 freshDayState 会把 lastSendAt 清零。
  fs.writeFileSync(
    process.env.PG_STATE_PATH,
    JSON.stringify({ day: TODAY, real: { todaySent: 1, lastSendAt: Date.now() - 60_000 } }),
  );
});

function fakeGen(text) {
  const calls = [];
  const fn = async ({ prompt }) => {
    calls.push(prompt.includes('只输出一个 JSON 对象') ? 'judge' : 'compose');
    return { ok: true, text, ms: 5 };
  };
  fn.calls = calls;
  return fn;
}

test('shadowEligible：开关、judge、别烧静默/忙碌/停用那几拍', () => {
  const on = { rules: { judge: { enabled: true, shadow: true } } };
  assert.equal(shadowEligible(on, 'GAP_TOO_SHORT'), true);
  assert.equal(shadowEligible(on, 'NO_TOPIC'), true);
  assert.equal(shadowEligible(on, 'DAILY_CAP'), true);
  assert.equal(shadowEligible(on, 'GLOBAL_QUIET'), false);
  assert.equal(shadowEligible(on, 'BUSY_HOURS'), false);
  assert.equal(shadowEligible(on, 'PLUGIN_DISABLED'), false);
  assert.equal(shadowEligible({ rules: { judge: { enabled: true, shadow: false } } }, 'GAP_TOO_SHORT'), false);
  assert.equal(shadowEligible({ rules: { judge: { enabled: false, shadow: true } } }, 'GAP_TOO_SHORT'), false);
});

test('shadowRate：默认 0.25，越界夹回 0–1', () => {
  assert.equal(shadowRate({}), 0.25);
  assert.equal(shadowRate({ rules: { judge: { shadowSampleRate: 0.5 } } }), 0.5);
  assert.equal(shadowRate({ rules: { judge: { shadowSampleRate: 4 } } }), 1);
  assert.equal(shadowRate({ rules: { judge: { shadowSampleRate: -1 } } }), 0);
});

test('采样不中 → 一次模型都不叫，state 里没有 judgeShadow', async () => {
  writeConfig();
  const gen = fakeGen('{"say": true, "draft": "在吗", "why": "想说话"}');
  const r = await tick({ persist: true, generate: gen, llmReady: true, random: () => 0.99 });
  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'GAP_TOO_SHORT');
  assert.equal(r.record.shadow, undefined);
  assert.deepEqual(gen.calls, []);
  assert.equal(loadState().judgeShadow, undefined);
});

test('采样命中 → 被拦的拍子也判一次，只记不发、不碰 feedback', async () => {
  writeConfig();
  const gen = fakeGen('{"say": true, "angle": "问她吃没吃", "draft": "饭吃了没", "why": "到饭点了"}');
  const r = await tick({ persist: true, generate: gen, llmReady: true, random: () => 0.01 });

  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'GAP_TOO_SHORT');
  assert.equal(r.delivery, null); // 没发
  assert.equal(r.record.shadow.blockedBy, 'GAP_TOO_SHORT');
  assert.equal(r.record.shadow.say, true);
  assert.deepEqual(gen.calls, ['judge']);

  const st = loadState();
  assert.equal(st.judgeShadow.asked, 1);
  assert.equal(st.judgeShadow.sayTrue, 1);
  assert.equal(st.judgeShadow.sayFalse, 0);
  assert.equal(st.judgeShadow.parseFail, 0);
  assert.equal(st.feedback.pending.length, 0); // 没污染接住率
  assert.deepEqual(st.feedback.slots, {});
});

test('runShadow：说 false / 判坏 各自计数，last 记下被谁拦的', async () => {
  const cfg = writeConfig();
  const st = {};
  const now = Date.now();
  const say = (t) => async () => ({ ok: true, text: t, ms: 3 });

  const a = await runShadow({ cfg, now, tz: 'Asia/Shanghai', st, ctx: {}, generate: say('{"say": false, "draft": "", "why": "她在忙"}'), blockedBy: 'NO_TOPIC' });
  assert.equal(a.say, false);
  assert.equal(st.judgeShadow.sayFalse, 1);

  const b = await runShadow({ cfg, now: now + 1000, tz: 'Asia/Shanghai', st, ctx: {}, generate: say('我不会写 JSON'), blockedBy: 'GAP_TOO_SHORT' });
  assert.equal(b.fallback, true);
  assert.equal(st.judgeShadow.parseFail, 1);
  assert.equal(st.judgeShadow.last.blockedBy, 'GAP_TOO_SHORT');

  assert.match(shadowLine(st, cfg), /问 2 次，会说 0 \/ 不说 1，解析失败 1/);
});