// anticheat.test.mjs —— 2026-11-08 她说：WeGame 在进程中时，某些操作可能触发反作弊。
// 所以只要名单里的进程在跑，这一拍就不读窗口标题、不读浏览器标签、不截屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { anticheatRunning, ANTICHEAT_DEFAULT } from '../src/probe.js';
import { loadConfig } from '../src/config.js';

const cfg = (o = {}) => ({ perception: { anticheat: { skip: true, procs: ANTICHEAT_DEFAULT, ...o } } });

test('WeGame 在进程里：认出来，这一拍不读窗口/标签/屏幕', () => {
  assert.equal(anticheatRunning({ procs: ['explorer', 'wegame', 'chrome'] }, cfg()), 'wegame');
});

test('大小写不敏感（探针给的是小写，名单是人写的）', () => {
  assert.equal(anticheatRunning({ procs: ['wegame'] }, cfg({ procs: ['WeGame'] })), 'wegame');
});

test('没命中就不拦：普通开着浏览器、编辑器照常读', () => {
  assert.equal(anticheatRunning({ procs: ['explorer', 'code', 'msedge'] }, cfg()), null);
});

test('没有 procs（探针没读到）时也不拦，别把整机都当成在打游戏', () => {
  assert.equal(anticheatRunning({ procs: [] }, cfg()), null);
  assert.equal(anticheatRunning({}, cfg()), null);
});

test('名单可以自己改：只认 wegame 时不认 crossproxy', () => {
  const c = cfg({ procs: ['wegame'] });
  assert.equal(anticheatRunning({ procs: ['crossproxy'] }, c), null);
  assert.equal(anticheatRunning({ procs: ['wegame'] }, c), 'wegame');
});

test('自己把保护关掉（skip=false）就永远不拦——出了事自己负责', () => {
  assert.equal(anticheatRunning({ procs: ['wegame'] }, cfg({ skip: false })), null);
});

test('默认配置里保护是开着的，名单里有 wegame', () => {
  const ac = loadConfig().perception.anticheat;
  assert.equal(ac.skip, true);
  assert.ok(ac.procs.includes('wegame'));
});