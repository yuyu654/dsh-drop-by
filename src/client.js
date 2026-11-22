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

      // ------------------------------------------------------------ 取数

      function readJson(res) {
        return res.text().then(function (text) {
          var data = null;
          try {
            data = text === '' ? null : JSON.parse(text);
          } catch (e) {
            data = null;
          }
          if (!res.ok) {
            var msg = data && data.error ? data.error : 'HTTP ' + res.status;
            var err = new Error(msg);
            err.status = res.status;
            err.body = data;
            throw err;
          }
          return data;
        });
      }

      var BRIDGE_API = '/dsh-qq-bridge';

      function apiGet(path) {
        return fetch(API + path, { cache: 'no-store' }).then(readJson);
      }

      function apiPost(path, body) {
        return fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }).then(readJson);
      }

      function bridgeGet(path) {
        return fetch(BRIDGE_API + path, { cache: 'no-store' }).then(readJson);
      }

      function bridgePost(path, payload) {
        return fetch(BRIDGE_API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        }).then(readJson);
      }

      function apiSave(payload) {
        return fetch(API + '/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(readJson);
      }

      // ------------------------------------------------------------ 小工具

      function clockOf(iso) {
        if (typeof iso !== 'string' || iso === '') return '—';
        var d = new Date(iso);
        if (isNaN(d.getTime())) return '—';
        var now = new Date();
        var pad = function (x) {
          return x < 10 ? '0' + x : String(x);
        };
        var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
        var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        return sameDay ? hm : pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + hm;
      }

      function secLabel(ms) {
        var s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
        if (s < 60) return s + ' 秒';
        var m = Math.floor(s / 60);
        if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
        return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
      }

      function untilLabel(iso) {
        if (typeof iso !== 'string' || iso === '') return '—';
        var t = new Date(iso).getTime();
        if (isNaN(t)) return '—';
        var diff = t - Date.now();
        if (diff <= 0) return '马上';
        return clockOf(iso) + '（' + secLabel(diff) + '后）';
      }

      var DECISION_TEXT = { send: '发了', skip: '没发' };

      // ------------------------------------------------------------ 控件

      /** 数字/文本输入：本地草稿，失焦或回车才提交（别每敲一个字就写一次盘）。 */
      function DraftInput(props) {
        var item = props.item;
        var [draft, setDraft] = useState(String(props.value == null ? '' : props.value));
        var [focus, setFocus] = useState(false);
        useEffect(
          function () {
            if (!focus) setDraft(String(props.value == null ? '' : props.value));
          },
          [props.value, focus]
        );

        var commit = function () {
          if (String(props.value) === String(draft)) return;
          props.onSave(item.path, draft);
          // 凭据存进去之后就清空输入框（服务端不会把值读回来，留着只会像没保存）
          if (item.type === 'secret') setDraft('');
        };

        // 多行文本（课表）：回车不提交，失焦才存；整张表粘进来就行
        if (item.type === 'text') {
          return h('textarea', {
            className: 'pg-input pg-textarea',
            rows: item.rows || 6,
            value: draft,
            disabled: props.busy,
            onFocus: function () { setFocus(true); },
            onChange: function (e) { setDraft(e.target.value); },
            onBlur: function () { setFocus(false); commit(); },
            onKeyDown: function (e) {
              if (e.key === 'Escape') {
                setDraft(String(props.value == null ? '' : props.value));
                e.target.blur();
              }
            },
          });
        }
        var wide = item.type === 'str' || item.type === 'secret' || item.type === 'windows';
        return h('input', {
          className: 'pg-input' + (wide ? ' pg-input-wide' : ''),
          type: item.type === 'int' || item.type === 'num' ? 'number' : item.type === 'secret' ? 'password' : 'text',
          value: draft,
          min: item.min === undefined ? undefined : item.min,
          max: item.max === undefined ? undefined : item.max,
          step: item.type === 'num' ? 'any' : undefined,
          inputMode: item.type === 'num' ? 'decimal' : item.type === 'int' ? 'numeric' : undefined,
          placeholder: item.type === 'secret' ? (item.set ? '已设置，留空不改' : '还没有，填一次就好') : item.type === 'windows' ? '22:30-07:30,12:00-13:00' : item.type === 'hm' ? '00:30' : '',
          autoComplete: item.type === 'secret' ? 'off' : undefined,
          disabled: props.busy,
          onFocus: function () {
            setFocus(true);
          },
          onChange: function (e) {
            setDraft(e.target.value);
          },
          onBlur: function () {
            setFocus(false);
            commit();
          },
          onKeyDown: function (e) {
            if (e.key === 'Enter') e.target.blur();
            if (e.key === 'Escape') {
              setDraft(String(props.value == null ? '' : props.value));
              e.target.blur();
            }
          },
        });
      }

      /** 课表读出来的课：可折叠 + 逐节勾选（勾上 = 这节课提前提醒）。 */
      function CourseList(props) {
        var item = props.item;
        var list = Array.isArray(item.items) ? item.items : [];
        var off = Array.isArray(item.value) ? item.value : [];
        var onCount = list.filter(function (i) {
          return off.indexOf(i.key) < 0;
        }).length;
        var allOff = list.length > 0 && onCount === 0;

        var toggle = function (key, checked) {
          var next = checked
            ? off.filter(function (k) {
                return k !== key;
              })
            : off.concat([key]);
          props.onSave(item.path, next);
        };

        return h(
          'details',
          { className: 'pg-courses' },
          h(
            'summary',
            { className: 'pg-courses-sum' },
            list.length ? '共 ' + list.length + ' 节 · 提醒 ' + onCount + ' 节（点开勾选）' : '课表还空着，先在上面填'
          ),
          list.length
            ? h(
                'div',
                { className: 'pg-courses-list' },
                h(
                  'label',
                  { className: 'pg-course pg-course-all', key: '__all__' },
                  h('input', {
                    type: 'checkbox',
                    checked: allOff,
                    disabled: props.busy,
                    onChange: function (e) {
                      // 勾上 = 一节都不提醒（全不选）；取消 = 全勾回来
                      props.onSave(
                        item.path,
                        e.target.checked
                          ? list.map(function (i) {
                              return i.key;
                            })
                          : []
                      );
                    },
                  }),
                  h('span', null, allOff ? '全不选：现在一节都不提醒（取消勾选 = 全提醒）' : '全不选：一节都不提醒')
                ),
                list.map(function (i) {
                  return h(
                    'label',
                    { className: 'pg-course', key: i.key },
                    h('input', {
                      type: 'checkbox',
                      checked: off.indexOf(i.key) < 0,
                      disabled: props.busy,
                      onChange: function (e) {
                        toggle(i.key, e.target.checked);
                      },
                    }),
                    h('span', null, i.label)
                  );
                })
              )
            : null
        );
      }

      function Control(props) {
        var item = props.item;
        var onSave = props.onSave;

        if (item.type === 'courses') {
          return h(CourseList, { item: item, busy: props.busy, onSave: onSave });
        }

        if (item.type === 'bool') {
          return h(
            'label',
            { className: 'pg-switch' },
            h('input', {
              type: 'checkbox',
              checked: item.value === true,
              disabled: props.busy,
              onChange: function (e) {
                onSave(item.path, e.target.checked);
              },
            }),
            h('span', { className: 'pg-switch-track' }, h('span', { className: 'pg-switch-dot' }))
          );
        }

        if (item.type === 'select') {
          return h(
            'select',
            {
              className: 'pg-input pg-select',
              value: item.value == null ? '' : item.value,
              disabled: props.busy,
              onChange: function (e) {
                onSave(item.path, e.target.value);
              },
            },
            (item.options || []).map(function (o) {
              return h('option', { key: o[0], value: o[0] }, o[1]);
            })
          );
        }

        // windows 在界面上是一行文本（"22:30-07:30,12:00-13:00"），空 = 全天不限
        var shown = item.type === 'windows' && Array.isArray(item.value) ? item.value.map(function (w) { return w[0] + '-' + w[1]; }).join(',') : item.value;

        return h(DraftInput, { item: item, value: shown, busy: props.busy, onSave: onSave });
      }

      function Row(props) {
        var item = props.item;
        return h(
          'div',
          { className: 'pg-row' + (item.type === 'text' || item.type === 'courses' ? ' pg-row-wide' : '') },
          h(
            'div',
            { className: 'pg-row-text' },
            h('div', { className: 'pg-row-label' }, item.label),
            item.hint ? h('div', { className: 'pg-row-hint' }, item.hint) : null
          ),
          h('div', { className: 'pg-row-ctl' }, h(Control, props))
        );
      }

      function Group(props) {
        var g = props.group;
        var timing = g.name === '时间间隔';
        var [query, setQuery] = useState('');
        var keyword = query.trim().toLowerCase();
        var visible = timing && keyword ? g.items.filter(function (item) {
          return (item.label + ' ' + (item.hint || '')).toLowerCase().includes(keyword);
        }) : g.items;
        // 注释排在板块**上面**（她要求的：日常板块头上先提醒一句），不混进标题行
        var note = g.note ? h('div', { className: 'pg-note' }, g.note) : null;
        var wrap = function (card) {
          return note ? h('div', { className: 'pg-group' }, note, card) : card;
        };
        var rows = h(
          'div',
          { className: 'pg-rows' },
          visible.map(function (item) {
            return h(Row, { key: item.path, item: item, busy: props.busy, onSave: props.onSave });
          })
        );
        var innerNote = g.innerNote ? h('div', { className: 'pg-note pg-card-inner-note' }, g.innerNote) : null;
        if (!g.foldable) {
          return wrap(
            h(
              'section',
              { className: 'pg-card' },
              h(
                'div',
                { className: 'pg-card-head' },
                h('div', { className: 'pg-card-title' }, g.name),
                h('span', { className: 'pg-card-count' }, g.items.length + ' 项')
              ),
              innerNote,
              rows
            )
          );
        }
        return wrap(
          h(
            'details',
            { className: 'pg-card pg-card-fold' },
            h(
              'summary',
              { className: 'pg-card-title pg-card-sum' },
              h('span', { className: 'pg-card-sum-name' }, g.name),
              g.summary ? h('span', { className: 'pg-card-sub' }, g.summary) : null,
              h('span', { className: 'pg-card-count' }, g.items.length + ' 项')
            ),
            innerNote,
            timing ? h('input', {
              className: 'pg-input pg-timing-search',
              type: 'search',
              'aria-label': '搜索时间间隔',
              placeholder: '搜索，比如 冷却、探索、QQ',
              value: query,
              onChange: function (e) { setQuery(e.target.value); }
            }) : null,
            visible.length ? rows : h('div', { className: 'pg-note' }, '没有匹配的设置')
          )
        );
      }

      // ------------------------------------------------------------ 状态头

      function Badge(props) {
        return h('span', { className: 'pg-badge' + (props.tone ? ' pg-badge-' + props.tone : '') }, props.children);
      }

      function Head(props) {
        var st = props.state || {};
        var dry = st.dryRun !== false;
        var canSend = st.send && st.send.enabled && !dry;

        var tone = !st.enabled ? 'off' : canSend ? 'live' : 'dry';
        var toneText = !st.enabled ? '停着' : canSend ? '会真的发' : '演练中';

        return h(
          'header',
          { className: 'pg-head' },
          h(
            'div',
            { className: 'pg-head-left' },
            h(
              'div',
              { className: 'pg-h1' },
              '陪伴 ',
              h(Badge, { tone: tone }, toneText)
            ),
            h(
              'div',
              { className: 'pg-sub' },
              st.enabled ? '每 ' + st.tickMinutes + ' 分钟醒一次' : '总开关关着，一拍都不跑',
              ' · 下次 ',
              untilLabel(st.nextAt)
            )
          ),
          h(
            'div',
            { className: 'pg-head-actions' },
            h(
              'button',
              { className: 'pg-btn', type: 'button', disabled: props.busy, onClick: props.onRefresh },
              '刷新'
            ),
            h('button', { className: 'pg-btn', type: 'button', onClick: props.onGuide }, '使用引导 / 自检'),
            h(
              'button',
              {
                className: 'pg-btn pg-btn-primary',
                type: 'button',
                disabled: props.busy || st.running,
                onClick: props.onTick,
                title: st.running ? '上一拍还在跑' : '立刻按现在的时间跑一拍（演练模式下不会发出去）',
              },
              props.busy ? '跑着呢…' : '立刻跑一拍'
            )
          )
        );
      }

      function Facts(props) {
        var st = props.state || {};
        var last = st.last || null;
        var dry = st.dryRun !== false;
        var today = st.today || {};
        var sent = dry ? today.sim || 0 : today.real || 0;

        var cells = [
          {
            k: '上一拍',
            v: last ? clockOf(last.at) + ' · ' + (DECISION_TEXT[last.decision] || last.decision || '—') : '还没跑过',
            note: last && last.explanation ? last.explanation.summary : last && last.why || '',
          },
          { k: '今天', v: sent + ' 条', note: dry ? '演练计数（没真发）' : '真实发送' },
          {
            k: '用谁写',
            v: last && last.llm ? (last.llm.via === 'host' ? last.llm.model || '宿主模型' : '命令行 CLI') : '—',
            note: last && last.llm && last.llm.provider ? last.llm.provider : '',
          },
          { k: st.externalChat && st.externalChat.primary === 'douyin' ? '抖音' : 'QQ', v: st.send && st.send.peer ? st.send.peer : '没配', note: st.mail && st.mail.enabled ? '邮箱开着' : '邮箱关着' },
        ];

        return h(
          'div',
          { className: 'pg-facts' },
          cells.map(function (c) {
            return h(
              'div',
              { className: 'pg-fact', key: c.k, title: c.v + (c.note ? ' — ' + c.note : '') },
              h('div', { className: 'pg-fact-k' }, c.k),
              h('div', { className: 'pg-fact-v' }, c.v),
              c.note ? h('div', { className: 'pg-fact-note' }, c.note) : null
            );
          })
        );
      }

      function LastWords(props) {
        var last = props.state && props.state.last;
        if (!last || !last.text) return null;
        if (last.delivery && last.delivery.attempted && last.delivery.ok) return null;
        return h(
          'div',
          { className: 'pg-quote' },
          h('div', { className: 'pg-quote-k' }, '上一句写出来的是'),
          h('div', { className: 'pg-quote-v' }, '「' + last.text + '」'),
          h(
            'div',
            { className: 'pg-quote-note' },
            last.explanation ? last.explanation.summary : '这句没有发出去'
          )
        );
      }

      var GUIDE_CLOSED_KEY = 'dsh-drop-by:guide-closed';

      function storedGuideClosed() {
        try { return window.localStorage.getItem(GUIDE_CLOSED_KEY) === '1'; }
        catch (_) { return false; }
      }

      function CheckRows(props) {
        var tones = { ok: 'live', warn: 'dry', bad: 'bad' };
        var labels = { ok: '就绪', warn: '留意', bad: '需处理' };
        return h('ul', { className: 'pg-check-rows' }, props.items.map(function (item) {
          return h('li', { key: item.key },
            h(Badge, { tone: tones[item.level] }, labels[item.level]),
            h('div', null,
              h('strong', null, item.label),
              h('div', null, item.detail),
              item.actionHint ? h('div', { className: 'pg-row-hint' }, item.actionHint) : null));
        }));
      }

      function RunExplanation(props) {
        var run = props.run || {};
        var info = run.explanation || {};
        return h('div', { className: 'pg-guide-copy', role: props.preview ? 'status' : undefined },
          props.preview ? h('strong', null, info.summary) : null,
          run.text && props.preview ? h('blockquote', { className: 'pg-quote' }, run.text) : null,
          info.detail ? h('div', null, info.detail) : null,
          props.preview && run.text
            ? h('div', { className: 'pg-row-hint' }, run.llm
                ? '模型 · ' + [run.llm.provider, run.llm.model].filter(Boolean).join(' / ')
                : '这句草稿未使用模型')
            : null,
          info.actionHint ? h('div', { className: 'pg-row-hint' }, info.actionHint) : null);
      }

      function QuickGuide(props) {
        var check = props.check;
        var deps = (props.items || []).filter(function (item) {
          return ['channel', 'llm', 'persona', 'memory', 'emotion'].indexOf(item.key) >= 0;
        });
        return h('section', { className: 'pg-card', ref: props.anchor },
          h('div', { className: 'pg-card-head' },
            h('button', { className: 'pg-btn pg-guide-toggle', type: 'button',
              'aria-expanded': props.open, 'aria-controls': 'pg-quick-guide', onClick: props.onToggle },
              h('span', { 'aria-hidden': true }, props.open ? '▾ ' : '▸ '), '快速引导与自检')),
          props.open ? h('div', { id: 'pg-quick-guide', className: 'pg-guide-copy' },
            h('div', { className: 'pg-guide-step' },
              h('h3', null, '1. 依赖检测'),
              check ? h('div', { className: 'pg-row-hint' }, '最新检查结果见下方。')
                : deps.length ? h(CheckRows, { items: deps })
                : h('div', { className: 'pg-row-hint' }, props.error || '读取依赖状态中…')),
            h('div', { className: 'pg-guide-step' },
              h('div', { className: 'pg-guide-step-head' },
                h('h3', null, '2. 连通测试'),
                h('button', { type: 'button', className: 'pg-btn', onClick: props.onCheck, disabled: props.pending !== '' || props.saving },
                  props.pending === 'check' ? '检查中…' : '检查连通状态')),
              check ? h(CheckRows, { items: check.items }) : null),
            h('div', { className: 'pg-guide-step' },
              h('div', { className: 'pg-guide-step-head' },
                h('h3', null, '3. 安全试跑'),
                h('button', { type: 'button', className: 'pg-btn pg-btn-primary', onClick: props.onPreview,
                  disabled: props.pending !== '' || props.saving || props.running },
                  props.pending === 'preview' ? '试跑中…' : '试跑一次')),
              h('div', { className: 'pg-row-hint' }, '按当前设置判断，可能调用模型写草稿。草稿只显示在这里，不会发给联系人。'),
              props.preview ? h(RunExplanation, { run: props.preview, preview: true }) : null)
          ) : null);
      }

      function RecentReports(props) {
        var data = props.data || {};
        var reports = data.reports || [];
        var slots = data.slots || [];
        var chit = data.chitchat;
        var [openSlot, setOpenSlot] = useState('');
        var [saving, setSaving] = useState(false);
        var [receiptError, setReceiptError] = useState('');

        function updateReceipt(item, row, received, event) {
          if (saving) return;
          var control = event && event.currentTarget;
          if (control) control.closest('li').focus();
          setSaving(true);
          setReceiptError('');
          props.onReceiptChange(item.slot, row.id, received).catch(function (error) {
            setReceiptError(error.message || '保存失败，请重试。');
          }).finally(function () {
            setSaving(false);
          });
        }

        return h('details', { className: 'pg-card pg-card-fold' },
          h('summary', { className: 'pg-card-title pg-card-sum' }, '近期日报与接住率'),
          h('div', { className: 'pg-guide-copy' },
            chit ? h('div', { className: 'pg-guide-step' },
              h('strong', null, '随口话今日已发 ' + (Number(chit.todayCount) || 0) + ' / ' + chit.effectivePerDay + ' 条' +
                (chit.effectivePerDay < chit.configuredPerDay ? '（设置上限 ' + chit.configuredPerDay + ' 条）' : '')),
              h('div', { className: 'pg-row-hint' }, chit.why)) : null,
            h('div', { className: 'pg-guide-step' },
              h('h3', null, '分由头接住率'),
              slots.length ? h('ul', { className: 'pg-check-rows pg-feedback-slots' }, slots.map(function (item) {
                var open = openSlot === item.slot;
                var detailsId = 'pg-receipts-' + item.slot;
                var summary = item.replied + ' / ' + item.sent + ' 条' + (item.rate == null ? '' : ' · ' + Math.round(item.rate * 100) + '%');
                var receipts = item.receipts || [];
                return h('li', { key: item.slot },
                  h('div', { className: 'pg-receipt-summary' },
                    h('span', null, item.label),
                    h('button', { type: 'button', className: 'pg-badge pg-receipt-toggle', 'aria-expanded': open,
                      'aria-controls': detailsId, 'aria-label': item.label + '接住率明细，' + summary,
                      onClick: function () { setOpenSlot(open ? '' : item.slot); setReceiptError(''); } }, summary)),
                  h('div', { id: detailsId, hidden: !open }, open ? (receipts.length
                    ? h('ul', { className: 'pg-receipt-list', 'aria-label': item.label + '接住率明细' }, receipts.map(function (row) {
                      return h('li', { key: row.id, tabIndex: -1 },
                        h('span', { className: 'pg-receipt-time' }, row.at),
                        h('span', { className: row.received ? 'pg-receipt-caught' : 'pg-receipt-missed', 'aria-live': 'polite' },
                          row.received === null ? (row.status === 'pending' ? '待判定' : '结果未记录')
                            : row.received ? (row.manual ? '接住（手动）' : '接住') : '未回'),
                        row.manual ? h('button', { type: 'button', className: 'pg-btn', disabled: saving,
                          'aria-label': '撤销 ' + row.at + ' 的手动标记',
                          onClick: function (event) { updateReceipt(item, row, false, event); } }, '撤销')
                        : row.received === false ? h('label', { className: 'pg-receipt-mark' },
                          h('input', { type: 'checkbox', checked: false, disabled: saving, 'aria-label': row.at + ' 标记接住',
                            onChange: function (event) { if (event.target.checked) updateReceipt(item, row, true, event); } }),
                          '标记接住') : null);
                    })) : h('div', { className: 'pg-row-hint pg-receipt-empty' }, '暂无可定位的逐条记录。')) : null,
                    open && item.unlistedMisses > 0 ? h('div', { className: 'pg-row-hint pg-receipt-empty' },
                      '另有 ' + item.unlistedMisses + ' 条未回仅有汇总（旧版未记录具体时间，新消息起会完整列出）。') : null));
              })) : h('div', { className: 'pg-row-hint' }, props.data ? '还没有接住率样本。' : (props.error || '正在读取…')),
              receiptError ? h('div', { role: 'alert', className: 'pg-receipt-error' }, receiptError) : null),
            h('div', { className: 'pg-guide-step' },
              h('h3', null, '每日摘要'),
              reports.length ? reports.map(function (report) {
                return h('div', { className: 'pg-report', key: report.day },
                  h('strong', null, report.day),
                  h('div', null, report.text.replace(/^# .*\n/, '').trim()));
              }) : h('div', { className: 'pg-row-hint' }, props.data ? '还没有日报记录。' : (props.error || '正在读取…')))));
      }

      function AgreementsCard(props) {
        var data = props.data;
        if (!data) return null;
        var items = data.items || [];
        var date = new Intl.DateTimeFormat('zh-CN', { timeZone: data.timezone || 'Asia/Shanghai',
          month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
        return h('details', { className: 'pg-card pg-card-fold' },
          h('summary', { className: 'pg-card-title pg-card-sum' }, '约定小本本',
            h('span', { className: 'pg-card-count' }, data.enabled ? items.length + ' 条' : '未开启')),
          h('div', { className: 'pg-guide-copy' },
            !data.enabled ? h('div', { className: 'pg-row-hint' }, '在「高级」打开约定小本本。') : null,
            items.length ? h('ul', { className: 'pg-check-rows pg-notebook-list' }, items.map(function (item) {
              return h('li', { key: item.id },
                h('div', null, h('strong', null, item.title),
                  h('div', { className: 'pg-row-hint' }, date.format(new Date(item.dueAt)) + (item.explicit ? ' · 已约提醒' : ' · 待跟进'))),
                h('button', { type: 'button', className: 'pg-btn', disabled: props.busy,
                  'aria-label': '划掉 ' + item.title, onClick: function () { props.onDismiss(item.id); } }, '划掉'));
            })) : data.enabled ? h('div', { className: 'pg-row-hint' }, '暂无待跟进事项。') : null));
      }

      function AlertBar(props) {
        if (!props.items.length) return null;
        return h('aside', { className: 'pg-card pg-alert', 'aria-label': '当前异常' },
          props.items.map(function (item) {
            return h('div', { key: item.key },
              h(Badge, { tone: item.level === 'bad' ? 'bad' : 'dry' }, item.label),
              h('span', null, item.detail),
              item.actionHint ? h('div', { className: 'pg-row-hint' }, item.actionHint) : null);
          }));
      }

      // ------------------------------------------------------------ 页面

      function Panel() {
        var [state, setState] = useState(null);
        var [groups, setGroups] = useState([]);
        var [explorationItems, setExplorationItems] = useState([]);
        var [channelItems, setChannelItems] = useState([]);
        var [error, setError] = useState('');
        var [toast, setToast] = useState(null);
        var [busy, setBusy] = useState(false);
        var [explorePending, setExplorePending] = useState(false);
        var [smallActionPending, setSmallActionPending] = useState(false);
        var [exploreResult, setExploreResult] = useState(null);
        var [showExplorationDetails, setShowExplorationDetails] = useState(false);
        var [liveBridge, setLiveBridge] = useState({});
        var [rebindId, setRebindId] = useState('');
        var [hostSessions, setHostSessions] = useState([]);
        var [sessionsLoading, setSessionsLoading] = useState(false);
        var [selectedSessionId, setSelectedSessionId] = useState('');
        var [bindingBusy, setBindingBusy] = useState(false);
        var [mergeOpen, setMergeOpen] = useState(false);
        var [mergeTargetFile, setMergeTargetFile] = useState('');
        var [mergePicked, setMergePicked] = useState({});
        var [mergePreviewInfo, setMergePreviewInfo] = useState(null);
        var [mergePreviewBusy, setMergePreviewBusy] = useState(false);
        var [loading, setLoading] = useState(true);
        var [diagnostic, setDiagnostic] = useState(null);
        var [diagnosticError, setDiagnosticError] = useState('');
        var [guideChoice, setGuideChoice] = useState(function () { return storedGuideClosed() ? false : null; });
        var [guidePending, setGuidePending] = useState('');
        var [connectivity, setConnectivity] = useState(null);
        var [preview, setPreview] = useState(null);
        var guideAnchor = useRef(null);
        var diagnosticRequest = useRef(0);
        var stateRequest = useRef(0);
        var mounted = useRef(true);
        var toastTimer = useRef(null);

        var flash = useCallback(function (text, kind) {
          setToast({ text: text, kind: kind || 'ok' });
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(function () {
            if (mounted.current) setToast(null);
          }, kind === 'err' ? 6000 : 3000);
        }, []);

        var load = useCallback(
          function (silent) {
            var request = ++stateRequest.current;
            if (!silent) setBusy(true);
            return Promise.all([apiGet('/state'), apiGet('/config')])
              .then(function (r) {
                if (!mounted.current || request !== stateRequest.current) return;
                setState(r[0]);
                setGroups(r[1].groups || []);
                setExplorationItems(r[1].explorationItems || []);
                setChannelItems(r[1].channelItems || []);
                setError('');
              })
              .catch(function (e) {
                if (!mounted.current || request !== stateRequest.current) return;
                setError(e && e.message ? e.message : String(e));
              })
              .then(function () {
                if (!mounted.current || request !== stateRequest.current) return;
                setBusy(false);
                setLoading(false);
              });
          },
          []
        );

        useEffect(function () {
          mounted.current = true;
          load(false);
          // 状态每 15 秒刷一次就够（判定本身是 10 分钟一拍）
          var t = setInterval(function () {
            if (mounted.current) load(true);
          }, 15000);
          return function () {
            mounted.current = false;
            clearInterval(t);
            if (toastTimer.current) clearTimeout(toastTimer.current);
          };
        }, [load]);

        var loadDiagnostics = useCallback(function () {
          var request = ++diagnosticRequest.current;
          return apiGet('/diagnostics').then(function (data) {
            if (!mounted.current || request !== diagnosticRequest.current) return;
            setDiagnostic(data);
            setDiagnosticError('');
          }).catch(function () {
            if (mounted.current && request === diagnosticRequest.current) setDiagnosticError('暂时读不到诊断，点「刷新」再试。');
          });
        }, []);

        function changeReceipt(slot, id, received) {
          return apiPost('/feedback/receipt', { slot: slot, id: id, received: received }).then(function (result) {
            if (!mounted.current) return;
            diagnosticRequest.current++;
            setDiagnostic(function (current) {
              return Object.assign({}, current, { slots: result.slots });
            });
          });
        }

        var diagnosticAt = state ? (state.lastAt || 'ready') : null;
        useEffect(function () {
          if (diagnosticAt) loadDiagnostics();
        }, [diagnosticAt, loadDiagnostics]);

        var guideOpen = guideChoice === null ? Boolean(diagnostic && diagnostic.guideRecommended) : guideChoice;
        function setGuide(open) {
          setGuideChoice(open);
          try {
            if (open) window.localStorage.removeItem(GUIDE_CLOSED_KEY);
            else window.localStorage.setItem(GUIDE_CLOSED_KEY, '1');
          } catch (_) {}
        }

        function openGuide() {
          setGuide(true);
          if (guideAnchor.current) guideAnchor.current.scrollIntoView({ block: 'nearest' });
        }

        function testGuide(action) {
          setGuidePending(action);
          var check = action === 'check';
          if (!check) setPreview(null);
          apiPost(check ? '/connectivity' : '/tick', check ? {} : { preview: true }).then(function (r) {
            if (!mounted.current) return;
            if (!r || r.ok === false) throw new Error(r && r.error || '自检未能完成');
            if (check) {
              setConnectivity(r);
              loadDiagnostics();
            } else {
              setPreview(r.run);
            }
          }).catch(function (e) {
            if (!mounted.current) return;
            flash(e && e.status === 409 ? '上一拍还在跑，等它跑完再试。' : e.message, 'err');
          }).finally(function () {
            if (mounted.current) setGuidePending('');
          });
        }

        var onSave = useCallback(
          function (path, value) {
            setBusy(true);
            apiSave({ path: path, value: value })
              .then(function (r) {
                if (!mounted.current) return;
                if (!r || r.ok === false) {
                  flash((r && r.error) || '保存失败', 'err');
                  load(true);
                  return;
                }
                setState(r.state);
                setConnectivity(null);
                setPreview(null);
                loadDiagnostics();
                setGroups(r.groups || []);
                if (Array.isArray(r.explorationItems)) setExplorationItems(r.explorationItems);
                if (Array.isArray(r.channelItems)) setChannelItems(r.channelItems);
                setError('');
                var note = r.notes && r.notes.length ? r.notes[0] : '已保存，下一拍生效';
                flash(note, 'ok');
              })
              .catch(function (e) {
                if (!mounted.current) return;
                flash((e && e.message) || '保存失败', 'err');
                // 值没写进去：把界面拉回真实值，别让人以为改了
                load(true);
              })
              .then(function () {
                if (mounted.current) setBusy(false);
              });
          },
          [flash, load, loadDiagnostics]
        );

        var onTick = useCallback(
          function () {
            setBusy(true);
            apiPost('/tick')
              .then(function (r) {
                if (!mounted.current) return;
                setState(r.state);
                var run = r.run;
                var dl = run && run.delivery;
                var msg = run && run.explanation ? run.explanation.summary : !run
                  ? '跑完了'
                  : dl && dl.attempted && dl.ok
                    ? '这一拍真的发出去了'
                    : run.decision === 'send'
                      ? '写出来了一句，但没发出去（演练模式或发送开关关着）'
                      : '这一拍没发（' + (run.why || '没由头') + '）';
                flash(msg, 'ok');
              })
              .catch(function (e) {
                if (!mounted.current) return;
                flash(e && e.status === 409 ? '上一拍还在跑，等它跑完' : (e && e.message) || '跑不起来', 'err');
              })
              .then(function () {
                if (mounted.current) setBusy(false);
                load(true);
              });
          },
          [flash, load]
        );

        function applySmallAction(endpoint, body) {
          if (smallActionPending) return;
          setSmallActionPending(true);
          apiPost(endpoint, body).then(function (result) {
            if (!mounted.current) return;
            setState(result.state);
            load(true);
          }).catch(function (error) {
            if (mounted.current) flash(error.message || '暂时无法保存，请重试。', 'err');
          }).finally(function () {
            if (mounted.current) setSmallActionPending(false);
          });
        }

        function onExplore() {
          setExplorePending(true);
          setExploreResult(null);
          var topic = String((state && state.exploration && state.exploration.nextTopic) || '').trim();
          apiPost('/explore', topic ? { topic: topic } : {}).then(function (r) {
            if (!mounted.current) return;
            setState(r.state);
            var labels = {
              NO_PERSONA: '请先配置角色人设',
              QUIET_OR_BUSY: '当前是静默或忙碌时段，本轮未运行',
              CHARACTER_ASLEEP: '角色正在休息，暂停自动探索',
              PEAK_HOURS: '当前为 DeepSeek 高峰时段，已按谷时开关跳过',
              DISABLED: '插件已关闭',
              UNAVAILABLE: '探索暂不可用，可能已有一轮在运行',
              HOST_LLM_MISSING: '宿主模型服务不可用',
              HOST_LLM_NO_MODEL: 'DSH 尚未配置可用的模型',
              HOST_LLM_TIMEOUT: '模型响应超时',
              HOST_LLM_ERROR: '模型请求失败',
              HOST_LLM_EMPTY: '模型没有返回内容',
              INVALID_OUTPUT: '重试后模型仍未返回完整的探索 JSON，上轮进展已保留',
              INVALID_FIELDS: '重试后探索结果仍缺少有效的主题、进展或下一步，上轮进展已保留',
              CANCELLED: '探索已取消，结果未保存'
            };
            var detail = r.note ? '（' + r.note + '）' : '';
            var message = r.ok
              ? (r.action === 'skip' ? '本轮已结束，角色选择跳过' : '本轮已结束，探索进展已保存')
              : ((labels[r.reason] || r.reason || '探索失败') + detail);
            setExploreResult({ text: message, error: !r.ok });
            if (r.ok && r.action !== 'skip') setShowExplorationDetails(true);
            load(true);
          }).catch(function (e) {
            if (mounted.current) setExploreResult({ text: e.message || '探索请求失败', error: true });
          }).finally(function () {
            if (mounted.current) setExplorePending(false);
          });
        }

        var loadHostSessions = useCallback(function () {
          setSessionsLoading(true);
          return apiGet('/sessions').then(function (data) {
            if (!mounted.current) return;
            var list = Array.isArray(data && data.sessions) ? data.sessions : [];
            setHostSessions(list);
            setSelectedSessionId(function (prev) {
              if (prev && list.some(function (s) { return s.id === prev; })) return prev;
              if (data && data.boundSessionId && list.some(function (s) { return s.id === data.boundSessionId; })) {
                return data.boundSessionId;
              }
              return list.length ? list[0].id : (data && data.boundSessionId) || '';
            });
          }).catch(function () {
            /* 宿主会话列表读取失败时保留上次列表 */
          }).finally(function () {
            if (mounted.current) setSessionsLoading(false);
          });
        }, []);

        var primaryChannel = state && state.externalChat ? state.externalChat.primary : '';
        useEffect(function () {
          if (primaryChannel === 'internal') loadHostSessions();
        }, [primaryChannel, loadHostSessions]);

        function onBindInternalSession(body) {
          setBindingBusy(true);
          apiPost('/internal/session', body).then(function (r) {
            if (!mounted.current) return;
            if (!r || r.ok === false) throw new Error((r && r.error) || '绑定失败');
            if (r.state) setState(r.state);
            if (r.sessionId) setSelectedSessionId(r.sessionId);
            setConnectivity(null);
            setPreview(null);
            loadDiagnostics();
            loadHostSessions();
            flash((r.notes && r.notes[0]) || '内部会话已绑定', 'ok');
          }).catch(function (e) {
            if (mounted.current) flash((e && e.message) || '绑定失败', 'err');
          }).finally(function () {
            if (mounted.current) setBindingBusy(false);
          });
        }

        useEffect(function () {
          var list = state && Array.isArray(state.rollovers) ? state.rollovers : [];
          var p = state && state.externalChat ? state.externalChat.primary : '';
          if (!list.length || p === 'douyin' || p === 'internal') return;
          var active = true;
          Promise.all(list.map(function (r) {
            return bridgeGet('/state?sessionId=' + encodeURIComponent(r.newSessionId))
              .then(function (res) { return [r.newSessionId, Boolean(res && res.binding && res.binding.enabled !== false)]; })
              .catch(function () { return null; });
          })).then(function (entries) {
            if (!active || !mounted.current) return;
            setLiveBridge(function (prev) {
              var next = Object.assign({}, prev);
              entries.forEach(function (pair) {
                if (pair) next[pair[0]] = pair[1];
              });
              return next;
            });
          });
          return function () { active = false; };
        }, [state]);

        function onRebind(r) {
          if (!r || !r.newSessionId) return;
          setRebindId(r.newSessionId);
          var p = state && state.externalChat ? state.externalChat.primary : '';
          if (p === 'douyin' || p === 'internal') {
            apiPost('/rollover/switch', { sessionId: r.newSessionId }).then(function (result) {
              if (!result.ok) throw new Error(result.error);
              flash(p === 'internal' ? '已切换内部续聊会话，下一条消息会带上前情' : '已切换抖音续聊会话，下一条消息会带上前情', 'ok');
              load(true);
            }).catch(function (error) { flash(error.message, 'err'); })
              .finally(function () { if (mounted.current) setRebindId(''); });
            return;
          }
          bridgeGet('/state?sessionId=' + encodeURIComponent(r.oldSessionId))
            .catch(function () { return null; })
            .then(function (oldState) {
              var oldBinding = oldState && oldState.binding;
              var disableOld = oldBinding && oldBinding.enabled !== false
                ? bridgePost('/options', { sessionId: r.oldSessionId, enabled: false })
                : Promise.resolve();
              return disableOld.then(function () {
                var peerId = r.peerId || (oldBinding && oldBinding.peerId) || '';
                if (!peerId) throw new Error('缺少 QQ 对象 ID，请到 QQ 桥手动绑定');
                return bridgePost('/bind', {
                  sessionId: r.newSessionId,
                  peerKind: r.peerKind || (oldBinding && oldBinding.peerKind) || 'private',
                  peerId: peerId,
                  peerName: r.peerName || (oldBinding && oldBinding.peerName) || undefined,
                  mentionOnly: typeof r.mentionOnly === 'boolean' ? r.mentionOnly : Boolean(oldBinding && oldBinding.mentionOnly),
                  authoritative: typeof r.authoritative === 'boolean' ? r.authoritative : Boolean(oldBinding && oldBinding.authoritative),
                });
              });
            })
            .then(function () {
              if (!mounted.current) return;
              setLiveBridge(function (prev) {
                var next = Object.assign({}, prev);
                next[r.newSessionId] = true;
                return next;
              });
              flash('已切换 QQ 绑定到续聊会话 ' + r.newSessionId.slice(0, 8) + '，发一条消息即完成交接', 'ok');
              load(true);
            })
            .catch(function (e) {
              if (!mounted.current) return;
              flash((e && e.message) || '重绑失败（请确认 QQ 桥插件已启用）', 'err');
            })
            .then(function () {
              if (mounted.current) setRebindId('');
            });
        }

        function onDismissRollover(r) {
          if (!r || !r.oldSessionId) return;
          setRebindId(r.oldSessionId);
          apiPost('/rollover/dismiss', { oldSessionId: r.oldSessionId })
            .then(function (res) {
              if (!mounted.current) return;
              if (res && res.state) setState(res.state);
              flash('已忽略该续聊提醒', 'ok');
            })
            .catch(function (e) {
              if (!mounted.current) return;
              flash((e && e.message) || '操作失败', 'err');
            })
            .then(function () {
              if (mounted.current) setRebindId('');
            });
        }

        function onRepairEmotion() {
          setBusy(true);
          apiPost('/emotion/repair', {})
            .then(function (res) {
              if (!mounted.current) return;
              if (res && res.state) setState(res.state);
              var msg = res && res.ok
                ? (res.changed ? '已对齐情绪插件：' + res.changes.join('；') : '情绪插件配置已是当前本机路径')
                : ('未能自动修复：' + ((res && res.reason) || '未知原因'));
              flash(msg, res && res.ok ? 'ok' : 'err');
            })
            .catch(function (e) {
              if (!mounted.current) return;
              flash((e && e.message) || '修复失败', 'err');
            })
            .then(function () {
              if (mounted.current) setBusy(false);
            });
        }

        function runMergePreview(targetFile, sourceFiles) {
          if (!targetFile || !sourceFiles || !sourceFiles.length) {
            setMergePreviewInfo(null);
            return;
          }
          setMergePreviewBusy(true);
          apiPost('/memory/merge', { targetFile: targetFile, sourceFiles: sourceFiles, dryRun: true })
            .then(function (res) {
              if (!mounted.current) return;
              if (res && res.ok) setMergePreviewInfo({ target: res.target, added: res.added, skipped: res.skipped, count: sourceFiles.length });
            })
            .catch(function () {})
            .then(function () {
              if (mounted.current) setMergePreviewBusy(false);
            });
        }

        function onMergeMemory(targetFile, sourceFiles) {
          if (!sourceFiles || !sourceFiles.length) {
            flash('请先勾选至少一个要并入的旧会话', 'err');
            return;
          }
          setBusy(true);
          apiPost('/memory/merge', { targetFile: targetFile || '', sourceFiles: sourceFiles })
            .then(function (res) {
              if (!mounted.current) return;
              if (res && res.state) setState(res.state);
              setMergePicked({});
              setMergePreviewInfo(null);
              var msg = res && res.ok
                ? (res.added > 0
                  ? '已将所选 ' + sourceFiles.length + ' 份会话中的 ' + res.added + ' 条新记忆并入工作区（跳过重复 ' + res.skipped + ' 条，已自动备份）'
                  : '所选会话的记忆均已在目标工作区中（跳过重复 ' + res.skipped + ' 条）')
                : ('并入失败：' + ((res && res.reason) || '未找到目标工作区文件'));
              flash(msg, res && res.ok ? 'ok' : 'err');
            })
            .catch(function (e) {
              if (!mounted.current) return;
              flash((e && e.message) || '并入记忆失败', 'err');
            })
            .then(function () {
              if (mounted.current) setBusy(false);
            });
        }

        function onRestoreMemory(targetFile) {
          setBusy(true);
          apiPost('/memory/restore', { targetFile: targetFile || '' })
            .then(function (res) {
              if (!mounted.current) return;
              if (res && res.state) setState(res.state);
              setMergePreviewInfo(null);
              var msg = res && res.ok
                ? '已撤销上次并入，恢复工作区合并前备份（共 ' + res.totalRestored + ' 条）'
                : ('无法撤销：' + ((res && res.reason === 'NO_BACKUP_FOUND') ? '该工作区没有合并前备份' : (res && res.reason) || '未知原因'));
              flash(msg, res && res.ok ? 'ok' : 'err');
            })
            .catch(function (e) {
              if (!mounted.current) return;
              flash((e && e.message) || '撤销并入失败', 'err');
            })
            .then(function () {
              if (mounted.current) setBusy(false);
            });
        }

        if (loading && !state) return h('div', { className: 'pg-root' }, h('div', { className: 'pg-loading' }, '读状态…'));
        var rollovers = state && Array.isArray(state.rollovers) ? state.rollovers : [];
        var emotion = state && state.emotion;
        var memory = state && state.memory;
        var exploration = state && state.exploration;
        var exploring = explorePending || Boolean(exploration && exploration.running);
        var thread = exploration && exploration.thread;
        var leisure = exploration && exploration.leisure;
        var lightExp = exploration && exploration.light;
        var exploreFeedback = exploration && exploration.feedback;
        function feedbackButtons(kind) {
          if (!exploreFeedback || !exploreFeedback.enabled) return null;
          var entry = (exploreFeedback.entries || []).find(function (row) { return row.kind === kind; });
          if (!entry) return null;
          return h('div', { className: 'pg-exp-actions', 'aria-label': entry.topic + '的探索反馈' },
            [['more', '想多听听'], ['change', '换个方向'], ['pause', '先放着']].map(function (option) {
              return h('button', { key: option[0], type: 'button', className: 'pg-btn' + (entry.action === option[0] ? ' pg-btn-primary' : ''),
                disabled: smallActionPending, 'aria-pressed': entry.action === option[0], onClick: function () {
                  applySmallAction('/exploration/feedback', { id: entry.id, action: option[0] });
                } }, option[1]);
            }));
        }
        function sourceLinks(entry) {
          return (entry && entry.sources || []).filter(function (s) { return /^https?:\/\//i.test(s.url); }).map(function (s) {
            return h('div', { className: 'pg-exp-item', key: s.url },
              s.evidence + ' · ', h('a', { className: 'pg-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title));
          });
        }
        function shortId(s) {
          var str = String(s || '');
          return str.length > 34 ? str.slice(0, 16) + '…' + str.slice(-14) : str;
        }
        function dayClock(ms) {
          if (!ms) return '';
          var d = new Date(ms);
          if (isNaN(d.getTime())) return '';
          var mm = String(d.getMonth() + 1).padStart(2, '0');
          var dd = String(d.getDate()).padStart(2, '0');
          return mm + '/' + dd + ' ' + clockOf(ms);
        }
        function decodeWsSlug(name) {
          var raw = String(name || '').replace(/\.json$/, '').replace(/^ws_--/, '').replace(/--$/, '');
          raw = raw.replace(/_([0-9a-fA-F]{4})/g, function (_, hex) {
            return String.fromCharCode(parseInt(hex, 16));
          }).replace(/-_dsh/g, '-.dsh');
          raw = raw.replace(/^[A-Za-z]-Users-[^-]+-/, '');
          return raw || String(name || '');
        }
        function memDisplay(name) {
          var s = String(name || '');
          if (s.indexOf('ws_') === 0) {
            var dec = decodeWsSlug(s);
            return '工作区 ' + (dec.length > 28 ? '…' + dec.slice(-26) : dec);
          }
          if (s.indexOf('session-') === 0) {
            var sid = s.replace(/\.json$/, '').replace(/^session-/, '');
            return '旧会话 ' + sid.slice(0, 8);
          }
          return shortId(s);
        }
        var hasModules = Boolean((emotion && emotion.installed) || (memory && memory.enabled && memory.files && memory.files.length) || rollovers.length || exploration);

        return h(
          'div',
          { className: 'pg-root' },
          state ? h(Head, { state: state, busy: busy || guidePending === 'preview', onGuide: openGuide,
            onRefresh: function () { load(false); loadDiagnostics(); }, onTick: onTick }) : null,
          h(AlertBar, { items: diagnostic && diagnostic.alerts || [] }),
          toast
            ? h('div', { className: 'pg-toast pg-toast-sticky' + (toast.kind === 'err' ? ' pg-toast-err' : ' pg-toast-ok'), role: 'status' },
                h('span', { className: 'pg-toast-text' }, toast.text),
                h('button', {
                  type: 'button',
                  className: 'pg-toast-close',
                  'aria-label': '关闭提示',
                  onClick: function () { setToast(null); },
                }, '×'))
            : null,
          error ? h('div', { className: 'pg-error' }, '取不到状态：' + error) : null,
          state ? h(Facts, { state: state }) : null,
          state ? h(LastWords, { state: state }) : null,
          state && state.last && state.last.decision === 'skip' && state.last.explanation &&
            (state.last.explanation.detail || state.last.explanation.actionHint)
            ? h('details', { className: 'pg-card pg-card-fold' },
                h('summary', { className: 'pg-card-title pg-card-sum' }, '上一拍为什么跳过'),
                h(RunExplanation, { run: state.last })) : null,
          state ? h(QuickGuide, { anchor: guideAnchor, open: guideOpen, onToggle: function () { setGuide(!guideOpen); },
            items: diagnostic && diagnostic.items, error: diagnosticError, check: connectivity, preview: preview,
            pending: guidePending, running: state.running, saving: busy,
            onCheck: function () { testGuide('check'); }, onPreview: function () { testGuide('preview'); } }) : null,
          state ? h(AgreementsCard, { data: state.agreements, busy: smallActionPending, onDismiss: function (id) {
            applySmallAction('/agreements/dismiss', { id: id });
          } }) : null,
          state ? h(RecentReports, { data: diagnostic, error: diagnosticError, onReceiptChange: changeReceipt }) : null,
          hasModules ? h('div', { className: 'pg-sec-label' }, '联动模块与状态') : null,
          emotion && emotion.installed ? h('div', { className: 'pg-card' },
            h('div', { className: 'pg-card-head' },
              h('div', { className: 'pg-card-title' }, '情绪状态（emotion-state-portrait' + (emotion.version ? ' v' + emotion.version : '') + '）'),
              emotion.needsRepair
                ? h('span', { className: 'pg-badge pg-badge-dry' }, '需对齐本机')
                : h('span', { className: 'pg-badge pg-badge-live' }, '已对齐本机')
            ),
            h('div', { className: 'pg-rows' },
              h('div', { className: 'pg-row' },
                h('div', { className: 'pg-row-text' },
                  h('div', { className: 'pg-row-label' },
                    emotion.live
                      ? ('心情 ' + (emotion.live.mood && emotion.live.mood.length ? emotion.live.mood.join(' · ') : '平静') +
                          ' · 精神 ' + emotion.live.spirit + '/100' +
                          (emotion.live.statusWord ? '（' + emotion.live.statusWord + '）' : '') +
                          (emotion.live.transition ? ' · 跃迁 ' + emotion.live.transition : '') +
                          ' · 画像 ' + emotion.live.portraitCount + ' 人')
                      : (emotion.stateExists === false
                          ? '已安装情绪插件 · 暂无 state.json（等待首轮打分或发条 QQ 私聊后自动生成）'
                          : (emotion.note || '已安装'))
                  ),
                  h('div', { className: 'pg-row-hint' },
                    emotion.needsRepair && emotion.issues && emotion.issues.length
                      ? '检测到遗留或无效配置：' + emotion.issues.join('；')
                      : ('自动随 QQ 私聊、指令与探索更新 inbox.jsonl' +
                          (emotion.live && emotion.live.updatedAt ? ' · 最近更新 ' + clockOf(new Date(emotion.live.updatedAt).toISOString()) : '') +
                          (emotion.inboxBytes ? ' · inbox ' + Math.max(1, Math.round(emotion.inboxBytes / 1024)) + ' KB' : ''))
                  )
                ),
                h('div', { className: 'pg-row-ctl' },
                  h('button', {
                    className: 'pg-btn' + (emotion.needsRepair ? ' pg-btn-primary' : ''),
                    type: 'button',
                    disabled: busy,
                    onClick: onRepairEmotion,
                  }, emotion.needsRepair ? '一键修复本机配置' : '重新对齐配置')
                )
              )
            )
          ) : null,
          memory && memory.enabled && memory.files && memory.files.length ? (function () {
            var sVal = memory.sessionSetting || '';
            var nonEmpty = memory.files.filter(function (f) { return f.count > 0; });
            var wsFiles = memory.supportsMerge !== false ? memory.files.filter(function (f) { return f.kind === 'workspace'; }) : [];
            var sessFiles = memory.supportsMerge !== false ? nonEmpty.filter(function (f) { return f.kind === 'session'; }) : [];
            var known = sVal === '' || sVal === 'all' || nonEmpty.some(function (f) { return f.id === sVal; });
            var activeTarget = mergeTargetFile && wsFiles.some(function (f) { return f.name === mergeTargetFile; })
              ? mergeTargetFile
              : (memory.mergeTarget || (wsFiles[0] && wsFiles[0].name) || '');
            var activeTargetObj = wsFiles.find(function (f) { return f.name === activeTarget; }) || null;
            var pickedNames = sessFiles.filter(function (f) { return mergePicked[f.name]; }).map(function (f) { return f.name; });
            var anyBackup = wsFiles.some(function (f) { return f.hasBackup; });
            var fullActive = memory.active && memory.active.files && memory.active.files.length ? memory.active.files.join(' + ') : '';
            var readableActive = memory.active && memory.active.files && memory.active.files.length
              ? memory.active.files.map(memDisplay).join(' + ')
              : '';
            var toggleAllSessions = function (checkAll) {
              var next = {};
              if (checkAll) sessFiles.forEach(function (f) { next[f.name] = true; });
              setMergePicked(next);
              runMergePreview(activeTarget, checkAll ? sessFiles.map(function (f) { return f.name; }) : []);
            };
            var toggleOneSession = function (fname) {
              var next = Object.assign({}, mergePicked);
              next[fname] = !next[fname];
              setMergePicked(next);
              var list = sessFiles.filter(function (f) { return next[f.name]; }).map(function (f) { return f.name; });
              runMergePreview(activeTarget, list);
            };
            var readBadge = sVal === 'all' ? '全部只读汇总' : sVal ? '指定文件' : '自动';
            var memTitleName = memory.label || memory.resolvedPlugin || memory.plugin || 'fish-memory';
            return h('div', { className: 'pg-card' },
              h('div', { className: 'pg-card-head' },
                h('div', { className: 'pg-card-title' }, '长期记忆（' + memTitleName + ' · 共 ' + memory.files.length + ' 份）'),
                h('span', { className: 'pg-badge ' + (sVal && sVal !== 'all' ? 'pg-badge-dry' : 'pg-badge-live') }, readBadge)
              ),
              h('div', { className: 'pg-rows' },
                h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label', title: fullActive || undefined },
                      readableActive
                        ? ('平时读取：' + readableActive + '（本轮带 ' + memory.active.count + ' 条）')
                        : '当前未命中有效记忆文件'
                    ),
                    h('div', { className: 'pg-row-hint' },
                      memory.supportsMerge === false
                        ? '当前记忆源按只读适配读取，不会修改外部插件文件。可在「数据从哪来」切换插件类型或自定义目录。'
                        : '这里只决定写消息时看哪几份文件，不会改动磁盘。工作区（ws_*）按目录跨对话共享；旧会话（session-*）是早期的单次对话记录。'
                    )
                  ),
                  h('div', { className: 'pg-row-ctl' },
                    h('select', {
                      className: 'pg-input pg-select',
                      value: sVal,
                      title: sVal || '自动：当前工作区 + 最新旧会话',
                      disabled: busy,
                      onChange: function (e) { onSave('sources.memory.session', e.target.value); },
                    },
                      h('option', { value: '' }, '自动（推荐）：工作区 + 最新会话'),
                      h('option', { value: 'all' }, '全部只读汇总（不改磁盘文件）'),
                      !known ? h('option', { value: sVal }, '前缀锁定：' + memDisplay(sVal)) : null,
                      nonEmpty.map(function (f) {
                        var when = f.mtime ? ' · ' + dayClock(f.mtime) : '';
                        return h('option', { key: f.name, value: f.id, title: f.name + (f.sample && f.sample.length ? '\n' + f.sample.join(' / ') : '') },
                          memDisplay(f.name) + '（' + f.count + '条' + (f.kind === 'session' ? when : '') + '）');
                      })
                    )
                  )
                ),
                wsFiles.length && (sessFiles.length > 0 || anyBackup) ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '整理历史会话到工作区（可选）'),
                    h('div', { className: 'pg-row-hint' },
                      '如果想让以前旧会话里的长期设定也沉淀到某个工作区里，点右侧展开挑选要并入哪些会话，不会立刻写入。' +
                      (anyBackup ? '（检测到上次并入前备份，可点右侧展开撤销还原）' : '')
                    )
                  ),
                  h('div', { className: 'pg-row-ctl' },
                    h('button', {
                      className: 'pg-btn',
                      type: 'button',
                      disabled: busy,
                      onClick: function () {
                        var nextOpen = !mergeOpen;
                        setMergeOpen(nextOpen);
                        if (nextOpen && !mergeTargetFile && activeTarget) setMergeTargetFile(activeTarget);
                      },
                    }, mergeOpen ? '收起整理面板' : '挑选会话并入…')
                  )
                ) : null,
                mergeOpen && wsFiles.length ? h('div', { className: 'pg-merge-box' },
                  h('div', { className: 'pg-merge-bar' },
                    h('span', { className: 'pg-merge-bar-label' }, '1. 并入哪个工作区：'),
                    h('select', {
                      className: 'pg-input pg-select',
                      value: activeTarget,
                      disabled: busy,
                      onChange: function (e) {
                        var nextT = e.target.value;
                        setMergeTargetFile(nextT);
                        runMergePreview(nextT, pickedNames);
                      },
                    }, wsFiles.map(function (w) {
                      return h('option', { key: w.name, value: w.name, title: w.name },
                        memDisplay(w.name) + '（现有 ' + w.count + ' 条）');
                    })),
                    activeTargetObj && activeTargetObj.hasBackup ? h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy,
                      title: '把该工作区文件恢复到最近一次并入前的状态',
                      onClick: function () { onRestoreMemory(activeTargetObj.name); },
                    }, '撤销上次并入') : null
                  ),
                  sessFiles.length ? h('div', { className: 'pg-merge-bar' },
                    h('span', { className: 'pg-merge-bar-label' },
                      '2. 勾选要并入的旧会话（已选 ' + pickedNames.length + '/' + sessFiles.length + ' 份）：'
                    ),
                    h('div', { className: 'pg-merge-quick' },
                      h('button', { type: 'button', className: 'pg-link-btn', disabled: busy, onClick: function () { toggleAllSessions(true); } }, '全选'),
                      h('button', { type: 'button', className: 'pg-link-btn', disabled: busy || !pickedNames.length, onClick: function () { toggleAllSessions(false); } }, '清空')
                    )
                  ) : null,
                  sessFiles.length ? h('div', { className: 'pg-merge-list' },
                    sessFiles.map(function (f) {
                      var checked = Boolean(mergePicked[f.name]);
                      var sampleText = f.sample && f.sample.length ? f.sample.join('；') : '暂无可预览文本';
                      return h('label', { key: f.name, className: 'pg-merge-item' + (checked ? ' pg-merge-item-on' : ''), title: f.name },
                        h('input', {
                          type: 'checkbox',
                          checked: checked,
                          disabled: busy,
                          onChange: function () { toggleOneSession(f.name); },
                        }),
                        h('div', { className: 'pg-merge-item-body' },
                          h('div', { className: 'pg-merge-meta' },
                            h('strong', null, memDisplay(f.name)),
                            h('span', { className: 'pg-badge' }, f.count + ' 条' + (f.stableCount ? ' · 含设定 ' + f.stableCount : '')),
                            f.mtime ? h('span', { className: 'pg-merge-time' }, dayClock(f.mtime)) : null
                          ),
                          h('div', { className: 'pg-merge-sample' }, '内容摘录：' + sampleText)
                        )
                      );
                    })
                  ) : h('div', { className: 'pg-row-hint' }, '当前没有非空的历史 session-*.json 文件。'),
                  h('div', { className: 'pg-merge-foot' },
                    h('div', { className: 'pg-row-hint' },
                      pickedNames.length === 0
                        ? '请勾选上面想并入的旧会话；只新增去重条目，原会话文件保留不删，写入前自动备份。'
                        : mergePreviewBusy
                          ? '正在统计预计新增条目…'
                          : (mergePreviewInfo && mergePreviewInfo.target === activeTarget
                            ? (mergePreviewInfo.added > 0
                              ? '预览：将新增 ' + mergePreviewInfo.added + ' 条到「' + memDisplay(activeTarget) + '」，跳过重复/已删 ' + mergePreviewInfo.skipped + ' 条'
                              : '所选 ' + pickedNames.length + ' 份会话内容均已在目标工作区中（无需重复写入）')
                            : '已选 ' + pickedNames.length + ' 份会话')
                    ),
                    h('div', { className: 'pg-row-ctl pg-row-ctl-wrap' },
                      h('button', {
                        type: 'button',
                        className: 'pg-btn pg-btn-primary',
                        disabled: busy || mergePreviewBusy || pickedNames.length === 0 || (mergePreviewInfo && mergePreviewInfo.target === activeTarget && mergePreviewInfo.added === 0),
                        onClick: function () { onMergeMemory(activeTarget, pickedNames); },
                      }, '确认并入（' + pickedNames.length + ' 份）'),
                      h('button', {
                        type: 'button',
                        className: 'pg-btn',
                        disabled: busy,
                        onClick: function () { setMergeOpen(false); },
                      }, '取消')
                    )
                  )
                ) : null
              )
            );
          })() : null,
          rollovers.length ? h('div', { className: 'pg-card' },
            h('div', { className: 'pg-card-head' },
              h('div', { className: 'pg-card-title' }, '外部聊天会话续聊'),
              h('span', { className: 'pg-badge pg-badge-dry' }, '待切换 ' + rollovers.length)
            ),
            h('div', { className: 'pg-rows' }, rollovers.map(function (r) {
              var p = state.externalChat ? state.externalChat.primary : '';
              var switched = (p === 'douyin' || p === 'internal') ? state.externalChat.sessionId === r.newSessionId : liveBridge[r.newSessionId] === true;
              var working = rebindId === r.newSessionId || rebindId === r.oldSessionId;
              var meta = [
                '目标 ' + r.newSessionId.slice(0, 8),
                '来自 ' + r.oldSessionId.slice(0, 8),
                r.carryMessages ? '保留最近 ' + r.carryMessages + ' 条前情' : '空白上下文',
                r.createdAt ? '创建于 ' + clockOf(r.createdAt) : '',
              ].filter(Boolean).join(' · ');
              var hint = switched
                ? '当前已绑定到该新会话，发一条私信即可注入前情并完成切换'
                : (r.diskBound
                  ? '已写入磁盘等待重启生效；若不想重启 DSH，可点右侧立即切换当前连接'
                  : '新会话已创建，点击右侧即可停用旧绑定并切到新会话');
              return h('div', { className: 'pg-row', key: r.oldSessionId + '->' + r.newSessionId },
                h('div', { className: 'pg-row-text' },
                  h('div', { className: 'pg-row-label' },
                    (r.peerName ? r.peerName + ' · ' : '') + meta,
                    switched ? h('span', { className: 'pg-badge pg-badge-live', style: { marginLeft: '6px' } }, '已绑定待首条消息') : null
                  ),
                  h('div', { className: 'pg-row-hint' }, hint)
                ),
                h('div', { className: 'pg-row-ctl pg-row-ctl-wrap' },
                  h('button', {
                    className: 'pg-btn pg-btn-primary',
                    type: 'button',
                    disabled: working || switched,
                    onClick: function () { onRebind(r); },
                  }, working ? '切换中…' : (switched ? '已切换' : '立即重绑')),
                  h('button', {
                    className: 'pg-btn',
                    type: 'button',
                    disabled: working,
                    onClick: function () { onDismissRollover(r); },
                  }, '忽略')
                )
              );
            }))
          ) : null,
          exploration ? h('div', { className: 'pg-card pg-exp-card' },
            h('div', { className: 'pg-card-head' },
              h('div', { className: 'pg-card-title' }, '自主探索'),
              h('div', { className: 'pg-card-badges' },
                exploration.peakStatus ? h('span', {
                  className: 'pg-badge ' + (exploration.peakStatus.offPeak ? 'pg-badge-live' : 'pg-badge-dry'),
                  title: '按 DeepSeek 官方峰谷说明（北京时间）与日历判定'
                }, (exploration.peakStatus.offPeak ? '谷时 · ' : '高峰 · ') + exploration.peakStatus.label) : null,
                exploration.pausedForRest ? h(Badge, { tone: 'off' }, '角色休息中 · 自动探索暂停') : null,
                exploration.offPeakOnly ? h('span', { className: 'pg-badge pg-badge-off' }, '仅谷时自动') : null,
                exploring
                  ? h('span', { className: 'pg-badge pg-badge-dry' }, '探索中')
                  : exploration.lastRun
                    ? h('span', { className: 'pg-badge pg-badge-live' }, (exploration.lastRun.mode === 'leisure' ? '休闲' : exploration.lastRun.mode === 'light' ? '轻探' : '研究') + ' · ' + exploration.lastRun.outcome)
                    : h('span', { className: 'pg-badge pg-badge-off' }, '待试跑')
              )
            ),
            h('div', { className: 'pg-exp-body' },
              exploration.lastRun ? h('div', { className: 'pg-row-hint' },
                '最近路径：' + (exploration.lastRun.calls && exploration.lastRun.calls.length ? exploration.lastRun.calls.join(' → ') : '文字探索')) : null,
              exploration.candidate && exploration.candidate.loginSite ? h('div', { className: 'pg-row-hint' },
                '待登录 · ', h('a', { className: 'pg-link', href: exploration.candidate.source.url, target: '_blank', rel: 'noopener noreferrer' }, exploration.candidate.loginSite),
                '。请在网站页面完成登录；公开网页工具可能仍无法读取登录后的页面。') : null,
              thread || leisure || lightExp ? h('details', {
                className: 'pg-exp-details',
                open: showExplorationDetails,
                onToggle: function (event) { setShowExplorationDetails(event.currentTarget.open); }
              },
                h('summary', { className: 'pg-exp-sum' }, '最近的探索进展'),
                h('div', { className: 'pg-exp-list' },
                  [thread, leisure].filter(Boolean).flatMap(function (entry, index) {
                    var prefix = entry === leisure ? '休闲' : '研究';
                    return [['进度', entry.checkpoint], ['新发现', entry.discovery], ['待确认', entry.waitingFor]]
                      .filter(function (item) { return item[1]; }).map(function (item) {
                        return h('div', { key: index + item[0], className: 'pg-exp-item' }, prefix + ' · ' + item[0] + '：' + item[1]);
                      });
                  }),
                  thread ? h('div', { className: 'pg-exp-highlight' }, thread.topic + '：' + thread.progress) : null,
                  thread && thread.next ? h('div', { className: 'pg-exp-item' }, '下一步：' + thread.next) : null,
                  ...sourceLinks(thread),
                  feedbackButtons('thread'),
                  leisure ? h('div', { className: 'pg-exp-highlight' }, '随便逛逛 · ' + leisure.topic + '：' + leisure.progress) : null,
                  ...sourceLinks(leisure),
                  feedbackButtons('leisure'),
                  lightExp ? h('div', { className: 'pg-exp-highlight' }, '随手看看 · ' + lightExp.topic + '：' + (lightExp.summary || lightExp.progress)) : null,
                  ...sourceLinks(lightExp),
                  feedbackButtons('light'),
                  exploration.candidate ? h('div', { className: 'pg-exp-item' }, '可分享：' + exploration.candidate.line) : null,
                  exploration.mood ? h('div', { className: 'pg-exp-item' }, '探索感受：' + exploration.mood.text) : null
                )
              ) : null,
              exploreFeedback && exploreFeedback.candidates && exploreFeedback.candidates.length ?
                h('div', { className: 'pg-exp-list' },
                  h('strong', null, '近期好奇候选'),
                  h('ul', { className: 'pg-check-rows pg-notebook-list' }, exploreFeedback.candidates.map(function (item) {
                    return h('li', { key: item.id },
                      h('div', null, item.topic, h('div', { className: 'pg-row-hint' }, item.source === 'forward' ? '来自私聊转发' : '来自探索分享')),
                      h('button', { className: 'pg-btn', type: 'button', disabled: smallActionPending, 'aria-label': '删除 ' + item.topic,
                        onClick: function () { applySmallAction('/exploration/feedback', { id: item.id, action: 'delete' }); } }, '删除'));
                  }))) : null,
              h('div', { className: 'pg-exp-actions' },
                h('button', { className: 'pg-btn', type: 'button', disabled: busy || exploring || !state.enabled, onClick: onExplore },
                  exploring ? '探索进行中…' : '试跑一轮（不发送）')
              ),
              exploreResult ? h('div', { role: 'status', className: 'pg-toast' + (exploreResult.error ? ' pg-toast-err' : ' pg-toast-ok') }, exploreResult.text) : null
            ),
            explorationItems.length ? h(
              'div',
              { className: 'pg-rows pg-exp-rows' },
              explorationItems.map(function (item) {
                return h(Row, { key: item.path, item: item, busy: busy, onSave: onSave });
              })
            ) : null
          ) : null,
          channelItems.length || (state && state.externalChat) ? (function () {
            var ec = (state && state.externalChat) || {};
            var p = ec.primary || 'internal';
            var badgeText = p === 'internal'
              ? (ec.sessionId ? '当前：内部会话' : '当前：内部会话（未绑定）')
              : p === 'douyin' ? '当前：抖音私信' : '当前：QQ';
            var badgeCls = p === 'internal'
              ? (ec.sessionId ? 'pg-badge-live' : 'pg-badge-dry')
              : p === 'douyin' ? 'pg-badge-dry' : 'pg-badge-live';
            var boundLabel = ec.sessionId
              ? (ec.sessionTitle ? '「' + ec.sessionTitle + '」' : '') + ec.sessionId.slice(0, 8)
              : '';
            return h('div', { className: 'pg-card' },
              h('div', { className: 'pg-card-head' },
                h('div', { className: 'pg-card-title' }, '主聊天接口与通道开关'),
                h('div', { className: 'pg-card-badges' },
                  h('span', { className: 'pg-badge ' + badgeCls }, badgeText)
                )
              ),
              p === 'internal' ? h('div', { className: 'pg-row-hint', style: { marginBottom: '8px' } },
                ec.sessionId
                  ? '已绑定共用会话 ' + boundLabel +
                    (ec.lastUserAt ? ' · 最近对话 ' + clockOf(new Date(ec.lastUserAt).toISOString()) : '') +
                    '。切换到 QQ 或抖音时也会沿用此会话。'
                  : '尚未绑定内部会话：请从下方选择一个已有 DSH 会话，或点击「新建陪伴会话」。'
              ) : null,
              p === 'qq' && ec.sessionId ? h('div', { className: 'pg-row-hint', style: { marginBottom: '8px' } },
                '当前共用会话 ' + boundLabel + '（切换通道时会沿用）。'
              ) : null,
              p === 'douyin' ? h('div', { className: 'pg-row-hint', style: { marginBottom: '8px' } }, ec.restartRequired
                ? '旧收发已暂停，请重启 DSH 完成抖音接管。'
                : (ec.sharedWithQq ? 'QQ 共用会话 ' : '共用会话 ') +
                  (ec.sessionId ? ec.sessionId.slice(0, 8) : '待建立') +
                  (ec.polledAt ? ' · 上次读取 ' + clockOf(new Date(ec.polledAt).toISOString()) : ' · 等待轮询') +
                  (ec.status ? ' · ' + ec.status : '') +
                  (ec.retryAt && ec.status ? ' · 下次重试 ' + clockOf(new Date(ec.retryAt).toISOString()) : '') +
                  (ec.gap ? ' · 抖音历史窗口可能有缺口' : '')
              ) : null,
              channelItems.length ? h(
                'div',
                { className: 'pg-rows' },
                channelItems.map(function (item) {
                  return h(Row, { key: item.path, item: item, busy: busy, onSave: onSave });
                }),
                p === 'internal' ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '绑定内部会话'),
                    h('div', { className: 'pg-row-hint' },
                      hostSessions.length
                        ? '从当前 DSH 的 ' + hostSessions.length + ' 个会话中选择绑定，或新建一条陪伴会话。'
                        : (sessionsLoading ? '正在读取 DSH 会话列表…' : '未找到可绑定的已有会话，可直接新建陪伴会话。')
                    )
                  ),
                  h('div', { className: 'pg-row-ctl pg-row-ctl-wrap' },
                    h('select', {
                      className: 'pg-input pg-select',
                      value: selectedSessionId,
                      disabled: busy || bindingBusy || sessionsLoading || !hostSessions.length,
                      onChange: function (e) { setSelectedSessionId(e.target.value); },
                    },
                      !hostSessions.length ? h('option', { value: '' }, '暂无已有会话') : null,
                      hostSessions.map(function (s) {
                        var label = (s.title || '未命名会话') + ' [' + s.id.slice(0, 8) + ']' + (s.id === ec.sessionId ? '（当前）' : '');
                        return h('option', { key: s.id, value: s.id }, label);
                      })
                    ),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn pg-btn-primary',
                      disabled: busy || bindingBusy || !selectedSessionId || selectedSessionId === ec.sessionId,
                      onClick: function () { onBindInternalSession({ sessionId: selectedSessionId }); },
                    }, bindingBusy ? '绑定中…' : '绑定所选'),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy || bindingBusy,
                      onClick: function () { onBindInternalSession({ create: true }); },
                    }, '新建陪伴会话'),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy || bindingBusy || sessionsLoading,
                      onClick: loadHostSessions,
                    }, sessionsLoading ? '刷新中…' : '刷新列表')
                  )
                ) : null
              ) : null
            );
          })() : null,
          groups.length ? h('div', { className: 'pg-sec-label' }, '参数设置') : null,
          groups.map(function (g) {
            return h(Group, { key: g.name, group: g, busy: busy, onSave: onSave });
          }),
          h(
            'div',
            { className: 'pg-foot' },
            '改完立刻写进 config.json，下一拍（最多 ',
            state ? state.tickMinutes : 10,
            ' 分钟）生效。命令行那套 --status / --set 读的是同一个文件。'
          )
        );
      }

      /**
       * 设置页崩了也要看得见原因，而不是整块白屏。
       * 只能写成 class：componentDidCatch 是 class 才有的钩子。
       * （别用 ES5 的 `React.Component.call(this)` —— React 18 的 Component 是 class，
       *   不带 new 调用会直接抛「Class constructor cannot be invoked without 'new'」。）
       */
      class ErrorBoundary extends React.Component {
        constructor(props) {
          super(props);
          this.state = { err: null };
        }
        componentDidCatch(e) {
          this.setState({ err: e });
        }
        render() {
          if (this.state.err) {
            var msg = this.state.err && this.state.err.message ? this.state.err.message : String(this.state.err);
            return h('div', { className: 'pg-root' }, h('div', { className: 'pg-error' }, '这一页崩了：' + msg));
          }
          return this.props.children;
        }
      }

      // ------------------------------------------------------------ 样式

      var CSS = [
        '.pg-root{',
        '--pg-fg:var(--dsw-alias-label-primary,#1f1c18);',
        '--pg-muted:var(--dsw-alias-label-secondary,#6f6558);',
        '--pg-faint:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed,#8a7f6e));',
        '--pg-card:var(--dsw-alias-bg-layer-1,#fffdf8);',
        '--pg-bar:var(--dsw-alias-bg-layer-2,#f4efe4);',
        '--pg-field:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2,#fbf7ef));',
        '--pg-line:var(--dsw-alias-border-l2,#e3daca);',
        '--pg-line-soft:var(--dsw-alias-border-l1,#ece5d8);',
        '--pg-hover:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10));',
        '--pg-brand:var(--dsw-alias-brand-primary,var(--dsw-alias-button-primary-fill,#1f1c18));',
        '--pg-brand-fg:var(--dsw-alias-label-primary-foreground,#fffdf8);',
        '--pg-ok:var(--dsw-alias-state-success-primary,#2f6b46);',
        '--pg-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
        '--pg-err:var(--dsw-alias-state-error-primary,#a83a2c);',
        'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
        'color:var(--pg-fg);display:flex;flex-direction:column;gap:14px;padding:4px 2px 10px;box-sizing:border-box;max-width:100%;}',
        '.pg-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:2px 2px 4px;}',
        '.pg-head-left{flex:1 1 auto;min-width:0;}',
        '.pg-h1{font-size:15.5px;font-weight:650;letter-spacing:.2px;line-height:1.4;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.pg-sub{font-size:12.5px;color:var(--pg-muted);margin-top:5px;line-height:1.6;}',
        '.pg-head-actions{display:flex;gap:8px;flex:0 0 auto;flex-wrap:wrap;}',
        '.pg-btn{font:inherit;font-size:12.5px;font-weight:500;padding:6px 12px;border-radius:9px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-fg);cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,transform .08s,opacity .15s;}',
        '.pg-btn:hover:not(:disabled){background:var(--pg-hover);border-color:color-mix(in srgb,var(--pg-brand) 30%,var(--pg-line));}',
        '.pg-btn:active:not(:disabled){transform:translateY(1px);}',
        '.pg-btn:focus-visible{outline:2px solid color-mix(in srgb,var(--pg-brand) 45%,transparent);outline-offset:1px;}',
        '.pg-btn:disabled{opacity:.5;cursor:default;}',
        '.pg-btn-primary{background:var(--pg-brand);color:var(--pg-brand-fg);border-color:transparent;}',
        '.pg-btn-primary:hover:not(:disabled){background:var(--pg-brand);opacity:.9;border-color:transparent;}',
        '.pg-badge{font-size:11px;font-weight:550;padding:2px 8px;border-radius:999px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-muted);line-height:1.45;white-space:nowrap;}',
        '.pg-badge-live{color:var(--pg-ok);border-color:color-mix(in srgb,var(--pg-ok) 38%,transparent);background:color-mix(in srgb,var(--pg-ok) 11%,transparent);}',
        '.pg-badge-dry{color:var(--pg-warn);border-color:color-mix(in srgb,var(--pg-warn) 38%,transparent);background:color-mix(in srgb,var(--pg-warn) 11%,transparent);}',
        '.pg-badge-off{color:var(--pg-faint);}',
        '.pg-badge-bad{color:var(--pg-err);border-color:color-mix(in srgb,var(--pg-err) 35%,transparent);background:color-mix(in srgb,var(--pg-err) 9%,transparent);}',
        '.pg-alert{padding:9px 14px;border-color:color-mix(in srgb,var(--pg-warn) 45%,var(--pg-line));font-size:12px;line-height:1.5;}',
        '.pg-alert>div+div{margin-top:5px;}',
        '.pg-alert .pg-badge{margin-right:7px;}',
        '.pg-guide-toggle{background:transparent;border-color:transparent;font-weight:650;}',
        '.pg-guide-copy{padding:7px 0;font-size:12px;line-height:1.55;overflow-wrap:anywhere;}',
        '.pg-guide-copy .pg-quote{margin:7px 0;}',
        '.pg-guide-step{padding:7px 0;}',
        '.pg-guide-step+.pg-guide-step{border-top:1px solid var(--pg-line-soft);}',
        '.pg-guide-step h3{margin:0 0 4px;font-size:12px;font-weight:650;}',
        '.pg-guide-step-head{display:flex;align-items:center;justify-content:space-between;gap:7px;flex-wrap:wrap;margin-bottom:5px;}',
        '.pg-check-rows{list-style:none;padding:0;margin:5px 0 0;display:grid;gap:6px;}',
        '.pg-check-rows li{display:flex;align-items:baseline;gap:8px;}',
        '.pg-notebook-list>li{justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--pg-line-soft);}',
        '.pg-notebook-list>li>div{min-width:0;overflow-wrap:anywhere;}',
        '.pg-feedback-slots>li{display:block;}',
        '.pg-receipt-summary,.pg-receipt-list li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.pg-receipt-toggle{font-family:inherit;cursor:pointer;}',
        '.pg-receipt-toggle:hover,.pg-receipt-toggle[aria-expanded=true]{border-color:var(--pg-muted);color:var(--pg-fg);}',
        '.pg-receipt-toggle::after{content:"▸";margin-left:6px;}',
        '.pg-receipt-toggle[aria-expanded=true]::after{content:"▾";}',
        '.pg-receipt-list{list-style:none;padding:2px 10px;margin:6px 0 8px;border-left:2px solid var(--pg-line-soft);}',
        '.pg-receipt-list li{min-height:34px;}',
        '.pg-receipt-list li+li{border-top:1px solid var(--pg-line-soft);}',
        '.pg-receipt-time{font-variant-numeric:tabular-nums;}',
        '.pg-receipt-caught{color:var(--pg-ok);}',
        '.pg-receipt-missed{color:var(--pg-muted);}',
        '.pg-receipt-mark{display:inline-flex;align-items:center;gap:4px;cursor:pointer;color:var(--pg-muted);}',
        '.pg-receipt-mark input{margin:0;accent-color:var(--pg-brand);}',
        '.pg-receipt-empty,.pg-receipt-error{padding:6px 0;}',
        '.pg-receipt-error{color:var(--pg-err);}',
        '.pg-report{padding-top:7px;}',
        '.pg-report>div{white-space:pre-line;color:var(--pg-muted);}',
        '.pg-sec-label{font-size:11px;font-weight:650;letter-spacing:.6px;color:var(--pg-faint);display:flex;align-items:center;gap:10px;padding:4px 2px 0;}',
        '.pg-sec-label::after{content:"";flex:1 1 auto;height:1px;background:var(--pg-line-soft);}',
        '.pg-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(136px,1fr));gap:9px;}',
        '.pg-fact{background:var(--pg-bar);border:1px solid var(--pg-line-soft);border-radius:11px;padding:10px 12px;min-width:0;transition:border-color .15s;}',
        '.pg-fact:hover{border-color:var(--pg-line);}',
        '.pg-fact-k{font-size:11px;font-weight:600;color:var(--pg-faint);letter-spacing:.3px;}',
        '.pg-fact-v{font-size:13.5px;font-weight:550;font-variant-numeric:tabular-nums;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pg-fact-note{font-size:11px;color:var(--pg-muted);margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pg-quote{background:var(--pg-field);border:1px solid var(--pg-line-soft);border-left:3px solid var(--pg-brand);border-radius:11px;padding:10px 13px;}',
        '.pg-quote-k{font-size:11px;font-weight:600;color:var(--pg-faint);}',
        '.pg-quote-v{font-size:13px;line-height:1.65;margin-top:4px;}',
        '.pg-quote-note{font-size:11.5px;color:var(--pg-muted);margin-top:4px;}',
        '.pg-card{background:var(--pg-card);border:1px solid var(--pg-line-soft);border-radius:13px;padding:4px 14px 6px;box-shadow:0 1px 2px rgba(0,0,0,.025);}',
        '.pg-card-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0 6px;border-bottom:1px solid var(--pg-line-soft);flex-wrap:wrap;}',
        '.pg-card-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}',
        '.pg-card-title{font-size:12px;font-weight:650;letter-spacing:.25px;color:var(--pg-muted);}',
        '.pg-card-count{font-size:11px;font-weight:500;color:var(--pg-faint);white-space:nowrap;}',
        '.pg-card-fold .pg-card-sum{padding:11px 0;margin:0;border-bottom:0;transition:color .15s;}',
        '.pg-card-fold[open] .pg-card-sum{border-bottom:1px solid var(--pg-line-soft);padding-bottom:9px;}',
        '.pg-card-sum{cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px;}',
        '.pg-card-sum:hover{color:var(--pg-fg);}',
        '.pg-card-sum::-webkit-details-marker{display:none;}',
        '.pg-card-sum::before{content:"▸";font-size:10px;opacity:.7;transition:transform .15s;flex:0 0 auto;}',
        '.pg-card-fold[open] .pg-card-sum::before{content:"▾";}',
        '.pg-card-sum-name{flex:0 0 auto;}',
        '.pg-card-sub{font-size:11px;font-weight:400;letter-spacing:0;color:var(--pg-faint);flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pg-note{font-size:11.5px;line-height:1.65;color:var(--pg-muted);background:var(--pg-field);border:1px solid var(--pg-line-soft);border-left:3px solid var(--pg-warn);border-radius:9px;padding:9px 11px;margin:0 0 8px;}',
        '.pg-card-inner-note{margin:9px 0 4px;}',
        '.pg-rows{display:flex;flex-direction:column;}',
        '.pg-timing-search{width:100%;margin:9px 0 4px;text-align:left;padding:6px 10px;}',
        '.pg-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--pg-line-soft);}',
        '.pg-row:last-child{border-bottom:0;}',
        '.pg-row-text{flex:1 1 auto;min-width:0;}',
        '.pg-row-label{font-size:12.5px;font-weight:500;line-height:1.5;overflow-wrap:anywhere;}',
        '.pg-row-hint{font-size:11.5px;color:var(--pg-muted);line-height:1.55;margin-top:2px;overflow-wrap:anywhere;}',
        '.pg-row-ctl{flex:0 0 auto;display:flex;align-items:center;justify-content:flex-end;min-height:26px;max-width:48%;}',
        '.pg-row-ctl-wrap{gap:6px;flex-wrap:wrap;justify-content:flex-end;}',
        '.pg-input{font:inherit;font-size:12.5px;color:var(--pg-fg);background:var(--pg-field);border:1px solid var(--pg-line);border-radius:8px;padding:5px 9px;width:96px;max-width:100%;box-sizing:border-box;text-align:right;transition:border-color .15s,box-shadow .15s;}',
        '.pg-input-wide{width:210px;text-align:left;}',
        '.pg-input:focus{outline:none;border-color:var(--pg-brand);box-shadow:0 0 0 2px color-mix(in srgb,var(--pg-brand) 16%,transparent);}',
        '.pg-select{width:auto;min-width:140px;max-width:240px;text-align:left;cursor:pointer;text-overflow:ellipsis;}',
        '.pg-textarea{width:100%;min-height:110px;text-align:left;resize:vertical;line-height:1.6;padding:7px 9px;font-size:12.5px;}',
        '.pg-row-wide{flex-wrap:wrap;align-items:flex-start;}',
        '.pg-row-wide .pg-row-ctl{flex:1 1 100%;max-width:100%;justify-content:flex-start;}',
        '.pg-exp-card{padding-bottom:6px;}',
        '.pg-exp-body{display:flex;flex-direction:column;gap:8px;padding-top:8px;padding-bottom:6px;}',
        '.pg-exp-rows{margin-top:4px;border-top:1px solid var(--pg-line-soft);padding-top:2px;}',
        '.pg-exp-details{border:1px solid var(--pg-line-soft);border-radius:9px;background:var(--pg-field);padding:6px 10px;}',
        '.pg-exp-sum{cursor:pointer;font-size:12px;font-weight:550;color:var(--pg-muted);list-style:none;display:flex;align-items:center;gap:6px;}',
        '.pg-exp-sum::-webkit-details-marker{display:none;}',
        '.pg-exp-sum::before{content:"▸";font-size:10px;opacity:.75;}',
        '.pg-exp-details[open] .pg-exp-sum::before{content:"▾";}',
        '.pg-exp-list{display:flex;flex-direction:column;gap:5px;padding-top:8px;margin-top:6px;border-top:1px solid var(--pg-line-soft);}',
        '.pg-exp-item{font-size:11.5px;color:var(--pg-muted);line-height:1.55;overflow-wrap:anywhere;}',
        '.pg-exp-highlight{font-size:12.5px;color:var(--pg-fg);line-height:1.6;padding:4px 8px;background:var(--pg-card);border-radius:7px;border:1px solid var(--pg-line-soft);}',
        '.pg-exp-actions{display:flex;align-items:center;gap:8px;padding-top:2px;}',
        '.pg-link{color:var(--pg-brand);text-decoration:underline;text-underline-offset:2px;}',
        '.pg-link-btn{font:inherit;font-size:11.5px;border:0;background:transparent;color:var(--pg-brand);cursor:pointer;padding:2px 4px;text-decoration:underline;text-underline-offset:2px;}',
        '.pg-link-btn:disabled{opacity:.45;cursor:default;text-decoration:none;}',
        '.pg-merge-box{margin:6px 0 8px;padding:10px 12px;border-radius:10px;border:1px solid var(--pg-line);background:var(--pg-field);display:flex;flex-direction:column;gap:9px;}',
        '.pg-merge-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.pg-merge-bar-label{font-size:12px;font-weight:600;color:var(--pg-fg);}',
        '.pg-merge-quick{display:flex;align-items:center;gap:6px;margin-left:auto;}',
        '.pg-merge-list{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow-y:auto;padding-right:2px;}',
        '.pg-merge-item{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:8px;border:1px solid var(--pg-line-soft);background:var(--pg-card);cursor:pointer;transition:border-color .15s,background .15s;}',
        '.pg-merge-item:hover{border-color:var(--pg-line);}',
        '.pg-merge-item-on{border-color:color-mix(in srgb,var(--pg-brand) 45%,var(--pg-line));background:color-mix(in srgb,var(--pg-brand) 4%,var(--pg-card));}',
        '.pg-merge-item input{margin-top:3px;flex:0 0 auto;accent-color:var(--pg-brand);}',
        '.pg-merge-item-body{flex:1 1 auto;min-width:0;}',
        '.pg-merge-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;}',
        '.pg-merge-time{font-size:11px;color:var(--pg-faint);margin-left:auto;}',
        '.pg-merge-sample{font-size:11.5px;color:var(--pg-muted);margin-top:3px;line-height:1.5;overflow-wrap:anywhere;}',
        '.pg-merge-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding-top:4px;border-top:1px solid var(--pg-line-soft);}',
        '.pg-courses{width:100%;border:1px solid var(--pg-line);border-radius:9px;padding:6px 10px;background:var(--pg-field);}',
        '.pg-courses-sum{cursor:pointer;font-size:12.5px;opacity:.9;list-style:none;}',
        '.pg-courses-sum::-webkit-details-marker{display:none;}',
        '.pg-courses-sum::before{content:"▸ ";}',
        '.pg-courses[open] .pg-courses-sum::before{content:"▾ ";}',
        '.pg-courses-list{display:flex;flex-direction:column;gap:5px;padding:8px 2px 4px;}',
        '.pg-course-all{font-weight:600;border-bottom:1px solid var(--pg-line-soft);padding-bottom:6px;margin-bottom:2px;}',
        '.pg-course{display:flex;align-items:center;gap:7px;font-size:12.5px;cursor:pointer;line-height:1.45;}',
        '.pg-course input{flex:0 0 auto;accent-color:var(--pg-brand);}',
        '.pg-switch{display:inline-flex;align-items:center;cursor:pointer;position:relative;}',
        '.pg-switch input{position:absolute;opacity:0;width:0;height:0;}',
        '.pg-switch-track{width:36px;height:20px;border-radius:999px;background:var(--pg-line);display:inline-block;position:relative;transition:background .15s;}',
        '.pg-switch-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--pg-card);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.18);}',
        '.pg-switch input:checked+.pg-switch-track{background:var(--pg-brand);}',
        '.pg-switch input:checked+.pg-switch-track .pg-switch-dot{transform:translateX(16px);}',
        '.pg-switch input:focus-visible+.pg-switch-track{outline:2px solid color-mix(in srgb,var(--pg-brand) 45%,transparent);outline-offset:2px;}',
        '.pg-switch input:disabled+.pg-switch-track{opacity:.5;}',
        '.pg-toast{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12.5px;padding:9px 12px;border-radius:10px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-fg);}',
        '.pg-toast-sticky{position:sticky;top:6px;z-index:5;box-shadow:0 4px 12px rgba(0,0,0,.08);}',
        '.pg-toast-ok{color:var(--pg-ok);border-color:color-mix(in srgb,var(--pg-ok) 35%,transparent);background:color-mix(in srgb,var(--pg-ok) 9%,var(--pg-card));}',
        '.pg-toast-err{color:var(--pg-err);border-color:color-mix(in srgb,var(--pg-err) 35%,transparent);background:color-mix(in srgb,var(--pg-err) 9%,var(--pg-card));}',
        '.pg-toast-text{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;}',
        '.pg-toast-close{flex:0 0 auto;border:0;background:transparent;color:inherit;font-size:16px;line-height:1;padding:0 4px;cursor:pointer;opacity:.7;}',
        '.pg-toast-close:hover{opacity:1;}',
        '.pg-error{color:var(--pg-err);background:color-mix(in srgb,var(--pg-err) 10%,transparent);border:1px solid color-mix(in srgb,var(--pg-err) 35%,transparent);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.6;}',
        '.pg-loading{font-size:12.5px;color:var(--pg-muted);padding:18px 0;}',
        '.pg-foot{font-size:11.5px;color:var(--pg-faint);line-height:1.6;padding:2px 4px 6px;}',
        '@media (max-width:580px){.pg-head{flex-direction:column;align-items:stretch;}.pg-row{flex-direction:column;align-items:stretch;gap:8px;}.pg-row-ctl,.pg-row-ctl-wrap{max-width:100%;justify-content:flex-start;}.pg-input-wide,.pg-select{width:100%;max-width:100%;}}',
        '@supports not (color:var(--dsw-alias-label-primary)){.pg-root{--pg-fg:#241f18;--pg-muted:#6f6558;--pg-faint:#9a9084;--pg-card:#fffdf8;--pg-bar:#f6f2ea;--pg-field:#fbf8f2;--pg-line:#e0d7c8;--pg-line-soft:#ece5d8;--pg-hover:rgba(0,0,0,.05);--pg-brand:#241f18;--pg-brand-fg:#fffdf8;--pg-ok:#2f6b46;--pg-warn:#8a6a2f;--pg-err:#a83a2c}}',
      ].join('');

      // ------------------------------------------------------------ 注册

      function apply(ctx) {
        ctx.effect(function () {
          var id = 'dsh-drop-by-styles';
          if (document.getElementById(id) === null) {
            var style = document.createElement('style');
            style.id = id;
            style.textContent = CSS;
            document.head.appendChild(style);
          }
          return function () {
            var el = document.getElementById(id);
            if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el);
          };
        }, 'dsh-drop-by: styles');

        var slots = typeof ctx.get === 'function' ? ctx.get('slots') : null;
        if (!slots) return;
        var off = slots.inject('settings.section', function () {
          return slots.register(
            { name: 'settings.section', id: 'dsh-drop-by', order: 34, label: '陪伴' },
            function (props) {
              var p = props || {};
              return h(ErrorBoundary, { sessionId: p.sessionId }, h(Panel, p));
            }
          );
        });
        if (typeof off === 'function') ctx.effect(function () { return off; });
      }

      module.exports = { name: 'dsh-drop-by', inject: ['slots'], apply: apply };
      return module.exports;
    },
  });
}
