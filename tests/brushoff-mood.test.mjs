import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-brushoff-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const {
  BRUSHOFF_DECAY_MS,
  SAME_CHAT_WINDOW_MS,
  evaluateBrushoffTurn,
  evaluateBrushoffNoReply,
  noteProactiveForBrushoff,
  getBrushoffMoodState,
  isSharePausedByMood,
  isBrushoffFollowUpSuppressed,
  proactiveBrushoffHint,
} = await import('../src/chat/brushoff-mood.js');
const { listForUi } = await import('../src/settings/settings.js');
const { loadConfig } = await import('../src/settings/config.js');

const baseCfg = (enabled = true) => ({
  timezone: 'Asia/Shanghai',
  busyHours: [],
  channels: { primary: 'qq', qq: { enabled: true, peerId: '728361417' } },
  rules: {
    brushoffMood: { enabled, angryDelayMinSec: 25, angryDelayMaxSec: 50 },
  },
  content: { agenda: { text: '' } },
});

test('默认关闭：settings 中放在「决定TA粘不粘人」紧接「轻招呼一天最多几次」下方，且默认 false', () => {
  const cfg = loadConfig();
  assert.equal(cfg.rules.brushoffMood.enabled, false);
  const groups = listForUi({ ...cfg, rules: { ...cfg.rules, chitchat: { ...cfg.rules.chitchat, enabled: true } } });
  const g = groups.find((x) => x.name === '决定TA粘不粘人');
  assert.ok(g);
  const idxBare = g.items.findIndex((i) => i.path === 'rules.chitchat.barePerDay');
  const idxMood = g.items.findIndex((i) => i.path === 'rules.brushoffMood.enabled');
  assert.ok(idxBare >= 0);
  assert.equal(idxMood, idxBare + 1);
  assert.equal(g.items[idxMood].value, false);
  assert.match(g.items[idxMood].hint, /高频聊天/);
  assert.match(g.items[idxMood].hint, /25–50 秒/);
});

test('3 次无理由敷衍递进（闷闷 -> 更失落 -> 生气），同一次生气只主动说明一遍，暂停分享、闲聊带情绪', () => {
  const cfg = baseCfg(true);
  const peer = 'p1';
  const t0 = Date.UTC(2026, 10, 26, 4, 0, 0); // 12:00 +08

  // 约定确认不算敷衍
  let r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '我到了，出来吧。', userText: '嗯嗯', at: t0, now: t0 });
  assert.equal(r.triggered, false);
  assert.equal(r.level, 'normal');

  // 第 1 次敷衍 -> 有点闷，不追问
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '今天翻到部挺有意思的漫画，社恐设计师被超级E人拖着搭档。', userText: '哦', at: t0 + 1000, now: t0 + 1000 });
  assert.equal(r.triggered, true);
  assert.equal(r.level, 'sulking');
  assert.equal(r.count, 1);
  assert.equal(r.delayMs, 0);
  assert.match(r.hint, /有点闷/);
  assert.equal(isBrushoffFollowUpSuppressed(cfg, peer, t0 + 2000), true);
  assert.equal(isSharePausedByMood(cfg, peer, t0 + 2000), false);

  // 第 2 次敷衍 -> 更失落，速度与分享照常
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '外面风比想的大，下午打算煮点热汤喝。', userText: '嗯', at: t0 + 60_000, now: t0 + 60_000 });
  assert.equal(r.level, 'sulking');
  assert.equal(r.count, 2);
  assert.equal(r.delayMs, 0);
  assert.match(r.hint, /更失落/);
  assert.equal(isSharePausedByMood(cfg, peer, t0 + 61_000), false);

  // 第 3 次敷衍 -> 进入生气，首次明确说明，延迟 25–50 秒，暂停分享，闲聊带情绪
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '刚才又去翻了第002话，讲主角怎么硬着头皮回绝别人。', userText: '行吧', at: t0 + 120_000, now: t0 + 120_000, rand: () => 0.5 });
  assert.equal(r.level, 'angry');
  assert.equal(r.count, 3);
  assert.equal(r.delayMs, 37500);
  assert.match(r.hint, /明确说清楚为什么不开心/);
  assert.equal(isSharePausedByMood(cfg, peer, t0 + 121_000), true);
  assert.match(proactiveBrushoffHint(cfg, peer, t0 + 121_000), /还在生气/);

  // 仍在生气时的普通消息：不再重复控诉，依然慢回
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '哼', userText: '晚饭吃啥', at: t0 + 180_000, now: t0 + 180_000, rand: () => 0,
    outgoing: { peer, firstAt: t0 + 157_500, lastAt: t0 + 158_000, count: 1, text: '连着好几次都只回几个字，我有点不开心。' } });
  assert.equal(r.level, 'angry');
  assert.equal(r.delayMs, 25000);
  assert.match(r.hint, /不要反复控诉/);

  // 主动问「怎么了」时可以再说原因
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '随便。', userText: '怎么了，生气啦？', at: t0 + 240_000, now: t0 + 240_000, rand: () => 1 });
  assert.equal(r.level, 'angry');
  assert.equal(r.delayMs, 50000);
  assert.match(r.hint, /简短再说一遍原因/);

  // 补说理由 -> 当轮立刻消气
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '你自己想。', userText: '刚才在上课，没来得及细看', at: t0 + 300_000, now: t0 + 300_000 });
  assert.equal(r.level, 'normal');
  assert.equal(r.recovered, 'excuse');
  assert.equal(r.delayMs, 0);
  assert.match(r.hint, /早说你在忙嘛/);
  assert.equal(isSharePausedByMood(cfg, peer, t0 + 301_000), false);
});

test('道歉当轮消气，且满 6 小时自然衰减恢复正常', () => {
  const cfg = baseCfg(true);
  const peer = 'p2';
  const t0 = Date.UTC(2026, 10, 26, 5, 0, 0);

  for (let i = 0; i < 3; i++) {
    evaluateBrushoffTurn({
      cfg, peer,
      prevMeText: '今天遇到一件挺有意思的事想跟你说说。',
      userText: '哦',
      at: t0 + i * 10_000,
      now: t0 + i * 10_000,
    });
  }
  assert.equal(getBrushoffMoodState({ cfg, peer, now: t0 + 30_000 }).level, 'angry');

  // 道歉直接消气
  const res = evaluateBrushoffTurn({ cfg, peer, prevMeText: '不聊了。', userText: '对不起嘛别生气了，刚才太敷衍了', at: t0 + 40_000, now: t0 + 40_000 });
  assert.equal(res.level, 'normal');
  assert.equal(res.recovered, 'apology');
  assert.equal(res.delayMs, 0);

  // 再触发一次生气（隔开 30 分钟同一段聊天窗口），验证 6 小时后自动衰减恢复
  const t1 = t0 + SAME_CHAT_WINDOW_MS + 60_000;
  for (let i = 0; i < 3; i++) {
    evaluateBrushoffTurn({
      cfg, peer,
      prevMeText: '刚才又看到一条好玩的新闻想分享给你。',
      userText: '嗯',
      at: t1 + i * 10_000,
      now: t1 + i * 10_000,
    });
  }
  assert.equal(getBrushoffMoodState({ cfg, peer, now: t1 + 30_000 }).level, 'angry');
  assert.equal(getBrushoffMoodState({ cfg, peer, now: t1 + 20_000 + BRUSHOFF_DECAY_MS }).level, 'normal');
});

test('首次说明在未确认普通回复送达前可重试，送达后只保留情绪提示', () => {
  const cfg = baseCfg();
  const peer = 'explanation-retry';
  const at = Date.UTC(2026, 10, 26, 4, 0, 0);
  const turn = (offset, extra = {}) => evaluateBrushoffTurn({
    cfg, peer, channel: 'qq', at: at + offset, now: at + offset,
    prevMeText: '今天翻到部挺有意思的漫画想跟你分享。', userText: '哦', ...extra,
  });
  turn(10);
  turn(20);
  assert.match(turn(30).hint, /明确说清楚为什么不开心/);
  assert.match(turn(30).hint, /明确说清楚为什么不开心/);
  assert.equal(getBrushoffMoodState({ cfg, peer, now: at + 30 }).explained, false);
  const outgoing = { peer, firstAt: at + 34, lastAt: at + 35, count: 1, text: '有点委屈，你接连几次都只回了一个字。' };
  assert.match(turn(30, { outgoing: { ...outgoing, count: 0, lastAt: 0 } }).hint, /明确说清楚为什么不开心/);
  assert.match(turn(40, { outgoing, userText: '晚饭吃啥' }).hint, /不要反复控诉/);
  assert.equal(getBrushoffMoodState({ cfg, peer, now: at + 40 }).explained, true);
});

test('生气时间设置随开关显示，保存回显并改变慢回、衰减与不回阈值', async () => {
  const { applyChange } = await import('../src/settings/settings.js');
  const { saveConfig } = await import('../src/settings/config.js');
  const paths = ['noReplyMin', 'decayHours', 'angryDelayMinSec', 'angryDelayMaxSec'].map(key => 'rules.brushoffMood.' + key);
  const fields = config => listForUi(config).flatMap(group => group.items).filter(item => paths.includes(item.path));
  assert.equal(loadConfig().rules.brushoffMood.noReplyMin, 90);
  assert.equal(fields(loadConfig()).length, 0);
  let cfg = baseCfg();
  for (const [index, value] of [30, 1, 2, 4].entries()) {
    const change = applyChange(cfg, paths[index], value);
    assert.ok(change.ok, change.error);
    cfg = change.cfg;
  }
  assert.equal(applyChange(cfg, paths[2], 5).ok, false);
  saveConfig(cfg);
  cfg = loadConfig();
  assert.deepEqual(Object.fromEntries(fields(cfg).map(({ path, value }) => [path, value])),
    Object.fromEntries(paths.map((path, i) => [path, [30, 1, 2, 4][i]])));
  const peer = 'custom-timing';
  const base = Date.UTC(2026, 10, 26, 4, 0, 0);
  // 非默认 noReplyMin=30：29 分钟不计入，满 30 分钟计入 1 次
  noteProactiveForBrushoff({ cfg, peer, slot: 'share', text: '发现一部超好看的漫画想发给你。', at: base });
  assert.equal(evaluateBrushoffNoReply({ cfg, peer, now: base + 29 * 60_000 }).triggered, false);
  const nr = evaluateBrushoffNoReply({ cfg, peer, now: base + 30 * 60_000 });
  assert.equal(nr.triggered, true);
  assert.equal(nr.count, 1);
  let result;
  for (let i = 0; i < 2; i++) {
    const at = base + 31 * 60_000 + i * 1000;
    result = evaluateBrushoffTurn({ cfg, peer, at, now: at, prevMeText: '刚看了有意思的漫画想分享。', userText: '嗯', rand: () => 0.5 });
  }
  assert.equal(result.level, 'angry');
  assert.equal(result.delayMs, 3000);
  assert.equal(getBrushoffMoodState({ cfg, peer, now: base + 31 * 60_000 + 1000 + 3599999 }).level, 'angry');
  assert.equal(getBrushoffMoodState({ cfg, peer, now: base + 31 * 60_000 + 1000 + 3600000 }).level, 'normal');
});

test('随口话：敷衍不计入，但超过 90 分钟不回计入', () => {
  const cfg = baseCfg(true);
  const peer = 'chitchat-asymmetry';
  const t0 = Date.UTC(2026, 10, 26, 4, 0, 0); // 12:00 +08

  // 随口话被敷衍 -> 不计入
  noteProactiveForBrushoff({ cfg, peer, slot: 'chitchat', text: '今天外面太阳挺不错的，你在干嘛呀？', at: t0 });
  const r1 = evaluateBrushoffTurn({
    cfg, peer,
    prevMeText: '今天外面太阳挺不错的，你在干嘛呀？',
    userText: '哦',
    at: t0 + 60_000,
    now: t0 + 60_000,
  });
  assert.equal(r1.triggered, false);
  assert.equal(r1.count, 0);
  assert.equal(r1.level, 'normal');

  // 随口话 90 分钟不回 -> 计入 1 次
  const t1 = t0 + 2 * 60_000;
  noteProactiveForBrushoff({ cfg, peer, slot: 'chitchat', text: '刚路过楼下看到一只橘猫在晒太阳。', at: t1 });
  assert.equal(evaluateBrushoffNoReply({ cfg, peer, now: t1 + 89 * 60_000 }).triggered, false);
  const r2 = evaluateBrushoffNoReply({ cfg, peer, now: t1 + 90 * 60_000 });
  assert.equal(r2.triggered, true);
  assert.equal(r2.level, 'sulking');
  assert.equal(r2.count, 1);
});

test('同一段聊天 30 分钟内认真回过一次：抵消之前攒的闷闷，且 30 分钟内后续短回或不回均不计入', () => {
  const cfg = baseCfg(true);
  const peer = 'same-chat-offset';
  const t0 = Date.UTC(2026, 10, 26, 4, 0, 0);

  // 先攒 2 次闷闷
  let r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '刚看了一部挺有意思的漫画想跟你讲讲。', userText: '哦', at: t0, now: t0 });
  assert.equal(r.count, 1);
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '今天下午想煮个番茄牛腩试试看。', userText: '嗯', at: t0 + 60_000, now: t0 + 60_000 });
  assert.equal(r.count, 2);
  assert.equal(r.level, 'sulking');

  // 认真回过一次 -> 直接抵消之前攒的闷闷次数（归零）
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '算了不说了。', userText: '番茄牛腩听起来不错，记得多放点洋葱提香！', at: t0 + 120_000, now: t0 + 120_000 });
  assert.equal(r.level, 'normal');
  assert.equal(r.count, 0);
  assert.equal(r.triggered, false);

  // 30 分钟内后续短回 -> 不计入
  r = evaluateBrushoffTurn({ cfg, peer, prevMeText: '好嘞，那我顺便再买点土豆一起炖。', userText: '嗯', at: t0 + 10 * 60_000, now: t0 + 10 * 60_000 });
  assert.equal(r.triggered, false);
  assert.equal(r.count, 0);

  // 30 分钟内发出的主动消息即使后续不回 -> 不计入
  noteProactiveForBrushoff({ cfg, peer, slot: 'share', text: '我买完菜回来啦，土豆看着超新鲜。', at: t0 + 20 * 60_000 });
  const nr = evaluateBrushoffNoReply({ cfg, peer, now: t0 + 120 * 60_000 });
  assert.equal(nr.triggered, false);
  assert.equal(nr.count, 0);
});

test('不回免责：静默时段、忙碌时段或之前说过在忙/告别均不计入', () => {
  const cfg = {
    ...baseCfg(true),
    quietHours: [['23:00', '08:00']],
    busyHours: [['14:00', '16:00']],
  };
  const peer = 'no-reply-exempt';

  // 忙碌时段重叠 -> 免责
  const tBusy = Date.UTC(2026, 10, 26, 5, 30, 0); // 13:30 +08 -> +90m = 15:00 +08 (重叠 14:00-16:00)
  noteProactiveForBrushoff({ cfg, peer, slot: 'share', text: '刚看到一个好玩的帖子发你看看。', at: tBusy });
  assert.equal(evaluateBrushoffNoReply({ cfg, peer, now: tBusy + 90 * 60_000 }).triggered, false);

  // 静默时段 -> 免责
  const tQuiet = Date.UTC(2026, 10, 26, 14, 30, 0); // 22:30 +08 -> +90m = 00:00 +08 (进入静默)
  noteProactiveForBrushoff({ cfg, peer, slot: 'chitchat', text: '还没睡吗？', at: tQuiet });
  assert.equal(evaluateBrushoffNoReply({ cfg, peer, now: tQuiet + 90 * 60_000 }).triggered, false);

  // 之前用户说过在忙 -> 免责
  const tNormal = Date.UTC(2026, 10, 26, 2, 0, 0); // 10:00 +08
  noteProactiveForBrushoff({ cfg, peer, slot: 'share', text: '这个番剧更新了，超好看。', at: tNormal });
  assert.equal(evaluateBrushoffNoReply({ cfg, peer, now: tNormal + 90 * 60_000, lastHerText: '我先去开个会' }).triggered, false);
});
