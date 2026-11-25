// triggers.test.mjs —— 阶段 3：自然触发时刻只负责「这一拍有没有事件」，不负责发不发。
// 2026-11-07 起「下课」改成段：上午段上完一次、当天最后一节上完一次（一天最多两次）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectTriggers } from '../src/decision/triggers.js';
import { parseAgenda, courseKey } from '../src/perception/agenda.js';

const TZ = 'Asia/Shanghai';
const cfg = (nt = {}, extra = {}) => ({
  timezone: TZ,
  rules: { naturalTriggers: { enabled: true, ...nt } },
  ...extra,
});
const agenda = (text, off = []) => ({ content: { agenda: { text, off } } });
const at = (hm, date = '2026-11-02') => new Date(`${date}T${hm}:00+08:00`).getTime();

// 2026-11-02 是周一，10:00
const NOW = new Date('2026-11-02T10:00:00+08:00').getTime();

test('关着时立刻返回：不碰 state、不产生事件', () => {
  const st = {};
  const r = detectTriggers({ cfg: cfg({ enabled: false }), now: NOW, tz: TZ, st, activity: { kind: 'media' }, selfMtimeMs: 123 });
  assert.equal(r.enabled, false);
  assert.deepEqual(r.fired, []);
  assert.equal(st.triggers, undefined);
});

test('L2 归类切换算事件；同一类连着两拍不算；other 不算', () => {
  const st = { triggers: { lastKind: 'coding' } };
  const r = detectTriggers({ cfg: cfg(), now: NOW, tz: TZ, st, activity: { kind: 'media' } });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].kind, 'l2');
  assert.match(r.fired[0].label, /写代码.*看视频/);
  assert.equal(st.triggers.lastKind, 'media');

  const again = detectTriggers({ cfg: cfg(), now: NOW + 60_000, tz: TZ, st, activity: { kind: 'media' } });
  assert.deepEqual(again.fired, []);

  st.triggers.lastKind = 'coding';
  const other = detectTriggers({ cfg: cfg(), now: NOW + 120_000, tz: TZ, st, activity: { kind: 'other' } });
  assert.deepEqual(other.fired, []);
});

test('上午三节 + 下午一节：上午段只在上完时触发，段中间下课不触发', () => {
  const c = cfg(
    {},
    agenda(['周一 08:00-09:40 高数', '周一 09:50-11:40 电路', '周一 11:45-12:10 习题', '周一 14:00-15:40 电机学'].join('\n')),
  );
  const st = {};
  const first = detectTriggers({ cfg: c, now: at('09:40'), tz: TZ, st });
  assert.deepEqual(first.fired, [], '9:40 只是第一节课下课，不是上午段上完');

  const am = detectTriggers({ cfg: c, now: at('12:10'), tz: TZ, st });
  assert.equal(am.fired.length, 1);
  assert.equal(am.fired[0].kind, 'course-am');
  assert.match(am.fired[0].label, /上午的课上完了/);
  assert.match(am.fired[0].label, /习题/);

  const pm = detectTriggers({ cfg: c, now: at('15:40'), tz: TZ, st });
  assert.equal(pm.fired.length, 1);
  assert.equal(pm.fired[0].kind, 'course-pm');
  assert.match(pm.fired[0].label, /课上完了/);
  assert.match(pm.fired[0].label, /电机学/);

  const again = detectTriggers({ cfg: c, now: at('15:41'), tz: TZ, st });
  assert.deepEqual(again.fired, [], '段去重：同一天同一段只触发一次');
});

test('只有上午课：只触发一次，文案是「课上完了」', () => {
  const c = cfg({}, agenda('周一 08:00-09:40 高数'));
  const st = {};
  const r = detectTriggers({ cfg: c, now: at('09:40'), tz: TZ, st });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].kind, 'course-am');
  assert.match(r.fired[0].label, /课上完了/);
  assert.doesNotMatch(r.fired[0].label, /上午的/);
  assert.deepEqual(detectTriggers({ cfg: c, now: at('09:50'), tz: TZ, st }).fired, []);
});

test('只有晚上的课：只触发一次，文案是「课上完了」', () => {
  const c = cfg({}, agenda('周一 19:00-20:35 电力电子'));
  const r = detectTriggers({ cfg: c, now: at('20:35'), tz: TZ, st: {} });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].kind, 'course-pm');
  assert.match(r.fired[0].label, /课上完了/);
  assert.doesNotMatch(r.fired[0].label, /上午的/);
  assert.match(r.fired[0].label, /电力电子.*20:35 下课/);
});

test('只有下午课（没有上午课）：一次，文案是「课上完了」', () => {
  const c = cfg({}, agenda('周一 14:00-16:00 电机学 @教三201'));
  const r = detectTriggers({ cfg: c, now: at('16:00'), tz: TZ, st: {} });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].kind, 'course-pm');
  assert.match(r.fired[0].label, /课上完了/);
  assert.doesNotMatch(r.fired[0].label, /上午的/);
  assert.match(r.fired[0].label, /@教三201/);
});

test('下午 + 晚上都有课：16:00 不触发，20:35 只触发一次', () => {
  const c = cfg({}, agenda(['周一 14:00-16:00 电机学', '周一 19:00-20:35 电力电子'].join('\n')));
  const st = {};
  assert.deepEqual(detectTriggers({ cfg: c, now: at('16:00'), tz: TZ, st }).fired, [], '后段还有课，不能说「都上完了」');
  const r = detectTriggers({ cfg: c, now: at('20:35'), tz: TZ, st });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].atMin, 20 * 60 + 35);
  assert.equal(r.fired[0].name, '电力电子');
});

test('跨午间的课归上午段：11:00-12:10 的事件点在 12:10', () => {
  const c = cfg({}, agenda(['周一 08:00-09:40 高数', '周一 11:00-12:10 电路', '周一 14:00-15:40 电机学'].join('\n')));
  const st = {};
  assert.deepEqual(detectTriggers({ cfg: c, now: at('11:40'), tz: TZ, st }).fired, [], '11:40 不是上午段最后一节');
  const r = detectTriggers({ cfg: c, now: at('12:10'), tz: TZ, st });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].atMin, 12 * 60 + 10);
  assert.match(r.fired[0].label, /电路/);
});

test('没课 / 课全被勾掉：不产生课上完了的事件', () => {
  assert.deepEqual(detectTriggers({ cfg: cfg(), now: NOW, tz: TZ, st: {} }).fired, []);
  const text = '周一 08:00-09:40 高数\n周一 14:00-15:40 电机学';
  const off = parseAgenda(text).map((c) => courseKey(c));
  const r = detectTriggers({ cfg: cfg({}, agenda(text, off)), now: at('09:40'), tz: TZ, st: {} });
  assert.deepEqual(r.fired, []);
});

test('窗口边界：toMin + courseWindowMin - 1 触发，toMin + courseWindowMin 不触发', () => {
  const c = cfg({}, agenda('周一 08:00-09:40 高数'));
  assert.equal(detectTriggers({ cfg: c, now: at('09:59'), tz: TZ, st: {} }).fired.length, 1);
  assert.deepEqual(detectTriggers({ cfg: c, now: at('10:00'), tz: TZ, st: {} }).fired, []);
});

test('courseSplitMin 改成 780 后，12:30 的课归上午段', () => {
  const c = (split) => cfg({ courseSplitMin: split }, agenda('周一 12:30-13:50 习题课'));
  const def = detectTriggers({ cfg: c(undefined), now: at('13:50'), tz: TZ, st: {} });
  assert.equal(def.fired.length, 1);
  assert.match(def.fired[0].label, /课上完了/);
  assert.equal(def.fired[0].kind, 'course-pm');

  const late = detectTriggers({ cfg: c(780), now: at('13:50'), tz: TZ, st: {} });
  assert.equal(late.fired.length, 1);
  assert.equal(late.fired[0].kind, 'course-am');
  assert.match(late.fired[0].label, /课上完了/);
});

test('段内最后一节被勾掉：事件点顺延到前一节', () => {
  const text = '周一 08:00-09:40 高数\n周一 10:00-11:40 电路';
  const last = parseAgenda(text).find((c) => c.name === '电路');
  const c = cfg({}, agenda(text, [courseKey(last)]));
  const st = {};
  // 11:40 不该触发（电路被勾掉了），事件点在 09:40 那一节
  assert.deepEqual(detectTriggers({ cfg: c, now: at('11:40'), tz: TZ, st }).fired, []);
  const r = detectTriggers({ cfg: c, now: at('09:40'), tz: TZ, st });
  assert.equal(r.fired.length, 1);
  assert.match(r.fired[0].label, /高数/);
});

test('self.md 第一次只记基线，之后写入才算事件', () => {
  const st = {};
  const c = cfg();
  const first = detectTriggers({ cfg: c, now: NOW, tz: TZ, st, selfMtimeMs: 1000 });
  assert.deepEqual(first.fired, []);
  assert.equal(st.triggers.selfMtime, 1000);

  const same = detectTriggers({ cfg: c, now: NOW + 60_000, tz: TZ, st, selfMtimeMs: 1000 });
  assert.deepEqual(same.fired, []);

  const newer = detectTriggers({ cfg: c, now: NOW + 120_000, tz: TZ, st, selfMtimeMs: 2000 });
  assert.equal(newer.fired.length, 1);
  assert.equal(newer.fired[0].kind, 'self');
  assert.equal(st.triggers.selfMtime, 2000);
});

test('takeGap / floorMin / 下课窗口的默认值', () => {
  const r = detectTriggers({
    cfg: cfg({ enabled: true, takeGap: undefined, floorMin: undefined, courseWindowMin: undefined, courseSplitMin: undefined }),
    now: NOW,
    tz: TZ,
    st: {},
  });
  assert.equal(r.gapAllowed, false);
  assert.equal(r.floorMin, 20);
  // 默认窗口 20 分钟：09:41 结束的课，10:00 还在窗口里（旧默认 5 分钟就不会触发）
  const c = cfg({}, agenda('周一 08:01-09:41 高数'));
  assert.equal(detectTriggers({ cfg: c, now: at('10:00'), tz: TZ, st: {} }).fired.length, 1);
});