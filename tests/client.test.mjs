// client.test.mjs —— 浏览器半侧的"能不能装上去"。
//
// 不引真实 React（宿主的模块表里才有），用一个够用的假 React：
//   · 函数组件**立即执行**，所以能真的跑到 Panel 的渲染分支；
//   · class 组件不执行（只建元素）——ErrorBoundary 靠 componentDidCatch，测试里不触发；
//   · hooks 给稳定值，useEffect 不执行（不联网）。
// 这样验的是：模块结构对不对、settings.section 注册得对不对、首屏能不能渲染出来。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function fakeReact() {
  const React = {
    createElement(type, props, ...children) {
      const p = Object.assign({}, props || {}, { children: children.length <= 1 ? children[0] : children });
      const el = { type: type, props: p };
      // 函数组件立即执行（class 组件有 prototype.render，跳过）
      if (typeof type === 'function' && !(type.prototype && type.prototype.render)) {
        return type(p);
      }
      return el;
    },
    Component: class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(s) {
        this.state = Object.assign({}, this.state, typeof s === 'function' ? s(this.state) : s);
      }
    },
    useState(init) {
      return [typeof init === 'function' ? init() : init, function () {}];
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
    useRef(v) {
      return { current: v };
    },
    useMemo(fn) {
      return fn();
    },
  };
  return React;
}

/** 把渲染出来的树里的文字拼起来（假 React 给的是普通对象）。 */
function textOf(node) {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.props) return textOf(node.props.children);
  return '';
}

function load() {
  const loaded = [];
  const styles = [];
  const document = {
    getElementById: () => null,
    createElement: (tag) => ({ tag: tag, textContent: '', id: '' }),
    head: {
      appendChild: (el) => styles.push(el),
    },
  };
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => loaded.push(spec) } },
    document: document,
    fetch: () => Promise.reject(new Error('测试不该发请求')),
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    setInterval: setInterval,
    clearInterval: clearInterval,
    Date: Date,
    JSON: JSON,
    Math: Math,
    String: String,
    Number: Number,
    Array: Array,
    Object: Object,
    Promise: Promise,
    isNaN: isNaN,
  };
  sandbox.globalThis = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/client.js'), 'utf8'), sandbox, { filename: 'client.js' });
  return { loaded, styles, sandbox };
}

test('client：自注册一个 id = 包名的模块', () => {
  const { loaded } = load();
  assert.equal(loaded.length, 1, '文件应该调一次 __ModuleLoader__.load');
  assert.equal(loaded[0].id, PKG.name);
  assert.equal(typeof loaded[0].factory, 'function');
});

test('client：模块导出 name/inject/apply', () => {
  const { loaded } = load();
  const mod = loaded[0].factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error('不该 require ' + name);
  });
  assert.equal(mod.name, 'dsh-drop-by');
  // 跨 vm 边界的数组原型不同，deepEqual 会判「结构相同但不是同一个东西」→ 转一下
  assert.deepEqual(Array.from(mod.inject), ['slots']);
  assert.equal(typeof mod.apply, 'function');
});

test('client：apply 会注册 settings.section（左侧导航出现 dsh-drop-by）', () => {
  const { loaded, styles } = load();
  const mod = loaded[0].factory(() => fakeReact());

  let captured = null;
  const slots = {
    inject(name, cb) {
      // 先建 captured 再调 cb：cb 里会同步调 register 往 captured 上写
      captured = { name: name };
      captured.dispose = cb();
      return () => {};
    },
    register(def, render) {
      captured.def = def;
      captured.render = render;
      return () => {};
    },
  };
  const ctx = {
    get: (k) => (k === 'slots' ? slots : null),
    effect: (fn) => {
      const d = fn();
      return () => (typeof d === 'function' ? d() : undefined);
    },
  };

  mod.apply(ctx);

  assert.ok(captured, 'slots.inject 应该被调用');
  assert.equal(captured.name, 'settings.section');
  assert.equal(captured.def.name, 'settings.section');
  assert.equal(captured.def.id, 'dsh-drop-by');
  assert.equal(captured.def.label, '陪伴');
  assert.equal(typeof captured.def.order, 'number');

  // 样式随插件生命周期挂上去（卸载时摘）
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.pg-root/);
  assert.match(styles[0].textContent, /pg-switch/);
  assert.doesNotMatch(styles[0].textContent, /\.pg-alert\{[^}]*position\s*:\s*sticky/);
});

test('client：首屏能渲染（还没拿到数据时显示「读状态…」）', () => {
  const { loaded } = load();
  const mod = loaded[0].factory(() => fakeReact());

  let render = null;
  const slots = {
    inject: (name, cb) => {
      cb();
      return () => {};
    },
    register: (def, r) => {
      render = r;
      return () => {};
    },
  };
  mod.apply({ get: (k) => (k === 'slots' ? slots : null), effect: (fn) => fn() });

  assert.equal(typeof render, 'function');
  const tree = render({ sessionId: 's1' });
  assert.match(textOf(tree), /读状态/);
});

function elements(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate));
  if (!node?.props) return [];
  return [...(predicate(node) ? [node] : []), ...elements(node.props.children, predicate)];
}

function mountPanel(loaded) {
  let render;
  const hookValues = [];
  const hookDeps = new Map();
  let cursor = 0;
  const React = fakeReact();
  React.useState = init => {
    const index = cursor++;
    if (!(index in hookValues)) hookValues[index] = typeof init === 'function' ? init() : init;
    return [hookValues[index], value => { hookValues[index] = typeof value === 'function' ? value(hookValues[index]) : value; }];
  };
  React.useRef = init => {
    const index = cursor++;
    return hookValues[index] ||= { current: init };
  };
  React.useEffect = (effect, deps) => {
    const index = cursor++;
    const prev = hookDeps.get(index);
    if (!prev || deps.some((value, i) => value !== prev[i])) {
      hookDeps.set(index, deps);
      effect();
    }
  };
  const mod = loaded[0].factory(() => React);
  const slots = { inject: (_, register) => register(), register: (_, fn) => { render = fn; } };
  mod.apply({ get: () => slots, effect: fn => fn() });
  const draw = () => { cursor = 0; return render({}); };
  return draw;
}

test('引导首次自动展开、收起可记住、自检只显示一套结果，试跑发 preview', async () => {
  const { loaded, sandbox } = load();
  const calls = [];
  const stored = new Map();
  const state = { enabled: true, dryRun: true, tickMinutes: 10, today: {}, send: {} };
  const items = [{ key: 'channel', label: 'QQ 主通道', level: 'ok', detail: '已配对并绑定。' }];
  sandbox.window.localStorage = {
    getItem: key => stored.get(key),
    setItem: (key, value) => stored.set(key, value),
    removeItem: key => stored.delete(key),
  };
  sandbox.setInterval = () => 1;
  const bodies = {
    '/state': state, '/config': { groups: [] },
    '/diagnostics': { guideRecommended: true, items, alerts: [], reports: [], slots: [] },
    '/connectivity': { ok: true, items },
    '/tick': { ok: true, run: { text: '模拟草稿', llm: { provider: '测试', model: '模型' },
      explanation: { summary: '已生成草稿。', detail: '命中由头：随口话。', actionHint: '' } } },
  };
  sandbox.fetch = async (url, options) => {
    const endpoint = url.replace('/api/dsh-drop-by', '');
    calls.push([endpoint, options?.body]);
    return { ok: true, text: async () => JSON.stringify(bodies[endpoint]) };
  };

  const draw = mountPanel(loaded);
  const flush = () => new Promise(setImmediate);
  const button = (tree, label) => elements(tree, el => el.type === 'button' && textOf(el).includes(label))[0];

  draw();
  await flush();
  draw();
  await flush();
  let tree = draw();
  assert.ok(button(tree, '试跑一次'));
  assert.equal(elements(tree, el => el.type === 'details' && textOf(el).includes('近期日报与接住率'))[0].props.open, undefined);
  assert.equal(elements(tree, el => el.type === 'aside').length, 0);

  button(tree, '快速引导与自检').props.onClick();
  assert.equal(stored.get('dsh-drop-by:guide-closed'), '1');
  tree = draw();
  assert.equal(button(tree, '试跑一次'), undefined);
  button(tree, '使用引导 / 自检').props.onClick();
  assert.equal(stored.has('dsh-drop-by:guide-closed'), false);

  button(draw(), '检查连通状态').props.onClick();
  await flush();
  tree = draw();
  assert.equal(textOf(tree).split('已配对并绑定。').length - 1, 1);
  button(tree, '试跑一次').props.onClick();
  await flush();
  assert.deepEqual(calls.find(([endpoint]) => endpoint === '/tick'), ['/tick', '{"preview":true}']);
  assert.match(textOf(draw()), /模拟草稿.*命中由头：随口话.*测试 \/ 模型/);
});

test('点击接住率胶囊查看明细，勾选未回并可撤销标记', async () => {
  const { loaded, sandbox } = load();
  const calls = [];
  let marked = false;
  const slot = () => ({ slot: 'sleep', label: '睡眠', sent: 2, replied: marked ? 2 : 1, rate: marked ? 1 : 0.5,
    unlistedMisses: 3,
    receipts: [{ id: 'pending', at: '11-23日 16:10', received: null, status: 'pending' },
      { id: 'auto', at: '11-22日 16:10', received: true, manual: false },
      { id: 'miss', at: '11-22日 11:10', received: marked, manual: marked },
      { id: 'unknown', at: '11-21日 09:10', received: null, status: 'unknown' }] });
  sandbox.setInterval = () => 1;
  sandbox.fetch = async (url, options) => {
    const endpoint = url.replace('/api/dsh-drop-by', '');
    const bodies = {
      '/state': { enabled: true, dryRun: true, tickMinutes: 10, today: {}, send: {} },
      '/config': { groups: [] },
      '/diagnostics': { guideRecommended: false, chitchat: { todayCount: 2, effectivePerDay: 5, configuredPerDay: 5, why: '最近 15 条接住了 15 条' }, slots: [slot()] },
    };
    if (endpoint === '/feedback/receipt') {
      const body = JSON.parse(options.body);
      calls.push(body);
      marked = body.received;
      bodies[endpoint] = { ok: true, slots: [slot()] };
    }
    return { ok: true, text: async () => JSON.stringify(bodies[endpoint]) };
  };
  const draw = mountPanel(loaded);
  const flush = () => new Promise(setImmediate);
  const checkboxes = tree => elements(tree, el => el.type === 'input' && el.props.type === 'checkbox');
  const button = (tree, label) => elements(tree, el => el.type === 'button' && textOf(el).includes(label))[0];

  draw();
  await flush();
  draw();
  await flush();
  let tree = draw();
  assert.match(textOf(tree), /随口话今日已发 2 \/ 5 条/);
  assert.doesNotMatch(textOf(tree), /11-22日/);
  const chip = button(tree, '1 / 2 条');
  assert.equal(chip?.props['aria-expanded'], false);
  chip.props.onClick();
  tree = draw();
  assert.equal(button(tree, '1 / 2 条').props['aria-expanded'], true);
  assert.match(textOf(tree), /11-23日 16:10待判定.*11-22日 16:10接住.*11-22日 11:10未回.*11-21日 09:10结果未记录/);
  assert.match(textOf(tree), /另有 3 条未回仅有汇总/);
  assert.equal(checkboxes(tree).length, 1);
  checkboxes(tree)[0].props.onChange({ target: { checked: true } });
  await flush();
  tree = draw();
  assert.ok(button(tree, '2 / 2 条'));
  assert.match(textOf(tree), /11-22日 11:10接住（手动）/);
  assert.equal(checkboxes(tree).length, 0);
  button(tree, '撤销').props.onClick();
  await flush();
  tree = draw();
  assert.ok(button(tree, '1 / 2 条'));
  assert.equal(checkboxes(tree).length, 1);
  assert.deepEqual(calls, [{ slot: 'sleep', id: 'miss', received: true }, { slot: 'sleep', id: 'miss', received: false }]);
});

test('小本本划掉和原探索卡片的轻互动向对应路由提交', async () => {
  const { loaded, sandbox } = load();
  let agreement = true, candidate = true, action = '';
  const calls = [];
  sandbox.setInterval = () => 1;
  const state = () => ({ enabled: true, today: {},
    agreements: { enabled: true, timezone: 'Asia/Shanghai', items: agreement
      ? [{ id: 'agenda-id', title: '带资料开会', dueAt: Date.parse('2026-11-22T19:00:00+08:00') }] : [] },
    exploration: { thread: { topic: '古典吉他', progress: '试过新指法' },
      feedback: { enabled: true, entries: [{ kind: 'thread', id: 'thread-id', topic: '古典吉他', action }],
        candidates: candidate ? [{ id: 'candidate-id', topic: '小提琴', source: 'forward' }] : [] } },
  });
  sandbox.fetch = async (url, options) => {
    const endpoint = url.replace('/api/dsh-drop-by', '');
    let body = endpoint === '/state' ? state() : { groups: [] };
    if (options?.body) {
      const value = JSON.parse(options.body);
      calls.push([endpoint, value]);
      if (endpoint === '/agreements/dismiss') agreement = false;
      else if (value.action === 'delete') candidate = false;
      else action = value.action;
      body = { ok: true, state: state() };
    }
    return { ok: true, text: async () => JSON.stringify(body) };
  };
  const draw = mountPanel(loaded);
  const flush = () => new Promise(setImmediate);
  const button = (tree, label) => elements(tree, el => el.type === 'button' && textOf(el) === label)[0];
  draw();
  await flush();
  draw();
  await flush();
  let tree = draw();
  assert.match(textOf(tree), /约定小本本.*带资料开会.*近期好奇候选/);
  button(tree, '划掉').props.onClick();
  await flush();
  tree = draw();
  assert.doesNotMatch(textOf(tree), /带资料开会/);
  button(tree, '换个方向').props.onClick();
  await flush();
  tree = draw();
  assert.equal(button(tree, '换个方向').props['aria-pressed'], true);
  button(tree, '删除').props.onClick();
  await flush();
  assert.doesNotMatch(textOf(draw()), /近期好奇候选/);
  assert.deepEqual(calls, [
    ['/agreements/dismiss', { id: 'agenda-id' }],
    ['/exploration/feedback', { id: 'thread-id', action: 'change' }],
    ['/exploration/feedback', { id: 'candidate-id', action: 'delete' }],
  ]);
});
