// engine-smoke.test.mjs —— 真跑一拍。
//
// 为什么要有这个文件：2026-11-05 真的跑 `node src/run.js` 时连炸两次
// 「classifyActivity is not defined」「pollFishMail is not defined」——
// 改 engine.js 时漏了 import，而 187 个单元测试一个都没碰到这条路径
// （它们都在测零件，没人把 engine.tick 当整体跑一次）。
// 这个用例用固定内容模式 + 临时目录跑一整拍：不联网、不叫模型、不碰真配置，
// 但会经过 probe → decide → 发送分支（dryRun）→ 写日志/状态。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-engine-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_STATE_PATH = path.join(dir, 'state.json');
process.env.PG_LOG_DIR = path.join(dir, 'logs');
process.env.PG_SECRETS_PATH = path.join(dir, 'credentials.json');
// 别读真实的 QQ 历史 / qq-bridge/last-out.json：上次真发出去一条会让这里
// 撞上「距上次主动太近」而假失败（2026-11-10 09:27 就是这样）。
process.env.PG_DSH_HOME = path.join(dir, 'home');

fs.writeFileSync(
  process.env.PG_CONFIG_PATH,
  JSON.stringify({
    enabled: true,
    dryRun: true,
    tickMinutes: 10,
    timezone: 'Asia/Shanghai',
    quietHours: [],
    idle: { onlineSec: 30, awaySec: 600 },
    rules: { replyCooldownMin: 5, minGapMin: 240, dailyCap: 3, backfillWindowMin: 30, douyinStaleMin: 10 },
    channels: {
      qq: { enabled: true, read: true, send: true, peerId: '10001', activeHours: [] },
      main: { enabled: false, read: true, send: false, activeHours: [] },
      douyin: { enabled: false, read: true, send: false, activeHours: [] },
    },
    content: { mode: 'fixed', fixedText: '测试句子' },
    perception: { l2: { enabled: false }, l3: { enabled: false } },
    mail: { enabled: false },
  }),
);

const { tick } = await import('../src/engine.js');

after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('engine：一整拍能跑完，判到 send 就用固定内容走 dryRun 发送', async () => {
  const r = await tick({ persist: true });
  assert.equal(r.record.decision, 'send', `实际判定是 ${r.record.decision}/${r.record.reason}`);
  assert.equal(r.record.content.text, '测试句子');
  assert.deepEqual(r.delivery, { attempted: false, reason: 'DRY_RUN', preview: '测试句子' });
  assert.ok(fs.existsSync(process.env.PG_STATE_PATH), '状态应该落盘');
});

test('engine：dryRun 推进 sim 计数、不动 real', async () => {
  const st = JSON.parse(fs.readFileSync(process.env.PG_STATE_PATH, 'utf8'));
  assert.equal(st.sim.todaySent, 1);
  assert.equal(Number(st.real.todaySent) || 0, 0);
});