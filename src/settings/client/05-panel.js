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
        var [exploreTopicPending, setExploreTopicPending] = useState(false);
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
        var [refreshing, setRefreshing] = useState(false);
        var [tickPending, setTickPending] = useState(false);
        var busy = actionBusy || refreshing || tickPending;
        var guideAnchor = useRef(null);
        var diagnosticRequest = useRef(0);
        var stateRequest = useRef(0);
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
              .then(function () {
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

