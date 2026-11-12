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
  assert.equal(loaded[0].id, 'presence-gate');
  assert.equal(typeof loaded[0].factory, 'function');
});

test('client：模块导出 name/inject/apply', () => {
  const { loaded } = load();
  const mod = loaded[0].factory((name) => {
    if (name === 'react') return fakeReact();
    throw new Error('不该 require ' + name);
  });
  assert.equal(mod.name, 'presence-gate');
  // 跨 vm 边界的数组原型不同，deepEqual 会判「结构相同但不是同一个东西」→ 转一下
  assert.deepEqual(Array.from(mod.inject), ['slots']);
  assert.equal(typeof mod.apply, 'function');
});

test('client：apply 会注册 settings.section（左侧导航出现「陪伴」）', () => {
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
  assert.equal(captured.def.id, 'presence-gate');
  assert.equal(captured.def.label, '陪伴');
  assert.equal(typeof captured.def.order, 'number');

  // 样式随插件生命周期挂上去（卸载时摘）
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.pg-root/);
  assert.match(styles[0].textContent, /pg-switch/);
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
