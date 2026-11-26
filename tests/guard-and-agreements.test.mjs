import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-guard-agree-'));
process.env.PG_CONFIG_PATH = path.join(tmp, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(tmp, 'data');
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_LOG_DIR = path.join(tmp, 'logs');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { guard } = await import('../src/decision/compose.js');
const { explainRun } = await import('../src/decision/explain.js');
const { agreementAnchor, handleAgreementChatCommand, listAgreements, observeAgreement } = await import('../src/chat/agreements.js');

test('guard：卷次/平台/年份短标签括号不误杀，真正的括号动作仍拦截', () => {
  for (const okText of [
    '刚翻完《哆哆嗦嗦逃离你》（第1话），社恐躲会议那段太真实了。',
    '这篇（番外）比正篇还好笑。',
    '在（B漫）看到更新了。',
    '这套规范（2026）改得挺顺手。',
  ]) {
    const g = guard(okText, {});
    assert.equal(g.violations.some((v) => v.code === 'PAREN_ACTION'), false, okText);
  }

  for (const badText of [
    '（叹气）你又熬夜了。',
    '好吧（轻轻拍了拍你的肩）早点睡。',
  ]) {
    const g = guard(badText, {});
    assert.equal(g.violations.some((v) => v.code === 'PAREN_ACTION'), true, badText);
  }
});

test('guard：分享发现时允许正常论述词（往往/本质上/所谓），闲聊仍保持严格', () => {
  const text = '看那篇拆解，这种保护算法本质上就是按电流热累积来算延时，往往比固定时限稳。';
  const asShare = guard(text, {}, null, { shareTechnical: true, maxChars: 80 });
  assert.equal(asShare.violations.some((v) => v.code === 'ESSAY'), false);

  const asNormal = guard(text, {}, null, { maxChars: 80 });
  assert.equal(asNormal.violations.some((v) => v.code === 'ESSAY'), true);

  // 即使在分享里，泛抒情套话照样拦截
  const preachy = guard('这世界无一例外都是这样，其实我们都一样。', {}, null, { shareTechnical: true });
  assert.equal(preachy.violations.some((v) => v.code === 'ESSAY'), true);
});

test('guard：MOOD_LEAK 剔除《作品名》且要求 6 字连续重合，不误杀作品名/四字短语', () => {
  const rawMood = '看了《哆哆嗦嗦逃离你》，感觉社恐职场有点憋屈。';
  // 正常提作品名 + 4 字重合不误杀
  const ok = guard('刚刷到《哆哆嗦嗦逃离你》最新一话，社恐职场那段太真实了。', {}, {
    explorationMood: { raw: rawMood },
    self: { section: '《哆哆嗦嗦逃离你》' },
  });
  assert.equal(ok.violations.some((v) => v.code === 'MOOD_LEAK'), false);

  // 真正照抄 6 字以上心情原话仍拦截
  const bad = guard('感觉社恐职场有点憋屈，不想说话。', {}, {
    explorationMood: { raw: rawMood },
  });
  assert.equal(bad.violations.some((v) => v.code === 'MOOD_LEAK'), true);
});

test('explainRun：GUARD_REJECTED 与 CHITCHAT_GUARD_REJECTED 在 detail 中展示命中规则与被拦原句', () => {
  const exp = explainRun({
    record: {
      reason: 'GUARD_REJECTED',
      content: {
        text: '这是一条超过六十个字被拦下来的测试草稿。',
        violations: ['TOO_LONG', 'PAREN_ACTION'],
      },
    },
  });
  assert.match(exp.detail, /超过字数上限（TOO_LONG）/);
  assert.match(exp.detail, /带了括号动作说明（PAREN_ACTION）/);
  assert.match(exp.detail, /被拦原句：「这是一条超过六十个字被拦下来的测试草稿。」/);
});

test('agreements：识别口语事件型相对时间（等我洗完澡 / 下课后）', () => {
  const now = Date.parse('2026-11-24T19:00:00+08:00');
  const a1 = agreementAnchor('等我洗完澡提醒我吹头发', now, {});
  assert.equal(a1.length, 1);
  assert.equal(a1[0].anchor, '等我洗完澡');
  assert.equal(a1[0].short, true);
  assert.equal(a1[0].precision, 'event');
  assert.equal(a1[0].dueAt, now + 30 * 60_000);

  const a2 = agreementAnchor('下课后喊我交作业', now, {});
  assert.equal(a2.length, 1);
  assert.equal(a2[0].anchor, '下课后');
  assert.equal(a2[0].dueAt, now + 60 * 60_000);
});

test('agreements：聊天内直接查看、按关键词取消、取消最近一条与全部清空', async () => {
  const cfg = { timezone: 'Asia/Shanghai', agreements: { enabled: true } };
  const now = Date.parse('2026-11-24T19:00:00+08:00');
  await observeAgreement({
    cfg,
    text: '十分钟后提醒我喝口水',
    at: now,
    now,
    peer: '10001',
    channel: 'qq',
    generate: async () => ({
      ok: true,
      text: JSON.stringify({ items: [{ index: 0, anchor: '十分钟后', title: '喝口水', quote: '十分钟后提醒我喝口水' }] }),
    }),
  });
  await observeAgreement({
    cfg,
    text: '等我洗完澡提醒我吹头发',
    at: now + 1000,
    now: now + 1000,
    peer: '10001',
    channel: 'qq',
    generate: async () => ({
      ok: true,
      text: JSON.stringify({ items: [{ index: 0, anchor: '等我洗完澡', title: '吹头发', quote: '等我洗完澡提醒我吹头发' }] }),
    }),
  });
  assert.equal(listAgreements(cfg, now + 2000).length, 2);

  // 1. 查看待办
  const listed = handleAgreementChatCommand({ text: '我还有哪些提醒', peer: '10001', channel: 'qq', cfg, now: now + 2000 });
  assert.match(listed, /喝口水/);
  assert.match(listed, /吹头发/);

  // 2. 疑问句不误删
  const q = handleAgreementChatCommand({ text: '要不要取消喝口水提醒？', peer: '10001', channel: 'qq', cfg, now: now + 2000 });
  assert.equal(q, '');
  assert.equal(listAgreements(cfg, now + 2000).length, 2);

  // 3. 按关键词取消
  const c1 = handleAgreementChatCommand({ text: '别提醒我喝口水了', peer: '10001', channel: 'qq', cfg, now: now + 2000 });
  assert.match(c1, /已取消.*喝口水/);
  assert.equal(listAgreements(cfg, now + 2000).length, 1);

  // 4. 取消最近一条
  const c2 = handleAgreementChatCommand({ text: '取消刚才那个提醒', peer: '10001', channel: 'qq', cfg, now: now + 2000 });
  assert.match(c2, /已取消.*吹头发/);
  assert.equal(listAgreements(cfg, now + 2000).length, 0);
});

test('tickDueAgreement：到点提醒优先走轻量无思考模型按人设生成，失败或违规才退回固定模板', async (t) => {
  const { saveConfig, saveState } = await import('../src/settings/config.js');
  const { writeChatData } = await import('../src/channels/douyin-im.js');
  const { tickDueAgreement } = await import('../src/decision/engine.js');
  const now = Date.parse('2026-11-25T15:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  const peer = '20002';
  const cfg = {
    enabled: true, dryRun: false, timezone: 'Asia/Shanghai', quietHours: [], busyHours: [],
    send: { enabled: true },
    characterRest: { bed: '23:00', wake: '07:00', jitterMin: 0 },
    channels: { primary: 'qq', qq: { enabled: true, read: true, send: true, peerId: peer } },
    rules: { proactive: true, dailyCap: 5, minGapMin: 1 },
    content: { enabled: true, mode: 'auto', maxChars: 60 },
    agreements: { enabled: true, extractTimeoutMs: 5000 },
  };
  saveConfig(cfg);
  saveState({ day: '2026-11-25', real: { todaySent: 0, lastSendAt: 0 } });

  // 1. 轻量模型正常返回自然口吻（且请求 reasoningEffort: 'off'）
  writeChatData('agreements', {
    items: [{ id: 'llm-ok-1', title: '喝口水', anchor: '十分钟后', dueAt: now - 1000, peer, channel: 'qq', explicit: true, short: true, status: 'pending' }],
  });
  const sent = [];
  const calls = [];
  const res1 = await tickDueAgreement({
    generate: async (req) => {
      calls.push(req);
      return { ok: true, text: '到点啦，记得先去喝口水。' };
    },
    send: async ({ text, canDispatch }) => {
      assert.equal(canDispatch(), true);
      sent.push(text);
      return { ok: true, sentAt: now };
    },
  });
  assert.deepEqual(res1, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].reasoningEffort, 'off');
  assert.equal(calls[0].tag, 'agreement-remind');
  assert.match(calls[0].prompt, /喝口水/);
  assert.equal(sent[0], '到点啦，记得先去喝口水。');

  // 2. 模型输出违规（客服腔）时，自动退回固定模板
  writeChatData('agreements', {
    items: [{ id: 'llm-fallback-1', title: '交作业', anchor: '五分钟后', dueAt: now - 1000, peer, channel: 'qq', explicit: true, short: true, status: 'pending' }],
  });
  const res2 = await tickDueAgreement({
    generate: async () => ({ ok: true, text: '您好，很高兴为您提醒交作业，希望能帮到您。' }),
    send: async ({ text, canDispatch }) => {
      assert.equal(canDispatch(), true);
      sent.push(text);
      return { ok: true, sentAt: now };
    },
  });
  assert.deepEqual(res2, { ok: true });
  assert.equal(sent[1], '提醒一下，你说过的「交作业」。');

  // 3. 模型超时/报错时，自动退回固定模板
  writeChatData('agreements', {
    items: [{ id: 'llm-err-1', title: '关烤箱', anchor: '一分钟后', dueAt: now - 1000, peer, channel: 'qq', explicit: true, short: true, status: 'pending' }],
  });
  const res3 = await tickDueAgreement({
    generate: async () => ({ ok: false, reason: 'HOST_LLM_TIMEOUT' }),
    send: async ({ text, canDispatch }) => {
      assert.equal(canDispatch(), true);
      sent.push(text);
      return { ok: true, sentAt: now };
    },
  });
  assert.deepEqual(res3, { ok: true });
  assert.equal(sent[2], '提醒一下，你说过的「关烤箱」。');
});

test('buildReplyContext：仅在本轮提醒实际落盘后注入防重复 DSH 定时器提示', async (t) => {
  const { saveConfig } = await import('../src/settings/config.js');
  const { buildReplyContext } = await import('../src/chat/qq-reply.js');
  const now = Date.parse('2026-11-25T15:00:00+08:00');
  t.mock.method(Date, 'now', () => now);
  const peer = '30003';
  const baseCfg = {
    enabled: true, timezone: 'Asia/Shanghai', quietHours: [], busyHours: [],
    channels: { primary: 'qq', qq: { enabled: true, read: true, send: true, peerId: peer } },
    agreements: { enabled: true },
    exploration: { mood: false, portrait: false },
    rules: { qqCommands: { enabled: false } },
  };
  saveConfig(baseCfg);
  const dummyCtx = { get: () => null };

  const text = '十分钟后提醒我喝水';
  const input = { peer, kind: 'private', text, at: now, cfg: baseCfg };
  assert.doesNotMatch(await buildReplyContext(dummyCtx, input), /【约定小本本已接管】/);
  await observeAgreement({ ...input, now, channel: 'qq', generate: async () => ({ ok: false }) });
  assert.doesNotMatch(await buildReplyContext(dummyCtx, input), /【约定小本本已接管】/);

  const savedInput = { ...input, at: now - 1000 };
  let finishExtraction;
  const extraction = observeAgreement({ ...savedInput, now, channel: 'qq', generate: () =>
    new Promise(resolve => { finishExtraction = resolve; }) });
  const reply = buildReplyContext(dummyCtx, { ...savedInput, observed: true });
  finishExtraction({ ok: true, text: JSON.stringify({
    items: [{ index: 0, title: '喝水', anchor: '十分钟后', quote: text }],
  }) });
  await extraction;
  const withTime = await reply;
  assert.equal(listAgreements(baseCfg, now).filter(item => item.peer === peer).length, 1);
  assert.doesNotMatch(await buildReplyContext(dummyCtx, { ...savedInput, text: '十分钟后提醒我交作业' }), /【约定小本本已接管】/);
  assert.match(withTime, /【约定小本本已接管】/);
  assert.match(withTime, /不要再额外创建一次性 DSH 定时器/);

  // 普通闲聊（无时间词）→ 不注入
  const noTime = await buildReplyContext(dummyCtx, { peer, kind: 'private', text: '今天天气真不错', at: now, cfg: baseCfg, observed: true });
  assert.doesNotMatch(noTime, /【约定小本本已接管】/);

  // 小本本关闭 → 不注入
  const disabledCfg = { ...baseCfg, agreements: { enabled: false } };
  saveConfig(disabledCfg);
  const off = await buildReplyContext(dummyCtx, { peer, kind: 'private', text: '十分钟后提醒我喝水', at: now, cfg: disabledCfg, observed: true });
  assert.doesNotMatch(off, /【约定小本本已接管】/);
});

test('取消指令遵循否定语境，并按创建时间选择刚才那条', async () => {
  const now = Date.parse('2026-11-25T15:00:00+08:00');
  const cfg = { timezone: 'Asia/Shanghai', agreements: { enabled: true } };
  const peer = 'cancel-order';
  const channel = 'qq';
  for (const [index, anchor, title] of [[0, '十分钟后', '交作业'], [1, '五分钟后', '带钥匙']]) {
    const at = now + index * 1000;
    const text = anchor + '提醒我' + title;
    await observeAgreement({ cfg, peer, channel, text, at, now: at,
      generate: async () => ({ ok: true, text: JSON.stringify({ items: [{ index: 0, title, anchor, quote: text }] }) }),
    });
  }
  const command = text => handleAgreementChatCommand({ cfg, peer, channel, text, now: now + 2000 });
  const pending = () => listAgreements(cfg, now + 2000).filter(item => item.peer === peer);
  for (const text of ['不要取消所有提醒', '千万别删除交作业的提醒', '不用清空全部提醒', '提醒不要全部取消', '别把提醒全部取消']) {
    assert.equal(command(text), '', text);
    assert.equal(pending().length, 2);
  }
  assert.match(command('取消刚才那个提醒'), /带钥匙/);
  assert.deepEqual(pending().map(item => item.title), ['交作业']);
  assert.match(command('取消所有提醒'), /已全部取消/);
});

test('缺少创建时间的旧提醒按到期时间回退', async () => {
  const { readChatData, writeChatData } = await import('../src/channels/douyin-im.js');
  const now = Date.parse('2026-11-25T15:00:00+08:00');
  const cfg = { timezone: 'Asia/Shanghai', agreements: { enabled: true } };
  const peer = 'legacy-cancel-order';
  const channel = 'qq';
  const { items } = readChatData('agreements');
  writeChatData('agreements', { items: [...items, ...['先到期', '后到期'].map((title, index) => ({
    id: 'legacy-' + index, title, dueAt: now + (index + 1) * 60_000, peer, channel, status: 'pending',
  }))] });
  const result = handleAgreementChatCommand({ text: '取消刚才那个提醒', peer, channel, cfg, now });
  assert.match(result, /后到期/);
  assert.deepEqual(listAgreements(cfg, now).filter(item => item.peer === peer).map(item => item.title), ['先到期']);
});
