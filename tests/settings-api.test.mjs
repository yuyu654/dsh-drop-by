// settings-api.test.mjs —— 设置页那条 HTTP 写口：读得到、写进去、非法值写不进去。
//
// 关键是**不能碰真实配置**：config.js 允许 PG_CONFIG_PATH / PG_STATE_PATH 顶掉路径，
// 这里指到临时目录；同时前后比对仓库里的 config.json 没被动过。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_CONFIG = path.join(ROOT, 'config.json');
const realHashBefore = (() => {
  try {
    return createHash('sha1').update(fs.readFileSync(REAL_CONFIG)).digest('hex');
  } catch {
    return null;
  }
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-settings-'));
const cfgPath = path.join(tmp, 'config.json');
fs.writeFileSync(
  cfgPath,
  JSON.stringify({ enabled: true, dryRun: true, tickMinutes: 10, send: { enabled: false }, rules: { dailyCap: 3 } }, null, 2)
);

process.env.PG_CONFIG_PATH = cfgPath;
process.env.PG_STATE_PATH = path.join(tmp, 'state.json');
process.env.PG_SECRETS_PATH = path.join(tmp, 'credentials.json');

// 环境变量必须在 import 之前设好（config.js 在模块加载时算路径）
const { apply } = await import('../src/plugin.js');

function fakeCtx() {
  let route = null;
  const ctx = {
    get(k) {
      if (k === 'logger') return { info() {}, warn() {}, error() {} };
      if (k === 'webServer') return { register(r) { route = r; return () => {}; } };
      return null;
    },
    effect(fn) {
      const d = fn();
      return () => (typeof d === 'function' ? d() : undefined);
    },
    set() {},
    on() {},
  };
  return { ctx, routeOf: () => route };
}

/** 造一个够用的 req/res，把 handler 的响应读回来。 */
function call(route, { method = 'GET', url, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  req.headers = {};

  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(s) {
      this.body = s || '';
    },
  };
  return route.handler(req, res).then(() => ({
    status: res.statusCode,
    headers: res.headers,
    json: (() => {
      try {
        return JSON.parse(res.body);
      } catch {
        return null;
      }
    })(),
  }));
}

test('设置口：读、写、拒绝、以及不碰真配置', async (t) => {
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const { ctx, routeOf } = fakeCtx();
  const api = apply(ctx, { enabled: false, startupDelaySec: 3600, tool: false });
  t.after(() => api.stop());

  const route = routeOf();
  assert.ok(route, 'statusApi 默认开着，应该注册了路由');
  assert.equal(route.path, '/api/presence-gate');

  // ---- 读
  const got = await call(route, { url: '/api/presence-gate/config' });
  assert.equal(got.status, 200);
  assert.equal(got.json.ok, true);
  const groups = got.json.groups;
  assert.equal(groups.length, 6); // 日常/节奏/说什么/数据从哪来/课表与考试/高级（后两组折成一个模块）
  // 感知那三层的开关和间隔要能看能改
  const flat0 = groups.flatMap((g) => g.items);
  for (const p of ['idle.onlineSec', 'idle.awaySec', 'perception.l2.enabled', 'perception.l3.enabled']) {
    assert.ok(flat0.some((i) => i.path === p), `设置页应该列出 ${p}`);
  }
  // L3 默认关着，它的「多久看一次」跟父开关走：关着不显示，开了才出来
  assert.ok(!flat0.some((i) => i.path === 'perception.l3.everyMin'));
  const l3 = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'perception.l3.enabled', value: true } });
  assert.ok(l3.json.groups.flatMap((g) => g.items).some((i) => i.path === 'perception.l3.everyMin'), 'L3 开了以后间隔要出现');
  const flat = groups.flatMap((g) => g.items);
  const tick = flat.find((i) => i.path === 'tickMinutes');
  assert.equal(tick.value, 10);
  // 邮箱那组要出现；但授权码只给「未设置」，值必须是空的
  const auth0 = flat.find((i) => i.path === 'mail.authCode');
  assert.equal(auth0.type, 'secret');
  assert.equal(auth0.value, '');
  assert.equal(auth0.display, '未设置');
  assert.equal(JSON.stringify(got.json).includes('authCode":"ab'), false, '授权码原值不能出现在响应里');

  // ---- 写：数字
  const saved = await call(route, {
    method: 'POST',
    url: '/api/presence-gate/config',
    body: { path: 'tickMinutes', value: 15 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.ok, true);
  assert.equal(saved.json.path, 'tickMinutes');
  assert.equal(saved.json.value, 15);
  // 返回的新清单里也是 15（界面直接用它重渲染）
  assert.equal(saved.json.groups.flatMap((g) => g.items).find((i) => i.path === 'tickMinutes').value, 15);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).tickMinutes, 15, '应该真的落盘了');
  // 别的键没被抹掉
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).rules.dailyCap, 3);

  // ---- 写：布尔 + 一句提醒
  const send = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'send.enabled', value: true } });
  assert.equal(send.json.ok, true);
  assert.equal(send.json.notes.length, 1);
  assert.match(send.json.notes[0], /演练模式/);

  // ---- 写：时段（界面传的是文本）
  const quiet = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'quietHours', value: '23:00-07:00' } });
  assert.equal(quiet.json.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).quietHours, [['23:00', '07:00']]);

  // ---- 写：凭据（进 credentials.json，不进 config.json，响应里也不回显）
  const cred = await call(route, {
    method: 'POST',
    url: '/api/presence-gate/config',
    body: { path: 'mail.authCode', value: 'abcd1234efgh5678' },
  });
  assert.equal(cred.json.ok, true);
  assert.equal(cred.json.secret, true);
  assert.equal(cred.json.value, '', '响应里不能把授权码吐回来');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'credentials.json'), 'utf8')).authCode, 'abcd1234efgh5678');
  assert.equal(fs.readFileSync(cfgPath, 'utf8').includes('abcd1234efgh5678'), false, '授权码不能进 config.json');
  const afterAuth = cred.json.groups.flatMap((g) => g.items).find((i) => i.path === 'mail.authCode');
  assert.equal(afterAuth.display, '已设置');
  assert.equal(afterAuth.value, '');

  // ---- 写：邮箱账号（不是凭据，正常落 config.json）
  const user = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'mail.user', value: '123456@qq.com' } });
  assert.equal(user.json.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mail.user, '123456@qq.com');

  // ---- 拒：不在白名单（IMAP 端口/加密这类不给界面动）
  const denied = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'mail.tls', value: false } });
  assert.equal(denied.json.ok, false);
  assert.match(denied.json.error, /不开放修改/);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).mail.tls, true, '被拒的值绝不能写进文件（还该是默认的 true）');

  // ---- 拒：值越界
  const tooBig = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: { path: 'tickMinutes', value: 999 } });
  assert.equal(tooBig.json.ok, false);
  assert.equal(JSON.parse(fs.readFileSync(cfgPath, 'utf8')).tickMinutes, 15, '越界值不该覆盖旧值');

  // ---- 拒：请求体不是 JSON / 没 path
  const badJson = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: 'not json' });
  assert.equal(badJson.json.ok, false);
  const noPath = await call(route, { method: 'POST', url: '/api/presence-gate/config', body: {} });
  assert.equal(noPath.json.ok, false);
  assert.match(noPath.json.error, /缺 path/);

  // ---- 方法不对 → 404（不是 500）
  const wrongMethod = await call(route, { method: 'GET', url: '/api/presence-gate/config2' });
  assert.equal(wrongMethod.status, 404);

  // ---- 真配置没被动过
  if (realHashBefore) {
    const after = createHash('sha1').update(fs.readFileSync(REAL_CONFIG)).digest('hex');
    assert.equal(after, realHashBefore, '测试不该改到仓库里的 config.json');
  }
});
