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
              extra: g.name === '高级' && presets ? h(PresetEditor, {
                data: presets,
                busy: busy,
                onOverride: function (presetId, path, value) { applyPresetAction('/presets/override', { presetId: presetId, path: path, value: value }); },
                onReset: function (presetId) { applyPresetAction('/presets/reset', { presetId: presetId }); },
              }) : null,
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

