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
          state ? h(Head, { state: state, busy: busy || guidePending === 'preview', tickPending: tickPending, onGuide: openGuide,
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
            return h('div', { className: 'pg-card' },
              h('div', { className: 'pg-card-head' },
                h('div', { className: 'pg-card-title' }, '长期记忆（' + memTitleName + ' · 共 ' + memFiles.length + ' 份）'),
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
