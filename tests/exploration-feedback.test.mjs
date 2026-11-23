import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-curiosity-'));
const env = {
  PG_CONFIG_PATH: 'config.json', PG_STATE_PATH: 'state.json', PG_LOG_DIR: 'logs',
  PG_DSH_HOME: 'dsh', PG_CHAT_DATA_DIR: 'data', PG_SECRETS_PATH: 'credentials.json',
};
const previous = Object.keys(env).map(key => [key, process.env[key]]);
for (const [key, value] of Object.entries(env)) process.env[key] = path.join(dir, value);
test.after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
const { applyExplorationFeedback, explorationFeedbackForUi, explorationFeedbackHints, observeCuriosity,
  rememberExplorationShare, recentSharedExplorationTopic, consumeExplorationFeedback, recordExplorationDirection } = await import('../src/exploration-feedback.js');
const now = Date.parse('2026-11-22T12:00:00+08:00');
const cfg = { exploration: { feedback: { enabled: true, maxCandidates: 2, warmMin: 10 } } };

test('探索操作作用于确实存在的进展，偏好只供下回参考，换方向与暂放会避开', () => {
  const status = { thread: { topic: '独立游戏关卡', at: now }, leisure: { topic: '摇滚乐编曲', at: now - 1 } };
  const [thread, leisure] = explorationFeedbackForUi(status, cfg, now).entries;
  assert.equal(applyExplorationFeedback({ status, cfg, id: '假的', action: 'more', now }), false);
  assert.equal(applyExplorationFeedback({ status, cfg, id: thread.id, action: 'more', now }), true);
  const hint = explorationFeedbackHints(cfg, status, now);
  assert.equal(hint.prefer, thread.topic);
  consumeExplorationFeedback(cfg, hint, now);
  assert.equal(explorationFeedbackHints(cfg, status, now).prefer, '');
  assert.equal(applyExplorationFeedback({ status, cfg, id: thread.id, action: 'change', now }), true);
  assert.equal(applyExplorationFeedback({ status, cfg, id: leisure.id, action: 'pause', now }), true);
  assert.deepEqual(new Set(explorationFeedbackHints(cfg, status, now).avoid), new Set(['独立游戏关卡', '摇滚乐编曲']));
  assert.equal(applyExplorationFeedback({ status, cfg, id: thread.id, action: 'clear', now }), true);
  assert.deepEqual(explorationFeedbackHints(cfg, status, now).avoid, ['摇滚乐编曲']);
  assert.equal(explorationFeedbackForUi(status, cfg, now).entries.find((e) => e.id === thread.id).action, '');
});

test('真发出去的分享和有标题的转发聊热后才纳入，不保存聊天原文，删除不会马上冒回', () => {
  const src = { peer: 'green', channel: 'qq', cfg };
  rememberExplorationShare({ ...src, topic: '古典吉他指法', at: now });
  const observe = (text, offset, extra = {}) => observeCuriosity({ ...src, text, at: now + offset, now: now + offset, ...extra });
  observe('嗯嗯', 1);
  observe('古典吉他的指法我也想了解', 2);
  assert.equal(explorationFeedbackForUi({}, cfg, now + 2).candidates.length, 0);
  observe('吉他指法这一段很好玩，我还想看', 3);
  const [candidate] = explorationFeedbackForUi({}, cfg, now + 3).candidates;
  assert.equal(candidate.topic, '古典吉他指法');
  assert.doesNotMatch(fs.readFileSync(path.join(process.env.PG_CHAT_DATA_DIR, 'exploration-feedback.json'), 'utf8'), /这一段很好玩/);
  assert.equal(applyExplorationFeedback({ cfg, status: {}, now: now + 4, id: candidate.id, action: 'delete' }), true);
  observe('古典吉他指法具体怎么练', 5);
  assert.equal(explorationFeedbackForUi({}, cfg, now + 5).candidates.length, 0);
  observe('转发', 6, { forward: { title: '铅笔速写的光影', id: 'card' } });
  observe('速写的光影我还没练过，有意思', 7);
  assert.equal(explorationFeedbackForUi({}, cfg, now + 7).candidates[0].source, 'forward');
  assert.deepEqual(explorationFeedbackForUi({}, cfg, now + 8 * 86400000).candidates, []);
});

test('深度和轻量探索避开已淡出的题材，明确指定主题优先', async () => {
  const { exploreRound } = await import('../src/explore.js');
  const known = { prefer: '古典吉他', avoid: ['遥感气象重建'] };
  for (const mode of ['deep', 'light']) {
    const attempts = [];
    const payload = mode === 'deep'
      ? { action: 'start', topic: '遥感气象重建', progress: '列出两个要点', next: '做小结' }
      : { action: 'light', topic: '遥感气象重建', summary: '列出两个要点' };
    const generate = async ({ prompt }) => {
      attempts.push(prompt);
      return { ok: true, text: JSON.stringify(payload) };
    };
    const args = { persona: { ok: true, text: '喜欢乐器和气象' }, interest: '乐器',
      timing: { mode }, topicFeedback: known, generate };
    const changed = await exploreRound(args);
    assert.equal(changed.action, 'skip');
    assert.match(attempts[0], /"recentCuriosity":"古典吉他"/);
    assert.match(attempts[0], /"avoidTopics":\["遥感气象重建"\]/);
    const pinned = await exploreRound({ ...args, focusTopic: '遥感气象重建' });
    assert.notEqual(pinned.action, 'skip');
    assert.doesNotMatch(attempts.at(-1), /"recentCuriosity"/);
  }
});

test('明确暂停在自动反馈关闭时仍生效，沿用现有保留期和最近分享窗口', () => {
  const time = now + 86400000 * 10;
  const settings = { exploration: { feedback: { enabled: false, keepDays: 1, warmMin: 2 } } };
  const current = { cfg: settings, peer: 'same-peer', channel: 'qq' };
  rememberExplorationShare({ ...current, topic: '旧街区窗花', at: time });
  assert.equal(recentSharedExplorationTopic({ ...current, now: time + 1 }), '旧街区窗花');
  assert.equal(recentSharedExplorationTopic({ ...current, peer: 'other-peer', now: time + 1 }), '');
  assert.equal(recentSharedExplorationTopic({ ...current, channel: 'douyin', now: time + 1 }), '');
  assert.equal(recentSharedExplorationTopic({ ...current, now: time + 120000 }), '');
  assert.equal(recordExplorationDirection({ cfg: settings, action: 'pause', topic: '旧街区窗花', now: time }), true);
  assert.deepEqual(explorationFeedbackHints(settings, {}, time + 1), { prefer: '', avoid: ['旧街区窗花'] });
  assert.deepEqual(explorationFeedbackHints(settings, {}, time + 86400000).avoid, []);
});
