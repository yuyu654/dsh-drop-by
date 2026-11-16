import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collectIncoming, douyinPeer, douyinPeerName, originalWatcherDisabled, pollDelayMs } from '../src/channels/douyin-im.js';

const msg = (text, ms, from = 'them') => ({ at: new Date(ms).toISOString(), text, from, kind: 'text' });
test('polling establishes a baseline, preserves identical messages and detects gaps', () => {
  const original = [msg('历史', 1000)];
  const base = collectIncoming({}, 'conversation', original);
  assert.deepEqual(base.pending, []);
  const burst = [...original, msg('新', 2000), msg('新', 2000), msg('我回的', 2100, 'me')];
  const next = collectIncoming(base, 'conversation', burst);
  assert.deepEqual(next.pending.map(m => m.text), ['新', '新']);
  assert.deepEqual(collectIncoming(next, 'conversation', burst).pending, next.pending);
  assert.equal(collectIncoming(next, 'conversation', [msg('缺口后', 3000)]).gap, true);
});

test('polling never falls below ten seconds and backoff is bounded', () => {
  assert.equal(pollDelayMs({ pollSec: 5 }), 10000);
  assert.equal(pollDelayMs({ pollSec: 37 }, 1), 74000);
  assert.equal(pollDelayMs({ pollSec: 300 }, 9), 300000);
});

test('douyinPeer auto-fetches sec_uid and nick from douyin-duty when left blank', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-dyduty-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dutyDir = path.join(home, 'douyin-duty');
  fs.mkdirSync(dutyDir, { recursive: true });
  fs.writeFileSync(path.join(dutyDir, 'config.json'), JSON.stringify({
    chatWatch: false,
    dmTo: '用户A',
    dmToId: 'MS4wLjABAAAA_AUTO',
    dmPeers: [{ nick: '用户A', sec_uid: 'MS4wLjABAAAA_AUTO' }],
  }));
  const blankCfg = { channels: { douyin: { peerSecUid: '', peerName: '' } } };
  assert.equal(douyinPeer(blankCfg, { dshHome: home }), 'MS4wLjABAAAA_AUTO');
  assert.equal(douyinPeerName(blankCfg, { dshHome: home }), '用户A');

  const explicitCfg = { channels: { douyin: { peerSecUid: 'MS4wLjABAAAA_CUSTOM', peerName: '自定义' } } };
  assert.equal(douyinPeer(explicitCfg, { dshHome: home }), 'MS4wLjABAAAA_CUSTOM');
  assert.equal(douyinPeerName(explicitCfg, { dshHome: home }), '自定义');
  assert.equal(originalWatcherDisabled(home), true);
});

test('consumeCompanionQqOutbound delivers unsynced QQ proactive messages once', async (t) => {
  const prevHome = process.env.PG_DSH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-by-qq-sync-'));
  process.env.PG_DSH_HOME = home;
  t.after(() => {
    if (prevHome === undefined) delete process.env.PG_DSH_HOME;
    else process.env.PG_DSH_HOME = prevHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const { consumeCompanionQqOutbound } = await import('../src/send.js');
  const dir = path.join(home, 'qq-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'companion-out.json'), JSON.stringify({
    items: [{ peer: '728', ts: now - 5000, text: '我去买饭，带一份吗' }],
    syncedAt: {},
  }));
  assert.equal(consumeCompanionQqOutbound('728', now), '我：我去买饭，带一份吗');
  assert.equal(consumeCompanionQqOutbound('728', now), '');
});
