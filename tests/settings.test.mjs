// settings.test.mjs —— 设置页能改什么、改成什么样算合法。纯函数，不碰磁盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA, coerce, applyChange, listForUi, channelItemsForUi, display, normalizeHm } from '../src/settings.js';

const cfg = () => ({
  enabled: true,
  dryRun: true,
  tickMinutes: 10,
  quietHours: [['22:30', '07:30']],
  rules: { dailyCap: 3, minGapMin: 240 },
  send: { enabled: true },
  content: {
    mode: 'llm',
    maxChars: 60,
    llm: { attempts: 2 },
    topics: { sleep: true, sleepShortMin: 420, sleepDeepShortMin: 120, sleepLateBed: '00:30', stressHighMin: 59 },
  },
});

test('白名单：只开放表里的路径，别的（CLI/端口/通道）一律拒绝', () => {
  for (const badPath of ['mail.tls', 'mail.port', 'mail.fetchCount', 'content.llm.cli', 'content.llm.electron', 'persona.dshHome', 'channels.qq.peerId', 'evil', '']) {
    const r = coerce(badPath, 1);
    assert.equal(r.ok, false, `${badPath} 不该被允许`);
    assert.match(r.error, /不开放修改/);
  }
});

test('凭据类：能写、读不回来——applyChange 不回写 cfg，coerce 标 secret', () => {
  const cfg0 = cfg();
  const r = applyChange(cfg0, 'mail.authCode', 'abcd1234efgh5678');
  assert.equal(r.ok, true);
  assert.equal(r.secret, true);
  assert.equal(r.value, 'abcd1234efgh5678');
  assert.deepEqual(r.cfg, cfg0, '凭据绝不能进 config.json');
  assert.equal(coerce('mail.authCode', '   ').ok, false, '空值不算设置');
  // 邮箱账号本身不是凭据，可以进 config
  assert.equal(applyChange(cfg0, 'mail.user', 'a@qq.com').cfg.mail.user, 'a@qq.com');
});

test('换邮箱账号时，写死的 IMAP 服务器对不上就清掉（否则会拿 QQ 的地址连别家）', () => {
  const c = cfg();
  c.mail = { user: '', host: 'imap.qq.com' };
  const r = applyChange(c, 'mail.user', 'someone@163.com');
  assert.equal(r.ok, true);
  assert.equal(r.cfg.mail.host, '', '和 163 对不上就该清成自动');
  assert.deepEqual(r.hostReset, { from: 'imap.qq.com', to: 'imap.163.com' });
  // 同一个域就不动
  const same = applyChange(c, 'mail.user', 'x@qq.com');
  assert.equal(same.cfg.mail.host, 'imap.qq.com');
  assert.equal(same.hostReset, undefined);
});

test('bool：认真假值，也认 开/关', () => {
  assert.deepEqual(coerce('dryRun', false), { ok: true, path: 'dryRun', value: false });
  assert.equal(coerce('dryRun', '关').value, false);
  assert.equal(coerce('enabled', '开').value, true);
  assert.equal(coerce('dryRun', '随便').ok, false);
});

test('邮箱账号：写成 qq/com 这种当场拒，别等联网才 ENOTFOUND', () => {
  assert.equal(coerce('mail.user', '12345678@qq.com').value, '12345678@qq.com');
  assert.equal(coerce('mail.user', ' 12345678@qq.com ').value, '12345678@qq.com');
  assert.equal(coerce('mail.user', '12345678@qq/com').ok, false);
  assert.equal(coerce('mail.user', '12345678com').ok, false);
  assert.equal(coerce('mail.user', 'a@b@c.com').ok, false);
  // 允许清空（等于关掉邮箱读取）
  assert.deepEqual(coerce('mail.user', ''), { ok: true, path: 'mail.user', value: '' });
});

test('int：范围卡住，浮点和小数点都要拒', () => {
  assert.equal(coerce('tickMinutes', 15).value, 15);
  assert.equal(coerce('tickMinutes', '15').value, 15);
  assert.equal(coerce('tickMinutes', 0).ok, false);
  assert.equal(coerce('tickMinutes', 121).ok, false);
  assert.equal(coerce('tickMinutes', 7.5).ok, false);
  assert.equal(coerce('tickMinutes', '').ok, false);
  assert.equal(coerce('tickMinutes', 'abc').ok, false);
  // 上限 0 也要能填（每日 0 条 = 今天不发）
  assert.equal(coerce('rules.dailyCap', 0).value, 0);
});

test('select：只认选项里的键', () => {
  assert.equal(coerce('content.mode', 'template').value, 'template');
  assert.equal(coerce('content.mode', '乱写').ok, false);
});

test('hm：补零、认全角冒号，非法时间拒掉', () => {
  assert.equal(normalizeHm('0:30'), '00:30');
  assert.equal(normalizeHm('23：45'), '23:45');
  assert.equal(normalizeHm('24:00'), '24:00');
  assert.equal(normalizeHm('24:30'), null);
  assert.equal(normalizeHm('9'), null);
  assert.equal(coerce('content.topics.sleepLateBed', '1:05').value, '01:05');
  assert.equal(coerce('content.topics.sleepLateBed', '25:00').ok, false);
});

test('windows：空 = 全天不限；写错整条拒绝（不默默丢段）', () => {
  assert.deepEqual(coerce('quietHours', '').value, []);
  assert.deepEqual(coerce('quietHours', '全天').value, []);
  assert.deepEqual(coerce('quietHours', '22:30-07:30').value, [['22:30', '07:30']]);
  assert.deepEqual(coerce('quietHours', '12:00-13:00, 18:00-19:00').value, [
    ['12:00', '13:00'],
    ['18:00', '19:00'],
  ]);
  const bad = coerce('quietHours', '22:30-07:30, abc');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /abc/);
  assert.equal(coerce('quietHours', '09:00-09:00').ok, false);
});

test('display：给人看的那一行', () => {
  const spec = (p) => SCHEMA.find((s) => s.path === p);
  assert.equal(display(spec('dryRun'), true), '开');
  assert.equal(display(spec('tickMinutes'), 15), '15 分钟');
  assert.equal(display(spec('quietHours'), []), '全天不限');
  assert.equal(display(spec('quietHours'), [['22:30', '07:30']]), '22:30-07:30');
  assert.equal(display(spec('content.mode'), 'fixed'), '固定一句话（测试）');
});

test('applyChange：改一项不动别的，也不改传进来的对象', () => {
  const before = cfg();
  const r = applyChange(before, 'rules.dailyCap', 5);
  assert.equal(r.ok, true);
  assert.equal(r.cfg.rules.dailyCap, 5);
  assert.equal(before.rules.dailyCap, 3, '原对象不该被改');
  assert.equal(r.cfg.content.topics.sleepShortMin, 420, '别的项不该丢');
  assert.equal(r.cfg.tickMinutes, 10);
});

test('applyChange：非法值不产生半截配置', () => {
  const r = applyChange(cfg(), 'tickMinutes', -1);
  assert.equal(r.ok, false);
  assert.equal(r.cfg, undefined);
});

test('listForUi：八组都在，且带 value/display，凭据只给「已设置/未设置」', () => {
  const groups = listForUi(cfg());
  assert.deepEqual(
    groups.map((g) => g.name),
    ['日常', '决定TA粘不粘人', '节奏', '说什么', '数据从哪来', '课表与考试', '时间间隔', '高级']
  );
  const flat = groups.flatMap((g) => g.items);
  const paths = flat.map((i) => i.path);
  assert.ok(paths.includes('dryRun'));
  assert.ok(paths.includes('content.topics.sleepLateBed'));
  assert.ok(paths.includes('mail.user'), '邮箱账号得有入口');
  for (const p of ['sources.phone.enabled', 'sources.qq.enabled', 'sources.douyin.enabled']) assert.ok(paths.includes(p), '接入开关要有入口：' + p);
  assert.ok(!paths.some((p) => p.includes('llm.cli') || p === 'mail.tls'));
  // 授权码：出现在界面上，但值永远是空的（读不回来）
  const auth = flat.find((i) => i.path === 'mail.authCode');
  assert.ok(auth, '授权码要有入口');
  assert.equal(auth.type, 'secret');
  assert.equal(auth.value, '');
  assert.ok(['已设置', '未设置'].includes(auth.display));
  assert.equal(JSON.stringify(groups).includes('authCode":"'), false, '清单里不能夹带授权码原值');
  const dry = flat.find((i) => i.path === 'dryRun');
  assert.equal(dry.value, true);
  assert.equal(dry.display, '开');
  const quiet = flat.find((i) => i.path === 'quietHours');
  assert.deepEqual(quiet.value, [['22:30', '07:30']]);
  // 每一项都得有 label 和 type，否则界面会渲染成空白
  for (const i of flat) {
    assert.ok(i.label && i.type, `${i.path} 缺 label/type`);
  }
});

test('接入开关和通道开关一起动，不出现两个开关打架', () => {
  const a = applyChange(cfg(), 'sources.douyin.enabled', true);
  assert.equal(a.ok, true);
  assert.equal(a.cfg.sources.douyin.enabled, true);
  assert.equal(a.cfg.channels.douyin.enabled, true, '总闸开了通道也得开，否则开了没反应');

  const b = applyChange(a.cfg, 'sources.qq.enabled', false);
  assert.equal(b.ok, true);
  assert.equal(b.cfg.channels.qq.enabled, false, '总闸关了通道也得关');
});

test('课表勾选列表：读出来的课都列在上面，取消勾选的记成 off', () => {
  const c = cfg();
  c.content.agenda = { text: '周一 08:00-09:40 电机学 @教三201\n周三 第3-4节 电路 1-16周', termStart: '', periods: '', off: [] };
  const groups = listForUi(c);
  const item = groups.flatMap((g) => g.items).find((i) => i.path === 'content.agenda.off');
  assert.ok(item, '「课表与考试」组要有课程勾选列表');
  assert.equal(item.type, 'courses');
  assert.equal(item.items.length, 2);
  assert.deepEqual(item.items.map((i) => i.checked), [true, true]);
  assert.match(item.items[0].label, /周一 08:00-09:40 电机学 @教三201/);
  assert.match(item.items[1].label, /1-16周/);
  assert.equal(item.display, '2/2 节在提醒');

  // 取消一节：提交的是「不提醒的那些 key」，回读时勾就没了
  const key = item.items[0].key;
  const r = applyChange(c, 'content.agenda.off', [key]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cfg.content.agenda.off, [key]);
  const again = listForUi(r.cfg).flatMap((g) => g.items).find((i) => i.path === 'content.agenda.off');
  assert.deepEqual(again.items.map((i) => i.checked), [false, true]);
  assert.equal(again.display, '1/2 节在提醒');
  // 命令行也能写：逗号分隔或 JSON 都行；空串 = 全勾
  assert.deepEqual(coerce('content.agenda.off', 'a,b').value, ['a', 'b']);
  assert.deepEqual(coerce('content.agenda.off', '["a"]').value, ['a']);
  assert.deepEqual(coerce('content.agenda.off', '').value, []);
  assert.equal(coerce('content.agenda.off', 3).ok, false);
});

test('考试组：科目/地点/时间能填，两个提醒时间和开关都在', () => {
  const flat = listForUi(cfg()).flatMap((g) => g.items);
  for (const p of ['content.exams.text', 'content.topics.examReview', 'content.topics.examReviewDays', 'content.topics.examSoon', 'content.topics.examSoonMin']) {
    assert.ok(flat.some((i) => i.path === p), `设置页应该有 ${p}`);
  }
  assert.equal(coerce('content.topics.examReviewDays', 7).value, 7);
  assert.equal(coerce('content.topics.examReviewDays', 0).ok, false);
  assert.equal(coerce('content.topics.examSoonMin', 60).value, 60);
  assert.equal(coerce('content.topics.examSoonMin', 2000).ok, false);
});

test('课表和考试折成同一个模块：标题旁边写清几节课、几场考试', () => {
  const c = cfg();
  c.content.agenda = { text: '周一 08:00-09:40 电机学', termStart: '', periods: '', off: [] };
  c.content.exams = { text: '2026-12-20 09:00 电机学 @教三201' };
  const groups = listForUi(c);
  const g = groups.find((x) => x.name === '课表与考试');
  assert.ok(g, '应该只有「课表与考试」一个模块');
  assert.equal(g.foldable, true);
  assert.match(g.summary, /课表 1 节/);
  assert.match(g.summary, /考试 1 场/);
  assert.equal(groups.some((x) => x.name === '课表' || x.name === '考试'), false, '不该再分两组');
  // 什么都没填：折起来的标题也得说人话
  const empty = listForUi(cfg()).find((x) => x.name === '课表与考试');
  assert.equal(empty.summary, '课表还没填 · 考试还没填');
  // 勾掉一节，标题上跟着写「提醒 N 节」
  const offKey = g.items.find((i) => i.path === 'content.agenda.off').items[0].key;
  const r = applyChange(c, 'content.agenda.off', [offKey]);
  const g2 = listForUi(r.cfg).find((x) => x.name === '课表与考试');
  assert.match(g2.summary, /课表 1 节（提醒 0 节）/);
});

test('忙碌时段与追问：都在界面上，忙碌时段按多段解析', () => {
  assert.deepEqual(coerce('busyHours', '09:00-12:00, 14:00-18:00').value, [
    ['09:00', '12:00'],
    ['14:00', '18:00'],
  ]);
  assert.equal(coerce('busyHours', '').value.length, 0);
  const byPath = Object.fromEntries(SCHEMA.map((s) => [s.path, s]));
  assert.equal(byPath.busyHours.group, '日常');
  assert.equal(byPath.busyHours.type, 'windows');
  assert.equal(byPath['content.topics.noReply']?.group, '说什么');
  for (const p of [
    'content.topics.noReplyMin',
    'content.topics.noReplyAfterHerMin',
    'content.topics.noReplyAfterBusyMin',
    'content.topics.noReplyJudge',
  ]) {
    assert.equal(byPath[p]?.group, '高级', p);
  }
  assert.equal(byPath['content.topics.noReplyDouyin']?.group, '数据从哪来');

  const c = cfg();
  c.busyHours = [['09:00', '12:00']];
  const ui = listForUi(c);
  const run = ui.find((g) => g.name === '日常');
  const item = run.items.find((i) => i.path === 'busyHours');
  assert.ok(item, '日常组里要有忙碌时段');
  assert.equal(item.type, 'windows');
  assert.match(display(item, c.busyHours), /09:00-12:00/);
});

test('每个独立功能都有开关：轨道、回填、通道读发', () => {
  const c = cfg();
  const cDouyin = { ...c, channels: { ...c.channels, primary: 'douyin' } };
  const ui = listForUi(c);
  const all = [
    ...ui.flatMap((g) => g.rows || g.items || []),
    ...channelItemsForUi(c),
    ...channelItemsForUi(cDouyin),
  ];
  const paths = all.map((r) => r.path);
  for (const p of [
    'rules.proactive',
    'rules.autoReply',
    'rules.backfill',
    'rules.replyGuard',
    'rules.feedback.enabled',
    'rules.adaptiveGap',
    'channels.qq.read',
    'channels.qq.send',
    'channels.douyin.read',
    'channels.douyin.send',
    'channels.main.read',
    'content.topics.forward',
    'content.topics.share',
    'content.topics.catchup',
    'content.topics.sleep',
    'content.topics.stress',
    'content.topics.steps',
    'content.topics.screen',
    'content.topics.lateUp',
    'content.topics.longSit',
    'content.topics.backHome',
    'content.topics.agenda',
    'content.topics.examSoon',
    'content.topics.examReview',
    'content.topics.noReply',
    'content.topics.noReplyDouyin',
    'content.topics.noReplyJudge',
    'content.prompt.recentOutbound',
    'content.prompt.slotStats',
    'sources.phone.staleGuard',
  ]) {
    assert.ok(paths.includes(p), `缺开关 ${p}`);
  }
});
