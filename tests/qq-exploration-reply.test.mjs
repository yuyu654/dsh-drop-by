import test from 'node:test';
import assert from 'node:assert/strict';
import { qqReplyContext } from '../src/qq-reply.js';
import { exploreRound } from '../src/explore.js';

test('QQ reply gets relevant exploration context only for the configured private contact', async () => {
  const persona = { ok: true, text: '喜欢推理' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mood: true } };
  const at = 1_000_000;
  const { state } = await exploreRound({ persona, now: at, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '推理短篇', progress: '想到一个反例',
      next: '再试一遍', mood: '有点得意' }),
  }) });
  const input = { kind: 'private', peer: '42', cfg, state, persona, now: at + 1000 };
  const context = qqReplyContext(input);
  assert.match(context, /推理短篇/);
  assert.match(context, /有点得意/);
  assert.match(context, /优先接住这次 QQ 消息/);
  assert.doesNotMatch(qqReplyContext({ ...input, now: at + 7_200_000 }), /有点得意/);
  assert.equal(qqReplyContext({ ...input, kind: 'group' }), '');
  assert.equal(qqReplyContext({ ...input, peer: '43' }), '');
  assert.equal(qqReplyContext({ ...input, persona: { ok: true, text: '另一角色' } }), '');
});

test('QQ 背景里的「当前感受」只留情绪，不把探索的业务词带进私聊', async () => {
  const persona = { ok: true, text: '喜欢推理' };
  const cfg = { channels: { qq: { peerId: '42' } }, exploration: { mood: true } };
  const at = 2_000_000;
  const { state } = await exploreRound({ persona, now: at, includeMood: true, generate: async () => ({
    ok: true, text: JSON.stringify({ action: 'start', topic: '推理短篇', progress: '想到一个反例',
      next: '再试一遍', mood: '术语对上了，但人都还没进去，卡在这儿不上不下，有点闷。' }),
  }) });
  const context = qqReplyContext({ kind: 'private', peer: '42', cfg, state, persona, now: at + 1000 });
  assert.match(context, /有点闷/);
  for (const w of ['术语', '不上不下']) assert.equal(context.includes(w), false, w);
});
