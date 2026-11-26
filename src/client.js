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

      var FOLD_STORAGE_KEY = 'dsh-drop-by:folds:v1';

      function readFoldState(key, fallback) {
        try {
          var raw = window.localStorage.getItem(FOLD_STORAGE_KEY);
          if (!raw) return fallback;
          var map = JSON.parse(raw);
          if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, key)) {
            return Boolean(map[key]);
          }
        } catch (_) {}
        return fallback;
      }

      function writeFoldState(key, isOpen) {
        try {
          var raw = window.localStorage.getItem(FOLD_STORAGE_KEY);
          var map = raw ? JSON.parse(raw) : {};
          if (!map || typeof map !== 'object') map = {};
          map[key] = Boolean(isOpen);
          window.localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify(map));
        } catch (_) {}
      }

      // ------------------------------------------------------------ 控件

      /** 数字/文本输入：本地草稿，失焦或回车才提交（别每敲一个字就写一次盘）。 */
      function DraftInput(props) {
        var item = props.item;
        var [draft, setDraft] = useState(String(props.value == null ? '' : props.value));
        var [focus, setFocus] = useState(false);
        var cancelBlur = useRef(false);
        useEffect(
          function () {
            if (!focus) setDraft(String(props.value == null ? '' : props.value));
          },
          [props.value, focus]
        );

        function onBlur() {
          setFocus(false);
          if (cancelBlur.current) {
            cancelBlur.current = false;
            return;
          }
          if (String(props.value == null ? '' : props.value) === draft) return;
          props.onSave(item.path, draft);
          // 凭据存进去之后就清空输入框（服务端不会把值读回来，留着只会像没保存）
          if (item.type === 'secret') setDraft('');
        }

        function onKeyDown(e) {
          if (e.nativeEvent && e.nativeEvent.isComposing) return;
          if (e.key === 'Escape') {
            cancelBlur.current = true;
            e.target.blur();
          } else if (e.key === 'Enter' && item.type !== 'text') {
            e.target.blur();
          }
        }

        // 多行文本（课表）：回车不提交，失焦才存；整张表粘进来就行
        if (item.type === 'text') {
          return h('textarea', {
            className: 'pg-input pg-textarea',
            rows: item.rows || 6,
            value: draft,
            'aria-label': item.label,
            disabled: props.busy,
            onFocus: function () { setFocus(true); },
            onChange: function (e) { setDraft(e.target.value); },
            onBlur: onBlur,
            onKeyDown: onKeyDown,
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
          'aria-label': item.label,
          disabled: props.busy,
          onFocus: function () {
            setFocus(true);
          },
          onChange: function (e) {
            setDraft(e.target.value);
          },
          onBlur: onBlur,
          onKeyDown: onKeyDown,
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
              'aria-label': item.label,
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
              'aria-label': item.label,
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
            h(
              'div',
              { className: 'pg-row-label' },
              item.label,
              props.showGroup && item.group ? h('span', { className: 'pg-row-group' }, item.group) : null
            ),
            item.hint ? h('div', { className: 'pg-row-hint' }, item.hint) : null
          ),
          h('div', { className: 'pg-row-ctl' }, h(Control, props))
        );
      }

      function matchesSettingSearch(item, tokens, tagId) {
        if (!item) return false;
        if (tagId) {
          if (!Array.isArray(item.tags) || item.tags.indexOf(tagId) < 0) return false;
        }
        if (!tokens.length) return true;
        var optText = Array.isArray(item.options)
          ? item.options.map(function (o) { return Array.isArray(o) ? o.join(' ') : String(o || ''); }).join(' ')
          : '';
        var hay = [
          item.label || '',
          item.hint || '',
          item.path || '',
          item.group || '',
          item.unit || '',
          optText,
        ].join(' ').toLowerCase();
        for (var i = 0; i < tokens.length; i++) {
          if (hay.indexOf(tokens[i]) < 0) return false;
        }
        return true;
      }

      function Group(props) {
        var g = props.group;
        var timing = g.name === '时间间隔';
        var [query, setQuery] = useState('');
        var foldKey = 'group:' + g.name;
        var [open, setOpen] = useState(function () { return readFoldState(foldKey, Boolean(g.defaultOpen)); });
        var [subOpen, setSubOpen] = useState(function () {
          var init = {};
          (g.items || []).forEach(function (item) {
            if (item && item.foldSection && !Object.prototype.hasOwnProperty.call(init, item.foldSection)) {
              init[item.foldSection] = readFoldState('sub:' + g.name + ':' + item.foldSection, false);
            }
          });
          return init;
        });
        var keyword = query.trim().toLowerCase();
        var visible = timing && keyword ? g.items.filter(function (item) {
          return (item.label + ' ' + (item.hint || '')).toLowerCase().includes(keyword);
        }) : g.items;
        // 注释排在板块**上面**（她要求的：日常板块头上先提醒一句），不混进标题行
        var note = g.note ? h('div', { className: 'pg-note' }, g.note) : null;
        var wrap = function (card) {
          return note ? h('div', { className: 'pg-group' }, note, card) : card;
        };
        var mainItems = [];
        var foldSections = [];
        var foldSectionMap = {};
        visible.forEach(function (item) {
          if (item && item.foldSection) {
            if (!foldSectionMap[item.foldSection]) {
              foldSectionMap[item.foldSection] = { name: item.foldSection, items: [] };
              foldSections.push(foldSectionMap[item.foldSection]);
            }
            foldSectionMap[item.foldSection].items.push(item);
          } else {
            mainItems.push(item);
          }
        });
        var renderRows = function (list) {
          return h(
            'div',
            { className: 'pg-rows' },
            list.map(function (item) {
              return h(Row, { key: item.path, item: item, busy: props.busy, onSave: props.onSave });
            })
          );
        };
        var rows = h(
          React.Fragment,
          null,
          props.topExtra || null,
          mainItems.length ? renderRows(mainItems) : null,
          props.extra || null,
          foldSections.map(function (sec) {
            var secOpen = Boolean(timing && keyword) || Boolean(subOpen[sec.name]);
            return h(
              'details',
              {
                key: 'sub-' + sec.name,
                className: 'pg-exp-details pg-sub-fold',
                open: secOpen,
                onToggle: function (e) {
                  var isOpen = e.currentTarget.open;
                  if (Boolean(subOpen[sec.name]) === isOpen) return;
                  writeFoldState('sub:' + g.name + ':' + sec.name, isOpen);
                  setSubOpen(function (prev) {
                    var next = Object.assign({}, prev);
                    next[sec.name] = isOpen;
                    return next;
                  });
                },
              },
              h(
                'summary',
                { className: 'pg-exp-sum' },
                h('span', null, sec.name),
                h('span', { className: 'pg-card-count', style: { marginLeft: 'auto' } }, sec.items.length + ' 项')
              ),
              renderRows(sec.items)
            );
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
            {
              className: 'pg-card pg-card-fold',
              open: open,
              onToggle: function (e) {
                var isOpen = e.currentTarget.open;
                if (open === isOpen) return;
                writeFoldState(foldKey, isOpen);
                setOpen(isOpen);
              },
            },
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

      // ------------------------------------------------------------ 一键节奏套餐

      function formatPresetVal(field, val) {
        if (field.type === 'bool') return val ? '开' : '关';
        if (field.type === 'select' && Array.isArray(field.options)) {
          var hit = field.options.find(function (o) { return o[0] === val; });
          return hit ? hit[1] : String(val);
        }
        return String(val) + (field.unit ? ' ' + field.unit : '');
      }

      function PresetCard(props) {
        var data = props.data;
        if (!data || !Array.isArray(data.presets)) return null;
        var active = data.active || 'custom';
        var activeObj = data.presets.find(function (p) { return p.id === active; });
        var activeLabel = active === 'custom' ? '自定义' : (activeObj ? activeObj.label : active);
        var activeDesc = active === 'custom'
          ? (data.hasCustomSnapshot
              ? '当前使用你自己的个性化参数。切换到任意套餐后，随时点「自定义」可一键恢复你原来的参数。'
              : '当前使用你自己的个性化参数（手动修改下方节奏或探索参数时会自动保持为「自定义」）。')
          : (activeObj ? activeObj.desc : '');
        return h(
          'details',
          { className: 'pg-card pg-card-fold', open: true },
          h(
            'summary',
            { className: 'pg-card-title pg-card-sum' },
            h('span', { className: 'pg-card-sum-name' }, '一键节奏套餐'),
            h('span', { className: 'pg-card-sub' }, '快速切换主动频率与探索节奏'),
            h('span', { className: 'pg-badge' + (active === 'custom' ? '' : ' pg-badge-live') }, '当前：' + activeLabel)
          ),
          h(
            'div',
            { className: 'pg-chips', role: 'group', 'aria-label': '一键节奏套餐', style: { marginTop: '8px' } },
            h(
              'button',
              {
                type: 'button',
                className: 'pg-chip' + (active === 'custom' ? ' pg-chip-on' : ''),
                disabled: props.busy || active === 'custom',
                onClick: function () { props.onApply('custom'); },
              },
              data.hasCustomSnapshot && active !== 'custom' ? '自定义（恢复原参数）' : '自定义'
            ),
            data.presets.map(function (p) {
              var on = active === p.id;
              return h(
                'button',
                {
                  key: p.id,
                  type: 'button',
                  className: 'pg-chip' + (on ? ' pg-chip-on' : ''),
                  disabled: props.busy,
                  onClick: function () { props.onApply(p.id); },
                },
                p.label + (p.customized ? ' · 已微调' : '')
              );
            })
          ),
          h('div', { className: 'pg-note', style: { marginTop: '8px' } }, activeDesc),
          h('div', { className: 'pg-row-hint', style: { marginTop: '4px' } }, '只调主动节奏与探索参数，不改静默/忙碌、课表、人设、通道或真实发送开关；手动改下方对应参数后自动变为「自定义」，各套餐默认参数可在「高级」里自定义。')
        );
      }

      function PresetEditor(props) {
        var data = props.data;
        var [presetId, setPresetId] = useState('daily');
        var [fieldPath, setFieldPath] = useState('');
        var [draftVal, setDraftVal] = useState('');
        if (!data || !Array.isArray(data.presets) || !Array.isArray(data.fields)) return null;
        var chosen = data.presets.find(function (p) { return p.id === presetId; }) || data.presets[0];
        var chosenField = fieldPath ? data.fields.find(function (f) { return f.path === fieldPath; }) : null;
        var currentVal = chosen && chosenField ? chosen.values[chosenField.path] : undefined;

        function selectPreset(id) {
          setPresetId(id);
          if (chosenField) {
            var nextP = data.presets.find(function (p) { return p.id === id; });
            var nv = nextP ? nextP.values[chosenField.path] : '';
            setDraftVal(nv === undefined ? '' : String(nv));
          }
        }

        function selectField(path) {
          setFieldPath(path);
          var f = data.fields.find(function (x) { return x.path === path; });
          if (f && chosen) {
            var v = chosen.values[f.path];
            setDraftVal(v === undefined ? '' : String(v));
          } else {
            setDraftVal('');
          }
        }

        return h(
          'div',
          { style: { padding: '8px 2px 4px', marginTop: '6px', borderTop: '1px solid var(--pg-line-soft)' } },
          h('div', { className: 'pg-row-label', style: { marginBottom: '6px' } }, '自定义各套餐参数'),
          h('div', { className: 'pg-row-hint', style: { marginBottom: '8px' } }, '先选要修改的套餐，再选子参数进行调整。若修改的正是当前激活套餐，保存后会立即同步生效到当前配置。'),
          h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' } },
            h(
              'select',
              {
                className: 'pg-input',
                'aria-label': '选择要修改参数的套餐',
                value: chosen ? chosen.id : '',
                disabled: props.busy,
                onChange: function (e) { selectPreset(e.target.value); },
              },
              data.presets.map(function (p) {
                return h('option', { key: p.id, value: p.id }, p.label + (p.customized ? '（已修改）' : ''));
              })
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pg-btn',
                disabled: props.busy || !chosen || !chosen.customized,
                onClick: function () { if (chosen) props.onReset(chosen.id); },
              },
              '恢复该套餐默认'
            )
          ),
          chosen ? h(
            'div',
            { style: { marginBottom: chosenField ? '8px' : '0' } },
            h(
              'select',
              {
                className: 'pg-input',
                style: { width: '100%' },
                'aria-label': '选择要调整的套餐参数',
                value: fieldPath,
                disabled: props.busy,
                onChange: function (e) { selectField(e.target.value); },
              },
              h('option', { value: '' }, '—— 请选择「' + chosen.label + '」要调整的参数 ——'),
              data.fields.map(function (f) {
                return h(
                  'option',
                  { key: f.path, value: f.path },
                  f.label + '（当前：' + formatPresetVal(f, chosen.values[f.path]) + '）'
                );
              })
            )
          ) : null,
          chosen && chosenField ? h(
            'div',
            { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', paddingTop: '4px' } },
            h('span', { className: 'pg-row-hint' }, chosenField.label + '：'),
            chosenField.type === 'bool'
              ? h(
                  'select',
                  {
                    className: 'pg-input',
                    value: currentVal ? 'true' : 'false',
                    disabled: props.busy,
                    onChange: function (e) { props.onOverride(chosen.id, chosenField.path, e.target.value === 'true'); },
                  },
                  h('option', { value: 'true' }, '开'),
                  h('option', { value: 'false' }, '关')
                )
              : chosenField.type === 'select'
              ? h(
                  'select',
                  {
                    className: 'pg-input',
                    value: String(currentVal ?? ''),
                    disabled: props.busy,
                    onChange: function (e) { props.onOverride(chosen.id, chosenField.path, e.target.value); },
                  },
                  (chosenField.options || []).map(function (o) {
                    return h('option', { key: o[0], value: o[0] }, o[1]);
                  })
                )
              : h(
                  React.Fragment,
                  null,
                  h('input', {
                    className: 'pg-input',
                    type: 'number',
                    style: { width: '96px' },
                    min: chosenField.min,
                    max: chosenField.max,
                    step: chosenField.type === 'num' ? 0.01 : 1,
                    value: draftVal,
                    disabled: props.busy,
                    onChange: function (e) { setDraftVal(e.target.value); },
                  }),
                  chosenField.unit ? h('span', { className: 'pg-unit' }, chosenField.unit) : null,
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: props.busy,
                      onClick: function () { props.onOverride(chosen.id, chosenField.path, Number(draftVal)); },
                    },
                    '保存参数'
                  ),
                  chosenField.min != null && chosenField.max != null
                    ? h('span', { className: 'pg-row-hint' }, '范围 ' + chosenField.min + '–' + chosenField.max + (chosenField.unit ? ' ' + chosenField.unit : ''))
                    : null
                )
          ) : null
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

        var activeTask = st.activeTask || null;
        var taskElapsed = activeTask && activeTask.startedAt
          ? Math.max(0, Math.round((Date.now() - Number(activeTask.startedAt)) / 1000))
          : 0;
        var taskTitle = activeTask
          ? '当前后台任务：' + (activeTask.label || '后台任务') + (taskElapsed > 0 ? '（已运行 ' + taskElapsed + ' 秒）' : '') + '，点击中止'
          : '';

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
            activeTask ? h(
              'button',
              {
                className: 'pg-btn pg-btn-warn',
                type: 'button',
                disabled: props.taskStopPending,
                onClick: props.onTaskStop,
                title: taskTitle,
              },
              props.taskStopPending ? '正在中止…' : '中止后台任务'
            ) : null,
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
                disabled: props.busy || st.running || !st.enabled,
                onClick: props.onTick,
                title: !st.enabled ? '请先开启总开关' : st.running ? '上一拍还在跑' : '立刻按现在的时间跑一拍（演练模式下不会发出去）',
              },
              props.tickPending || st.running ? '跑着呢…' : '立刻跑一拍'
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

      var EXPLORE_NOTICE = {
        CANCELLED: '探索已停止，本轮结果未保存',
        EXPLORATION_TIMEOUT: '探索超时，本轮结果未保存',
        FULLSCREEN_GAME: '检测到进入全屏游戏，已中止本轮探索并保留已有进度',
        FULLSCREEN_COOLDOWN: '退出全屏游戏缓冲期内，暂不启动自动探索'
      };

      function ExplorationTopicIssue(props) {
        var issue = props.issue;
        var [sourceUrl, setSourceUrl] = useState('');
        var ambiguous = issue.reason === 'TOPIC_AMBIGUOUS';
        var canChooseKind = ambiguous && (issue.field === 'nextTopic' || issue.field === 'interest');
        var candidates = Array.isArray(issue.candidates) ? issue.candidates : [];
        var title = '「' + (issue.title || issue.input) + '」';
        var hint = ambiguous ? '这个标题可能是作品，也可能是普通主题。'
          : issue.reason === 'WORK_SOURCE_UNAVAILABLE' ? '暂时读不到已选来源，请换一个公开页面。'
            : '请选择一个能确认这部作品的公开页面。';
        return h('section', { className: 'pg-exp-details', 'aria-label': '探索主题待确认' },
          h('strong', { className: 'pg-row-label' }, ambiguous ? '确认' + title + '的探索方式' : '为' + title + '选择来源'),
          h('div', { className: 'pg-row-hint' }, hint),
          canChooseKind ? h('div', { className: 'pg-exp-actions' },
            h('button', { className: 'pg-btn', type: 'button', disabled: props.busy,
              onClick: function () { props.onResolve(issue, 'work'); } }, '按作品探索'),
            h('button', { className: 'pg-btn', type: 'button', disabled: props.busy,
              onClick: function () { props.onResolve(issue, 'topic'); } }, '按普通主题探索')
          ) : null,
          candidates.length ? h('ul', { className: 'pg-check-rows pg-notebook-list' }, candidates.map(function (candidate) {
            return h('li', { key: candidate.url },
              h('div', null, candidate.label || candidate.url,
                candidate.label ? h('div', { className: 'pg-row-hint' }, candidate.url) : null),
              h('button', { className: 'pg-btn', type: 'button', disabled: props.busy,
                'aria-label': '使用来源 ' + (candidate.label || candidate.url),
                onClick: function () { props.onResolve(issue, 'source', candidate.url); } }, '使用此来源'));
          })) : null,
          h('form', { className: 'pg-exp-actions', onSubmit: function (event) {
            event.preventDefault();
            if (!props.busy && sourceUrl.trim()) props.onResolve(issue, 'source', sourceUrl.trim());
          } },
            h('input', { className: 'pg-input pg-input-wide', type: 'url', value: sourceUrl,
              'aria-label': '作品的公开来源网址', placeholder: 'https://…', required: true, disabled: props.busy,
              onChange: function (event) { setSourceUrl(event.target.value); } }),
            h('button', { className: 'pg-btn', type: 'submit', disabled: props.busy || !sourceUrl.trim() }, '保存网址')));
      }

      // ------------------------------------------------------------ 页面

      function Panel() {
        var [state, setState] = useState(null);
        var [groups, setGroups] = useState([]);
        var [presets, setPresets] = useState(null);
        var [explorationItems, setExplorationItems] = useState([]);
        var [channelItems, setChannelItems] = useState([]);
        var [hiddenItems, setHiddenItems] = useState([]);
        var [searchTags, setSearchTags] = useState([]);
        var [searchQuery, setSearchQuery] = useState('');
        var [searchTag, setSearchTag] = useState('');
        var [error, setError] = useState('');
        var [toast, setToast] = useState(null);
        var [actionBusy, setBusy] = useState(false);
        var [explorePending, setExplorePending] = useState(false);
        var [exploreStopPending, setExploreStopPending] = useState(false);
        var [taskStopPending, setTaskStopPending] = useState(false);
        var [exploreTopicPending, setExploreTopicPending] = useState(false);
        var [smallActionPending, setSmallActionPending] = useState(false);
        var [exploreResult, setExploreResult] = useState(null);
        var [showExplorationDetails, setShowExplorationDetails] = useState(false);
        var [memoryCardOpen, setMemoryCardOpen] = useState(function () { return readFoldState('card:memory', true); });
        var [explorationCardOpen, setExplorationCardOpen] = useState(function () { return readFoldState('card:exploration', true); });
        var [channelCardOpen, setChannelCardOpen] = useState(function () { return readFoldState('card:channels', true); });
        var [presetEditorOpen, setPresetEditorOpen] = useState(function () { return readFoldState('sub:高级:套餐自定义', false); });
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
        var [refreshing, setRefreshing] = useState(false);
        var [tickPending, setTickPending] = useState(false);
        var busy = actionBusy || refreshing || tickPending;
        var guideAnchor = useRef(null);
        var diagnosticRequest = useRef(0);
        var stateRequest = useRef(0);
        var stateRequestsInFlight = useRef(0);
        var manualExploreRequest = useRef(null);
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
            stateRequestsInFlight.current += 1;
            if (!silent) setRefreshing(true);
            return Promise.all([apiGet('/state'), apiGet('/config')])
              .then(function (r) {
                if (!mounted.current || request !== stateRequest.current) return;
                setState(r[0]);
                setGroups(r[1].groups || []);
                if (r[1].presets) setPresets(r[1].presets);
                setExplorationItems(r[1].explorationItems || []);
                setChannelItems(r[1].channelItems || []);
                setHiddenItems(r[1].hiddenItems || []);
                if (Array.isArray(r[1].searchTags)) setSearchTags(r[1].searchTags);
                setError('');
              })
              .catch(function (e) {
                if (!mounted.current || request !== stateRequest.current) return;
                setError(e && e.message ? e.message : String(e));
              })
              .finally(function () {
                stateRequestsInFlight.current -= 1;
                if (!mounted.current || request !== stateRequest.current) return;
                setRefreshing(false);
                setLoading(false);
              });
          },
          []
        );

        var applySavedConfig = useCallback(function (data) {
          // 这次写入的回显更新后，之前发出的读取不能再覆盖它。
          stateRequest.current += 1;
          setRefreshing(false);
          if (data.state) setState(data.state);
          if (Array.isArray(data.groups)) setGroups(data.groups);
          if (data.presets) setPresets(data.presets);
          if (Array.isArray(data.explorationItems)) setExplorationItems(data.explorationItems);
          if (Array.isArray(data.channelItems)) setChannelItems(data.channelItems);
          if (Array.isArray(data.hiddenItems)) setHiddenItems(data.hiddenItems);
          if (Array.isArray(data.searchTags)) setSearchTags(data.searchTags);
          setError('');
        }, []);

        useEffect(function () {
          mounted.current = true;
          load(false);
          // 状态每 15 秒刷一次就够（判定本身是 10 分钟一拍）
          var t = setInterval(function () {
            if (mounted.current && !stateRequestsInFlight.current) load(true);
          }, 15000);
          var onVisible = function () {
            if (mounted.current && !stateRequestsInFlight.current && typeof document !== 'undefined' && document.visibilityState === 'visible') {
              load(true);
            }
          };
          if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', onVisible);
          }
          return function () {
            mounted.current = false;
            clearInterval(t);
            if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
              document.removeEventListener('visibilitychange', onVisible);
            }
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
                applySavedConfig(r);
                setConnectivity(null);
                setPreview(null);
                loadDiagnostics();
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
          [applySavedConfig, flash, load, loadDiagnostics]
        );

        var onTick = useCallback(
          function () {
            setTickPending(true);
            apiPost('/tick')
              .then(function (r) {
                if (!mounted.current) return;
                if (r && r.state) setState(r.state);
                if (!r || r.ok !== true) {
                  var message = r && r.skipped === 'disabled'
                    ? '总开关已关闭，这一拍未运行'
                    : (r && r.error) || '这一拍未能完成';
                  flash(message, 'err');
                  return;
                }
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
                if (mounted.current) setTickPending(false);
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
            flash((result && result.note) || '已更新', 'ok');
            load(true);
          }).catch(function (error) {
            if (mounted.current) flash(error.message || '暂时无法保存，请重试。', 'err');
          }).finally(function () {
            if (mounted.current) setSmallActionPending(false);
          });
        }

        function applyPresetAction(endpoint, body) {
          setBusy(true);
          apiPost(endpoint, body).then(function (r) {
            if (!mounted.current) return;
            if (!r || r.ok !== true) throw new Error((r && r.error) || '套餐保存失败');
            applySavedConfig(r);
            flash((r.notes && r.notes[0]) || '已更新套餐', 'ok');
          }).catch(function (e) {
            if (mounted.current) flash((e && e.message) || '套餐保存失败', 'err');
          }).finally(function () {
            if (mounted.current) setBusy(false);
          });
        }

        function onExplore() {
          if (manualExploreRequest.current || exploreStopPending) return;
          var request = {};
          manualExploreRequest.current = request;
          setExplorePending(true);
          setExploreResult(null);
          apiPost('/explore', {}).then(function (r) {
            if (!mounted.current || manualExploreRequest.current !== request) return;
            if (r.state) setState(r.state);
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
              TOPIC_AMBIGUOUS: '请先确认这个标题的探索方式',
              WORK_SOURCE_REQUIRED: '请先为作品选择公开来源',
              WORK_SOURCE_UNAVAILABLE: '暂时读不到作品来源，请更换来源'
            };
            var detail = r.note ? '（' + r.note + '）' : '';
            var message = r.ok
              ? (r.action === 'skip' ? '本轮已结束，角色选择跳过' : '本轮已结束，探索进展已保存')
              : ((EXPLORE_NOTICE[r.reason] || labels[r.reason] || r.reason || '探索失败') + detail);
            var nextExploration = r.state && r.state.exploration;
            setExploreResult({ text: message, error: !r.ok && r.reason !== 'CANCELLED',
              runNotice: nextExploration && nextExploration.runNotice });
            if (r.ok && r.action !== 'skip') setShowExplorationDetails(true);
            load(true);
          }).catch(function (e) {
            if (!mounted.current || manualExploreRequest.current !== request) return;
            setExploreResult({ text: e.message || '探索请求失败', error: true, runNotice: exploration && exploration.runNotice });
            load(true);
          }).finally(function () {
            if (manualExploreRequest.current === request) {
              manualExploreRequest.current = null;
              if (mounted.current) setExplorePending(false);
            }
          });
        }

        function onExploreStop() {
          if (!exploring || exploreStopPending) return;
          var pendingRequest = manualExploreRequest.current;
          var runId = exploration && exploration.running && exploration.runId;
          setExploreStopPending(true);
          setExploreResult(null);
          apiPost('/explore/stop', runId ? { runId: runId } : {}).then(function (r) {
            if (!mounted.current) return;
            var nextExploration = r.state && r.state.exploration;
            if (r.ok && r.reason === 'CANCELLED') {
              // 停止确认可以先于试跑响应到达，后到的试跑响应不再更新界面。
              if (manualExploreRequest.current === pendingRequest) {
                manualExploreRequest.current = null;
                setExplorePending(false);
              }
              if (r.state) setState(r.state);
              setExploreResult({ text: EXPLORE_NOTICE.CANCELLED, error: false,
                runNotice: nextExploration && nextExploration.runNotice });
            } else if (!pendingRequest || manualExploreRequest.current === pendingRequest) {
              if (r.state) setState(r.state);
              var notRunning = pendingRequest ? '试跑请求仍在等待，可以稍后再试停止' : '当前没有正在运行的探索';
              var message = r.reason === 'STALE_RUN' ? '当前探索轮次已更换，请重新确认后停止'
                : r.reason === 'NOT_RUNNING' ? notRunning : '暂时无法停止探索';
              setExploreResult({ text: message, error: r.reason !== 'NOT_RUNNING',
                runNotice: nextExploration && nextExploration.runNotice });
            }
            load(true);
          }).catch(function (e) {
            if (!mounted.current) return;
            setExploreResult({ text: e.message || '停止请求失败，请重试', error: true,
              runNotice: exploration && exploration.runNotice });
            load(true);
          }).finally(function () {
            if (mounted.current) setExploreStopPending(false);
          });
        }

        function onTaskStop() {
          var activeTask = state && state.activeTask;
          if (!activeTask || taskStopPending) return;
          setTaskStopPending(true);
          apiPost('/task/stop', activeTask.id ? { taskId: activeTask.id } : {}).then(function (r) {
            if (!mounted.current) return;
            if (r.state) setState(r.state);
            flash(r.note || (r.ok ? '后台任务已中止' : '当前没有正在运行的后台任务'), r.ok || r.reason === 'NOT_RUNNING' ? 'ok' : 'err');
            load(true);
          }).catch(function (e) {
            if (!mounted.current) return;
            flash(e.message || '中止后台任务失败，请重试', 'err');
            load(true);
          }).finally(function () {
            if (mounted.current) setTaskStopPending(false);
          });
        }

        function onExploreTopic(issue, choice, url) {
          if (exploreTopicPending) return;
          setExploreTopicPending(true);
          var body = { input: issue.input, field: issue.field, choice: choice };
          if (url) body.url = url;
          function applyResult(r) {
            if (!mounted.current) return;
            if (r.state) setState(r.state);
            if (Array.isArray(r.explorationItems)) setExplorationItems(r.explorationItems);
            var labels = {
              TOPIC_CHANGED: '探索主题已更换，请重新确认',
              INVALID_SOURCE: '请输入可公开访问的作品网址',
              INVALID_CHOICE: '当前主题无法使用这个选项'
            };
            var message = r.ok ? ((r.notes && r.notes[0]) || (choice === 'source' ? '已保存作品来源' : '已保存探索方式'))
              : (labels[r.reason] || r.error || '暂时无法保存，请重试');
            var nextExploration = r.state && r.state.exploration;
            setExploreResult({ text: message, error: !r.ok,
              runNotice: nextExploration ? nextExploration.runNotice : exploration && exploration.runNotice });
            load(true);
          }
          apiPost('/explore/topic', body).then(applyResult).catch(function (e) {
            applyResult(e.body || { ok: false, error: e.message });
          }).finally(function () {
            if (mounted.current) setExploreTopicPending(false);
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
          if (primaryChannel) loadHostSessions();
        }, [primaryChannel, loadHostSessions]);

        function onBindChatSession(body) {
          setBindingBusy(true);
          apiPost('/chat/session', body).then(function (r) {
            if (!mounted.current) return;
            if (!r || r.ok === false) throw new Error((r && r.error) || '切换会话失败');
            if (r.state) setState(r.state);
            if (r.sessionId) setSelectedSessionId(r.sessionId);
            setConnectivity(null);
            setPreview(null);
            loadDiagnostics();
            loadHostSessions();
            flash((r.notes && r.notes[0]) || '聊天接入会话已切换', 'ok');
          }).catch(function (e) {
            if (mounted.current) flash((e && e.message) || '切换会话失败', 'err');
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
        var topicIssue = exploration && exploration.topicIssue;
        var runNotice = exploration && exploration.runNotice;
        var explorationStatus = exploreResult && (!exploreResult.runNotice || exploreResult.runNotice === runNotice) ? exploreResult : null;
        if (!exploring && !exploreStopPending && EXPLORE_NOTICE[runNotice] && (!exploreResult || exploreResult.runNotice !== runNotice)) {
          explorationStatus = { text: EXPLORE_NOTICE[runNotice], error: runNotice === 'EXPLORATION_TIMEOUT' };
        }
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
              var selected = entry.action === option[0];
              return h('button', { key: option[0], type: 'button', className: 'pg-btn' + (selected ? ' pg-btn-primary' : ''),
                disabled: smallActionPending, 'aria-pressed': selected,
                title: selected ? '已选中，再次点击可取消' : '',
                onClick: function () {
                  applySmallAction('/exploration/feedback', { id: entry.id, action: selected ? 'clear' : option[0] });
                } }, option[1]);
            }));
        }
        function sourceLinks(entry) {
          return (entry && entry.sources || []).filter(function (s) { return /^https?:\/\//i.test(s.url); }).map(function (s) {
            return h('div', { className: 'pg-exp-item', key: s.url },
              s.evidence + ' · ', h('a', { className: 'pg-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title));
          });
        }
        function activeExplorationEntries() {
          var list = [];
          var mode = exploration && exploration.mode;
          if (mode === 'light') {
            if (lightExp) list.push({ kind: 'light', label: '随手看看', entry: lightExp });
          } else {
            if (thread) list.push({ kind: 'thread', label: '研究', entry: thread });
            if (leisure) list.push({ kind: 'leisure', label: '休闲', entry: leisure });
            if (!list.length && lightExp && mode !== 'deep') {
              list.push({ kind: 'light', label: '随手看看', entry: lightExp });
            }
          }
          list.sort(function (a, b) { return (Number(b.entry && b.entry.at) || 0) - (Number(a.entry && a.entry.at) || 0); });
          return list;
        }
        function renderExplorationEntry(item) {
          var entry = item.entry;
          var meta = [['进度', entry.checkpoint], ['新发现', entry.discovery], ['待确认', entry.waitingFor]]
            .filter(function (pair) { return pair[1]; }).map(function (pair) {
              return h('div', { key: item.kind + '-' + pair[0], className: 'pg-exp-item' }, item.label + ' · ' + pair[0] + '：' + pair[1]);
            });
          var bodyText = entry.summary || entry.progress || '';
          return h('div', { key: item.kind, className: 'pg-exp-list' },
            meta,
            h('div', { className: 'pg-exp-highlight' }, item.label + ' · ' + entry.topic + '：' + bodyText),
            entry.next ? h('div', { className: 'pg-exp-item' }, '下一步：' + entry.next) : null,
            sourceLinks(entry),
            feedbackButtons(item.kind)
          );
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
        var extInfo = (state && state.extensions) || {};
        var extCount = (extInfo.exploreSources ? extInfo.exploreSources.length : 0) +
          (extInfo.moodSources ? extInfo.moodSources.length : 0) +
          (extInfo.memorySources ? extInfo.memorySources.length : 0) +
          (extInfo.topicProviders ? extInfo.topicProviders.length : 0);
        var hasModules = Boolean(state || (emotion && emotion.installed) || (memory && memory.enabled && memory.files && memory.files.length) || rollovers.length || exploration || extCount > 0);
        var trimmedSearch = searchQuery.trim().toLowerCase();
        var searchTokens = trimmedSearch ? trimmedSearch.split(/\s+/).filter(Boolean) : [];
        var searchActive = Boolean(searchTokens.length || searchTag);
        var allVisibleItems = [];
        var seenSearchPaths = {};
        [channelItems, explorationItems].forEach(function (arr) {
          (arr || []).forEach(function (item) {
            if (item && item.path && !seenSearchPaths[item.path]) {
              seenSearchPaths[item.path] = true;
              allVisibleItems.push(item);
            }
          });
        });
        (groups || []).forEach(function (g) {
          (g && g.items || []).forEach(function (item) {
            if (item && item.path && !seenSearchPaths[item.path]) {
              seenSearchPaths[item.path] = true;
              allVisibleItems.push(item);
            }
          });
        });
        var memPluginItem = allVisibleItems.find(function (i) { return i.path === 'sources.memory.plugin'; }) ||
          allVisibleItems.find(function (i) { return i.path === 'sources.memory.enabled'; }) || null;
        var moodSourceItem = allVisibleItems.find(function (i) { return i.path === 'exploration.moodSource'; }) || null;
        var extraToolsItem = allVisibleItems.find(function (i) { return i.path === 'exploration.extraTools'; }) || null;
        var extTimeoutItem = allVisibleItems.find(function (i) { return i.path === 'exploration.extTimeoutMs'; }) || null;
        var matchedSettings = searchActive ? allVisibleItems.filter(function (item) {
          return matchesSettingSearch(item, searchTokens, searchTag);
        }) : [];
        var matchedHidden = searchActive ? (hiddenItems || []).filter(function (item) {
          return matchesSettingSearch(item, searchTokens, searchTag);
        }) : [];
        var activeTagObj = searchTag ? (searchTags || []).find(function (t) { return t.id === searchTag; }) : null;

        return h(
          'div',
          { className: 'pg-root' },
          state ? h(Head, { state: state, busy: busy || guidePending === 'preview', tickPending: tickPending,
            taskStopPending: taskStopPending, onTaskStop: onTaskStop, onGuide: openGuide,
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
          presets ? h(PresetCard, {
            data: presets,
            busy: busy,
            onApply: function (id) { applyPresetAction('/presets/apply', { id: id }); },
          }) : null,
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
          allVisibleItems.length ? h('section', { className: 'pg-card pg-search-card', 'aria-label': '全局设置搜索' },
            h('div', { className: 'pg-search-bar' },
              h('input', {
                className: 'pg-input pg-search-input',
                type: 'search',
                'aria-label': '全局搜索设置项',
                placeholder: activeTagObj
                  ? '在「' + activeTagObj.label + '」内按字搜索（名称、说明或配置键）…'
                  : '全局搜索设置项（按字匹配，如 分享、冷却、作息、OCR、邮箱）…',
                value: searchQuery,
                onChange: function (e) { setSearchQuery(e.target.value); },
              }),
              searchActive ? h('button', {
                type: 'button',
                className: 'pg-btn',
                onClick: function () { setSearchQuery(''); setSearchTag(''); },
              }, '清空') : null
            ),
            searchTags.length ? h('div', { className: 'pg-chips', role: 'group', 'aria-label': '按关键词筛选设置' },
              h('button', {
                type: 'button',
                className: 'pg-chip' + (!searchTag ? ' pg-chip-on' : ''),
                'aria-pressed': !searchTag,
                onClick: function () { setSearchTag(''); },
              }, '全部'),
              searchTags.map(function (tag) {
                var on = searchTag === tag.id;
                return h('button', {
                  key: tag.id,
                  type: 'button',
                  className: 'pg-chip' + (on ? ' pg-chip-on' : ''),
                  'aria-pressed': on,
                  onClick: function () { setSearchTag(on ? '' : tag.id); },
                }, tag.label);
              })
            ) : null,
            searchActive ? h('div', { className: 'pg-search-results' },
              h('div', { className: 'pg-search-meta' },
                h('span', null,
                  (activeTagObj ? '关键词「' + activeTagObj.label + '」' : '全局搜索') +
                  (trimmedSearch ? ' · “' + searchQuery.trim() + '”' : '') +
                  ' · 找到 ' + matchedSettings.length + ' 项'
                )
              ),
              matchedSettings.length
                ? h('div', { className: 'pg-rows' }, matchedSettings.map(function (item) {
                    return h(Row, { key: item.path, item: item, busy: busy, onSave: onSave, showGroup: true });
                  }))
                : h('div', { className: 'pg-row-hint', style: { padding: '8px 0' } }, '没有匹配的当前可用设置项。'),
              matchedHidden.length ? h('div', { className: 'pg-row-hint pg-search-hidden-note' },
                '另有 ' + matchedHidden.length + ' 项相关设置因父开关关闭而隐藏：' +
                matchedHidden.slice(0, 6).map(function (item) {
                  var deps = item.depLabels && item.depLabels.length ? '（需先开启「' + item.depLabels.join('」「') + '」）' : '';
                  return item.label + deps;
                }).join('、') +
                (matchedHidden.length > 6 ? ' 等。' : '。')
              ) : null
            ) : null
          ) : null,
          !searchActive ? h(React.Fragment, null,
          hasModules ? h('div', { className: 'pg-sec-label' }, '联动模块与状态') : null,
          state ? h('details', { className: 'pg-card pg-card-fold' },
            h('summary', { className: 'pg-card-title pg-card-sum' },
              h('span', { className: 'pg-card-sum-name' }, '已接入的第三方扩展'),
              h('span', { className: 'pg-card-sub' }, '刷 B 站 / 心情 / 记忆 / 自定义由头'),
              extCount > 0
                ? h('span', { className: 'pg-badge pg-badge-live' }, extCount + ' 个已注册')
                : h('span', { className: 'pg-badge' }, '接口已就绪（0 个已注册）')
            ),
            h('div', { className: 'pg-rows' },
              extCount > 0 ? h(React.Fragment, null,
                extInfo.exploreSources && extInfo.exploreSources.length ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '探索源扩展'),
                    h('div', { className: 'pg-row-hint' }, extInfo.exploreSources.map(function (s) { return s.label + '（' + s.id + '）'; }).join('、'))
                  )
                ) : null,
                extInfo.moodSources && extInfo.moodSources.length ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '心情扩展'),
                    h('div', { className: 'pg-row-hint' }, extInfo.moodSources.map(function (s) { return s.label + '（' + s.id + '）'; }).join('、'))
                  )
                ) : null,
                extInfo.memorySources && extInfo.memorySources.length ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '记忆扩展'),
                    h('div', { className: 'pg-row-hint' }, extInfo.memorySources.map(function (s) { return s.label + '（' + s.id + '）'; }).join('、'))
                  )
                ) : null,
                extInfo.topicProviders && extInfo.topicProviders.length ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '自定义主动由头'),
                    h('div', { className: 'pg-row-hint' }, extInfo.topicProviders.map(function (s) { return s.label + '（' + s.slot + '）'; }).join('、'))
                  )
                ) : null
              ) : h('div', { className: 'pg-row' },
                h('div', { className: 'pg-row-text' },
                  h('div', { className: 'pg-row-label' }, '支持接入刷 B 站、心情/好感度、长期记忆与自定义主动由头'),
                  h('div', { className: 'pg-row-hint' }, '插件代码可通过 ctx.presenceGate.registerExploreSource / registerMoodSource / registerMemorySource / registerTopicProvider 注册；免代码可在下方填写宿主只读工具名，或往 data/extensions/{mood,topics}.json 投递 JSON（详见 docs/EXTENSIONS.md）。')
                )
              ),
              memPluginItem ? h(Row, { key: 'ext-card-' + memPluginItem.path, item: memPluginItem, busy: busy, onSave: onSave }) : null,
              moodSourceItem ? h(Row, { key: 'ext-card-' + moodSourceItem.path, item: moodSourceItem, busy: busy, onSave: onSave }) : null,
              extraToolsItem ? h(Row, { key: 'ext-card-' + extraToolsItem.path, item: extraToolsItem, busy: busy, onSave: onSave }) : null,
              extTimeoutItem ? h(Row, { key: 'ext-card-' + extTimeoutItem.path, item: extTimeoutItem, busy: busy, onSave: onSave }) : null
            )
          ) : null,
          emotion && (emotion.installed || emotion.activeKind === 'external' || emotion.activeKind === 'merge') ? (function () {
            var emTitle = emotion.activePluginLabel || ('emotion-state-portrait' + (emotion.version ? ' v' + emotion.version : ''));
            var emKind = emotion.activeKind || 'builtin';
            return h('div', { className: 'pg-card' },
              h('div', { className: 'pg-card-head' },
                h('div', { className: 'pg-card-title' }, '情绪状态（' + emTitle + '）'),
                emKind === 'external'
                  ? h('span', { className: 'pg-badge ' + (emotion.externalReady ? 'pg-badge-live' : 'pg-badge-dry') },
                      emotion.externalReady ? '第三方扩展生效中' : '等待扩展接入')
                  : emKind === 'merge'
                    ? h('span', { className: 'pg-badge pg-badge-live' }, '内置 + 扩展合并')
                    : (emotion.needsRepair
                        ? h('span', { className: 'pg-badge pg-badge-dry' }, '需对齐本机')
                        : h('span', { className: 'pg-badge pg-badge-live' }, '已对齐本机'))
              ),
              h('div', { className: 'pg-rows' },
                emKind === 'external' ? h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' },
                      emotion.externalLive
                        ? ('当前外部心情：' + emotion.externalLive)
                        : '已切换到第三方心情扩展（当前暂无实时心情文本）'
                    ),
                    h('div', { className: 'pg-row-hint' }, '当前已对接所选的第三方心情扩展，内置 emotion-state-portrait 已暂停写入与打分。')
                  )
                ) : h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' },
                      (emotion.live
                        ? ('心情 ' + (emotion.live.mood && emotion.live.mood.length ? emotion.live.mood.join(' · ') : '平静') +
                            ' · 精神 ' + emotion.live.spirit + '/100' +
                            (emotion.live.statusWord ? '（' + emotion.live.statusWord + '）' : '') +
                            (emotion.live.transition ? ' · 跃迁 ' + emotion.live.transition : '') +
                            ' · 画像 ' + emotion.live.portraitCount + ' 人')
                        : (emotion.stateExists === false
                            ? '已安装情绪插件 · 暂无 state.json（等待首轮打分或发条 QQ 私聊后自动生成）'
                            : (emotion.note || '已安装'))) +
                      (emKind === 'merge' && emotion.externalLive ? (' · 外部心情：' + emotion.externalLive) : '')
                    ),
                    h('div', { className: 'pg-row-hint' },
                      emotion.needsRepair && emotion.issues && emotion.issues.length
                        ? '检测到遗留或无效配置：' + emotion.issues.join('；')
                        : ('自动随 QQ 私聊、指令与探索更新 inbox.jsonl' +
                            (emotion.live && emotion.live.updatedAt ? ' · 最近更新 ' + clockOf(new Date(emotion.live.updatedAt).toISOString()) : '') +
                            (emotion.inboxBytes ? ' · inbox ' + Math.max(1, Math.round(emotion.inboxBytes / 1024)) + ' KB' : ''))
                    )
                  ),
                  emotion.installed ? h('div', { className: 'pg-row-ctl' },
                    h('button', {
                      className: 'pg-btn' + (emotion.needsRepair ? ' pg-btn-primary' : ''),
                      type: 'button',
                      disabled: busy,
                      onClick: onRepairEmotion,
                    }, emotion.needsRepair ? '一键修复本机配置' : '重新对齐配置')
                  ) : null
                )
              )
            );
          })() : null,
          memory && memory.enabled && ((memory.files && memory.files.length) || memory.label || memory.resolvedPlugin) ? (function () {
            var memFiles = memory.files || [];
            var sVal = memory.sessionSetting || '';
            var nonEmpty = memFiles.filter(function (f) { return f.count > 0; });
            var wsFiles = memory.supportsMerge !== false ? memFiles.filter(function (f) { return f.kind === 'workspace'; }) : [];
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
            return h('details', {
              className: 'pg-card pg-card-fold',
              open: memoryCardOpen,
              onToggle: function (e) {
                var isOpen = e.currentTarget.open;
                if (memoryCardOpen === isOpen) return;
                writeFoldState('card:memory', isOpen);
                setMemoryCardOpen(isOpen);
              },
            },
              h('summary', { className: 'pg-card-title pg-card-sum' },
                h('span', { className: 'pg-card-sum-name' }, '长期记忆（' + memTitleName + ' · 共 ' + memFiles.length + ' 份）'),
                h('span', { className: 'pg-badge ' + (sVal && sVal !== 'all' ? 'pg-badge-dry' : 'pg-badge-live'), style: { marginLeft: 'auto' } }, readBadge)
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
          exploration ? h('details', {
            className: 'pg-card pg-card-fold pg-exp-card',
            open: explorationCardOpen,
            onToggle: function (e) {
              var isOpen = e.currentTarget.open;
              if (explorationCardOpen === isOpen) return;
              writeFoldState('card:exploration', isOpen);
              setExplorationCardOpen(isOpen);
            },
          },
            h('summary', { className: 'pg-card-title pg-card-sum' },
              h('span', { className: 'pg-card-sum-name' }, '自主探索'),
              h('div', { className: 'pg-card-badges', style: { marginLeft: 'auto' } },
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
              topicIssue ? h(ExplorationTopicIssue, {
                key: topicIssue.field + '\n' + topicIssue.input,
                issue: topicIssue,
                busy: busy || exploring || exploreStopPending || exploreTopicPending,
                onResolve: onExploreTopic
              }) : null,
              exploration.lastRun ? (function () {
                var calls = Array.isArray(exploration.lastRun.calls) ? exploration.lastRun.calls : [];
                return h('details', { className: 'pg-exp-details' },
                  h('summary', { className: 'pg-exp-sum' },
                    calls.length ? ('最近路径（共 ' + calls.length + ' 步）') : '最近路径（文字探索）'),
                  h('div', { className: 'pg-row-hint' }, calls.length ? calls.join(' → ') : '文字探索')
                );
              })() : null,
              exploration.candidate && exploration.candidate.loginSite ? h('div', { className: 'pg-row-hint' },
                '待登录 · ', h('a', { className: 'pg-link', href: exploration.candidate.source.url, target: '_blank', rel: 'noopener noreferrer' }, exploration.candidate.loginSite),
                '。请在网站页面完成登录；公开网页工具可能仍无法读取登录后的页面。') : null,
              (function () {
                var entries = activeExplorationEntries();
                if (!entries.length) return null;
                var latest = entries[0];
                var older = entries.slice(1);
                return h('details', {
                  className: 'pg-exp-details',
                  open: showExplorationDetails,
                  onToggle: function (event) { setShowExplorationDetails(event.currentTarget.open); }
                },
                  h('summary', { className: 'pg-exp-sum' }, '最近的探索进展'),
                  h('div', { className: 'pg-exp-list' },
                    renderExplorationEntry(latest),
                    older.length ? h('details', { className: 'pg-exp-details' },
                      h('summary', { className: 'pg-exp-sum' }, '查看较早的另一条记录（' + older[0].label + '）'),
                      older.map(renderExplorationEntry)
                    ) : null,
                    exploration.candidate ? h('div', { className: 'pg-exp-item' }, '可分享：' + exploration.candidate.line) : null,
                    exploration.mood ? h('div', { className: 'pg-exp-item' }, '探索感受：' + exploration.mood.text) : null
                  )
                );
              })(),
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
                h('button', { className: 'pg-btn', type: 'button',
                  disabled: busy || exploring || exploreStopPending || exploreTopicPending || !state.enabled, onClick: onExplore },
                  exploring ? '探索进行中…' : '试跑一轮（不发送）'),
                exploring || exploreStopPending ? h('button', { className: 'pg-btn', type: 'button', disabled: exploreStopPending,
                  onClick: onExploreStop }, exploreStopPending ? '正在中止…' : '中止本轮') : null
              ),
              explorationStatus ? h('div', { role: 'status', className: 'pg-toast' + (explorationStatus.error ? ' pg-toast-err' : ' pg-toast-ok') }, explorationStatus.text) : null
            ),
            explorationItems.length ? h(
              'div',
              { className: 'pg-rows pg-exp-rows' },
              explorationItems.map(function (item) {
                return h(Row, { key: item.path, item: item, busy: busy, onSave: onSave });
              })
            ) : null,
            h(
              'div',
              { className: 'pg-row-hint', style: { marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--pg-border, rgba(128,128,128,0.16))' } },
              '注：鉴于不同外部记忆插件间的适配性差异，深度探索采用内置记忆机制；其遗忘衰减、召回强化与标签归类借鉴了插件「鱼的记忆（dsh-fish-memory）」的设计思路，并非原创，特此致谢。本插件仅作免费开源与个人学习交流，不用于任何商业及盈利用途，如有不妥请联系移除。'
            )
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
            var toolScope = state && state.compactChatTools;
            var toolScopeNote = toolScope && ({
              active: '已从当前陪聊会话隐藏 ' + toolScope.hiddenCount + ' 个工具',
              waiting: '精简陪聊工具已开启，等待绑定会话启动',
              unbound: '精简陪聊工具已开启，等待绑定会话',
              unsupported: '当前 DSH 尚不支持按会话精简工具，继续使用完整工具',
              error: '精简陪聊工具暂未生效，继续使用完整工具',
            })[toolScope.state];
            var boundLabel = ec.sessionId
              ? (ec.sessionTitle ? '「' + ec.sessionTitle + '」' : '') + ec.sessionId.slice(0, 8)
              : '';
            return h('details', {
              className: 'pg-card pg-card-fold',
              open: channelCardOpen,
              onToggle: function (e) {
                var isOpen = e.currentTarget.open;
                if (channelCardOpen === isOpen) return;
                writeFoldState('card:channels', isOpen);
                setChannelCardOpen(isOpen);
              },
            },
              h('summary', { className: 'pg-card-title pg-card-sum' },
                h('span', { className: 'pg-card-sum-name' }, '主聊天接口与通道开关'),
                h('div', { className: 'pg-card-badges', style: { marginLeft: 'auto' } },
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
              toolScopeNote ? h('div', { className: 'pg-row-hint', role: 'status' }, toolScopeNote) : null,
              channelItems.length ? h(
                'div',
                { className: 'pg-rows' },
                channelItems.map(function (item) {
                  return h(Row, { key: item.path, item: item, busy: busy, onSave: onSave });
                }),
                h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' }, '聊天接入会话'),
                    h('div', { className: 'pg-row-hint' },
                      hostSessions.length
                        ? '从当前 DSH 的 ' + hostSessions.length + ' 个会话中选择让' +
                          (p === 'qq' ? ' QQ ' : p === 'douyin' ? '抖音私信' : '内部聊天') +
                          '接入的会话，或直接新建一条。'
                        : (sessionsLoading ? '正在读取 DSH 会话列表…' : '未找到可选择的已有会话，可直接新建陪伴会话。')
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
                        var wsName = s.cwd ? String(s.cwd).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
                        var label = (s.title || '未命名会话') +
                          (wsName ? ' · ' + wsName : '') +
                          ' [' + s.id.slice(0, 8) + ']' +
                          (s.id === ec.sessionId ? '（当前）' : '');
                        return h('option', { key: s.id, value: s.id }, label);
                      })
                    ),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn pg-btn-primary',
                      disabled: busy || bindingBusy || !selectedSessionId || selectedSessionId === ec.sessionId,
                      onClick: function () { onBindChatSession({ sessionId: selectedSessionId }); },
                    }, bindingBusy ? '切换中…' : '接入所选会话'),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy || bindingBusy,
                      onClick: function () { onBindChatSession({ create: true }); },
                    }, '新建并接入'),
                    h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy || bindingBusy || sessionsLoading,
                      onClick: loadHostSessions,
                    }, sessionsLoading ? '刷新中…' : '刷新列表')
                  )
                )
              ) : null
            );
          })() : null,
          groups.length ? h('div', { className: 'pg-sec-label' }, '参数设置') : null,
          groups.map(function (g) {
            return h(Group, {
              key: g.name,
              group: g,
              busy: busy,
              onSave: onSave,
              topExtra: g.name === '高级' && state && state.fullscreenGuard ? (function () {
                var fg = state.fullscreenGuard;
                var badgeText = !fg.enabled
                  ? '已关闭'
                  : fg.mode === 'native'
                    ? (fg.ready ? '轻量原生模式 · 已就绪' : '轻量原生模式')
                    : fg.mode === 'powershell'
                      ? 'PowerShell 兜底'
                      : '按需待命（首次触发自动编译）';
                var badgeCls = !fg.enabled
                  ? 'pg-badge-off'
                  : fg.mode === 'native' && fg.ready
                    ? 'pg-badge-live'
                    : 'pg-badge-dry';
                var hintText = !fg.enabled
                  ? '全屏避让已关闭；可在下方「系统感知、反作弊与基础连接」中开启。'
                  : fg.inFullscreen
                    ? '当前检测到全屏游戏，敏感动作已自动避让。'
                    : fg.inCooldown && fg.remainingMs > 0
                      ? '退出全屏缓冲中，剩余约 ' + Math.max(1, Math.ceil(fg.remainingMs / 60000)) + ' 分钟后恢复。'
                      : '基于 Windows 原生通知状态位（SHQueryUserNotificationState），零进程枚举、打游戏期间 0 新进程创建。';
                return h('div', { className: 'pg-row' },
                  h('div', { className: 'pg-row-text' },
                    h('div', { className: 'pg-row-label' },
                      '全屏游戏检测 ',
                      h('span', { className: 'pg-badge ' + badgeCls, style: { marginLeft: '6px' } }, badgeText)
                    ),
                    h('div', { className: 'pg-row-hint' }, hintText)
                  ),
                  h('div', { className: 'pg-row-ctl' },
                    h('button', {
                      type: 'button',
                      className: 'pg-btn',
                      disabled: busy || smallActionPending,
                      onClick: function () { applySmallAction('/fullscreen-guard/redeploy', {}); },
                    }, smallActionPending ? '部署中…' : '重新部署')
                  )
                );
              })() : null,
              extra: g.name === '高级' && presets ? h(
                'details',
                {
                  className: 'pg-exp-details pg-sub-fold',
                  open: presetEditorOpen,
                  onToggle: function (e) {
                    var isOpen = e.currentTarget.open;
                    if (presetEditorOpen === isOpen) return;
                    writeFoldState('sub:高级:套餐自定义', isOpen);
                    setPresetEditorOpen(isOpen);
                  },
                },
                h('summary', { className: 'pg-exp-sum' }, h('span', null, '套餐自定义')),
                h(PresetEditor, {
                  data: presets,
                  busy: busy,
                  onOverride: function (presetId, path, value) { applyPresetAction('/presets/override', { presetId: presetId, path: path, value: value }); },
                  onReset: function (presetId) { applyPresetAction('/presets/reset', { presetId: presetId }); },
                })
              ) : null,
            });
          })) : null,
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
        '.pg-btn-warn{color:var(--pg-err);border-color:color-mix(in srgb,var(--pg-err) 40%,var(--pg-line));background:color-mix(in srgb,var(--pg-err) 9%,var(--pg-bar));}',
        '.pg-btn-warn:hover:not(:disabled){background:color-mix(in srgb,var(--pg-err) 16%,var(--pg-bar));border-color:color-mix(in srgb,var(--pg-err) 55%,var(--pg-line));}',
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
        '.pg-search-card{padding:10px 14px;}',
        '.pg-search-bar{display:flex;align-items:center;gap:8px;}',
        '.pg-search-input{flex:1 1 auto;width:auto;text-align:left;padding:7px 10px;}',
        '.pg-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
        '.pg-chip{font:inherit;font-size:11.5px;line-height:1.2;padding:4px 10px;border-radius:999px;border:1px solid var(--pg-line);background:var(--pg-field);color:var(--pg-muted);cursor:pointer;transition:background .15s,border-color .15s,color .15s;}',
        '.pg-chip:hover{border-color:var(--pg-muted);color:var(--pg-fg);}',
        '.pg-chip-on{background:var(--pg-brand);border-color:var(--pg-brand);color:var(--pg-brand-fg);}',
        '.pg-chip-on:hover{color:var(--pg-brand-fg);opacity:.92;}',
        '.pg-search-results{margin-top:10px;padding-top:8px;border-top:1px solid var(--pg-line-soft);}',
        '.pg-search-meta{font-size:11.5px;color:var(--pg-faint);margin-bottom:4px;}',
        '.pg-search-hidden-note{margin-top:8px;padding-top:8px;border-top:1px dashed var(--pg-line-soft);}',
        '.pg-row-group{display:inline-block;margin-left:7px;font-size:10.5px;font-weight:500;padding:1px 6px;border-radius:999px;background:var(--pg-bar);border:1px solid var(--pg-line-soft);color:var(--pg-faint);vertical-align:middle;}',
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
        '.pg-sub-fold{margin:8px 0 4px;}',
        '.pg-sub-fold .pg-rows{margin-top:6px;padding-top:4px;border-top:1px solid var(--pg-line-soft);}',
        '.pg-exp-list{display:flex;flex-direction:column;gap:5px;padding-top:8px;margin-top:6px;border-top:1px solid var(--pg-line-soft);}',
        '.pg-exp-item{font-size:11.5px;color:var(--pg-muted);line-height:1.55;overflow-wrap:anywhere;}',
        '.pg-exp-highlight{font-size:12.5px;color:var(--pg-fg);line-height:1.6;padding:4px 8px;background:var(--pg-card);border-radius:7px;border:1px solid var(--pg-line-soft);}',
        '.pg-exp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:2px;}',
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
