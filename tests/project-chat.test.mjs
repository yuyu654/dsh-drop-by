import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQuestion, recordProjectQuestion, captureProjectAnswer, proactiveProjectBlock, writeProjectQuestion } from '../src/project-chat.js';

const cfg = { rules: { askProjectOnce: true }, channels: { qq: { peerId: '42' } } };
const now = 1_000_000;

test('project opener uses the current persona and does not fall back to a stock line', async () => {
  const topic = projectQuestion(cfg, {});
  const run = (text) => writeProjectQuestion({
    cfg, topic, persona: { text: '习惯用轻松的比喻，叫手头的东西小工程。' },
    generate: async ({ prompt }) => {
      assert.match(prompt, /叫手头的东西小工程/);
      return { ok: true, text };
    },
  });
  const natural = await run('你手头那个小工程是做什么的？');
  assert.equal(natural.text, '你手头那个小工程是做什么的？');
  assert.equal(natural.ok, true);
  for (const text of ['__SKIP__', '你手头在忙什么？报错贴我。', '今天开心吗？']) assert.equal((await run(text)).ok, false);
});
test('asks once after a real send and remembers only a relevant later reply from that QQ peer', () => {
  const st = {};
  assert.equal(projectQuestion(cfg, st)?.slot, 'projectCheckIn');
  recordProjectQuestion(cfg, st, now);
  assert.equal(projectQuestion(cfg, st), null);
  const incoming = { peer: '42', kind: 'private', ts: now + 1000, text: '哈哈' };
  assert.equal(captureProjectAnswer(cfg, st, incoming, now + 3000), null);
  assert.equal(captureProjectAnswer(cfg, st, { ...incoming, peer: '99', text: '我在改视频插件' }, now + 3000), null);
  const memory = captureProjectAnswer(cfg, st, { ...incoming, text: '我在改视频插件' }, now + 3000);
  assert.equal(memory.answer, '我在改视频插件');
  assert.equal(projectQuestion(cfg, st), null);
});

test('window titles and old memory do not authorize troubleshooting; a fresh direct request does', () => {
  const text = '刷抖音那个插件，卡在哪一步了？报错贴我。';
  const ctx = { activity: { fgTitle: '插件报错排查' }, her: { lastChannel: 'qq', lastTs: now - 120_000, lastText: '早安' } };
  assert.equal(proactiveProjectBlock(text, ctx, now), 'PROJECT_HELP_WITHOUT_REQUEST');
  assert.equal(proactiveProjectBlock(text, { ...ctx, her: { ...ctx.her, lastText: '我卡住了，你帮我看看' } }, now), null);
  assert.equal(proactiveProjectBlock(text, { ...ctx, her: { ...ctx.her, lastChannel: 'douyin', lastText: '我卡住了，你帮我看看' } }, now, { channels: { primary: 'douyin' } }), null);
  assert.equal(proactiveProjectBlock('最近在忙什么项目呀？', ctx, now), 'PROJECT_QUESTION_OUTSIDE_SLOT');
});
