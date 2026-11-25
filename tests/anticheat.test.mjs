// anticheat.test.mjs —— 2026-11-08 她说：WeGame 在进程中时，某些操作可能触发反作弊。
// 所以只要名单里的进程在跑，这一拍就不读窗口标题、不读浏览器标签、不截屏。
import test from 'node:test';
import assert from 'node:assert/strict';
import { anticheatRunning, ANTICHEAT_DEFAULT } from '../src/perception/probe.js';
import { loadConfig } from '../src/settings/config.js';
import { applyChange, listForUi } from '../src/settings/settings.js';

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

test('默认配置里保护是开着的，名单里有 wegame 与常见外服反作弊', () => {
  const ac = loadConfig().perception.anticheat;
  assert.equal(ac.skip, true);
  assert.equal(ac.skipFullscreen, true);
  for (const name of ['wegame', 'easyanticheat', 'beservice', 'battleye', 'faceitclient', 'vgc', 'sguard64']) {
    assert.ok(ac.procs.includes(name), `missing ${name}`);
  }
});

test('外服/Steam 反作弊进程（EAC / BattlEye / FACEIT / Vanguard）全部识别拦截', () => {
  for (const proc of ['easyanticheat', 'easyanticheat_eos', 'beservice', 'battleye', 'faceitclient', 'eaanticheat', 'mhyprot2']) {
    assert.equal(anticheatRunning({ procs: ['explorer', proc] }, cfg()), proc);
  }
});

test('全屏游戏自动避让，但全屏浏览器/编辑器/播放器不误拦', () => {
  assert.equal(anticheatRunning({ procs: ['eldenring'], fullscreen: true, fg_name: 'eldenring' }, cfg()), 'fullscreen:eldenring');
  assert.equal(anticheatRunning({ procs: ['msedge'], fullscreen: true, fg_name: 'msedge' }, cfg()), null);
  assert.equal(anticheatRunning({ procs: ['code'], fullscreen: true, fg_name: 'code' }, cfg()), null);
  assert.equal(anticheatRunning({ procs: ['potplayermini64'], fullscreen: true, fg_name: 'potplayermini64' }, cfg()), null);
  // 关掉全屏避让后不按全屏拦，但反作弊进程照旧拦
  assert.equal(anticheatRunning({ procs: ['eldenring'], fullscreen: true, fg_name: 'eldenring' }, cfg({ skipFullscreen: false })), null);
  assert.equal(anticheatRunning({ procs: ['easyanticheat'], fullscreen: true, fg_name: 'eldenring' }, cfg({ skipFullscreen: false })), 'easyanticheat');
});

test('反作弊与全屏避让设置项可保存回显', () => {
  const c1 = applyChange(loadConfig(), 'perception.anticheat.skipFullscreen', false);
  assert.equal(c1.ok, true);
  const items = listForUi(c1.cfg).flatMap((g) => g.items || []);
  assert.equal(items.find((x) => x.path === 'perception.anticheat.skipFullscreen')?.value, false);
});