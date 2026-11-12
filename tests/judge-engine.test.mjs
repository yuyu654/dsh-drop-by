// judge-engine.test.mjs —— 阶段 2 的端到端验收：
// 用注入的假 generate 走完整 tick，确认「模型说」不能越过护栏、「模型判坏了」会退回规则链。
//
// 为什么单独一个文件：它要改 PG_* 环境变量指向临时目录，而模块在读配置时才用这些变量，
// 所以必须在 import engine.js 之前设好；和 engine-smoke 放在同一进程里会互相污染。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-judge-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'secrets.json');
process.env.PG_DSH_HOME = dir; // 记忆/课表/考试都别读真实的 ~/.dsh
fs.mkdirSync(process.env.PG_LOG_DIR, { recursive: true });

const { loadConfig, saveConfig, loadState, saveState } = await import('../src/config.js');
const { tick } = await import('../src/engine.js');

/** 把「30 分钟后有一场考试」写进配置：这样 pickTopic 一定挑得出一个与当前时刻无关的由头。 */
function examSoonText(minutes = 30) {
  const at = new Date(Date.now() + minutes * 60_000);
  const p2 = (n) => String(n).padStart(2, '0');
  const mo = p2(at.getMonth() + 1);
  const d = p2(at.getDate());
  const h = p2(at.getHours());
  const mi = p2(at.getMinutes());
  return `${mo}-${d} ${h}:${mi} 电机学`;
}

function writeConfig(patch = {}) {
  const cfg = loadConfig();
  const base = {
    ...cfg,
    dryRun: true,
    quietHours: [],
    busyHours: [],
    timezone: 'Asia/Shanghai',
    send: { enabled: false, requireConfirm: true },
    perception: { ...cfg.perception, l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    content: {
      ...cfg.content,
      mode: 'llm',
      maxChars: 60,
      agenda: { text: '' },
      exams: { text: examSoonText() },
      llm: { ...cfg.content.llm, attempts: 1 },
    },
    rules: { ...cfg.rules, judge: { enabled: true }, minGapMin: 0, dailyCap: 10, replyCooldownMin: 0 },
    channels: {
      ...cfg.channels,
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

beforeEach(() => {
  // 每个用例从干净 state 开始：上一拍发过一条会影响间隔/上限
  fs.writeFileSync(process.env.PG_STATE_PATH, JSON.stringify({}));
});

/** 假模型：judge 的 prompt 里有 JSON 契约，compose 的没有——靠这个分开两条链路。 */
function fakeGen(judgeText, composeText = '规则链写的句子') {
  const calls = [];
  const fn = async ({ prompt }) => {
    const isJudge = prompt.includes('只输出一个 JSON 对象');
    calls.push(isJudge ? 'judge' : 'compose');
    return { ok: true, text: isJudge ? judgeText : composeText, ms: 5 };
  };
  fn.calls = calls;
  return fn;
}

test('judge 说「说」→ 草稿过 guard 后原样发出（不再走 compose 重写）', async () => {
  writeConfig();
  const gen = fakeGen('{"say": true, "angle": "提醒早睡", "draft": "今晚早点睡，别又熬到两点。", "why": "她昨天只睡五个小时"}');
  const r = await tick({ persist: true, generate: gen, llmReady: true });

  assert.equal(r.record.decision, 'send');
  assert.equal(r.record.judge.say, true);
  assert.equal(r.record.judge.fallback, false);
  assert.equal(r.record.judge.why, '她昨天只睡五个小时');
  assert.equal(r.record.content.source, 'judge');
  assert.equal(r.record.content.text, '今晚早点睡，别又熬到两点。');
  assert.deepEqual(gen.calls, ['judge']); // 没有第二次生成
  assert.deepEqual(r.delivery, { attempted: false, reason: 'DRY_RUN', preview: '今晚早点睡，别又熬到两点。' });
});

test('judge 说「不说」→ 记 NO_TOPIC，不写句子、不发送', async () => {
  writeConfig();
  const gen = fakeGen('{"say": false, "angle": "", "draft": "", "why": "她在写代码，这会儿不该插话"}');
  const r = await tick({ persist: true, generate: gen, llmReady: true });

  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'NO_TOPIC');
  assert.equal(r.record.judge.say, false);
  assert.equal(r.record.content, null);
  assert.equal(r.delivery, null);
  assert.deepEqual(gen.calls, ['judge']);

  const st = loadState();
  assert.equal(st.judge.say, false);
  assert.equal(st.judge.why, '她在写代码，这会儿不该插话');
});

test('judge 返回坏 JSON → 退回规则链，仍然按由头写出句子', async () => {
  writeConfig();
  const gen = fakeGen('她这会儿大概在忙吧'); // 不是 JSON
  const r = await tick({ persist: true, generate: gen, llmReady: true });

  assert.equal(r.record.judge.fallback, true);
  assert.equal(r.record.judge.say, null);
  assert.equal(r.record.decision, 'send');
  assert.equal(r.record.content.source, 'llm'); // 规则链自己写的
  assert.equal(r.record.content.text, '规则链写的句子');
  // 判断失败会重试一次（角色人格容易把判断写成一句话），第二次还是坏 JSON 才退规则链
  assert.deepEqual(gen.calls, ['judge', 'judge', 'compose']);
  assert.equal(loadState().judge.fallback, true);
  assert.equal(loadState().judge.reason, 'JUDGE_NOT_JSON');
});

test('judge 写的草稿过不了护栏 → 不发送（不退回模板，也不重写）', async () => {
  writeConfig({ content: { ...loadConfig().content, mode: 'llm', maxChars: 20, exams: { text: examSoonText() } } });
  const long = '今天天气不错我觉得你应该出去走一走别老坐在电脑前面。';
  const gen = fakeGen(JSON.stringify({ say: true, angle: '说一句', draft: long, why: '关心她' }));
  const r = await tick({ persist: true, generate: gen, llmReady: true });

  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'GUARD_REJECTED');
  assert.equal(r.record.judge.say, true);
  assert.ok(r.record.content.violations.includes('TOO_LONG'));
  assert.deepEqual(gen.calls, ['judge']);
  assert.equal(r.delivery, null);
});

test('judge 关着 → 一次判断都不叫，行为就是原来的规则链', async () => {
  writeConfig({ rules: { ...loadConfig().rules, judge: { enabled: false } } });
  const gen = fakeGen('{"say": false, "draft": "", "why": "不该说"}');
  const r = await tick({ persist: true, generate: gen, llmReady: true });

  assert.deepEqual(gen.calls, ['compose']); // 只走 compose，没有 judge
  assert.equal(r.record.judge, null);
  assert.equal(r.record.decision, 'send');
  assert.equal(r.record.content.source, 'llm');
});