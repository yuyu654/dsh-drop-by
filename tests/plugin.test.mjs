// plugin.test.mjs —— 插件壳：能不能激活、会不会挂钟、状态接口与工具挂得上不上。
//
// 刻意**不跑真的一拍**：tick() 会读真配置、探真机、连真邮箱。这里只测壳的行为
// （所有会碰磁盘的路径都走 enabled:false 或走 webServer 的假对象）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../src/plugin.js';

function fakeCtx(services = {}) {
  const disposers = [];
  const registered = { routes: [], tools: [] };
  const svc = {
    logger: { info() {}, warn() {}, error() {} },
    ...services,
  };
  const ctx = {
    disposers,
    registered,
    get: (k) => svc[k] ?? null,
    effect(fn) {
      const d = fn();
      if (typeof d === 'function') disposers.push(d);
      return () => {};
    },
    set() {},
    on() {},
  };
  return ctx;
}

test('插件声明：裸包名 + 不声明任何硬依赖', () => {
  assert.equal(name, 'presence-gate');
  assert.deepEqual(inject, []);
});

test('apply：返回 api，起钟后 nextAt 有值，stop 后清掉', () => {
  const ctx = fakeCtx();
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false, statusApi: false });
  try {
    assert.equal(typeof api.runOnce, 'function');
    assert.equal(typeof api.snapshot, 'function');
    const s = api.snapshot();
    assert.equal(s.plugin, 'presence-gate');
    assert.equal(s.enabled, false);
    assert.ok(s.nextAt, '应该已经排了第一拍');
    assert.equal(s.ticks, 0);
  } finally {
    api.stop();
  }
  assert.equal(api.snapshot().nextAt, null, 'stop 之后不该还有下一拍');
});

test('runOnce：enabled=false 直接跳过，不去跑判定', async () => {
  const ctx = fakeCtx();
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false, statusApi: false });
  try {
    const r = await api.runOnce('test');
    assert.equal(r.ok, false);
    assert.equal(r.skipped, 'disabled');
    assert.equal(api.snapshot().ticks, 0);
  } finally {
    api.stop();
  }
});

test('状态接口：挂在 /api/presence-gate，GET /state 返回 JSON', async () => {
  let route = null;
  const ctx = fakeCtx({ webServer: { register: (r) => ((route = r), () => {}) } });
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false });
  try {
    assert.ok(route, 'webServer.register 应该被调用');
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/api/presence-gate');

    let body = '';
    const res = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(s) {
        body = s;
      },
    };
    await route.handler({ url: '/api/presence-gate/state', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(body);
    assert.equal(json.plugin, 'presence-gate');
    assert.equal(json.tickMinutes > 0, true);
    assert.ok('dryRun' in json);

    // 不认识的路径要 404，而不是抛
    await route.handler({ url: '/api/presence-gate/nope', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 404);
    // tick 只认 POST
    await route.handler({ url: '/api/presence-gate/tick', method: 'GET', headers: {} }, res);
    assert.equal(res.statusCode, 404);
  } finally {
    api.stop();
  }
});

test('工具：能挂上 presence_status（拿不到 dsh-tools 就用等价实现）', async () => {
  const ctx = fakeCtx();
  ctx.registered.tools = [];
  ctx.get = ((orig) => (k) =>
    k === 'tools'
      ? { register: (t) => (ctx.registered.tools.push(t), () => {}) }
      : orig(k))(ctx.get);

  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, statusApi: false });
  try {
    // 工具注册是异步的（要动态 import defineTool），给它一拍时间
    for (let i = 0; i < 50 && ctx.registered.tools.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const tool = ctx.registered.tools[0];
    assert.ok(tool, 'presence_status 应该挂上');
    assert.equal(tool.name, 'presence_status');
    assert.deepEqual(Object.keys(tool.parameters), ['action']);
    assert.equal(tool.parameters.action.enum.includes('tick'), true);
    const watch = ctx.registered.tools.find((t) => t.name === 'presence_watch_video');
    assert.ok(watch, 'presence_watch_video 应该挂上');
    assert.deepEqual(await watch.execute({ id: '7703237248204000521' }), { ok: false, reason: 'FORWARD_DISABLED' });

    // status 分支不能真的跑判定（enabled=false，tick 会返回 skipped）
    const out = await tool.execute({ action: 'tick' });
    assert.equal(out.ok, false);
    assert.equal(out.result.skipped, 'disabled');
  } finally {
    api.stop();
  }
});

test('dispose：ctx.effect 的清理函数会把钟停掉', () => {
  const ctx = fakeCtx();
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false, statusApi: false });
  assert.equal(ctx.disposers.length, 1);
  ctx.disposers[0]();
  assert.equal(api.snapshot().nextAt, null);
});

// 2026-11-04：apply 跑的那一刻 webServer / tools 还没 provide，直接 ctx.get 只会拿到 null，
// 结果设置页永远 404、presence_status 永远不在工具表里。必须走 ctx.inject 等就绪。
test('状态接口：webServer 晚一步就绪也能挂上（ctx.inject 延迟注入）', () => {
  let pending = null;
  const ctx = fakeCtx();
  ctx.inject = (deps, cb) => {
    pending = { deps, cb };
    return { dispose() {} };
  };
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false });
  try {
    assert.deepEqual(pending && pending.deps, ['webServer'], '应该向 cordis 申请 webServer');
    assert.equal(ctx.registered.routes.length, 0, '服务没就绪时不该假装挂上了');

    let route = null;
    pending.cb(fakeCtx({ webServer: { register: (r) => ((route = r), () => {}) } }));
    assert.ok(route, '服务就绪后回调里要真的注册路由');
    assert.equal(route.path, '/api/presence-gate');
  } finally {
    api.stop();
  }
});

test('工具：必须声明 output（DSH 的 tools.register 缺了直接 TypeError）', async () => {
  const ctx = fakeCtx();
  ctx.registered.tools = [];
  Object.defineProperty(ctx, 'get', {
    value: (k) =>
      k === 'tools' ? { register: (t) => (ctx.registered.tools.push(t), () => {}) } : null,
  });
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, statusApi: false });
  try {
    for (let i = 0; i < 50 && ctx.registered.tools.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const tool = ctx.registered.tools[0];
    assert.ok(tool, '工具应该注册上了');
    assert.equal(typeof tool.output, 'object');
    assert.equal(tool.output.schema.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
    const parts = tool.output.render({}, { ok: true });
    assert.equal(parts[0].type, 'text');
  } finally {
    api.stop();
  }
});
