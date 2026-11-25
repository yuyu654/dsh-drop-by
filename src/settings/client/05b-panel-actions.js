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

