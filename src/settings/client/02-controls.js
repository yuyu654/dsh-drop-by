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

