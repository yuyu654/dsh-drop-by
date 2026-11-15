import test from 'node:test';
import assert from 'node:assert/strict';
import { matchUserCommand, parseCommandIntent } from '../src/command-matcher.js';
import { guard } from '../src/compose.js';
import { guidedWebSearch, publicExplorationUrl } from '../src/explore-media.js';
import { coerce } from '../src/settings.js';

test('QQ 模型分流识别委婉请求，校验原话和白名单', async () => {
  const request = '能帮我翻翻公开的反时限过流实现吗';
  const result = { intent: 'user_command', actionType: 'explore_query', userGuidance: '反时限过流实现', ackCue: '轻快' };
  const match = await matchUserCommand(request, { generate: async ({ prompt }) => {
    assert.match(prompt, /反时限过流实现/);
    return { ok: true, text: JSON.stringify(result) };
  } });
  assert.deepEqual(match, { intent: 'user_command', actionType: 'explore_query', ackCue: '轻快', cmd: { type: 'explore_query', params: { query: '反时限过流实现' } } });
  for (const invalid of [{ ...result, actionType: 'shell' }, { ...result, userGuidance: '其他主题' }, { ...result, command: 'test' }]) {
    assert.equal(parseCommandIntent(JSON.stringify(invalid), request).intent, 'chat_only');
  }
  assert.equal(parseCommandIntent(JSON.stringify(result), '好').intent, 'chat_only');
  assert.equal(parseCommandIntent(JSON.stringify(result), '帮我带杯水').intent, 'chat_only');
});

test('QQ 分流超时、坏 JSON 或无意图时放回普通对话', async () => {
  for (const generate of [() => new Promise(() => {}), async () => ({ ok: true, text: '坏 JSON' }),
    async () => ({ ok: true, text: '{"type":"none"}' })]) {
    assert.deepEqual(await matchUserCommand('请查一查公开资料', { generate, timeoutMs: 1 }), { intent: 'chat_only' });
  }
  const notes = { intent: 'user_command', actionType: 'summarize_notes', userGuidance: '昨天', ackCue: '' };
  assert.equal(parseCommandIntent(JSON.stringify(notes), '昨天的探索笔记能不能整理下').cmd.params.target, '昨天');
});
test('接受提议必须有当前凭证，明确指定站点进入换源约束', () => {
  const response = JSON.stringify({ intent: 'accept_proposal', actionType: 'explore_retry', userGuidance: '知乎或者CSDN', ackCue: '自然' });
  const message = '可以，你去知乎或者CSDN翻翻看';
  assert.equal(parseCommandIntent(response, message).intent, 'chat_only');
  const pending = { actionType: 'explore_retry', prompt: '我自己去翻翻其他来源，方便吗？' };
  assert.equal(parseCommandIntent(response, message, pending).intent, 'accept_proposal');
  assert.deepEqual(guidedWebSearch('反时限算法', '知乎或者CSDN'), {
    query: '反时限算法 (site:zhihu.com OR site:csdn.net)', preferredSites: ['zhihu.com', 'csdn.net'],
  });
  assert.equal(guidedWebSearch('原搜索词', '反时限保护算法').query, '反时限保护算法');
  assert.equal(guidedWebSearch('原搜索词', 'github.com').query, '原搜索词 site:github.com');
});
test('探索参数不会被凭空归给用户', () => {
  assert.ok(guard('照你说的用120%。', {}, { her: { lastText: '试试150%' } }).violations
    .some((entry) => entry.code === 'FALSE_ATTRIBUTION'));
});
test('公开搜索和任务时间设置守住基本边界', () => {
  assert.equal(publicExplorationUrl('http://127.0.0.1/status'), null);
  assert.ok(publicExplorationUrl('https://example.org/story'));
  assert.equal(coerce('rules.qqCommands.timeoutSec', 90).ok, true);
  assert.equal(coerce('rules.qqCommands.timeoutSec', 180).ok, false);
});
