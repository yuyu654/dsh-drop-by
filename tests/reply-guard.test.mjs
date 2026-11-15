// reply-guard.test.mjs —— 真跑一拍：插件已经回过她了，presence-gate 不许再回一遍。
//
// 这个用例的价值在于「整拍」：决定「要不要回」用的是这一拍开头读到的快照
// （qq-history 里那条 user、没有 reply），而 outbound.js 看到的是更新的证据
// （qq-reply.out.txt 的 mtime 晚于她那句话）——两条线在 engine 里必须对上。
// 用 PG_DSH_HOME 造假家目录，不碰真实记录、不联网、不叫模型。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-guard-home-'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-guard-cfg-'));
process.env.PG_DSH_HOME = home;
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'credentials.json');

const cfgPath = process.env.PG_CONFIG_PATH;
const baseCfg = {
  enabled: true,
  dryRun: true,
  tickMinutes: 10,
  timezone: 'Asia/Shanghai',
  quietHours: [],
  idle: { onlineSec: 30, awaySec: 600 },
  rules: { replyCooldownMin: 1, minGapMin: 240, dailyCap: 3, backfillWindowMin: 30, replyGuard: true },
  channels: {
    qq: { enabled: true, read: true, send: true, peerId: '10001', activeHours: [] },
    main: { enabled: false, read: true, send: false, activeHours: [] },
    douyin: { enabled: false, read: true, send: false, activeHours: [] },
  },
  sources: { phone: { enabled: false }, qq: { enabled: true }, douyin: { enabled: false } },
  send: { enabled: false },
  content: { enabled: true, mode: 'auto', maxChars: 60 },
  perception: { l2: { enabled: false }, l3: { enabled: false } },
  mail: { enabled: false },
};

// 她 20 分钟前在 QQ 说了一句，qq-history 里没有我们的 reply（driver 还没写/写失败）
const herTs = Date.now() - 20 * 60_000;
fs.mkdirSync(path.join(home, 'autonomy'), { recursive: true });
fs.mkdirSync(path.join(home, 'douyin-duty', 'memory'), { recursive: true });
fs.writeFileSync(
  path.join(home, 'autonomy', 'qq-history.json'),
  JSON.stringify({ turns: [{ user: '在吗', reply: '', at: herTs }] }),
);
// 但 QQ 值班其实 19 分钟前已经回过了：只剩 qq-reply.out.txt 的 mtime 能证明
const out = path.join(home, 'douyin-duty', 'qq-reply.out.txt');
fs.writeFileSync(out, '在，怎么了');
const outAt = new Date(herTs + 60_000);
fs.utimesSync(out, outAt, outAt);

fs.writeFileSync(cfgPath, JSON.stringify(baseCfg));

const { tick: engineTick } = await import('../src/engine.js');
const tick = (options) => engineTick({ ...options, probeSystem: async () => ({ idle_ms: 0 }) });

after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('engine：QQ 值班已经回过 → 这一拍 skip REPLY_ALREADY_ANSWERED，不叫模型', async () => {
  fs.writeFileSync(process.env.PG_STATE_PATH, JSON.stringify({}));
  let called = 0;
  const r = await tick({
    persist: true,
    llmReady: true,
    generate: async () => {
      called += 1;
      return '不该出现的一句话';
    },
  });
  assert.equal(r.record.decision, 'skip');
  assert.equal(r.record.reason, 'REPLY_ALREADY_ANSWERED');
  assert.equal(called, 0, '拦下来就不该花一次模型调用');
  assert.equal(r.delivery, null);
  assert.equal(r.record.today_sent_real, 0, '被拦下的不算今天发过');
});

test('engine：关掉 replyGuard 就按原逻辑回（仍然照常走内容生成）', async () => {
  fs.writeFileSync(process.env.PG_STATE_PATH, JSON.stringify({}));
  fs.writeFileSync(cfgPath, JSON.stringify({ ...baseCfg, rules: { ...baseCfg.rules, replyGuard: false } }));
  let called = 0;
  const r = await tick({
    persist: true,
    llmReady: true,
    generate: async () => {
      called += 1;
      return '在。';
    },
  });
  assert.notEqual(r.record.reason, 'REPLY_ALREADY_ANSWERED');
  assert.ok(called >= 1, `关掉防重复后应当照常生成，实际调用 ${called} 次`);
});