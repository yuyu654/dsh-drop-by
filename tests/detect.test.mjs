// detect.test.mjs —— 「装没装、通不通」的判定。全部在临时目录里造假 dsh 家目录，不碰真机。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { detectPlugin, detectQq, detectDouyin, detectPhone } from '../src/detect.js';

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-detect-'));
}

function installPlugin(home, name, version = '1.0.0', profile = 'desktop') {
  const dir = path.join(home, 'profiles', profile, 'node_modules', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  return dir;
}

test('插件装在任意 profile 里都能找到（只读 package.json）', () => {
  const home = tmpHome();
  assert.equal(detectPlugin('dsh-douyin-scroll', { dshHome: home }).installed, false);
  installPlugin(home, 'dsh-douyin-scroll', '2.3.4');
  const d = detectPlugin('dsh-douyin-scroll', { dshHome: home, env: {} });
  assert.equal(d.installed, true);
  assert.equal(d.version, '2.3.4');
});

test('QQ：装了但没配对 → ready=false，理由说清楚', () => {
  const home = tmpHome();
  installPlugin(home, 'dsh-plugin-qq-bridge', '0.9.1');
  const d = detectQq({ dshHome: home, env: {} });
  assert.equal(d.installed, true);
  assert.equal(d.paired, false);
  assert.equal(d.ready, false);
  assert.match(d.note, /还没配对/);
});

test('QQ：装了又配对过 → ready=true', () => {
  const home = tmpHome();
  installPlugin(home, 'dsh-plugin-qq-bridge');
  fs.mkdirSync(path.join(home, 'qq-bridge'), { recursive: true });
  fs.writeFileSync(path.join(home, 'qq-bridge', 'connection.json'), JSON.stringify({ ws: 'ws://127.0.0.1:6700', token: 'x' }));
  const d = detectQq({ dshHome: home, env: {} });
  assert.equal(d.ready, true);
  assert.match(d.note, /已配对/);
});

test('抖音：插件在但盯梢关着 → ready=false', () => {
  const home = tmpHome();
  installPlugin(home, 'dsh-douyin-scroll');
  fs.mkdirSync(path.join(home, 'douyin-duty'), { recursive: true });
  fs.writeFileSync(path.join(home, 'douyin-duty', 'chat-watch-state.json'), JSON.stringify({ on: false }));
  const off = detectDouyin({ dshHome: home, env: {} });
  assert.equal(off.installed, true);
  assert.equal(off.listening, false);
  assert.equal(off.ready, false);
  assert.match(off.note, /盯梢关着/);

  fs.writeFileSync(path.join(home, 'douyin-duty', 'chat-watch-state.json'), JSON.stringify({ on: true }));
  assert.equal(detectDouyin({ dshHome: home, env: {} }).ready, true);
});

test('手机端：账号和授权码缺一样都不算就绪', () => {
  const home = tmpHome();
  const secrets = path.join(home, 'secrets.json');
  const root = tmpHome();
  const cfg = { mail: { enabled: true, user: 'a@qq.com' } };

  assert.equal(detectPhone(cfg, { dshHome: home, secretsPath: secrets, root }).ready, false, '没授权码');

  fs.writeFileSync(secrets, JSON.stringify({ authCode: 'abcd1234' }));
  const ok = detectPhone(cfg, { dshHome: home, secretsPath: secrets, root });
  assert.equal(ok.ready, true);
  assert.match(ok.user, /a\*\*\*@qq\.com/);
  assert.equal(ok.ageMin, null, '还没有数据文件');

  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'fish-latest.json'), JSON.stringify({ at: new Date(Date.now() - 30 * 60000).toISOString() }));
  const aged = detectPhone(cfg, { dshHome: home, secretsPath: secrets, root });
  assert.ok(aged.ageMin >= 30 && aged.ageMin <= 31, `最近一封时间要算出来，实际 ${aged.ageMin}`);
});

test('手机端：邮箱开关关着 → ready=false，不去看授权码', () => {
  const home = tmpHome();
  const d = detectPhone({ mail: { enabled: false, user: 'a@qq.com' } }, { dshHome: home, secretsPath: path.join(home, 'nope.json'), root: home });
  assert.equal(d.ready, false);
  assert.match(d.note, /邮箱没开/);
});