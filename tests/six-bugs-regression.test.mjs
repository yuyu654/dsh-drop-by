import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { probe } from '../src/probe.js';
import { readChannels } from '../src/channels/index.js';
import { detectPhone } from '../src/detect.js';
import { connectivity } from '../src/diagnostics.js';
import { windowOverlapsBusyOrClass, scoreReceptivity, updateReceptivity } from '../src/receptivity.js';
import { courseKey, parseAgenda } from '../src/agenda.js';

test('Bug 1：反作弊进程命中时 winprobe 不读取前台窗口标题与音频峰值', async () => {
  const res = await probe(
    true,
    { perception: { anticheat: { skip: true, procs: ['powershell'] }, probeTimeoutMs: 8000 } },
    { readOnly: true }
  );
  assert.equal(res.ok, true);
  assert.equal(res.anticheat, true);
  assert.equal(res.fg_title, '');
  assert.equal(res.fg_pid, 0);
  assert.equal(res.audio_peak, -1);
});

test('Bug 2：唯一启用通道读取失败时 allDown 应为 true（不被已关闭通道掩盖），静默期仍为 false', () => {
  const cfg = {
    timezone: 'Asia/Shanghai',
    quietHours: [],
    sources: { qq: { enabled: true }, douyin: { enabled: false } },
    channels: {
      primary: 'qq',
      qq: { enabled: true, read: true, activeHours: [] },
      main: { enabled: false, read: false, activeHours: [] },
      douyin: { enabled: false, read: false, activeHours: [] },
    },
  };
  const now = Date.parse('2026-11-24T15:00:00+08:00');
  const down = readChannels(cfg, now, {
    detect: { qq: { installed: false, paired: false, note: 'missing' } },
  });
  assert.equal(down.available.length, 0);
  assert.equal(down.allDown, true);

  const quietRes = readChannels(cfg, now, {
    quiet: true,
    detect: { qq: { installed: false, paired: false, note: 'missing' } },
  });
  assert.equal(quietRes.allDown, false);
});

test('Bug 3：detectPhone 按邮件日期算年龄且与取回时间区分；connectivity 在 IMAP 报错时降级告警', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bug3-'));
  try {
    const secrets = path.join(dir, 'credentials.json');
    fs.writeFileSync(secrets, JSON.stringify({ authCode: 'secret123' }));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, 'data', 'fish-latest.json'),
      JSON.stringify({
        dateTs: now - 146 * 3600_000,
        fetchedAt: now - 54 * 60_000,
      })
    );
    const cfg = {
      mail: { enabled: true, user: 'a@qq.com' },
      sources: { phone: { enabled: true }, memory: { enabled: false } },
      channels: { primary: 'qq', qq: { enabled: true, read: true } },
    };
    const phone = detectPhone(cfg, { dshHome: dir, secretsPath: secrets, root: dir });
    assert.ok(phone.ageMin >= 145 * 60, `ageMin 应反映邮件日期而非取回时间，实际 ${phone.ageMin}`);
    assert.ok(phone.fetchAgeMin >= 53 && phone.fetchAgeMin <= 55, `fetchAgeMin 应约 54，实际 ${phone.fetchAgeMin}`);
    assert.match(phone.note, /146 小时前/);
    assert.match(phone.note, /54 分钟前检查过邮箱/);

    const diag = await connectivity({
      cfg,
      host: { ready: true, provider: 'test', model: 'm' },
      st: { mail: { lastError: 'IMAP AUTH FAILED', failedAt: now - 10_000, lastOkAt: now - 3600_000 } },
      now,
      secretsPath: secrets,
    });
    const mailItem = diag.items.find((x) => x.key === 'mail');
    assert.equal(mailItem.level, 'warn');
    assert.match(mailItem.detail, /IMAP AUTH FAILED/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Bug 4：小算盘 gate 模式下 examSoon 豁免，但 examReview 低分时必须拦截', () => {
  const st = {};
  const t = Date.parse('2026-11-24T15:00:00+08:00');
  const pending = { slot: 'examReview', ts: t, ctx: { bucket: 'event', period: 'afternoon', activity: 'active' } };
  for (let i = 0; i < 12; i += 1) {
    updateReceptivity(st, pending, 'miss', { censored: false, now: t + i * 1000 });
  }
  const cfg = { rules: { receptivity: { mode: 'gate', threshold: 0.35, minSamples: 10 } } };
  assert.equal(scoreReceptivity({ st, slot: 'examSoon', now: t, cfg }).wouldBlock, false);
  assert.equal(scoreReceptivity({ st, slot: 'examReview', now: t, cfg }).wouldBlock, true);
});

test('Bug 5：小算盘课表判断支持自定义节次、单双周与 courseKey 停课过滤', () => {
  const cfg = {
    content: {
      agenda: {
        termStart: '2026-11-23', // 周一，第 1 周（单周）
        periods: '1-2 08:30-10:05',
        text: '周二 第1-2节 高等数学 单周',
        off: [],
      },
    },
  };
  // 第 1 周周二 08:05-08:20：自定义 08:30 开始，不应判上课
  const w1Before = Date.parse('2026-11-24T08:05:00+08:00');
  assert.equal(windowOverlapsBusyOrClass(w1Before, w1Before + 15 * 60_000, cfg, 'Asia/Shanghai'), false);

  // 第 1 周周二 09:50-10:00：自定义 10:05 结束，应判上课
  const w1During = Date.parse('2026-11-24T09:50:00+08:00');
  assert.equal(windowOverlapsBusyOrClass(w1During, w1During + 10 * 60_000, cfg, 'Asia/Shanghai'), true);

  // 第 2 周周二 09:00-09:30：单周课在双周不上，不应判上课
  const w2During = Date.parse('2026-12-01T09:00:00+08:00');
  assert.equal(windowOverlapsBusyOrClass(w2During, w2During + 30 * 60_000, cfg, 'Asia/Shanghai'), false);

  // 停课过滤按 courseKey 生效
  const parsed = parseAgenda(cfg.content.agenda.text, { periods: cfg.content.agenda.periods });
  const cfgOff = {
    content: {
      agenda: { ...cfg.content.agenda, off: [courseKey(parsed[0])] },
    },
  };
  assert.equal(windowOverlapsBusyOrClass(w1During, w1During + 10 * 60_000, cfgOff, 'Asia/Shanghai'), false);
});

test('Bug 6：engine.js 普通主动发送成功时将 channel 写回 d.channel 以落入决策日志', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'engine.js'), 'utf8');
  assert.match(src, /if \(delivered\)\s*\{\s*d\.channel = channel;/);
  assert.match(src, /const antiHitForLog = Boolean\(anticheatRunning\(sys, cfg\)\);/);
});
