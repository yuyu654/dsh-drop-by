import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-task-result-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(dir, 'chat');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const { bindActionExecutor, queueQqCommand } = await import('../src/chat/action-proposal.js');
const { writeChatData } = await import('../src/channels/douyin-im.js');

test('a slow task can send one status notice and still report its genuine completion', async (t) => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const notices = [];
  const loaded = loadConfig();
  saveConfig({ ...loaded, dryRun: false, channels: { ...loaded.channels, primary: 'internal' },
    send: { ...loaded.send, enabled: true },
    rules: { ...loaded.rules, actionGate: { ...loaded.rules.actionGate, ackWaitSec: 0 },
      qqCommands: { ...loaded.rules.qqCommands, timeoutSec: 5 } } });
  writeChatData('external-chat', { sessionId: 'bound' });
  t.after(bindActionExecutor({ command: () => pending, report: ({ result }) => { notices.push(result.text); } }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const at = Date.now();
  assert.equal(queueQqCommand({ cfg: loadConfig(), peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '后台查公开资料', at, now: at, cmd: { type: 'explore_query' } }), 'webDisabled');
  assert.equal(queueQqCommand({ cfg: loadConfig(), peer: 'bound', kind: 'private', internalSession: 'bound',
    text: '后台推进研究', at, now: at, cmd: { type: 'explore_trigger' } }), 'accepted');
  t.mock.timers.tick(5000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(notices.length, 1);
  assert.match(notices[0], /还没跑完/);
  finish({ text: '已经找到公开资料，结果如下。' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(notices.slice(1), ['已经找到公开资料，结果如下。']);
});
