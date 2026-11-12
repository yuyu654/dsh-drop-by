// persona.test.mjs —— 人格来源优先级。每个用例用独立的临时 DSH_HOME，互不干扰。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPersona, personaPlan, dshHome } from '../src/persona.js';

function tmpHome(files = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-persona-'));
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(home, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  return home;
}

/** 每个用例一个独立的本地兜底文件，避免互相踩。 */
function localFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-local-'));
  return path.join(dir, 'persona.md');
}

const cfgOf = (home, over = {}) => ({
  persona: { enabled: true, dshHome: home, includeGlobal: true, includeProject: false, localFile: localFile(), ...over },
});

test('dshHome：配置优先，其次环境变量，最后 ~/.dsh', () => {
  const home = tmpHome();
  assert.equal(dshHome(cfgOf(home)), home);
  delete process.env.DSH_HOME;
  assert.ok(dshHome({}).endsWith('.dsh'));
});

test('有插件的 AGENT.md → 用它（kind=plugin）', () => {
  const home = tmpHome({ 'AGENT.md': '# 我是谁\n说话短。\n' });
  const p = loadPersona({ cfg: cfgOf(home), force: true });
  assert.equal(p.kind, 'plugin');
  assert.equal(p.ok, true);
  assert.match(p.text, /说话短/);
  assert.deepEqual(p.sources.map((s) => s.kind), ['plugin-global']);
});

test('插件总开关关掉就不读 AGENT.md，并在说明里讲清楚', () => {
  const home = tmpHome({ 'AGENT.md': '# 人格\n不该被读到\n', 'agent-md.json': JSON.stringify({ enabled: false }) });
  const p = loadPersona({ cfg: cfgOf(home), force: true });
  assert.notEqual(p.kind, 'plugin');
  assert.ok(!p.text.includes('不该被读到'));
  assert.match(p.note, /总开关是关的/);
});

test('没装插件但自己写了 persona.md → 用自己那份', () => {
  const home = tmpHome();
  const local = localFile();
  fs.writeFileSync(local, '# 我自己的口吻\n别客套。\n', 'utf8');
  const p = loadPersona({ cfg: cfgOf(home, { localFile: local }), force: true });
  assert.equal(p.kind, 'local');
  assert.match(p.text, /别客套/);
  assert.match(p.note, /没找到 dsh-agent-md/);
});

test('什么都没有 → 内置兜底，并告知路径', () => {
  const home = tmpHome();
  const local = localFile();
  const p = loadPersona({ cfg: cfgOf(home, { localFile: local }), force: true });
  assert.equal(p.kind, 'builtin');
  assert.equal(p.ok, false);
  assert.match(p.text, /像发消息，不像客服/);
  assert.match(p.note, /内置兜底/);
});

test('persona.enabled=false → 不注入任何文件，用内置最小规则', () => {
  const home = tmpHome({ 'AGENT.md': '# 人格\n不该被读到\n' });
  const p = loadPersona({ cfg: cfgOf(home, { enabled: false }), force: true });
  assert.ok(!p.text.includes('不该被读到'));
  assert.equal(p.kind, 'builtin');
});

test('项目人格：projects.json 里登记的路径会被拼在全局后面', () => {
  const home = tmpHome({
    'AGENT.md': '# 全局\n底座。\n',
    'agents/projects/dev-x.md': '# 项目\n这个仓库里你是维护者。\n',
    'agents/projects.json': JSON.stringify({
      version: 1,
      projects: [{ key: 'c:/work/dev', cwd: 'C:\\work\\dev', path: path.join(os.tmpdir(), 'PLACEHOLDER') }],
    }),
  });
  // 用真实临时目录改写索引，避免路径不存在
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cwd-'));
  const projFile = path.join(home, 'agents', 'projects', 'dev-x.md');
  fs.writeFileSync(
    path.join(home, 'agents', 'projects.json'),
    JSON.stringify({ version: 1, projects: [{ key: cwd.toLowerCase(), cwd, path: projFile }] }),
    'utf8'
  );
  const p = loadPersona({ cfg: cfgOf(home, { includeProject: true, projectCwd: cwd }), force: true });
  assert.equal(p.kind, 'plugin');
  assert.deepEqual(p.sources.map((s) => s.kind), ['plugin-global', 'plugin-project']);
  assert.match(p.text, /维护者/);
});

test('项目内 AGENT.md 优先级高于 agents/projects 里那份', () => {
  const home = tmpHome({ 'AGENT.md': '# 全局\n底座\n' });
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-cwd2-'));
  fs.writeFileSync(path.join(cwd, 'AGENT.md'), '# 项目内\n跟着仓库走的\n', 'utf8');
  const p = loadPersona({ cfg: cfgOf(home, { includeProject: true, projectCwd: cwd }), force: true });
  assert.ok(p.sources.some((s) => s.path === path.join(cwd, 'AGENT.md')));
  assert.match(p.text, /跟着仓库走/);
});

test('personaPlan：列出四类候选与存在性', () => {
  const home = tmpHome({ 'AGENT.md': '# 人格\n' });
  const plan = personaPlan(cfgOf(home), '');
  assert.equal(plan.home, home);
  assert.equal(plan.rows.length, 4);
  assert.equal(plan.rows.find((r) => r.label.includes('全局')).exists, true);
  // 有 AGENT.md 就算「插件人格可用」，哪怕 agent-md.json 不存在（那是插件的默认态）
  assert.ok(plan.plugin, '有 AGENT.md 时不该判成没插件');
  assert.equal(plan.plugin.enabled, true);
});
