// edge-autostart.test.mjs —— 2026-11-07：她分享的视频没被看过，根因之一是
// 桌面 Edge 的调试口(9223)没开，下载脚本一上来就 ECONNREFUSED。
// 现在下载前要先确认口子在；不在就按脚本起一个，起不来就返回明确原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureEdge, downloadVideo } from '../src/videosum.js';

const tmpScript = path.join(os.tmpdir(), `pg-edge-test-${process.pid}.ps1`);
fs.writeFileSync(tmpScript, '# fake\n');

const cfgOf = (o = {}) => ({
  content: { forward: { edgePort: 9223, edgeScript: tmpScript, edgeAutostart: true, edgeWaitMs: 2000, ...o } },
});

test('ensureEdge：口子本来就开着 → 不动它，也不起进程', async () => {
  let spawned = 0;
  const r = await ensureEdge({
    cfg: cfgOf(),
    tcp: async () => true,
    spawnRun: async () => {
      spawned++;
      return { ok: true };
    },
  });
  assert.deepEqual({ ok: r.ok, started: r.started, port: r.port }, { ok: true, started: false, port: 9223 });
  assert.equal(spawned, 0);
});

test('ensureEdge：口子没开且关了自动起 → EDGE_NOT_RUNNING', async () => {
  const r = await ensureEdge({ cfg: cfgOf({ edgeAutostart: false }), tcp: async () => false, spawnRun: async () => ({ ok: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'EDGE_NOT_RUNNING');
});

test('ensureEdge：脚本不在 → EDGE_NO_SCRIPT，不去瞎起', async () => {
  const r = await ensureEdge({
    cfg: cfgOf({ edgeScript: path.join(os.tmpdir(), 'pg-edge-not-exist.ps1') }),
    tcp: async () => false,
    spawnRun: async () => assert.fail('脚本不存在时不该 spawn'),
  });
  assert.equal(r.reason, 'EDGE_NO_SCRIPT');
});

test('ensureEdge：口子没开 → 按脚本起 Edge，等端口通', async () => {
  const calls = [];
  let n = 0;
  const r = await ensureEdge({
    cfg: cfgOf({ edgeWaitMs: 5000 }),
    tcp: async () => {
      n++;
      return n > 1; // 第一次检查没开，spawn 之后通了
    },
    spawnRun: async (cmd, args) => {
      calls.push([cmd, args]);
      return { ok: true };
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(calls.length, 1);
  assert.ok(calls[0][1].join(' ').includes(tmpScript));
  assert.match(calls[0][1].join(' '), /-Port 9223/);
});

test('ensureEdge：起了但端口一直不通 → EDGE_START_FAILED', async () => {
  const r = await ensureEdge({
    cfg: cfgOf({ edgeWaitMs: 100 }),
    tcp: async () => false,
    spawnRun: async () => ({ ok: true }),
    sleep: async () => {},
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'EDGE_START_FAILED');
});

test('downloadVideo：Edge 起不来就不跑取数脚本，原因如实带出去', async () => {
  let fetched = 0;
  const r = await downloadVideo('7704617393389194511', {
    cfg: cfgOf({ fetchScript: 'D:/fake/fetch.mjs' }),
    ensure: async () => ({ ok: false, reason: 'EDGE_NOT_RUNNING', note: '9223 没人听' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'EDGE_NOT_RUNNING');
  assert.equal(fetched, 0);
});