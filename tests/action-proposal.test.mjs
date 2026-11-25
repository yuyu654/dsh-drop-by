import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('归属：角色笔记和角色历史不能证明用户说过参数', async () => {
  const { guard, buildPrompt, buildChitchatPrompt } = await import('../src/decision/compose.js');
  const { judgePrompt } = await import('../src/decision/judge.js');
  const draft = '照你说的，用120%、150%反解τ和A阈值。';
  const ctx = { her: { lastText: '用120%，别先改轴。' },
    dialogueTurns: [{ who: 'me', text: '用120%、150%反解τ和A阈值' }],
    myExploration: [{ next: '用120%、150%反解τ和A阈值' }] };
  assert.ok(guard(draft, {}, ctx).violations.some((v) => v.code === 'FALSE_ATTRIBUTION'));
  assert.equal(guard('照你说的，用20%反解。', {}, { her: { lastText: '用120%反解' } }).ok, false);
  ctx.dialogueTurns.push({ who: 'her', text: '用120%、150%反解τ和A阈值' });
  assert.ok(guard(draft, {}, ctx).ok);
  assert.equal(guard(draft.replace('A阈值', 'B阈值'), {}, ctx).ok, false);
  assert.ok(guard('我想用120%、150%反解τ和A阈值。', {}, ctx).ok);
  assert.ok(guard('你说的对', {}, ctx).ok);
  const input = { ctx, cfg: {}, topic: { slot: 'share', evidence: {} } };
  for (const prompt of [buildPrompt(input), buildChitchatPrompt(input), judgePrompt({})]) {
    assert.match(prompt, /来源归属铁律/);
  }
});

const bridgePath = process.env.DROP_BY_QQ_BRIDGE_PATH;
test('原版 QQ 桥：普通好不执行，接单走普通会话，后台只回传一次真实结果', { skip: !bridgePath }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-action-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A separate process for the installed bridge scenario keeps config paths isolated.
  const { spawnSync } = await import('node:child_process');
  const fixture = path.resolve(import.meta.dirname, 'fixtures', 'qq-action-flow.mjs');
  const out = spawnSync(process.execPath, [fixture, dir, path.resolve(bridgePath)], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stdout + out.stderr);
});
