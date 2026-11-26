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

