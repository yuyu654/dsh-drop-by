// bridge-visible.test.mjs —— 2026-11-09 她指出的洞：
// driver 的 qqReply 关着，qq-history 永远是空的，qq-bridge 又不写它，
// 于是 presence-gate 完全看不见桥发出去的话：桥刚回完，插件十秒后又补一句。
// 现在桥写 ~/.dsh/qq-bridge/last-out.json，插件读它；多段发送中途也算「正在应」。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeLastOut, bridgeLastIn, bridgeInFlight, qqLastOutbound, answeredAlready, recentTurns, recentOutbound } from '../src/outbound.js';
import { readQq } from '../src/channels/qq.js';
import { pickTopic } from '../src/topics.js';

function home(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-bridge-'));
  process.env.PG_DSH_HOME = dir;
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return dir;
}

const marker = (patch) => ({ peer: '10001', firstAt: 1_700_000_000_000, lastAt: 0, count: 2, text: '行，那我去看看。 别熬太晚。', ...patch });

test('没写过 marker → 当作没出站，不编时间', () => {
  home();
  assert.deepEqual(bridgeLastOut().ts, 0);
  assert.equal(bridgeInFlight({ now: 1_700_000_000_000 }), null);
});

test('桥正在发（lastAt=0）→ 算在飞；出站时间取 firstAt', () => {
  home({ 'qq-bridge/last-out.json': marker() });
  const b = bridgeLastOut();
  assert.equal(b.ts, 1_700_000_000_000);
  assert.equal(b.src, 'qq-bridge');
  assert.ok(bridgeInFlight({ now: 1_700_000_002_000 }));
  // 桥回在她那句之后 → 她那条算应过了
  assert.equal(answeredAlready({ herTs: 1_700_000_000_000 - 5000, out: b }), true);
});

test('桥发完了（lastAt 有）→ 不算在飞，出站取 lastAt', () => {
  home({ 'qq-bridge/last-out.json': marker({ lastAt: 1_700_000_012_000 }) });
  const b = bridgeLastOut();
  assert.equal(b.ts, 1_700_000_012_000);
  assert.equal(bridgeInFlight({ now: 1_700_000_013_000 }), null);
});

test('marker 挂了三分钟以上（桥崩了）→ 不再当成在飞', () => {
  home({ 'qq-bridge/last-out.json': marker() });
  assert.equal(bridgeInFlight({ now: 1_700_000_000_000 + 181_000 }), null);
});

test('qq-history 空着，桥刚回过 → QQ 通道的 lastSendTs 就是桥那一下', () => {
  const dir = home({
    'autonomy/qq-history.json': { turns: [] },
    'qq-bridge/last-out.json': marker({ firstAt: 1_700_000_000_000, lastAt: 1_700_000_009_000 }),
  });
  assert.ok(fs.existsSync(path.join(dir, 'qq-bridge', 'last-out.json')));
  const ch = readQq({ peerId: '10001' }, 1_700_000_010_000, 'Asia/Shanghai');
  assert.equal(ch.lastSendTs, 1_700_000_009_000);
  assert.equal(ch.lastUserTs, null);
});

test('qq-history 里有更晚的回复 → 取那条，不被旧 marker 顶掉', () => {
  home({
    'autonomy/qq-history.json': { turns: [{ user: '在吗', reply: '在。', at: 1_700_000_000_000 }] },
    'qq-bridge/last-out.json': marker({ firstAt: 1_699_999_000_000, lastAt: 1_699_999_001_000 }),
  });
  const ch = readQq({ peerId: '10001' }, 1_700_000_010_000, 'Asia/Shanghai');
  assert.equal(ch.lastSendTs, 1_700_000_000_000);
});

test('qqLastOutbound 三个来源取最晚的那个', () => {
  home({
    'autonomy/qq-history.json': { turns: [{ user: '嗯', reply: '嗯。', at: 1_700_000_000_000 }] },
    'qq-bridge/last-out.json': marker({ firstAt: 1_700_000_020_000, lastAt: 1_700_000_021_000 }),
  });
  const out = qqLastOutbound();
  assert.equal(out.ts, 1_700_000_021_000);
  assert.equal(out.src, 'qq-bridge');
});
// —— 2026-11-10：她在 QQ 回过了，插件看不见（qq-history 空），追着问了一句「那条」 ——

test('last-in.json：桥记下她最后说的话，插件据此算「她多久没动静」', () => {
  home({
    'qq-bridge/last-in.json': { peer: '10001', peerKind: 'private', at: 1_700_000_500_000, text: '在，有事？' },
    'qq-bridge/last-out.json': marker({ firstAt: 1_700_000_000_000, lastAt: 1_700_000_001_000 }),
  });
  const bi = bridgeLastIn();
  assert.equal(bi.ts, 1_700_000_500_000);
  assert.equal(bi.text, '在，有事？');
  // 她说话比我出站晚 → 我那条已经被应了，不能再追问
  const ch = readQq({ peerId: '10001' }, 1_700_000_600_000, 'Asia/Shanghai');
  assert.equal(ch.lastUserTs, 1_700_000_500_000);
  // 她在我出站之后才说话：桥那一下不算「应了她的」——该由后续一拍正常回
  assert.equal(answeredAlready({ herTs: 1_700_000_500_000, out: bridgeLastOut({}) }), false);
});

test('没有 last-in.json → lastUserTs 仍按 qq-history（空就是 null），不编时间', () => {
  home();
  const ch = readQq({ peerId: '10001' }, 1_700_000_600_000, 'Asia/Shanghai');
  assert.equal(ch.lastUserTs, null);
});

test('qq-history 为空但桥刚有过 QQ 对话：buildContext 看到她刚说话，不会误判 catchup 一天没出声', async () => {
  const now = 1_794_752_526_655;
  const twoDaysAgo = new Date(now - 2 * 86_400_000).toISOString();
  const dir = home({
    'autonomy/qq-history.json': { turns: [] },
    'qq-bridge/last-in.json': { peer: '10001', peerKind: 'private', at: now - 40 * 60_000, text: '我回你了哦' },
    'qq-bridge/last-out.json': marker({ firstAt: now - 39 * 60_000, lastAt: now - 39 * 60_000, count: 1, text: '好，看到了。' }),
    'douyin-duty/memory/dm-old.json': {
      messages: [{ from: 'them', at: twoDaysAgo, text: '旧抖音视频' }],
    },
  });
  const { buildContext } = await import(`../src/context.js?bridge=${now}`);
  const cfg = { channels: { qq: { peerId: '10001' } }, content: { topics: { catchup: true, catchupDays: 1, share: false } } };
  const ch = readQq({ peerId: '10001' }, now, 'Asia/Shanghai');
  const ctx = buildContext({ cfg, now, st: {}, ch, sys: {}, tz: 'Asia/Shanghai' });
  assert.equal(ctx.her.lastChannel, 'qq');
  assert.equal(ctx.her.lastText, '我回你了哦');
  assert.equal(ctx.her.answeredOnOwnChannel, true);
  assert.ok(ctx.her.lastAgoSec >= 2390 && ctx.her.lastAgoSec <= 2410);
  const picked = pickTopic(ctx, cfg, now, {});
  assert.notEqual(picked?.slot, 'catchup');
  assert.equal(recentTurns({ dsh: dir }).map((r) => r.text).includes('我回你了哦'), true);
  assert.equal(recentOutbound({ dsh: dir }).some((r) => r.text.includes('好，看到了')), true);
});
