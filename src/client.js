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
    id: 'dsh-drop-by',
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

      function apiGet(path) {
        return fetch(API + path, { cache: 'no-store' }).then(readJson);
      }

      function apiPost(path) {
        return fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then(readJson);
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
        return h('input', {
          className: 'pg-input',
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
        if (!g.foldable) {
          return wrap(h('section', { className: 'pg-card' }, h('div', { className: 'pg-card-title' }, g.name), rows));
        }
        return wrap(
          h(
            'details',
            { className: 'pg-card pg-card-fold' },
            h(
              'summary',
              { className: 'pg-card-title pg-card-sum' },
              h('span', null, g.name),
              g.summary ? h('span', { className: 'pg-card-sub' }, g.summary) : null
            ),
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
            note: last && last.why ? last.why : '',
          },
          { k: '今天', v: sent + ' 条', note: dry ? '演练计数（没真发）' : '真实发送' },
          {
            k: '用谁写',
            v: last && last.llm ? (last.llm.via === 'host' ? last.llm.model || '宿主模型' : '命令行 CLI') : '—',
            note: last && last.llm && last.llm.provider ? last.llm.provider : '',
          },
          { k: 'QQ', v: st.send && st.send.peer ? st.send.peer : '没配', note: st.mail && st.mail.enabled ? '邮箱开着' : '邮箱关着' },
        ];

        return h(
          'div',
          { className: 'pg-facts' },
          cells.map(function (c) {
            return h(
              'div',
              { className: 'pg-fact', key: c.k },
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
            last.delivery && last.delivery.reason ? '没发出去：' + last.delivery.reason : '演练模式，只记下来没发'
          )
        );
      }

      // ------------------------------------------------------------ 页面

      function Panel() {
        var [state, setState] = useState(null);
        var [groups, setGroups] = useState([]);
        var [error, setError] = useState('');
        var [toast, setToast] = useState(null);
        var [busy, setBusy] = useState(false);
        var [explorePending, setExplorePending] = useState(false);
        var [exploreResult, setExploreResult] = useState(null);
        var [showExplorationDetails, setShowExplorationDetails] = useState(false);
        var [loading, setLoading] = useState(true);
        var mounted = useRef(true);
        var toastTimer = useRef(null);

        var flash = useCallback(function (text, kind) {
          setToast({ text: text, kind: kind || 'ok' });
          if (toastTimer.current) clearTimeout(toastTimer.current);
          toastTimer.current = setTimeout(function () {
            if (mounted.current) setToast(null);
          }, 3000);
        }, []);

        var load = useCallback(
          function (silent) {
            if (!silent) setBusy(true);
            return Promise.all([apiGet('/state'), apiGet('/config')])
              .then(function (r) {
                if (!mounted.current) return;
                setState(r[0]);
                setGroups(r[1].groups || []);
                setError('');
              })
              .catch(function (e) {
                if (!mounted.current) return;
                setError(e && e.message ? e.message : String(e));
              })
              .then(function () {
                if (!mounted.current) return;
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

        var onSave = useCallback(
          function (path, value) {
            setBusy(true);
            apiSave({ path: path, value: value })
              .then(function (r) {
                if (!mounted.current) return;
                setState(r.state);
                setGroups(r.groups || []);
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
          [flash, load]
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
                var msg = !run
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

        function onExplore() {
          setExplorePending(true);
          setExploreResult(null);
          apiPost('/explore').then(function (r) {
            if (!mounted.current) return;
            setState(r.state);
            var labels = {
              NO_PERSONA: '请先配置角色人设',
              QUIET_OR_BUSY: '当前是静默时段，本轮未运行',
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
            var message = r.ok
              ? (r.action === 'skip' ? '本轮已结束，角色选择跳过' : '本轮已结束，探索进展已保存')
              : (labels[r.reason] || r.reason || '探索失败');
            setExploreResult({ text: message, error: !r.ok });
            if (r.ok && r.action !== 'skip') setShowExplorationDetails(true);
          }).catch(function (e) {
            if (mounted.current) setExploreResult({ text: e.message || '探索请求失败', error: true });
          }).finally(function () {
            if (mounted.current) setExplorePending(false);
          });
        }

        if (loading && !state) return h('div', { className: 'pg-root' }, h('div', { className: 'pg-loading' }, '读状态…'));
        var exploration = state && state.exploration;
        var exploring = explorePending || Boolean(exploration && exploration.running);
        var thread = exploration && exploration.thread;
        var leisure = exploration && exploration.leisure;
        function sourceLinks(entry) {
          return (entry && entry.sources || []).filter(function (s) { return /^https?:\/\//i.test(s.url); }).map(function (s) {
            return h('div', { className: 'pg-quote-note', key: s.url },
              s.evidence + ' · ', h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.title));
          });
        }

        return h(
          'div',
          { className: 'pg-root' },
          state ? h(Head, { state: state, busy: busy, onRefresh: function () { load(false); }, onTick: onTick }) : null,
          error ? h('div', { className: 'pg-error' }, '取不到状态：' + error) : null,
          state ? h(Facts, { state: state }) : null,
          state ? h(LastWords, { state: state }) : null,
          exploration ? h('div', { className: 'pg-quote' },
            h('div', { className: 'pg-quote-k' }, '自主探索（试用）'),
            exploration.lastRun ? h('div', { className: 'pg-quote-note' },
              (exploration.lastRun.mode === 'leisure' ? '休闲' : '研究') + ' · ' + exploration.lastRun.outcome +
              (exploration.lastRun.calls?.length ? ' · ' + exploration.lastRun.calls.join(' → ') : ' · 文字探索')) : null,
            exploration.candidate?.loginSite ? h('div', { className: 'pg-quote-note' },
              '待登录 · ', h('a', { href: exploration.candidate.source.url, target: '_blank', rel: 'noopener noreferrer' }, exploration.candidate.loginSite),
              '。请在网站页面完成登录；公开网页工具可能仍无法读取登录后的页面。') : null,
            h('div', { className: 'pg-quote-note' }, '遇到待确认的本地事实，可在「日常 → 最近对什么好奇」补充你知道的信息，保存后点「试跑一轮」。当前版本需要在这里补充。'),
            thread || leisure ? h('details', {
              open: showExplorationDetails,
              onToggle: function (event) { setShowExplorationDetails(event.currentTarget.open); }
            },
              h('summary', null, '最近的探索进展'),
              ...[thread, leisure].filter(Boolean).flatMap(function (entry, index) {
                var prefix = entry === leisure ? '休闲' : '研究';
                return [['进度', entry.checkpoint], ['新发现', entry.discovery], ['待确认', entry.waitingFor]]
                  .filter(function (item) { return item[1]; }).map(function (item) {
                    return h('div', { key: index + item[0], className: 'pg-quote-note' }, prefix + ' · ' + item[0] + '：' + item[1]);
                  });
              }),
              thread ? h('div', { className: 'pg-quote-v' }, thread.topic + '：' + thread.progress) : null,
              thread ? h('div', { className: 'pg-quote-note' }, '下一步：' + thread.next) : null,
              ...sourceLinks(thread),
              leisure ? h('div', { className: 'pg-quote-v' }, '随便逛逛 · ' + leisure.topic + '：' + leisure.progress) : null,
              ...sourceLinks(leisure),
              exploration.candidate ? h('div', { className: 'pg-quote-note' }, '可分享：' + exploration.candidate.line) : null,
              exploration.mood ? h('div', { className: 'pg-quote-note' }, '探索感受：' + exploration.mood.text) : null
            ) : null,
            h('button', { className: 'pg-btn', type: 'button', disabled: busy || exploring || !state.enabled, onClick: onExplore },
              exploring ? '探索进行中…' : '试跑一轮（不发送）'),
            exploreResult ? h('div', { role: 'status', className: 'pg-toast' + (exploreResult.error ? ' pg-toast-err' : '') }, exploreResult.text) : null
          ) : null,
          toast
            ? h('div', { className: 'pg-toast' + (toast.kind === 'err' ? ' pg-toast-err' : '') }, toast.text)
            : null,
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
        'color:var(--pg-fg);display:flex;flex-direction:column;gap:13px;padding:2px;box-sizing:border-box;max-width:100%;}',
        '.pg-head{display:flex;align-items:flex-start;gap:14px;}',
        '.pg-head-left{flex:1 1 auto;min-width:0;}',
        '.pg-h1{font-size:15px;font-weight:650;letter-spacing:.2px;line-height:1.4;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}',
        '.pg-sub{font-size:12.5px;color:var(--pg-muted);margin-top:5px;line-height:1.6;}',
        '.pg-head-actions{display:flex;gap:8px;flex:0 0 auto;}',
        '.pg-btn{font:inherit;font-size:12.5px;padding:6px 11px;border-radius:9px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-fg);cursor:pointer;white-space:nowrap;}',
        '.pg-btn:hover:not(:disabled){background:var(--pg-hover);}',
        '.pg-btn:disabled{opacity:.55;cursor:default;}',
        '.pg-btn-primary{background:var(--pg-brand);color:var(--pg-brand-fg);border-color:transparent;}',
        '.pg-badge{font-size:11.5px;font-weight:500;padding:2px 8px;border-radius:999px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-muted);}',
        '.pg-badge-live{color:var(--pg-ok);border-color:color-mix(in srgb,var(--pg-ok) 40%,transparent);background:color-mix(in srgb,var(--pg-ok) 12%,transparent);}',
        '.pg-badge-dry{color:var(--pg-warn);border-color:color-mix(in srgb,var(--pg-warn) 40%,transparent);background:color-mix(in srgb,var(--pg-warn) 12%,transparent);}',
        '.pg-badge-off{color:var(--pg-faint);}',
        '.pg-facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:9px;}',
        '.pg-fact{background:var(--pg-bar);border:1px solid var(--pg-line-soft);border-radius:11px;padding:9px 11px;min-width:0;}',
        '.pg-fact-k{font-size:11.5px;color:var(--pg-faint);}',
        '.pg-fact-v{font-size:13px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pg-fact-note{font-size:11px;color:var(--pg-muted);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
        '.pg-quote{background:var(--pg-field);border:1px solid var(--pg-line-soft);border-left:3px solid var(--pg-brand);border-radius:10px;padding:9px 12px;}',
        '.pg-quote-k{font-size:11.5px;color:var(--pg-faint);}',
        '.pg-quote-v{font-size:13px;line-height:1.6;margin-top:3px;}',
        '.pg-quote-note{font-size:11.5px;color:var(--pg-muted);margin-top:3px;}',
        '.pg-card{background:var(--pg-card);border:1px solid var(--pg-line-soft);border-radius:13px;padding:4px 13px 6px;}',
        '.pg-card-title{font-size:11.5px;font-weight:600;letter-spacing:.4px;color:var(--pg-faint);padding:9px 0 3px;}',
        '.pg-note{font-size:11.5px;line-height:1.65;color:var(--pg-muted);background:var(--pg-field);border:1px solid var(--pg-line-soft);border-left:3px solid #c98a2e;border-radius:9px;padding:8px 10px;margin:0 0 8px;}',
        '.pg-card-sum{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:6px;padding:10px 0 8px;}',
        '.pg-card-sum::-webkit-details-marker{display:none;}',
        '.pg-card-sum::before{content:"▸";font-size:10px;opacity:.75;}',
        '.pg-card-fold[open] .pg-card-sum::before{content:"▾";}',
        '.pg-card-sub{font-size:11px;font-weight:400;letter-spacing:0;color:var(--pg-faint);opacity:.92;}',
        '.pg-rows{display:flex;flex-direction:column;}',
        '.pg-timing-search{width:100%;margin:8px 0;}',
        '.pg-row{display:flex;align-items:flex-start;gap:12px;padding:9px 0;border-bottom:1px solid var(--pg-line-soft);}',
        '.pg-row:last-child{border-bottom:0;}',
        '.pg-row-text{flex:1 1 auto;min-width:0;}',
        '.pg-row-label{font-size:12.5px;line-height:1.5;}',
        '.pg-row-hint{font-size:11.5px;color:var(--pg-muted);line-height:1.55;margin-top:2px;}',
        '.pg-row-ctl{flex:0 0 auto;display:flex;align-items:center;min-height:24px;max-width:46%;}',
        '.pg-input{font:inherit;font-size:12.5px;color:var(--pg-fg);background:var(--pg-field);border:1px solid var(--pg-line);border-radius:8px;padding:4px 8px;width:96px;box-sizing:border-box;text-align:right;}',
        '.pg-input:focus{outline:none;border-color:var(--pg-brand);}',
        '.pg-select{width:auto;min-width:132px;text-align:left;cursor:pointer;}',
        '.pg-textarea{width:100%;min-height:110px;text-align:left;resize:vertical;line-height:1.55;padding:6px 8px;font-size:12.5px;}',
        '.pg-row-wide{flex-wrap:wrap;}',
        '.pg-row-wide .pg-row-ctl{flex:1 1 100%;max-width:100%;}',
        '.pg-courses{width:100%;border:1px solid rgba(127,127,127,.28);border-radius:8px;padding:4px 8px;background:rgba(127,127,127,.06);}',
        '.pg-courses-sum{cursor:pointer;font-size:12.5px;opacity:.85;list-style:none;}',
        '.pg-courses-sum::-webkit-details-marker{display:none;}',
        '.pg-courses-sum::before{content:"▸ ";}',
        '.pg-courses[open] .pg-courses-sum::before{content:"▾ ";}',
        '.pg-courses-list{display:flex;flex-direction:column;gap:4px;padding:6px 2px 4px;}',
        '.pg-course-all{font-weight:600;border-bottom:1px solid rgba(127,127,127,.25);padding-bottom:5px;margin-bottom:1px;}',
        '.pg-course{display:flex;align-items:center;gap:6px;font-size:12.5px;cursor:pointer;line-height:1.45;}',
        '.pg-course input{flex:0 0 auto;}',
        '.pg-switch{display:inline-flex;align-items:center;cursor:pointer;position:relative;}',
        '.pg-switch input{position:absolute;opacity:0;width:0;height:0;}',
        '.pg-switch-track{width:34px;height:20px;border-radius:999px;background:var(--pg-line);display:inline-block;position:relative;transition:background .15s;}',
        '.pg-switch-dot{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--pg-card);transition:transform .15s;box-shadow:0 1px 2px rgba(0,0,0,.18);}',
        '.pg-switch input:checked+.pg-switch-track{background:var(--pg-brand);}',
        '.pg-switch input:checked+.pg-switch-track .pg-switch-dot{transform:translateX(14px);}',
        '.pg-switch input:disabled+.pg-switch-track{opacity:.5;}',
        '.pg-toast{font-size:12.5px;padding:9px 12px;border-radius:9px;border:1px solid var(--pg-line);background:var(--pg-bar);color:var(--pg-fg);}',
        '.pg-toast-err{color:var(--pg-err);border-color:color-mix(in srgb,var(--pg-err) 35%,transparent);background:color-mix(in srgb,var(--pg-err) 10%,transparent);}',
        '.pg-error{color:var(--pg-err);background:color-mix(in srgb,var(--pg-err) 10%,transparent);border:1px solid color-mix(in srgb,var(--pg-err) 35%,transparent);border-radius:10px;padding:10px 12px;font-size:12.5px;line-height:1.6;}',
        '.pg-loading{font-size:12.5px;color:var(--pg-muted);padding:18px 0;}',
        '.pg-foot{font-size:11.5px;color:var(--pg-faint);line-height:1.6;padding:0 2px 4px;}',
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
