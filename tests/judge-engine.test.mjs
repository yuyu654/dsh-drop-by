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
const { tick: engineTick } = await import('../src/engine.js');
const tick = (options) => engineTick({ ...options, probeSystem: async () => ({ idle_ms: 0 }) });
const { loadPersona } = await import('../src/persona.js');
const { exploreRound, saveExploration } = await import('../src/explore.js');

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
  assert.equal(r.record.content_ok, true);
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

test('judge cannot send the reported troubleshooting prompt without user evidence', async () => {
  writeConfig();
  const gen = fakeGen(JSON.stringify({ say: true, angle: '插件排查', draft: '刷抖音那个插件，卡在哪一步了？报错贴我。', why: '窗口上看见插件排查' }));
  const r = await tick({ persist: true, generate: gen, llmReady: true });
  assert.equal(r.record.reason, 'PROJECT_HELP_WITHOUT_REQUEST');
  assert.equal(r.delivery, null);
});

test('an approved exploration share previews the original source URL and preserves judge context', async () => {
  const personaPath = path.join(dir, 'share-persona.md');
  fs.writeFileSync(personaPath, '喜欢推理短篇。');
  const cfg = writeConfig({
    exploration: { offerShare: true },
    persona: { enabled: true, localFile: personaPath, dshHome: dir },
    content: { ...loadConfig().content, mode: 'llm', exams: { text: '' } },
  });
  const source = { url: 'https://example.org/story', title: '推理短篇', evidence: '仅标题或搜索摘要' };
  const persona = loadPersona({ cfg });
  const round = await exploreRound({ persona, media: { web: true, collect: async () => [source] },
    generate: async ({ prompt }) => ({ ok: true, text: JSON.stringify(prompt.includes('替角色选')
      ? { mode: 'leisure', kind: 'web', query: '推理短篇' }
      : { action: 'start', topic: '推理短篇', progress: '找到一个链接', next: '留着看', share: '找到一篇标题挺有意思的推理短篇。', sourceIndex: 0 }) }),
  });
  saveExploration(round.state);
  const r = await tick({ persist: false, llmReady: true, generate: async ({ prompt }) => {
    assert.match(prompt, /推理短篇/);
    assert.match(prompt, /仅标题或搜索摘要/);
    assert.doesNotMatch(prompt, /\[object Object\]/);
    return { ok: true, text: '{"say":true,"angle":"分享短篇","draft":"我找到一篇标题挺有意思的推理短篇。","why":"适合分享"}' };
  } });
  assert.equal(r.delivery?.preview, '我找到一篇标题挺有意思的推理短篇。\n' + source.url);
});

test('exploration mood cannot affect the send decision, only an approved proactive draft', async () => {
  const personaPath = path.join(dir, 'test-persona.md');
  fs.writeFileSync(personaPath, '喜欢推理，擅长找反例。');
  const cfg = writeConfig({
    exploration: { mood: true },
    persona: { enabled: true, localFile: personaPath, dshHome: dir },
    content: { ...loadConfig().content, mode: 'llm', exams: { text: '' } },
  });
  const persona = loadPersona({ cfg });
  const r = await exploreRound({ persona, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '推理', progress: '找到反例', next: '再检查', mood: '有点得意。' }),
  }) });
  assert.equal(r.ok, true);
  saveExploration(r.state);
  for (const say of [false, true]) {
    let styled = 0;
    const result = await tick({ persist: false, llmReady: true, generate: async ({ prompt }) => {
      if (prompt.includes('只输出一个 JSON 对象')) {
        assert.doesNotMatch(prompt, /有点得意/);
        return { ok: true, text: JSON.stringify({ say, angle: '推理', draft: '我想到一个反例。', why: '有一处新发现' }) };
      }
      assert.match(prompt, /有点得意/);
      styled++;
      return { ok: true, text: '嘿，我刚想到一个反例。' };
    } });
    assert.equal(styled, say ? 1 : 0);
    assert.equal(result.delivery?.reason ?? null, say ? 'DRY_RUN' : null);
  }
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

test('judge 打开且命中常规由头 → 快照后附带当前心情底色参考', async (t) => {
  const emDir = path.join(dir, 'profiles', 'desktop', 'node_modules', 'emotion-state-portrait', 'emotion');
  fs.mkdirSync(emDir, { recursive: true });
  const qqDir = path.join(dir, 'qq-bridge');
  fs.mkdirSync(qqDir, { recursive: true });
  t.after(() => {
    fs.rmSync(path.join(dir, 'profiles'), { recursive: true, force: true });
    fs.rmSync(qqDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(path.dirname(emDir), 'package.json'), JSON.stringify({ name: 'emotion-state-portrait', version: '1.0.5' }));
  fs.writeFileSync(path.join(emDir, 'state.json'), JSON.stringify({ updatedAt: Date.now() }));
  fs.writeFileSync(path.join(path.dirname(emDir), 'mood-map.json'), JSON.stringify({
    '42': '心情：轻快Lv1；对她：熟悉；硬规则：别直念',
  }));
  const threeDaysAgo = Date.now() - 3 * 86_400_000;
  fs.writeFileSync(path.join(qqDir, 'last-in.json'), JSON.stringify({ peer: '42', peerKind: 'private', at: threeDaysAgo, text: '先去忙了' }));

  writeConfig({
    exploration: { portrait: true, mood: false },
    content: { ...loadConfig().content, exams: { text: '' } },
    channels: { ...loadConfig().channels, qq: { enabled: true, peerId: '42', read: true, send: false } },
  });
  let seenJudgePrompt = '';
  const gen = async ({ prompt }) => {
    if (prompt.includes('只输出一个 JSON 对象')) {
      seenJudgePrompt = prompt;
      return { ok: true, text: '{"say": true, "angle": "问她忙完没", "draft": "忙完这阵了没？", "why": "三天没说话，语气轻松点问候"}', ms: 5 };
    }
    return { ok: true, text: '忙完这阵了没？', ms: 5 };
  };
  const r = await tick({ persist: true, generate: gen, llmReady: true });
  assert.equal(r.record.decision, 'send');
  assert.match(seenJudgePrompt, /当前心情底色/);
  assert.match(seenJudgePrompt, /轻快Lv1/);
});

test('无由头且随口话不可用时（如额度用完）：不进 judge、不绕过 NO_TOPIC 发送', async () => {
  const personaPath = path.join(dir, 'no-topic-persona.md');
  fs.writeFileSync(personaPath, '说话简短。');
  writeConfig({
    persona: { enabled: true, localFile: personaPath, dshHome: dir },
    content: { ...loadConfig().content, mode: 'llm', exams: { text: '' } },
    rules: {
      ...loadConfig().rules,
      judge: { enabled: true },
      minGapMin: 0,
      dailyCap: 10,
      replyCooldownMin: 0,
      chitchat: { enabled: true, perDay: 1, dayStart: 0, dayEnd: 1439, maxChars: 40 },
    },
  });
  const now = Date.now();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(now));
  saveState({ chitchat: { day, count: 1 } });

  const gen = fakeGen('{"say": true, "angle": "强行找话", "draft": "我到楼下了，下来拿吧。", "why": "绕过上限"}');
  const r = await tick({ now, persist: true, generate: gen, llmReady: true });

  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'NO_TOPIC');
  assert.equal(r.record.chitchat.reason, 'NO_CHITCHAT_BUDGET');
  assert.equal(r.record.content_ok, false);
  assert.equal(r.delivery, null);
  assert.deepEqual(gen.calls, []);
});
