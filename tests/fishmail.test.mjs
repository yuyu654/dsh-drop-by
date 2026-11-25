// tests/fishmail.test.mjs —— 间隔闸、开关闸、主题过滤、摘要落库（用桩客户端，不联网）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pollFishMail, hostFor, maskUser, maskAuth, summaryOf, encryptSecret, decryptSecret, saveSecrets, loadSecrets } from '../src/fishmail.js';
import { buildFishMail, buildOtherMail, SUMMARY } from './fixtures.mjs';

// mailUpdateMode 在 logging 里，不在 mail 里（别顺手塞进 over，会被当成 mail 的键）
const cfgWithMode = (mode) => ({ ...cfgOf(), logging: { mailUpdateMode: mode, keepDays: 2, dayStartHour: 7 } });

const cfgOf = (over = {}) => ({
  timezone: 'Asia/Shanghai',
  mail: {
    enabled: true,
    user: '123456@qq.com',
    authCode: 'fake-auth-code',
    intervalMinutes: 30,
    fetchCount: 5,
    subjectPattern: '^\\s*FISH',
    ...over,
  },
});

function stub(messages, { fail = null } = {}) {
  return {
    client: {
      async login() {
        if (fail) throw fail;
      },
      async select() {
        return { exists: messages.length };
      },
      async fetchRecent() {
        return messages;
      },
      async logout() {},
      destroy() {},
    },
  };
}

// 归档写到临时目录：测试绝不碰真实的 data/fish
let seq = 0;
const tmpArchive = () => path.join(os.tmpdir(), `pg-fish-${process.pid}-${Date.now()}-${++seq}`);

const run = (cfg, state, messages, opts = {}) =>
  pollFishMail({
    cfg,
    state,
    now: opts.now ?? Date.now(),
    force: opts.force,
    secrets: { user: '', authCode: '' },
    clientFactory: async () => stub(messages).client,
    writeLatest: Boolean(opts.writeLatest),
    latestPath: opts.latestPath ?? path.join(tmpArchive(), 'latest.json'),
    archiveDir: opts.archiveDir ?? tmpArchive(),
    log: false,
  });

test('开关关着就不联网：state=off', async () => {
  const state = {};
  let touched = false;
  const r = await pollFishMail({
    cfg: cfgOf({ enabled: false }),
    state,
    clientFactory: async () => {
      touched = true;
      return stub([]).client;
    },
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'off');
  assert.equal(r.reason, 'MAIL_DISABLED');
  assert.equal(touched, false);
  assert.equal(state.mail, undefined);
});

test('没填邮箱/授权码：unconfigured，且不联网', async () => {
  const cfg = cfgOf({ user: '', authCode: '' });
  const r = await pollFishMail({
    cfg,
    state: {},
    secrets: { user: '', authCode: '' },
    clientFactory: async () => assert.fail('不该连'),
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'unconfigured');
  assert.equal(r.reason, 'MAIL_NO_USER');
  assert.match(r.note, /--mail-set/);
});

test('未到间隔就返回 wait，不重连', async () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0);
  const state = { mail: { lastPollAt: now - 5 * 60_000, lastUid: 88 } };
  const r = await pollFishMail({
    cfg: cfgOf({ intervalMinutes: 30 }),
    state,
    now,
    clientFactory: async () => assert.fail('不该连'),
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'wait');
  assert.equal(r.reason, 'MAIL_INTERVAL');
  assert.ok(r.waitSec > 20 * 60);
});

test('取到 FISH 邮件：摘要剥掉排查段，uid 记账', async () => {
  const messages = [
    { uid: 10, raw: buildOtherMail() },
    { uid: 11, raw: buildFishMail({ subject: 'FISH 11-03 22:04' }) },
  ];
  const state = {};
  const r = await run(cfgOf(), state, messages);
  assert.equal(r.state, 'ok');
  assert.equal(r.reason, 'MAIL_NEW');
  assert.equal(r.fetched, 2);
  assert.equal(r.matched, 1, '非 FISH 主题应被过滤');
  assert.equal(r.newCount, 1);
  assert.equal(r.latest.uid, 11);
  assert.equal(r.latest.chars, SUMMARY.length);
  assert.ok(r.latest.preview.startsWith('睡眠：深睡'));
  assert.equal(state.mail.lastUid, 11);
  assert.ok(state.mail.lastOkAt > 0);
  assert.equal(state.mail.polls, 1);
});

test('同一封再读一次：MAIL_SAME，新邮件才 MAIL_NEW', async () => {
  const first = [{ uid: 11, raw: buildFishMail() }];
  const state = {};
  await run(cfgOf(), state, first);
  const again = await run(cfgOf(), state, first, { force: true });
  assert.equal(again.reason, 'MAIL_SAME');
  assert.equal(again.newCount, 0);

  const newer = [...first, { uid: 12, raw: buildFishMail({ subject: 'FISH 11-04 08:00' }) }];
  const r3 = await run(cfgOf(), state, newer, { force: true });
  assert.equal(r3.reason, 'MAIL_NEW');
  assert.equal(r3.newCount, 1);
  assert.equal(r3.latest.uid, 12);
  assert.equal(state.mail.lastUid, 12);
});

test('一封 FISH 都没有：MAIL_NO_MATCH，不写 latest', async () => {
  const r = await run(cfgOf(), {}, [{ uid: 5, raw: buildOtherMail() }]);
  assert.equal(r.state, 'ok');
  assert.equal(r.reason, 'MAIL_NO_MATCH');
  assert.equal(r.latest, null);
});

test('服务器出错只记原因，不抛', async () => {
  const state = {};
  const err = Object.assign(new Error('IMAP NO: LOGIN failed'), { name: 'ImapError' });
  const r = await pollFishMail({
    cfg: cfgOf(),
    state,
    clientFactory: async () => stub([], { fail: err }).client,
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'error');
  assert.equal(r.reason, 'MAIL_IMAP_ERROR');
  assert.match(r.note, /LOGIN failed/);
  assert.equal(state.mail.lastError.includes('LOGIN failed'), true);
  // 失败也算一次检查，下一轮按间隔再来，不会每拍都敲门
  assert.ok(state.mail.lastPollAt > 0);
});

test('force 可越过开关（--mail-now 用）', async () => {
  const r = await run(cfgOf({ enabled: false }), {}, [{ uid: 1, raw: buildFishMail() }], { force: true });
  assert.equal(r.state, 'ok');
  assert.equal(r.forced, true);
});

test('地址与打码的边角', () => {
  assert.equal(hostFor('a@qq.com'), 'imap.qq.com');
  assert.equal(hostFor('a@163.com'), 'imap.163.com');
  assert.equal(hostFor('a@unknown.cn'), 'imap.unknown.cn');
  assert.equal(hostFor('a@qq.com', 'imap.custom.com'), 'imap.custom.com');
  assert.equal(maskUser('123456@qq.com'), '12***6@qq.com');
  assert.equal(maskAuth('abcdefghijklmnop'), 'ab********op');
  assert.equal(summaryOf('a\n\n\n\nb'), 'a\n\nb');
});

// ---------------------------------------------------------------- 时段闸

/** 上海时间 h:m 的时间戳（UTC+8）。 */
const at = (h, m = 0) => Date.UTC(2026, 10, 4, h - 8, m);

test('全局静默里不联网：state=quiet', async () => {
  const cfg = cfgOf();
  cfg.quietHours = [['10:00', '12:00']];
  let touched = false;
  const r = await pollFishMail({
    cfg,
    state: {},
    now: at(11),
    clientFactory: async () => {
      touched = true;
      return stub([]).client;
    },
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'quiet');
  assert.equal(r.reason, 'GLOBAL_QUIET');
  assert.equal(touched, false, '静默里一次都不该连');
});

test('不在自己的执行时段：state=window，且给出还有多久开', async () => {
  const cfg = cfgOf({ activeHours: ['19:00-21:00'] });
  let touched = false;
  const r = await pollFishMail({
    cfg,
    state: {},
    now: at(17, 30),
    clientFactory: async () => {
      touched = true;
      return stub([]).client;
    },
    writeLatest: false,
    log: false,
  });
  assert.equal(r.state, 'window');
  assert.equal(r.reason, 'MAIL_OUTSIDE_WINDOW');
  assert.equal(r.openInMin, 90);
  assert.equal(touched, false);
});

test('执行时段内照常读；force 能越过时段与静默', async () => {
  const cfg = cfgOf({ activeHours: ['19:00-21:00'] });
  cfg.quietHours = [['10:00', '12:00']];
  const inside = await run(cfg, {}, [{ uid: 7, raw: buildFishMail({ subject: 'FISH 11-04 19:10' }) }], {
    now: at(19, 10),
  });
  assert.notEqual(inside.state, 'window');

  const forced = await run(cfg, {}, [{ uid: 7, raw: buildFishMail({ subject: 'FISH 11-04 11:10' }) }], {
    now: at(11),
    force: true,
  });
  assert.notEqual(forced.state, 'quiet', '--mail-now 是硬闯，不该被静默挡住');
});

// ---------------------------------------------------------------- 归档

test('新邮件归档到 <健康日>.json，带解析结果', async () => {
  const dir = tmpArchive();
  const now = at(9);
  const r = await run(cfgOf(), {}, [{ uid: 21, raw: buildFishMail({ subject: 'FISH 11-04 07:00' }) }], { now, archiveDir: dir });
  assert.equal(r.archived.length, 1);
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-03.json'), 'utf8'));
  assert.equal(doc.day, '2026-11-03', '归档按邮件自己的日期，不按抓取日');
  assert.equal(doc.mails.length, 1);
  assert.equal(doc.mails[0].uid, 21);
  assert.equal(doc.mails[0].subject, 'FISH 11-04 07:00');
  // 解析结果一起存，不是只存原文
  assert.equal(doc.mails[0].parsed.deepMin, 65);
  assert.ok(doc.mails[0].summary.length > 0);
});

test('同一封再读一次不会堆重复记录', async () => {
  const dir = tmpArchive();
  const now = at(9);
  const msgs = [{ uid: 31, raw: buildFishMail({ subject: 'FISH 11-04 07:00' }) }];
  await run(cfgOf(), {}, msgs, { now, archiveDir: dir });
  await run(cfgOf(), {}, msgs, { now: now + 60_000, archiveDir: dir, force: true });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-03.json'), 'utf8'));
  assert.equal(doc.mails.length, 1, '同 uid 覆盖，不追加');
});

test('07:00 之前收到的邮件算前一天', async () => {
  const dir = tmpArchive();
  await run(cfgOf(), {}, [{ uid: 41, raw: buildFishMail({ subject: 'FISH 11-04 06:20' }) }], {
    now: at(6, 30),
    archiveDir: dir,
  });
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-03.json']);
});


// ---------------------------------------------------------------- 同日多封：latest 跟着合并
// 早上那封有睡眠、中午那封只有压力/屏幕。补充模式下午 13 点读一次，
// fish-latest.json（也就是判定读的那份）应该两样都有，不能只剩中午的。

const MORNING_BODY = [
  '起床 07:42 · 睡眠 7.1h · 步数 5120 · 压力 68',
  '睡眠详情',
  '夜间睡眠：7 小时 6 分钟',
  '深睡：2 小时 4 分钟 · 浅睡 3 小时 40 分钟 · 快速眼动 1 小时 22 分钟',
].join('\n');
const NOON_BODY = ['屏幕时间：4 小时 12 分钟', '压力 75'].join('\n');

test('merge：同日两封 → latest 里睡眠和屏幕都在，压力取最新', async () => {
  const dir = tmpArchive();
  const latestPath = path.join(dir, 'latest.json');
  const msgs = [
    { uid: 51, raw: buildFishMail({ subject: 'FISH 11-04 07:42', body: MORNING_BODY }) },
    { uid: 52, raw: buildFishMail({ subject: 'FISH 11-04 12:10', body: NOON_BODY }) },
  ];
  const r = await run(cfgOf(), {}, msgs, { now: at(13), archiveDir: dir, writeLatest: true, latestPath });
  assert.equal(r.state, 'ok');
  assert.equal(r.latest?.dayMails, 2);

  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.match(latest.summary, /夜间睡眠：7 小时 6 分钟/, '早上的睡眠还在');
  assert.match(latest.summary, /屏幕时间：4 小时 12 分钟/, '中午的屏幕也在');
  assert.equal(latest.parsed.sleepMin, 426);
  assert.equal(latest.parsed.stress, 75, '压力用最新那封的');
  assert.equal(latest.dayMails, 2);

  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-03.json'), 'utf8'));
  assert.equal(doc.mails.length, 1, '归档一天一条');
});

test('replace：同日两封 → latest 只剩最新那封', async () => {
  const dir = tmpArchive();
  const latestPath = path.join(dir, 'latest.json');
  const msgs = [
    { uid: 61, raw: buildFishMail({ subject: 'FISH 11-04 07:42', body: MORNING_BODY }) },
    { uid: 62, raw: buildFishMail({ subject: 'FISH 11-04 12:10', body: NOON_BODY }) },
  ];
  const r = await run(cfgWithMode('replace'), {}, msgs, { now: at(13), archiveDir: dir, writeLatest: true, latestPath });
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.doesNotMatch(latest.summary, /夜间睡眠/, '早上的内容被顶掉了');
  assert.match(latest.summary, /屏幕时间/);
  assert.equal(latest.parsed.sleepMin, null);
  assert.equal(r.latest?.mode, 'replace');
});

test('append：同日两封 → 归档两条，latest 只有最新那封', async () => {
  const dir = tmpArchive();
  const latestPath = path.join(dir, 'latest.json');
  const msgs = [
    { uid: 71, raw: buildFishMail({ subject: 'FISH 11-04 07:42', body: MORNING_BODY }) },
    { uid: 72, raw: buildFishMail({ subject: 'FISH 11-04 12:10', body: NOON_BODY }) },
  ];
  await run(cfgWithMode('append'), {}, msgs, { now: at(13), archiveDir: dir, writeLatest: true, latestPath });
  const doc = JSON.parse(fs.readFileSync(path.join(dir, '2026-11-03.json'), 'utf8'));
  assert.equal(doc.mails.length, 2, '追加模式各自留档');
  const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  assert.doesNotMatch(latest.summary, /夜间睡眠/, '追加模式 latest 就是最新那封');
});

test('跨天补抓：按邮件日期归档，不按抓取时间', async () => {
  const dir = tmpArchive();
  // 邮件写的是 11-04 07:42 那封，直到 11-05 09:00 才被抓回来（比如前一天服务器没连上）
  const msgs = [
    {
      uid: 81,
      raw: buildFishMail({ subject: 'FISH 11-04 07:42', date: 'Wed, 04 Nov 2026 07:42:00 +0800' }),
    },
  ];
  await run(cfgOf(), {}, msgs, { now: Date.UTC(2026, 10, 5, 1), archiveDir: dir });
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-04.json'], '落在邮件自己的那一天');
});

test('credentials：AES-256-GCM 加密落盘、自动解密、兼容旧明文且篡改密文安全返回空', () => {
  const dir = tmpArchive();
  const credFile = path.join(dir, 'credentials.json');
  saveSecrets({ user: 'demo@qq.com', authCode: 'my-secret-auth-code' }, credFile);
  const raw = fs.readFileSync(credFile, 'utf8');
  assert.equal(raw.includes('my-secret-auth-code'), false, '磁盘文件不应包含明文授权码');
  const parsed = JSON.parse(raw);
  assert.match(parsed.authCode, /^enc:v1:/);
  assert.equal(parsed.encrypted, true);

  const loaded = loadSecrets(credFile);
  assert.equal(loaded.user, 'demo@qq.com');
  assert.equal(loaded.authCode, 'my-secret-auth-code');

  // 兼容旧版明文文件
  fs.writeFileSync(credFile, JSON.stringify({ user: 'old@qq.com', authCode: 'legacy-plain' }), 'utf8');
  assert.equal(loadSecrets(credFile).authCode, 'legacy-plain');

  // 篡改密文安全返回空，不抛异常
  const enc = encryptSecret('top-secret');
  assert.equal(decryptSecret(enc), 'top-secret');
  assert.equal(decryptSecret(enc.slice(0, -4) + 'AAAA'), '');
});
