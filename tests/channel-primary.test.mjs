import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, channelItemsForUi, listForUi } from '../src/settings.js';
import { loadConfig } from '../src/config.js';

test('primary channel and polling bounds are available in settings', () => {
  const cfg = loadConfig();
  assert.ok(applyChange(cfg, 'channels.primary', 'internal').ok);
  assert.ok(applyChange(cfg, 'channels.primary', 'douyin').ok);
  assert.ok(applyChange(cfg, 'channels.primary', 'qq').ok);
  assert.equal(applyChange(cfg, 'channels.primary', 'both').ok, false);
  for (const seconds of [10, 30, 300]) {
    assert.equal(applyChange(cfg, 'channels.douyin.pollSec', seconds).value, seconds);
  }
  for (const seconds of [9, 301]) {
    assert.equal(applyChange(cfg, 'channels.douyin.pollSec', seconds).ok, false);
  }
  const internalCfg = { ...cfg, channels: { ...cfg.channels, primary: 'internal' } };
  const internalPaths = channelItemsForUi(internalCfg).map((i) => i.path);
  assert.deepEqual(internalPaths, [
    'channels.primary', 'channels.internal.send', 'channels.internal.read',
    'channels.douyin.peerSecUid', 'channels.qq.peerId',
  ]);
  const qqPaths = channelItemsForUi({ ...cfg, channels: { ...cfg.channels, primary: 'qq' } }).map((i) => i.path);
  assert.deepEqual(qqPaths, ['channels.primary', 'channels.douyin.peerSecUid', 'channels.qq.peerId', 'channels.qq.send', 'channels.qq.read']);

  const douyinCfg = { ...cfg, channels: { ...cfg.channels, primary: 'douyin' } };
  const douyinPaths = channelItemsForUi(douyinCfg).map((i) => i.path);
  assert.deepEqual(douyinPaths, [
    'channels.primary', 'channels.douyin.send', 'channels.douyin.read',
    'channels.douyin.pollSec', 'channels.douyin.peerSecUid', 'channels.douyin.peerName', 'channels.qq.peerId',
  ]);
  const groupPaths = new Set([
    ...listForUi(internalCfg).flatMap((g) => g.items.map((i) => i.path)),
    ...listForUi({ ...cfg, channels: { ...cfg.channels, primary: 'qq' } }).flatMap((g) => g.items.map((i) => i.path)),
    ...listForUi(douyinCfg).flatMap((g) => g.items.map((i) => i.path)),
  ]);
  for (const p of [...internalPaths, ...qqPaths, ...douyinPaths]) {
    assert.equal(groupPaths.has(p), false, `${p} 不应重复出现在折叠分组里`);
  }
});
