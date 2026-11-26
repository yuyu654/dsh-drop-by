import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  isFullscreenBlocked,
  fullscreenGuardStatus,
  disposeFullscreenGuard,
  resetFullscreenGuardForTest,
} from '../src/perception/fullscreen-guard.js';

const baseCfg = (overrides = {}) => ({
  perception: {
    anticheat: {
      skip: true,
      skipFullscreen: true,
      fullscreenCooldownMin: 10,
      ...overrides,
    },
  },
});

test.afterEach(() => {
  resetFullscreenGuardForTest();
});

test('fullscreen guard: blocks during fullscreen, holds 10m cooldown after exit, resets on Alt+Tab re-entry', async () => {
  const cfg = baseCfg({ fullscreenCooldownMin: 10 });
  const t0 = 1_000_000;

  // 正常桌面
  let r = await isFullscreenBlocked(cfg, { now: t0, query: async () => 5 });
  assert.equal(r.blocked, false);

  // 进入 D3D 独占全屏游戏（state=3）
  r = await isFullscreenBlocked(cfg, { now: t0 + 10_000, query: async () => 3 });
  assert.equal(r.blocked, true);
  assert.equal(r.inFullscreen, true);
  assert.equal(r.reason, 'FULLSCREEN_GAME');

  // 退出全屏 3 分钟后：仍在 10 分钟缓冲期内
  r = await isFullscreenBlocked(cfg, { now: t0 + 10_000 + 3 * 60_000, query: async () => 5 });
  assert.equal(r.blocked, true);
  assert.equal(r.inFullscreen, false);
  assert.equal(r.inCooldown, true);
  assert.equal(r.reason, 'FULLSCREEN_COOLDOWN');
  assert.equal(r.remainingMs, 7 * 60_000);

  // Alt+Tab 切回全屏游戏（state=2）：刷新 lastFullscreenAt
  const reenterAt = t0 + 10_000 + 5 * 60_000;
  r = await isFullscreenBlocked(cfg, { now: reenterAt, query: async () => 2 });
  assert.equal(r.blocked, true);
  assert.equal(r.inFullscreen, true);

  // 再次退出后 9 分钟：仍在缓冲期内
  r = await isFullscreenBlocked(cfg, { now: reenterAt + 9 * 60_000, query: async () => 5 });
  assert.equal(r.blocked, true);
  assert.equal(r.inCooldown, true);

  // 退出满 10 分钟：解除避让
  r = await isFullscreenBlocked(cfg, { now: reenterAt + 10 * 60_000, query: async () => 5 });
  assert.equal(r.blocked, false);
  assert.equal(r.inCooldown, false);
});

test('fullscreen guard: respects cooldown=0 and skipFullscreen=false', async () => {
  const t0 = 2_000_000;
  const zeroCfg = baseCfg({ fullscreenCooldownMin: 0 });
  let r = await isFullscreenBlocked(zeroCfg, { now: t0, query: async () => 3 });
  assert.equal(r.blocked, true);
  r = await isFullscreenBlocked(zeroCfg, { now: t0 + 1000, query: async () => 5 });
  assert.equal(r.blocked, false);

  const offCfg = baseCfg({ skipFullscreen: false });
  r = await isFullscreenBlocked(offCfg, { now: t0, query: async () => 3 });
  assert.equal(r.blocked, false);
  assert.equal(r.mode, 'off');
});

test('fullscreen guard: compiles tools/quns-helper.cs via csc.exe on Windows and queries natively', async () => {
  if (process.platform !== 'win32') return;
  const prevDir = process.env.PG_QUNS_CACHE_DIR;
  const isolatedDir = path.join(os.tmpdir(), `dsh-drop-by-quns-test-${process.pid}-${Date.now()}`);
  process.env.PG_QUNS_CACHE_DIR = isolatedDir;
  try {
    const cfg = baseCfg({ fullscreenCooldownMin: 10 });
    const r = await isFullscreenBlocked(cfg);
    assert.equal(r.mode, 'native', `expected native mode on Windows, got ${r.mode}`);
    const st = fullscreenGuardStatus(cfg);
    assert.equal(st.ready, true);
    assert.match(st.exePath, /quns-helper-[0-9a-f]{12}\.exe$/);
    const cacheDir = path.dirname(st.exePath);
    assert.equal(cacheDir, path.resolve(isolatedDir));
    assert.equal(fs.existsSync(st.exePath), true);
    disposeFullscreenGuard();
    // 等 Windows 释放进程句柄并清理临时目录
    for (let i = 0; i < 20 && fs.existsSync(cacheDir); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(fs.existsSync(cacheDir), false, `expected ${cacheDir} to be removed on dispose`);
  } finally {
    if (prevDir === undefined) delete process.env.PG_QUNS_CACHE_DIR;
    else process.env.PG_QUNS_CACHE_DIR = prevDir;
    try { fs.rmSync(isolatedDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('fullscreen guard cleanup preserves unrelated files in a shared cache directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-quns-shared-'));
  const prev = process.env.PG_QUNS_CACHE_DIR;
  process.env.PG_QUNS_CACHE_DIR = root;
  try {
    for (const name of ['quns-helper-0123456789ab.exe', 'quns-helper-0123456789ab.exe.12.tmp.exe', 'notes.txt']) {
      fs.writeFileSync(path.join(root, name), name);
    }
    disposeFullscreenGuard();
    assert.deepEqual(fs.readdirSync(root), ['notes.txt']);
  } finally {
    if (prev === undefined) delete process.env.PG_QUNS_CACHE_DIR;
    else process.env.PG_QUNS_CACHE_DIR = prev;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an idle Windows native helper does not hold its Node caller open', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-quns-child-'));
  const url = new URL('../src/perception/fullscreen-guard.js', import.meta.url).href;
  const source = 'import { isFullscreenBlocked } from ' + JSON.stringify(url) +
    '; console.log((await isFullscreenBlocked({})).mode)';
  try {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', source], {
      env: { ...process.env, PG_QUNS_CACHE_DIR: root }, timeout: 6000, windowsHide: true,
    });
    assert.match(stdout, /^native\s*$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
