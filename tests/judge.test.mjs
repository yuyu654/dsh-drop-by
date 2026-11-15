// judge.test.mjs —— 模型判断这一层的边界：能解析就用，解析不了就退规则链。
//
// 关键语义（改之前想清楚）：parseJudge 的 ok:false 不是「不说」，是「这次判不了」，
// 调用方要退回原来的规则链；只有明确 say:false 才是模型主动决定不开口。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePrompt, parseJudge, judgeDecision } from '../src/judge.js';

const persona = { text: '我是示例角色，话短。' };
const snapshot = '现在：2026-11-06 周五 12:17（中午）\n规则建议（可参考也可不用）：拿睡眠说事';

test('judgePrompt：带上人格、快照和 JSON 契约', () => {
  const p = judgePrompt({ snapshot, persona, maxChars: 30 });
  assert.match(p, /我是示例角色/);
  assert.match(p, /拿睡眠说事/);
  assert.match(p, /"say": true\|false/);
  assert.match(p, /不超过 30 字/);
  // 她 2026-11-06 提的两条：忙久了可以关心；不许拽旧梗（「别又是冰的」这种没由头的数落）
  assert.match(p, /说 false 不算失职/);
  assert.match(p, /不翻旧账/);
});

test('parseJudge：正常 JSON 解析出四个字段', () => {
  const r = parseJudge('{"say": true, "angle": "提醒她早睡", "draft": "今晚早点睡。", "why": "她昨晚只睡五个小时"}');
  assert.deepEqual(r, { ok: true, say: true, angle: '提醒她早睡', draft: '今晚早点睡。', why: '她昨晚只睡五个小时' });
});

test('parseJudge：允许代码块包着 JSON，也允许前后有废话', () => {
  const r = parseJudge('好的：\n```json\n{"say": false, "why": "没什么值得说的"}\n```');
  assert.equal(r.ok, true);
  assert.equal(r.say, false);
  assert.equal(r.draft, '');
});

test('parseJudge：坏 JSON / 缺字段 / say 非布尔 / 说要说但没草稿 —— 都算判不了', () => {
  assert.equal(parseJudge('我觉得她可能睡了').reason, 'JUDGE_NOT_JSON');
  assert.equal(parseJudge('{"say": tru}').reason, 'JUDGE_JSON_PARSE');
  assert.equal(parseJudge('{"say": true}').reason, 'JUDGE_NO_DRAFT');
  assert.equal(parseJudge('{"say": "yes", "draft": "在吗"}').reason, 'JUDGE_SAY_NOT_BOOL');
  assert.equal(parseJudge('').reason, 'JUDGE_EMPTY');
});

test('judgeDecision：注入的 generate 返回什么就解析什么', async () => {
  const r = await judgeDecision({
    snapshot,
    persona,
    cfg: { content: { maxChars: 60 } },
    generate: async () => ({ ok: true, text: '{"say": true, "angle": "问一句", "draft": "睡了没", "why": "十一点了"}' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.say, true);
  assert.equal(r.draft, '睡了没');
});

test('judgeDecision：模型调用失败 / 没准备好 → ok:false（退规则链，不是不说）', async () => {
  const timedOut = await judgeDecision({ snapshot, persona, cfg: {}, generate: async () => ({ ok: false, reason: 'HOST_LLM_TIMEOUT' }) });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.reason, 'HOST_LLM_TIMEOUT');

  const off = await judgeDecision({ snapshot, persona, cfg: {}, generate: async () => ({ ok: true, text: '{}' }), llmReady: false });
  assert.equal(off.ok, false);
  assert.equal(off.reason, 'JUDGE_LLM_NOT_READY');

  const none = await judgeDecision({ snapshot, persona, cfg: {} });
  assert.equal(none.reason, 'JUDGE_NO_LLM');

  const boom = await judgeDecision({ snapshot, persona, cfg: {}, generate: async () => { throw new Error('spawn ENOENT'); } });
  assert.equal(boom.ok, false);
  assert.equal(boom.reason, 'JUDGE_ERROR');
});
test('judgeDecision：第一次直接写了句话 → 重试一次拿到 JSON（角色人格最常见的失败）', async () => {
  const prompts = [];
  const r = await judgeDecision({
    snapshot,
    persona,
    cfg: {},
    generate: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompts.length === 1) return { ok: true, text: '出去一圈回来就扎进微信。……吃过了没。' };
      return { ok: true, text: '{"say": true, "angle": "问她吃了没", "draft": "吃过了没", "why": "刚回来"}' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.say, true);
  assert.equal(r.attempts, 2);
  assert.match(prompts[1], /没有输出 JSON/); // 第二次把「格式不对」甩在前面
});

test('judgeDecision：attempts 可配，设成 1 就不重试', async () => {
  let n = 0;
  const r = await judgeDecision({
    snapshot,
    persona,
    cfg: { rules: { judge: { attempts: 1 } } },
    generate: async () => { n++; return { ok: true, text: '一句人话' }; },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'JUDGE_NOT_JSON');
  assert.equal(n, 1);
});

test('judgeDecision / judgePrompt：给出足够输出预算，并约束 share 不说黑话、看兴趣、留接话口子', async () => {
  let seen = null;
  const r = await judgeDecision({
    snapshot,
    persona,
    cfg: {},
    generate: async (args) => {
      seen = args;
      return { ok: true, text: '{"say": false, "why": "对方不感兴趣"}' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.say, false);
  assert.ok(seen.minOutputTokens >= 512, `minOutputTokens=${seen.minOutputTokens}`);
  assert.match(seen.prompt, /大白话/);
  assert.match(seen.prompt, /接话/);
  assert.match(seen.prompt, /她接过我哪类话/);
});
