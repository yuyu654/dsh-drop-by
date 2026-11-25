// schedule.test.mjs —— 时间段 / 静默 / 冲突检测的纯函数单测，不联网不读写文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DAY,
  parseHm,
  fmtHm,
  normalizeWindows,
  fmtWindows,
  toSegs,
  inWindows,
  inQuiet,
  nextOpenIn,
  overlapOf,
  totalMins,
  checkSchedule,
  describeSchedule,
  featureByKey,
} from '../src/perception/schedule.js';

const TZ = 'Asia/Shanghai';

/** 上海时间 2026-11-04 h:m 的时间戳（UTC+8，无夏令时）。 */
function at(h, m = 0) {
  return Date.UTC(2026, 10, 4, h - 8, m);
}

const cfgWith = (o = {}) => ({
  timezone: TZ,
  quietHours: o.quiet ?? [],
  channels: {
    qq: { enabled: o.qq !== false, activeHours: o.qqWin ?? [] },
    main: { enabled: false, activeHours: [] },
    douyin: { enabled: false, activeHours: o.dyWin ?? [] },
  },
  mail: { enabled: o.mail === true, activeHours: o.mailWin ?? [] },
});

test('parseHm 接受 24:00 作为结束时间', () => {
  assert.equal(parseHm('07:00'), 420);
  assert.equal(parseHm('0:05'), 5);
  assert.equal(parseHm('23:59'), 1439);
  assert.equal(parseHm('24:00'), DAY);
  assert.equal(parseHm('24:01'), -1);
  assert.equal(parseHm('7点'), -1);
});

test('fmtHm 回写补零，24:00 例外', () => {
  assert.equal(fmtHm(420), '07:00');
  assert.equal(fmtHm(1440), '24:00');
  assert.equal(fmtHm(0), '00:00');
});

test('normalizeWindows 三种写法等价', () => {
  const a = normalizeWindows([['07:00', '12:00'], ['14:00', '18:00']]);
  const b = normalizeWindows(['07:00-12:00', '14:00-18:00']);
  const c = normalizeWindows('07:00-12:00,14:00-18:00');
  assert.deepEqual(a.windows, b.windows);
  assert.deepEqual(b.windows, c.windows);
  assert.equal(a.errors.length, 0);
  assert.equal(fmtWindows(a.windows), '07:00-12:00、14:00-18:00');
});

test('多段静默：全角逗号/分号/冒号/顿号都算分隔（中文输入法直接打）', () => {
  const want = [['22:30', '07:30'], ['12:00', '13:00']];
  for (const v of [
    '22:30-07:30，12:00-13:00',
    '22:30-07:30、12:00-13:00',
    '22:30-07:30；12:00-13:00',
    '22：30-07：30，12：00-13：00',
    '22:30-07:30 12:00-13:00',
    '22:30-07:30\n12:00-13:00',
  ]) {
    const r = normalizeWindows(v);
    assert.equal(r.errors.length, 0, `${JSON.stringify(v)} 不该报错：${r.errors[0]}`);
    assert.deepEqual(r.windows, want, `${JSON.stringify(v)} 应解析成两段`);
  }
});

test('三段以上也行，顺带保留写入顺序', () => {
  const r = normalizeWindows('22:30-07:30，09:00-09:30，12:00-13:30');
  assert.deepEqual(r.windows, [['22:30', '07:30'], ['09:00', '09:30'], ['12:00', '13:30']]);
  assert.equal(fmtWindows(r.windows), '22:30-07:30、09:00-09:30、12:00-13:30');
});

test('normalizeWindows 空值/全天 = 不限时段', () => {
  for (const v of [null, undefined, '', [], '全天', 'all', '*']) {
    assert.deepEqual(normalizeWindows(v).windows, [], `${JSON.stringify(v)} 应视为全天`);
  }
  assert.equal(fmtWindows([]), '全天不限');
});

test('normalizeWindows 坏输入只报错不抛异常', () => {
  const r = normalizeWindows('07:00-12:00,瞎写');
  assert.equal(r.windows.length, 1, '好的一段仍然保留');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /看不懂/);

  const same = normalizeWindows(['08:00-08:00']);
  assert.deepEqual(same.windows, []);
  assert.match(same.errors[0], /首尾相同/);

  assert.equal(normalizeWindows([['25:00', '26:00']]).errors.length, 1);
});

test('跨零点被拆成两段并合并', () => {
  assert.deepEqual(toSegs([['22:30', '07:30']]), [
    [0, 450],
    [1350, DAY],
  ]);
  // 相邻两段合并
  assert.deepEqual(toSegs([['08:00', '12:00'], ['12:00', '14:00']]), [[480, 840]]);
});

test('inWindows 空数组恒 true，跨零点在两侧都算在', () => {
  assert.equal(inWindows(at(3), [], TZ), true);
  const w = [['22:30', '07:30']];
  assert.equal(inWindows(at(23), w, TZ), true);
  assert.equal(inWindows(at(2), w, TZ), true);
  assert.equal(inWindows(at(7, 29), w, TZ), true);
  assert.equal(inWindows(at(7, 30), w, TZ), false, '结束时刻不含');
  assert.equal(inWindows(at(12), w, TZ), false);
});

test('inQuiet 与 inWindows 同源，空数组恒 false', () => {
  assert.equal(inQuiet(at(23), [], TZ), false);
  assert.equal(inQuiet(at(23), [['22:30', '07:30']], TZ), true);
  assert.equal(inQuiet(at(12), [['22:30', '07:30']], TZ), false);
});

test('nextOpenIn 给出下一次开窗的分钟数', () => {
  const w = ['07:00-12:00', '14:00-18:00'];
  assert.equal(nextOpenIn(at(11), w, TZ), 0, '已经在窗口内');
  assert.equal(nextOpenIn(at(12, 30), w, TZ), 90);
  assert.equal(nextOpenIn(at(19), w, TZ), 12 * 60, '跨到第二天 07:00');
  assert.equal(nextOpenIn(at(3), [], TZ), 0);
});

test('overlapOf 算重叠区间与分钟数', () => {
  const r = overlapOf(['06:00-09:00'], ['22:30-07:30']);
  assert.equal(r.mins, 90);
  assert.equal(r.ranges.length, 1);

  assert.equal(overlapOf(['08:00-09:00'], ['22:30-07:30']).mins, 0);
  // 跨零点两边对撞
  assert.equal(overlapOf(['23:00-01:00'], ['22:30-23:30']).mins, 30);
});

test('totalMins 跨零点合计', () => {
  assert.equal(totalMins(['22:30-07:30']), 9 * 60);
});

test('checkSchedule：整段落在静默里 = error', () => {
  const f = checkSchedule(cfgWith({ quiet: [['22:30', '07:30']], qqWin: ['06:00-07:00'] }));
  const hit = f.find((x) => x.feature === 'qq');
  assert.equal(hit.level, 'error');
  assert.match(hit.text, /整段落在静默里/);
});

test('checkSchedule：部分重叠 = warn，并说出重叠多少分钟', () => {
  const f = checkSchedule(cfgWith({ quiet: [['22:30', '07:30']], qqWin: ['07:00-12:00'] }));
  const hit = f.find((x) => x.feature === 'qq');
  assert.equal(hit.level, 'warn');
  assert.match(hit.text, /30 分钟/);
  assert.match(hit.text, /07:00-07:30/);
});

test('checkSchedule：不相交 = info，全天不报', () => {
  const f = checkSchedule(cfgWith({ quiet: [['22:30', '07:30']], qqWin: ['09:00-18:00'] }));
  const hit = f.find((x) => x.feature === 'qq');
  assert.equal(hit.level, 'info');
  assert.ok(!f.some((x) => x.feature === 'douyin'), '全天不限的功能不该出现在冲突列表里');
});

test('checkSchedule：静默覆盖全天是 error', () => {
  const f = checkSchedule(cfgWith({ quiet: [['00:00', '12:00'], ['12:00', '24:00']] }));
  assert.ok(f.some((x) => x.level === 'error' && x.feature === 'quiet'));
});

test('checkSchedule：功能关着时冲突仍然报，但标注开关状态', () => {
  const f = checkSchedule(cfgWith({ quiet: [['22:30', '07:30']], mailWin: ['06:00-09:00'] }));
  const hit = f.find((x) => x.feature === 'mail');
  assert.equal(hit.level, 'warn');
  assert.match(hit.text, /该功能现在是关的/);
});

test('checkSchedule：配置写错会变成 error 而不是崩', () => {
  const f = checkSchedule(cfgWith({ qqWin: ['乱写'] }));
  assert.ok(f.some((x) => x.level === 'error' && x.feature === 'qq'));
});

test('describeSchedule：静默为空的文案是「不静默」', () => {
  const rows = describeSchedule(cfgWith({ quiet: [] }), at(11), TZ);
  assert.equal(rows[0].kind, 'quiet');
  assert.equal(rows[0].windowsText, '不静默');
  assert.equal(rows[0].active, false);

  const rows2 = describeSchedule(cfgWith({ quiet: [['10:00', '12:00']] }), at(11), TZ);
  assert.equal(rows2[0].active, true, '11 点落在静默里');
});

test('describeSchedule：静默压制功能，即使功能时段正开着', () => {
  const cfg = cfgWith({ quiet: [['10:00', '12:00']], qqWin: ['07:00-18:00'] });
  const rows = describeSchedule(cfg, at(11), TZ);
  const qq = rows.find((r) => r.label === '读 QQ 消息');
  assert.equal(qq.active, false);
  assert.match(qq.note, /静默/);
});

test('featureByKey 认中文和别名', () => {
  assert.equal(featureByKey('qq').key, 'qq');
  assert.equal(featureByKey('邮箱').key, 'mail');
  assert.equal(featureByKey('抖音').key, 'douyin');
  assert.equal(featureByKey('不存在'), null);
});
