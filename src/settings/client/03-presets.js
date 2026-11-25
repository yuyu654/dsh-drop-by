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
          { style: { borderBottom: '1px solid var(--pg-line)', padding: '10px 0 12px', marginBottom: '6px' } },
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

