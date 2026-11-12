// outbound.test.mjs —— 「我最后一次开口是什么时候」以及防重复判定。
//
// 这一层存在的理由：qq-history 是 driver 发完才写的，写失败还只是静默 catch；
// 而 qq-reply.out.txt 是模型写出回复那一刻就落盘的（history 之前）。
// 两个来源都得看，取较晚的那个，否则「已经回过了」这件事会漏掉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dshHome,
  qqLastOutbound,
  douyinLastOutbound,
  lastOutbound,
  outboundFor,
  answeredAlready,
  recentOutbound,
} from '../src/outbound.js';

function fakeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-outbound-'));
  fs.mkdirSync(path.join(dir, 'autonomy'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'douyin-duty', 'memory'), { recursive: true });
  return dir;
}

test('dshHome：PG_DSH_HOME 能顶掉默认家目录', () => {
  assert.equal(dshHome({ PG_DSH_HOME: 'D:\\tmp\\pg' }), 'D:\\tmp\\pg');
  assert.match(dshHome({}), /\.dsh$/);
});

test('qqLastOutbound：只认带 reply 的 turn，取最新那条', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'autonomy', 'qq-history.json'),
    JSON.stringify({
      turns: [
        { user: 'a', reply: '嗯', at: 1000 },
        { user: 'b', at: 5000 }, // 只有她说、我没有回 → 不算出站
        { user: 'c', reply: '知道了', at: 3000 },
      ],
    }),
  );
  const r = qqLastOutbound({ dsh: home });
  assert.equal(r.ts, 3000);
  assert.equal(r.src, 'qq-history');
});

test('qqLastOutbound：qq-reply.out.txt 更新时以它为准', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'autonomy', 'qq-history.json'),
    JSON.stringify({ turns: [{ user: 'a', reply: '嗯', at: 1000 }] }),
  );
  const out = path.join(home, 'douyin-duty', 'qq-reply.out.txt');
  fs.writeFileSync(out, '后面到底是哪段');
  const t = new Date('2026-11-05T12:00:00Z');
  fs.utimesSync(out, t, t);
  const r = qqLastOutbound({ dsh: home });
  assert.equal(r.ts, t.getTime());
  assert.equal(r.src, 'qq-out');
});

test('douyinLastOutbound：只认 from=me 的最新一条', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({
      messages: [
        { at: '2026-11-05T10:00:00.000Z', from: 'them', text: '在吗' },
        { at: '2026-11-05T10:05:00.000Z', from: 'me', text: '在' },
        { at: '2026-11-05T10:09:00.000Z', from: 'them', text: '嗯' },
      ],
    }),
  );
  const r = douyinLastOutbound({ dsh: home, cfg: {} });
  assert.equal(r.ts, Date.parse('2026-11-05T10:05:00.000Z'));
  assert.equal(r.channel, 'douyin');
});

test('douyinLastOutbound：抖音通道关着时不拿陈旧文件当证据', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({ messages: [{ at: '2026-11-05T10:05:00.000Z', from: 'me', text: '在' }] }),
  );
  assert.equal(douyinLastOutbound({ dsh: home, cfg: { channels: { douyin: { enabled: false } } } }).ts, 0);
});

test('lastOutbound：两个通道取较晚的那个', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'autonomy', 'qq-history.json'),
    JSON.stringify({ turns: [{ user: 'a', reply: '嗯', at: 2000 }] }),
  );
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({ messages: [{ at: '2026-11-05T10:05:00.000Z', from: 'me', text: '在' }] }),
  );
  const r = lastOutbound({ dsh: home, cfg: {} });
  assert.equal(r.channel, 'douyin');
  assert.equal(r.ts, Date.parse('2026-11-05T10:05:00.000Z'));
});

test('lastOutbound：什么都没有时返回 0，不抛', () => {
  const home = fakeHome();
  const r = lastOutbound({ dsh: home, cfg: {} });
  assert.equal(r.ts, 0);
});

test('outboundFor：只看她说话的那个通道（跨通道不算应过）', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'autonomy', 'qq-history.json'),
    JSON.stringify({ turns: [{ user: 'a', reply: '嗯', at: 2000 }] }),
  );
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({ messages: [{ at: '2026-11-05T10:05:00.000Z', from: 'me', text: '在' }] }),
  );
  assert.equal(outboundFor('qq', { dsh: home }).channel, 'qq');
  assert.equal(outboundFor('qq', { dsh: home }).ts, 2000);
  assert.equal(outboundFor('douyin', { dsh: home, cfg: {} }).channel, 'douyin');
  // 不知道渠道 → 退回所有通道里最晚的那个
  assert.equal(outboundFor(null, { dsh: home, cfg: {} }).channel, 'douyin');
});

test('answeredAlready：出站晚于她那条才算「已经回过」', () => {
  assert.equal(answeredAlready({ herTs: 1000, out: { ts: 2000 } }), true);
  assert.equal(answeredAlready({ herTs: 2000, out: { ts: 2000 } }), false);
  assert.equal(answeredAlready({ herTs: 3000, out: { ts: 2000 } }), false);
  // 一边读不到就是「不知道」，不能因此吞掉一拍
  assert.equal(answeredAlready({ herTs: 0, out: { ts: 2000 } }), false);
  assert.equal(answeredAlready({ herTs: 1000, out: null }), false);
});
test('recentOutbound：合并两个通道按时间倒序，text 截断，limit 生效', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'autonomy', 'qq-history.json'),
    JSON.stringify({
      turns: [
        { reply: '嗯', at: 2000 },
        { reply: '这一条\n很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长', at: 4000 },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({
      messages: [
        { at: '2026-11-05T10:05:00.000Z', from: 'me', text: '这个视频你肯定喜欢' },
        { at: '2026-11-05T10:06:00.000Z', from: 'them', text: '不看' },
      ],
    }),
  );
  const r = recentOutbound({ dsh: home, cfg: {}, limit: 3 });
  assert.equal(r.length, 3);
  assert.equal(r[0].channel, 'douyin');
  assert.equal(r[0].text, '这个视频你肯定喜欢');
  for (const x of r) {
    assert.ok(x.text.length <= 60);
    assert.doesNotMatch(x.text, /\n/);
  }
  assert.deepEqual(r.map((x) => x.channel), ['douyin', 'qq', 'qq']);
});

test('recentOutbound：抖音通道关着时不读 dm 记忆；什么都没有就返回空数组', () => {
  const home = fakeHome();
  fs.writeFileSync(
    path.join(home, 'douyin-duty', 'memory', 'dm-1.json'),
    JSON.stringify({ messages: [{ at: '2026-11-05T10:05:00.000Z', from: 'me', text: '在' }] }),
  );
  assert.equal(recentOutbound({ dsh: home, cfg: { channels: { douyin: { enabled: false } } } }).length, 0);
  assert.deepEqual(recentOutbound({ dsh: fakeHome(), cfg: {} }), []);
});
