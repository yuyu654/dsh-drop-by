// dialogue.test.mjs —— 阶段 3：短期对话窗口（最近 6 轮，双方原文）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recentTurns } from '../src/outbound.js';
import { buildSnapshot } from '../src/snapshot.js';

function fakeHome(turns) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dialogue-'));
  fs.mkdirSync(path.join(dir, 'autonomy'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'autonomy', 'qq-history.json'), JSON.stringify({ turns }));
  return dir;
}

test('recentTurns：一轮里她在前、我在后，旧的在前', () => {
  const home = fakeHome([
    { user: '在吗', reply: '干嘛', at: 1000 },
    { user: '晚饭吃啥', reply: '随便', at: 2000 },
  ]);
  const rows = recentTurns({ dsh: home });
  assert.deepEqual(rows.map((r) => r.who), ['her', 'me', 'her', 'me']);
  assert.equal(rows[0].text, '在吗');
  assert.equal(rows[3].text, '随便');
});

test('recentTurns：最多 6 轮（12 条），每条截 80 字', () => {
  const turns = Array.from({ length: 9 }, (_, i) => ({ user: `她${i}` + 'x'.repeat(100), reply: `我${i}`, at: 1000 + i }));
  const rows = recentTurns({ dsh: fakeHome(turns), limit: 6 });
  assert.equal(rows.length, 12);
  assert.equal(rows[0].text.length, 80);
  assert.match(rows[0].text, /^她3/); // 前 3 轮被切掉
});

test('recentTurns：只有她说、没有我回的轮次也给出来', () => {
  const rows = recentTurns({ dsh: fakeHome([{ user: '还没回的那条', at: 1000 }]) });
  assert.deepEqual(rows.map((r) => r.who), ['her']);
});

test('recentTurns：文件读不到返回空数组', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-dialogue-empty-'));
  assert.deepEqual(recentTurns({ dsh: dir }), []);
});

test('快照：写「最近聊到哪」，旧的在前', () => {
  const text = buildSnapshot({
    cfg: {},
    now: 1_700_000_000_000,
    tz: 'Asia/Shanghai',
    ctx: { her: {}, me: {}, dialogueTurns: [{ who: 'her', text: '在吗' }, { who: 'me', text: '干嘛' }] },
  });
  assert.match(text, /最近聊到哪（旧的在前）：/);
  assert.match(text, /她：在吗/);
  assert.match(text, /我：干嘛/);
});

test('快照：一条都没有时整段省略', () => {
  const text = buildSnapshot({ cfg: {}, now: 1_700_000_000_000, tz: 'Asia/Shanghai', ctx: { her: {}, me: {}, dialogueTurns: [] } });
  assert.doesNotMatch(text, /最近聊到哪/);
});