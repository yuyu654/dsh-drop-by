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

