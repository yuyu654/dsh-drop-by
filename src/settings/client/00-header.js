/**
 * dsh-drop-by —— 浏览器半侧（手写的 __ModuleLoader__ bundle，不需要构建工具）。
 *
 * 注册一个「陪伴」设置页（slot: settings.section）。这一页只干两件事：
 *   1. 让人**看得见**它现在什么状态：开没开、演练还是真发、上一拍判了什么、今天发了几条、
 *      用的是宿主哪个模型、下一次什么时候醒；
 *   2. 让人**改得动**参数：运行 / 节奏 / 内容 / 由头四组，改完立刻写 config.json，
 *      下一拍生效（宿主每拍都重新读盘，不用重启）。
 *
 * 两条设计约束：
 *   · **参数表在宿主侧**（src/settings.js），这里只按表通用渲染。加一个参数不用动这个文件，
 *     而且界面上永远不会出现凭据、CLI 路径这些不该暴露的键。
 *   · **不自己糊弹层**：走 settings.section，跟别的插件一样出现在设置左侧导航里。
 *
 * 与宿主只走同源 HTTP（/api/dsh-drop-by/*），不用 RPC —— 少一条可能断的链路。
 * 修改后 `node --check src/client.js` 验语法（它是脚本，check 只解析不执行）。
 */

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({
    id: '@joshin/dsh-drop-by',
    factory: function (require) {
      var module = { exports: {} };
      var React = require('react');
      var h = React.createElement;
      var useState = React.useState;
      var useEffect = React.useEffect;
      var useCallback = React.useCallback;
      var useRef = React.useRef;

      var API = '/api/dsh-drop-by';
      var NS = 'dsh-drop-by';

