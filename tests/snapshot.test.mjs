// snapshot.test.mjs —— 快照是纯拼装：给定假 ctx / state，测每一段在不在。
//
// 这一层的价值就在「可单测」：它不读文件、不叫模型，阶段 2 的模型看到什么，
// 全在这里决定。任何一段拼错了，模型就会拿错材料做判断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, periodOf, agoText } from '../src/decision/snapshot.js';

const NOW = Date.parse('2026-11-06T12:17:00+08:00'); // 周五中午
const TZ = 'Asia/Shanghai';

function fakeCtx() {
  return {
    tz: TZ,
    clock: '12:17',
    presence: { idleSec: 45 },
    activity: { kind: 'coding', fgTitle: 'compose.js' },
    signals: { ok: true, tab: { title: 'bilibili 学习区', site: 'bilibili' }, window: {} },
    her: { lastText: '嗯，知道了', lastAgoSec: 600, lastChannel: 'qq' },
    me: { lastText: '别熬太晚', lastAgoSec: 3600 },
    fish: { ok: true, ageMin: 120, sleepMin: 488, deepMin: 92, stress: 42, steps: 3200, screenMin: 300 },
    self: { section: '想法', line: '她今天嗓子有点哑，别逼她多说话' },
    recentOutbound: [{ text: '在干嘛', channel: 'qq', ts: NOW - 86_400_000 }],
    memory: { ok: true, items: [{ text: '毕设做电机结构仿真', day: '11-02' }] },
  };
}

const fakeSt = {
  pc: { lastReturnAt: NOW - 10 * 60_000, lastAwayMs: 40 * 60_000 },
  feedback: { slots: { sleep: { sent: 3, replied: 2 }, examSoon: { sent: 1, replied: 1 } } },
};

const fakeCfg = {
  timezone: TZ,
  content: { agenda: { text: '周五 08:00-09:40 高数\n周三 10:00-11:40 电路' }, exams: { text: '11-09 09:00 电机学' } },
};

test('snapshot：处境该有的段都在，顺序从「现在」开始', () => {
  const topic = { slot: 'sleep', label: '拿睡眠说事', brief: '她昨夜只睡了 7 小时。' };
  const s = buildSnapshot({ ctx: fakeCtx(), topic, cfg: fakeCfg, st: fakeSt, now: NOW, tz: TZ });

  assert.match(s, /^现在：2026-11-06 周五 12:17（中午）/);
  assert.match(s, /她最后一条：「嗯，知道了」（10 分钟前，QQ）/);
  assert.match(s, /我最后一条：「别熬太晚」/);
  assert.match(s, /她电脑前：在写代码（窗口「compose\.js」）/);
  assert.match(s, /她在浏览器里看「bilibili 学习区」/);
  assert.match(s, /刚回到电脑前/);
  assert.match(s, /她的身体数据（2 小时前取回）/);
  assert.match(s, /夜间睡眠 8 小时 8 分钟（深睡 1 小时 32 分钟）/);
  assert.doesNotMatch(s, /压力 42|3200/);
  assert.match(s, /今天有课：08:00-09:40「高数」/);
  assert.match(s, /下一节：/);
  assert.match(s, /考试：电机学 2026-11-09 09:00，还有 3 天/);
  assert.match(s, /我私下记过一条判断（想法）/);
  assert.match(s, /我最近发出去的：/);
  assert.match(s, /她接过我哪类话：/);
  assert.match(s, /拿睡眠说事 2\/3（67%）/);
  assert.match(s, /毕设做电机结构仿真/);
  assert.match(s, /规则建议（可参考也可不用）：拿睡眠说事/);
});

test('snapshot：电脑锁屏时提示锁屏且手机可达，不输出刚回到电脑前', () => {
  const ctx = { ...fakeCtx(), presence: { idleSec: 20, locked: true }, activity: null };
  const s = buildSnapshot({ ctx, topic: { slot: 'sleep', label: '拿睡眠说事', brief: '她昨夜只睡了 7 小时。' }, cfg: fakeCfg, st: fakeSt, now: NOW, tz: TZ });
  assert.match(s, /电脑当前锁屏中（QQ \/ 抖音在手机端仍可联系）/);
  assert.doesNotMatch(s, /刚回到电脑前/);
});

test('snapshot：只把探索正文交给选中的分享或相关回复提示', () => {
  const self = { section: '推理短篇', at: NOW, line: '很想聊这个反转', exploration: true };
  const ctx = { ...fakeCtx(), self, myExploration: [
    { mode: 'research', topic: '推理短篇', at: NOW, progress: '找到了一个反转', evidence: '仅标题或搜索摘要' },
    { mode: 'leisure', topic: '周末看的漫画', at: NOW, progress: '想读第二卷', evidence: '文字推演' },
  ] };
  const snapshot = (topic) => buildSnapshot({ ctx, topic, now: NOW });
  const share = snapshot({ slot: 'share', evidence: { section: self.section } });
  assert.match(share, /【我这边的进展】.*找到了一个反转.*仅标题或搜索摘要/s);
  assert.doesNotMatch(share, /想读第二卷|3200|压力 42/);
  assert.match(snapshot({ slot: 'reply' }), /只有确实聊到相关内容.*想读第二卷/s);
  assert.doesNotMatch(snapshot(null), /找到了一个反转|这个反转|3200|压力 42/);
});

test('snapshot：没有的数据整段省略，只剩「现在」和规则建议', () => {
  const s = buildSnapshot({ ctx: { tz: TZ }, topic: null, cfg: { timezone: TZ }, st: {}, now: NOW, tz: TZ });
  assert.doesNotMatch(s, /她最后一条/);
  assert.doesNotMatch(s, /她的身体数据/);
  assert.doesNotMatch(s, /我最近发出去的/);
  assert.doesNotMatch(s, /我记得的事/);
  assert.doesNotMatch(s, /我私下记过/);
  assert.match(s, /规则建议（可参考也可不用）：这一拍规则没挑出由头/);
});

test('snapshot：反馈关掉、记忆读不到时不拼那两段', () => {
  const cfg = { ...fakeCfg, rules: { feedback: { enabled: false } } };
  const ctx = { ...fakeCtx(), memory: { ok: false, reason: 'MEMORY_OFF', items: [] } };
  const s = buildSnapshot({ ctx, topic: null, cfg, st: fakeSt, now: NOW, tz: TZ });
  assert.doesNotMatch(s, /她接过我哪类话/);
  assert.doesNotMatch(s, /我记得的事/);
});

test('periodOf / agoText：时间说法', () => {
  assert.equal(periodOf(Date.parse('2026-11-06T03:30:00+08:00'), TZ), '深夜');
  assert.equal(periodOf(Date.parse('2026-11-06T07:10:00+08:00'), TZ), '清早');
  assert.equal(periodOf(Date.parse('2026-11-06T12:17:00+08:00'), TZ), '中午');
  assert.equal(periodOf(Date.parse('2026-11-06T21:00:00+08:00'), TZ), '晚上');
  assert.equal(agoText(20), '刚刚');
  assert.equal(agoText(600), '10 分钟前');
  assert.equal(agoText(3 * 3600), '3 小时前');
  assert.equal(agoText(2 * 86_400), '2 天前');
});

test('snapshot：自定义作息与勾选关闭的课程一致生效', async () => {
  const { parseAgenda, courseKey } = await import('../src/perception/agenda.js');
  const periods = '1-2 08:30-10:05\n3-4 10:25-12:00';
  const text = '周一 第1-2节 电力电子技术\n周一 第3-4节 自动控制';
  const [c1] = parseAgenda(text, { periods });
  const cfg = {
    timezone: TZ,
    content: { agenda: { text, periods, off: [courseKey(c1)] } },
  };
  const sunday = Date.parse('2026-11-15T21:40:00+08:00');
  const s = buildSnapshot({ ctx: { tz: TZ }, cfg, st: {}, now: sunday, tz: TZ });
  assert.doesNotMatch(s, /电力电子技术|08:00/);
  assert.match(s, /下一节：明天 10:25「自动控制」/);
});

test('snapshot：主动发送缓存 recentSends 即使没有 recentOutbound 也进「我最近发出去的」并去重', () => {
  const s = buildSnapshot({
    ctx: {
      tz: TZ,
      recentOutbound: [{ text: '已经记在通道历史里的句子', channel: 'qq', ts: NOW - 60_000 }],
      recentSends: ['已经记在通道历史里的句子', '刚刚主动发的：早点睡别熬了'],
    },
    cfg: { timezone: TZ },
    st: {},
    now: NOW,
    tz: TZ,
  });
  assert.match(s, /我最近发出去的：/);
  assert.match(s, /「刚刚主动发的：早点睡别熬了」（本插件近期主动发出）/);
  assert.equal(s.match(/已经记在通道历史里的句子/g)?.length, 1);
});

test('snapshot：随口说话（chitchat）把人设自身起点送进 judge 快照', () => {
  const s = buildSnapshot({
    ctx: { tz: TZ },
    topic: {
      slot: 'chitchat',
      evidence: {
        kind: 'chitchat',
        seedKind: 'persona',
        seed: '明知胃不好，还是爱喝冰饮料，常让对方顺手带一杯。',
        allowBare: true,
        bareLeft: 1,
      },
    },
    cfg: { timezone: TZ },
    st: {},
    now: NOW,
    tz: TZ,
  });
  assert.match(s, /这一拍可聊的角色偏好或习惯.*爱喝冰饮料/);
  assert.match(s, /只有聊天或候选事实支持时才说已经发生的事/);
});