// overlay.test.mjs —— headless overlay 里的工作目录要跟着插件实际安装位置走。
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../src/settings/config.js';
import { materializeOverlayText } from '../src/decision/llm.js';

const posixRoot = ROOT.replace(/\\/g, '/');

test('overlay：任意用户名下的插件路径都换成当前 ROOT', () => {
  const raw = "defaultDirectory: 'C:/Users/somebody/.dsh/presence-gate'\nworkspaceRoot: 'C:/Users/somebody/.dsh/presence-gate'";
  const out = materializeOverlayText(raw);
  assert.equal(out.includes('somebody'), false);
  assert.equal(out.split(posixRoot).length - 1, 2);
});

test('overlay：反斜杠写法也能认出来', () => {
  const raw = "workspaceRoot: 'C:\\Users\\somebody\\.dsh\\presence-gate'";
  const out = materializeOverlayText(raw);
  assert.equal(out.includes('somebody'), false);
  assert.equal(out.includes(posixRoot), true);
});

test('overlay：不相关的路径原样保留', () => {
  const raw = "workspaceRoot: 'C:/Users/somebody/other-project'";
  assert.equal(materializeOverlayText(raw), raw);
});