import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-character-rest-'));
process.env.PG_CONFIG_PATH = path.join(tmp, 'config.json');
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_CHAT_DATA_DIR = path.join(tmp, 'data');
process.env.PG_DSH_HOME = tmp;
process.env.PG_FISH_LATEST_PATH = path.join(tmp, 'fish-latest.json');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { characterRestAt, characterRestStatus, characterRestCue, WIND_DOWN_HINT } = await import('../src/character-rest.js');
const { loadConfig, saveConfig } = await import('../src/config.js');
const { applyChange, listForUi, explorationItemsForUi } = await import('../src/settings.js');
const { decide } = await import('../src/decide.js');
const { buildReplyContext } = await import('../src/qq-reply.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');
const { guard, buildPrompt } = await import('../src/compose.js');
const { pickTopic, topicCandidates } = await import('../src/topics.js');
const { noteSent, sweep, slotStats, coldSlots, noteProactive, topicPreferenceMode } = await import('../src/feedback.js');
const { tick } = await import('../src/engine.js');
const { shadowEligible } = await import('../src/shadow.js');

const at = (day, hm) => Date.parse(day + 'T' + hm + ':00+08:00');
const cfg = { timezone: 'Asia/Shanghai', characterRest: { bed: '22:00', wake: '06:30', jitterMin: 0 } };

test('默认作息可编辑，零浮动跨午夜，非默认值生效', () => {
  const base = loadConfig();
  assert.deepEqual([base.characterRest.bed, base.characterRest.wake, base.characterRest.jitterMin], ['22:00', '06:30', 30]);
  const zero = applyChange(base, 'characterRest.jitterMin', 0);
  const shifted = applyChange(zero.cfg, 'characterRest.wake', '07:20');
  assert.ok(shifted.ok);
  saveConfig(shifted.cfg);
  const loaded = loadConfig();
  const fields = listForUi(loaded).flatMap(group => group.items);
  assert.equal(fields.find(f => f.path === 'characterRest.wake').value, '07:20');
  assert.equal(fields.find(f => f.path === 'characterRest.jitterMin').value, 0);
  assert.equal(applyChange(loaded, 'characterRest.bed', '07:20').ok, false);
  assert.equal(applyChange(loaded, 'characterRest.wake', '24:00').ok, false);
  assert.equal(characterRestAt(cfg, at('2026-11-22', '22:00')).asleep, true);
  assert.equal(characterRestAt(cfg, at('2026-11-23', '06:29')).asleep, true);
  assert.equal(characterRestAt(cfg, at('2026-11-23', '06:30')).asleep, false);
  assert.equal(characterRestAt(loaded, at('2026-11-23', '06:30')).asleep, true);
  assert.equal(characterRestAt(loaded, at('2026-11-23', '07:20')).asleep, false);
  assert.equal(characterRestAt(cfg, at('2026-11-22', '21:45')).windDown, true);
});

test('每日浮动有界，跨午夜看的是同一晚', () => {
  const varied = { ...cfg, characterRest: { ...cfg.characterRest, jitterMin: 30 } };
  const times = new Set();
  for (let i = 1; i <= 7; i++) {
    const late = characterRestAt(varied, at('2026-11-0' + i, '23:45'));
    assert.deepEqual(late, characterRestAt(varied, at('2026-11-0' + (i + 1), '00:15')));
    assert.ok(Math.abs(late.bedMin - 1320) <= 30);
    assert.ok(Math.abs(late.wakeMin - 390) <= 30);
    times.add(late.bedMin + '/' + late.wakeMin);
  }
  assert.ok(times.size > 1);
});

test('旧配置里的 adapt 字段被忽略，设置页不再暴露作息微调项', () => {
  const legacy = { ...cfg, characterRest: { ...cfg.characterRest, adapt: true, adaptDays: 7, adaptMaxMin: 20 } };
  const status = characterRestAt(legacy, at('2026-11-22', '23:10'));
  assert.equal(status.bedMin, 22 * 60);
  assert.equal(status.wakeMin, 6 * 60 + 30);
  for (const field of ['characterRest.adapt', 'characterRest.adaptDays', 'characterRest.adaptMaxMin']) {
    assert.equal(applyChange(legacy, field, true).ok, false);
  }
});

test('睡着只拦主动，QQ 和抖音私聊照常注入困意口吻', async () => {
  const now = at('2026-11-22', '23:00');
  const timing = { cfg: { ...cfg, rules: { dailyCap: 3 } }, now, idleSec: 0, todaySent: 0, characterAsleep: true };
  assert.equal(decide(timing).reason, 'CHARACTER_ASLEEP');
  assert.equal(decide({ ...timing, lastUserTs: now - 1000 }).track, 'reply');
  const qq = { ...cfg, channels: { primary: 'qq', qq: { peerId: '10001' } } };
  const dy = { ...cfg, channels: { primary: 'douyin', douyin: { peerSecUid: 'MS4w-test' } } };
  writeChatData('external-chat', { sessionId: 'fixture', qqBinding: null });
  for (const [cfg, peer] of [[qq, '10001'], [dy, 'MS4w-test']]) {
    assert.match(await buildReplyContext({}, { cfg, peer, kind: 'private', text: '在吗', at: now }), /睡着.*刚被这条消息吵醒.*先回应/u);
    assert.doesNotMatch(await buildReplyContext({}, { cfg, peer, kind: 'private', text: '在吗', at: at('2026-11-22', '12:00') }), /吵醒/u);
  }
  assert.doesNotMatch(await buildReplyContext({}, { cfg: qq, peer: '99999', kind: 'private', text: '在吗', at: now }), /吵醒/u);
  const ctx = { characterWindDown: true };
  const topic = { slot: 'share', brief: '分享一件事' };
  const limits = { content: { maxChars: 30 } };
  const draft = '这篇有个挺有意思的地方，留着一会儿再跟你细讲。';
  assert.ok(guard(draft, limits, {}).ok);
  assert.equal(guard(draft, limits, ctx).ok, false);
  assert.match(buildPrompt({ ctx, topic, persona: { text: '口语' }, cfg: limits }), new RegExp(WIND_DOWN_HINT));
});

test('主动草稿跨入睡边界时不送出，睡着后的下一拍也不生成', async (t) => {
  let clock = at('2026-11-22', '21:45');
  t.mock.method(Date, 'now', () => clock);
  saveConfig({
    ...cfg, quietHours: [], busyHours: [],
    sources: { phone: { enabled: false }, memory: { enabled: false } },
    perception: { l2: { enabled: false }, l3: { enabled: false }, signals: { enabled: false } },
    channels: { primary: 'qq', qq: { enabled: true, read: false, peerId: '10001' } },
    content: { mode: 'llm', exams: { text: '2026-11-22 22:15 电机学' } },
  });
  const result = await tick({ preview: true, probeSystem: async () => ({ idle_ms: 0 }), generate: async ({ prompt }) => {
    assert.ok(prompt.includes(WIND_DOWN_HINT));
    clock = at('2026-11-22', '22:01');
    return { ok: true, text: '电机学快开考了，记得带证件。' };
  } });
  assert.equal(result.record.reason, 'CHARACTER_ASLEEP', JSON.stringify(result.record));
  assert.equal(result.delivery, null);
  const asleep = await tick({ preview: true, probeSystem: async () => ({ idle_ms: 0 }),
    generate: async () => assert.fail('睡着后不该生成主动稿') });
  assert.equal(asleep.record.reason, 'CHARACTER_ASLEEP');
  assert.equal(shadowEligible({ rules: { judge: { enabled: true, shadow: true } } }, asleep.record.reason), false);
});

test('旧频率原样沿用，选择新三档后保存回显', () => {
  saveConfig({ exploration: { mode: 'light', leisureEvery: 1 } });
  const before = loadConfig();
  assert.equal(before.exploration.bias, undefined);
  assert.equal(before.exploration.leisureEvery, 1);
  const item = cfg => explorationItemsForUi(cfg).find(field => field.path === 'exploration.bias');
  assert.equal(item(before).value, 'leisure');
  assert.match(item(before).hint, /旧设置/);
  const other = applyChange(before, 'exploration.interest', '小动物');
  saveConfig(other.cfg);
  assert.equal(loadConfig().exploration.bias, undefined);
  const picked = applyChange(loadConfig(), 'exploration.bias', 'research');
  assert.ok(picked.ok);
  saveConfig(picked.cfg);
  assert.equal(loadConfig().exploration.leisureEvery, undefined);
  assert.equal(item(loadConfig()).value, 'research');
  assert.deepEqual(item(loadConfig()).options.map(([key]) => key), ['leisure', 'balanced', 'research']);
  assert.ok(!listForUi(loadConfig()).flatMap(group => group.items).some(field => field.path === 'exploration.leisureEvery'));
});

test('设置页角色作息展示今日实际作息与基准，不显示早晚微调项', (t) => {
  const noon = at('2026-11-22', '12:00');
  t.mock.method(Date, 'now', () => noon);
  const restCfg = {
    timezone: 'Asia/Shanghai',
    characterRest: { bed: '22:00', wake: '06:30', jitterMin: 0 },
  };
  const group = listForUi(restCfg).find(g => g.name === '角色作息');
  assert.match(group.summary, /今日实际 22:00–06:30 · 基准 22:00–06:30/);
  assert.match(group.innerNote, /今日实际作息：22:00 入睡 – 06:30 醒来（预设基准 22:00–06:30）。/);
  assert.doesNotMatch(group.summary + group.innerNote, /微调/);
  assert.equal(group.items.some(i => i.path.startsWith('characterRest.adapt')), false);
  const bedItem = group.items.find(i => i.path === 'characterRest.bed');
  const wakeItem = group.items.find(i => i.path === 'characterRest.wake');
  assert.match(bedItem.hint, /重算今日作息/);
  assert.match(wakeItem.hint, /重算今日作息/);
  assert.doesNotMatch(bedItem.hint + wakeItem.hint, /微调/);

  const changed = applyChange(restCfg, 'characterRest.bed', '22:30');
  assert.ok(changed.ok);
  const nextGroup = listForUi(changed.cfg).find(g => g.name === '角色作息');
  assert.match(nextGroup.summary, /今日实际 22:30–06:30 · 基准 22:30–06:30/);
  const status = characterRestStatus(changed.cfg, noon);
  assert.equal(status.bedHm, '22:30');
  assert.equal('adaptEnabled' in status, false);
});

test('角色睡前 10 分钟与醒来后 10 分钟可作为由头触发、去重，且设置项修改真实生效', () => {
  const base = loadConfig();
  assert.equal(base.content.topics.characterRest, true);
  assert.equal(base.content.topics.characterRestBeforeBedMin, 10);
  assert.equal(base.content.topics.characterRestAfterWakeMin, 10);

  const restCfg = {
    ...cfg,
    content: { topics: { characterRest: true, characterRestBeforeBedMin: 10, characterRestAfterWakeMin: 10 } },
  };
  const emptyCtx = { tz: 'Asia/Shanghai', her: {}, me: {}, fish: { ok: false }, pc: {} };

  // 入睡前 11 分钟不命中，入睡前 10 分钟命中，同一晚已用过去重
  assert.equal(pickTopic(emptyCtx, restCfg, at('2026-11-22', '21:49'), {}), null);
  const bedTopic = pickTopic(emptyCtx, restCfg, at('2026-11-22', '21:50'), {});
  assert.equal(bedTopic?.slot, 'characterRest');
  assert.equal(bedTopic?.evidence?.kind, 'bed');
  assert.equal(bedTopic?.evidence?.leftMin, 10);
  assert.equal(pickTopic(emptyCtx, restCfg, at('2026-11-22', '21:55'), {
    content: { lastCharacterBedFor: bedTopic.evidence.key },
  }), null);
  // 已入睡不再产出睡前由头
  assert.equal(characterRestCue(restCfg, at('2026-11-22', '22:00')), null);

  // 醒来后 0–10 分钟命中，11 分钟后不命中，同一早去重
  const wakeTopic = pickTopic(emptyCtx, restCfg, at('2026-11-23', '06:35'), {});
  assert.equal(wakeTopic?.slot, 'characterRest');
  assert.equal(wakeTopic?.evidence?.kind, 'wake');
  assert.equal(wakeTopic?.evidence?.sinceMin, 5);
  assert.equal(pickTopic(emptyCtx, restCfg, at('2026-11-23', '06:40'), {
    content: { lastCharacterWakeFor: wakeTopic.evidence.key },
  }), null);
  assert.equal(pickTopic(emptyCtx, restCfg, at('2026-11-23', '06:41'), {}), null);

  // 通过设置页保存、回显非默认值（25 分钟），原本 21:40 不命中 → 改完命中
  assert.equal(pickTopic(emptyCtx, restCfg, at('2026-11-22', '21:40'), {}), null);
  const widened = applyChange(restCfg, 'content.topics.characterRestBeforeBedMin', 25);
  assert.ok(widened.ok);
  const uiFields = listForUi(widened.cfg).flatMap(g => g.items);
  assert.equal(uiFields.find(f => f.path === 'content.topics.characterRestBeforeBedMin')?.value, 25);
  assert.equal(uiFields.find(f => f.path === 'content.topics.characterRest')?.value, true);
  assert.equal(pickTopic(emptyCtx, widened.cfg, at('2026-11-22', '21:40'), {})?.evidence?.kind, 'bed');

  // 关闭总开关后不再触发，且子项从设置页隐藏
  const off = applyChange(widened.cfg, 'content.topics.characterRest', false);
  assert.ok(off.ok);
  assert.equal(pickTopic(emptyCtx, off.cfg, at('2026-11-22', '21:55'), {}), null);
  assert.ok(!listForUi(off.cfg).flatMap(g => g.items).some(f => f.path === 'content.topics.characterRestBeforeBedMin'));
});

test('角色作息由头不计入接住率、不动 streak 或冷落惩罚，但仍可被偏好静音', () => {
  const st = {};
  const t0 = at('2026-11-22', '10:00'); // 白天公平窗口内，用于验证不会被判 miss
  for (let i = 0; i < 7; i++) {
    noteSent(st, 'characterRest', t0 + i * 60_000, '刚醒，早呀。', { tz: 'Asia/Shanghai', cfg });
  }
  sweep(st, t0 + 6 * 3_600_000, { tz: 'Asia/Shanghai', cfg, canJudge: true });
  assert.equal(st.feedback.streak, 0);
  assert.equal(slotStats(st).characterRest, undefined);
  assert.equal(coldSlots(st, cfg, t0 + 6 * 3_600_000).has('characterRest'), false);

  // 仍属于主动消息，允许用户通过偏好静音
  noteProactive(st, { slot: 'characterRest', evidence: {} }, { channel: 'qq', peer: '10001', at: t0 });
  assert.equal(st.feedback.lastProactive?.slot, 'characterRest');
  st.feedback.preferences = [{ mode: 'mute_less', target: { slot: 'characterRest' }, expiresAt: null }];
  assert.equal(topicPreferenceMode(st, { slot: 'characterRest' }, t0), 'mute_less');
});

test('用户先发早/晚问候后，去重窗口内不重复触发作息由头，设置项可调', () => {
  const base = loadConfig();
  assert.equal(base.content.topics.characterRestGreetSkipMin, 120);
  const restCfg = {
    ...cfg,
    content: { topics: { characterRest: true, characterRestBeforeBedMin: 10, characterRestAfterWakeMin: 10, characterRestGreetSkipMin: 120 } },
  };
  const bedNow = at('2026-11-22', '21:55');
  const nightGreetCtx = {
    tz: 'Asia/Shanghai',
    her: { lastTs: at('2026-11-22', '21:30'), lastText: '晚安啦' },
    me: { lastTs: at('2026-11-22', '21:31'), lastText: '晚安' },
    recent: [{ from: 'her', ts: at('2026-11-22', '21:30'), text: '晚安啦' }],
    fish: { ok: false }, pc: {},
  };
  const misses = new Map();
  assert.equal([...topicCandidates(nightGreetCtx, restCfg, bedNow, {}, undefined, misses)].length, 0);
  assert.equal(misses.get('characterRest'), 'already_used');

  // 早上先道了早安，醒后 10 分钟内不重复发早安
  const wakeNow = at('2026-11-23', '06:35');
  const morningGreetCtx = {
    tz: 'Asia/Shanghai',
    her: { lastTs: at('2026-11-23', '06:20'), lastText: '早安呀' },
    me: { lastTs: at('2026-11-23', '06:21'), lastText: '早' },
    recent: [{ from: 'her', ts: at('2026-11-23', '06:20'), text: '早安呀' }],
    fish: { ok: false }, pc: {},
  };
  assert.equal(pickTopic(morningGreetCtx, restCfg, wakeNow, {}), null);

  // 普通话题或昨天的晚安不会误拦截
  const normalCtx = {
    tz: 'Asia/Shanghai',
    her: { lastTs: at('2026-11-22', '21:40'), lastText: '你昨晚睡得好吗' },
    me: { lastTs: at('2026-11-22', '21:41'), lastText: '还行' },
    recent: [{ from: 'her', ts: at('2026-11-21', '21:50'), text: '晚安' }],
    fish: { ok: false }, pc: {},
  };
  assert.equal(pickTopic(normalCtx, restCfg, bedNow, {})?.slot, 'characterRest');

  // 改短去重窗口（15 分钟）后保存回显，25 分钟前的晚安不再拦截，10 分钟前的仍拦截
  const shortWin = applyChange(restCfg, 'content.topics.characterRestGreetSkipMin', 15);
  assert.ok(shortWin.ok);
  const fields = listForUi(shortWin.cfg).flatMap(g => g.items);
  assert.equal(fields.find(f => f.path === 'content.topics.characterRestGreetSkipMin')?.value, 15);
  assert.equal(pickTopic(nightGreetCtx, shortWin.cfg, bedNow, {})?.slot, 'characterRest');
  const justSaidCtx = {
    ...nightGreetCtx,
    her: { lastTs: at('2026-11-22', '21:46'), lastText: '先睡了' },
    me: { lastTs: at('2026-11-22', '21:47'), lastText: '好梦' },
    recent: [{ from: 'her', ts: at('2026-11-22', '21:46'), text: '先睡了' }],
  };
  assert.equal(pickTopic(justSaidCtx, shortWin.cfg, bedNow, {}), null);
});
