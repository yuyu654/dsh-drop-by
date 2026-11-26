# dsh-drop-by 开发速查

仓库是 DSH 的「陪伴」插件。按问题在下表定位，随后读对应入口和最贴近的集成测试。业务行为以当前 checkout 的代码、配置和验证结果为准。改动约定见 [AGENTS.md](../AGENTS.md)，安装及用户操作见 [README.md](../README.md)。

## 先查哪里

| 问题 | 代码入口和搜索词 | 定向回归 |
| --- | --- | --- |
| 主动消息没有发、发得太勤、时机或话题不合适 | [engine.js](../src/decision/engine.js) `tick` → [decide.js](../src/decision/decide.js) `REASONS`、[topics.js](../src/decision/topics.js) `topicCandidates`、[character-rest.js](../src/decision/character-rest.js)、[chat-rhythm.js](../src/chat/chat-rhythm.js) `isExpectedAckForPrompt`、[brushoff-mood.js](../src/chat/brushoff-mood.js) `isSharePausedByMood`。从 `record.reason` 追到 [explain.js](../src/decision/explain.js) 的解释 | `engine-smoke`、`character-rest`、`chat-rhythm`、`brushoff-mood`、`reply-guard`、`explain` |
| 话术、设备感知透露、来源归因 | [context.js](../src/decision/context.js)、[compose.js](../src/decision/compose.js)、[attribution.js](../src/decision/attribution.js)、[judge.js](../src/decision/judge.js)、[private.js](../src/settings/private.js)。从 `tick` 找实际采用的提示词及校验分支 | `judge-engine`、`reply-guard` |
| 同一会话切换内部、QQ、抖音后读错人或发错端 | [channels/chat-switch.js](../src/channels/chat-switch.js) `changePrimaryChannel`、[channels/external.js](../src/channels/external.js) `activeChatChannel`、`chatPeer`、`sendChatRound`，各通道的输入与状态实现见 [channels/](../src/channels/) | `channel-routing-primary`、`internal-channel`、`engine-switch-pending` |
| 私聊一句话没有触发内置派活或派活无法中止 | [qq-reply.js](../src/chat/qq-reply.js) `prepareQqReplyContext`、`buildReplyContext` → [command-matcher.js](../src/chat/command-matcher.js) `matchUserCommand` → [action-proposal.js](../src/chat/action-proposal.js) `qqCommandPreflight`、`queueQqCommand`、`activeBackgroundTask`、`stopBackgroundTask`、`tryStopBackgroundTaskCommand` → [qq-command.js](../src/chat/qq-command.js) `executeQqCommand` | `qq-exploration-reply`、`extended-commands-and-tool-limit`、`exploration-direction`、`background-task-stop` |
| 上下文涨得快、工具太多、续聊迁移 | [diagnostics.js](../src/settings/diagnostics.js) `inspectSessionContext`、[compact-chat-tools.js](../src/chat/compact-chat-tools.js) `OPTIONAL_CHAT_TOOLS`、[plugin.js](../src/plugin.js) `aroundPrompt`、[session-rollover.js](../src/chat/session-rollover.js) `contextUsage`、`createSessionRollover` | `compact-chat-tools`、`extended-commands-and-tool-limit`、`session-rollover` |
| 自主探索选题、作品查错站、长目录翻章、无头黑屏或登录后续读 | [plugin.js](../src/plugin.js) `runExploration` → [exploration-target.js](../src/explore/exploration-target.js) `resolveExplorationTarget` → [explore.js](../src/explore/explore.js) `exploreRound` → [explore-media.js](../src/explore/explore-media.js) `collectWork`；浏览器无头防风控/画布等待/长目录截窗（`selectRelevantLinks`、`find_link`、`click_text`）见 [explore-browser.js](../src/explore/explore-browser.js)、[exploration-work-page.js](../src/explore/exploration-work-page.js)、`qq-command.js` 的 `latestLoginContext` | `exploration-target`、`exploration-work-page`、`explore-media`、`explore-light-plugin`、`background-task-stop` |
| 自主探索卡住、中止、超时或旧结果覆盖新结果 | `plugin.js` 的 `stopExploration` 和 `runExploration`、[exploration-abort.js](../src/explore/exploration-abort.js) `abortable`、`action-proposal.js` 的 `tryStopExplorationCommand`，再沿信号找实际执行器 | `exploration-controls`、`exploration-work-page`、`explore-offpeak-topic` |
| 模型切换、宿主流式生成、视频只认识标题 | [hostllm.js](../src/decision/hostllm.js) `makeHostLlm`、`resolveBoundSessionModel`、`observeVideo`，[video-host.js](../src/perception/video-host.js) `watchVideo` → [videosum.js](../src/perception/videosum.js) `summarizeVideo` | `hostllm`、`videosum` |
| 设置保存后不生效、旧配置升级、套餐覆盖 | [config.js](../src/settings/config.js) `loadConfig` → [settings.js](../src/settings/settings.js) `SCHEMA`、`applyChange` → `plugin.js` 的 `saveFromBody`；套餐规则见 [presets.js](../src/settings/presets.js)，控件和请求见 [client.js](../src/client.js) | `settings-api`、`settings-units`、`settings-groups`、`presets` |
| 看不到手机状态、电脑活动或全屏游戏避让异常 | [channels/index.js](../src/channels/index.js) `readChannels`、[probe.js](../src/perception/probe.js) `probe`、`anticheatRunning`、[fullscreen-guard.js](../src/perception/fullscreen-guard.js) `isFullscreenBlocked`、`redeployFullscreenHelper`、`disposeFullscreenGuard`、[fishmail.js](../src/perception/fishmail.js)、[fishparse.js](../src/perception/fishparse.js)、[tools/](../tools/) | `anticheat`、`fullscreen-guard`、`fishmail`、`fish-parse` |
| 接住率、约定提醒、探索记忆或共享记忆 | [feedback.js](../src/decision/feedback.js) `settle`、[receptivity.js](../src/decision/receptivity.js)、[report.js](../src/decision/report.js)、[agreements.js](../src/chat/agreements.js)、[exploration-memory.js](../src/explore/exploration-memory.js)、[memorysource.js](../src/decision/memorysource.js) | `receptivity`、`guard-and-agreements`、`exploration-memory`、`settings-memory` |

表中的测试名对应 `tests/<名称>.test.mjs`。新增数据源、心情、记忆或主动由头适配器，从 [扩展接入指南](EXTENSIONS.md) 和 [extensions.js](../src/settings/extensions.js) 查注册契约。安卓采集端见 [鱼鱼状态](fish-condition.md)。

## 宿主与发送

- [package.json](../package.json) 的主入口是 `src/plugin.js`。`apply(ctx, config)` 管宿主服务挂载、定时器、会话钩子、工具和 HTTP 生命周期。`runOnce` 调用 `engine.tick`。[run.js](../src/run.js) 是 CLI 入口。用 CLI 复现的问题还要看是否依赖 DSH 的注入服务。
- 一拍的链路是采集和会话读入 → 决策 → 选题和生成 → 发送前重读配置与通道 → 实际发送 → 状态、反馈和解释。真实出站需要过 `dryRun`、`send.enabled`、主通道和相应发送条件。排障先读 `/state` 和 `/diagnostics`，先用 `POST /tick` 的 `{"preview":true}` 验证决定。预演仍可能调用模型，普通 `POST /tick` 和 `--once` 按当前配置运行。
- 私聊普通回复和内置派活走不同入口。QQ 桥调用包导出的 `dsh-drop-by/qq-reply`。内部会话从 `aroundPrompt` 进入，抖音从 [douyin-session.js](../src/channels/douyin-session.js) 和宿主回调进入。派活要求当前绑定、入站验证、时效和可回传等条件，意图识别后还会重验，队列负责去重和串行。部分扩展指令另依赖 `rules.qqCommands.extended`。看到 `ops_bash` 调用时，先查那条入站的分类与接单状态，再判断属于哪条路径。
- 工具精简作用在当前绑定会话模型可见的工具 schema，释放后恢复。内置后台派活读取宿主工具服务。状态看 `snapshot().compactChatTools` 的 `state` 和 `hiddenCount`。单轮工具次数上限和上下文续聊由另一套设置及宿主钩子负责，排障时分别查对应入口。
- 桌面开发可通过 DSH profile 的本地 link 或 junction 指向这个 checkout，接线见 [cordis.patch.yml](../cordis.patch.yml)。已运行的进程可能仍持有旧模块，验证新逻辑前先确认正在加载的包路径与进程版本。

## 剧情回话、真实派活与对话情绪

- 剧情回话从 [roleplay-followup.js](../src/chat/roleplay-followup.js) 的 `tickRoleplayFollowup` 追起。它核对绑定私聊的入站和已送达普通回复，共用秒级轮询。启动后的明确剧情才创建记录，随机时长在发送离场句时确定，并以绝对时间保存在 `data/roleplay-followup.json`。到点更新完成状态，发信前重验静默、通道和是否换题。
- 内置派活在 [action-proposal.js](../src/chat/action-proposal.js) 的 `startQqTask` 统一维护当前活跃任务与 `AbortController`，分别接收超时提示和最终结果。中止入口为 `POST /task/stop`（设置页右上角「刷新」左侧仅在有活跃任务时显隐，且切回页面触发 `visibilitychange` 静默刷新）和私聊口令 `tryStopBackgroundTaskCommand`（与「中止自主探索」严格分开），中止后立刻释放队列锁并屏蔽迟到回执。定向测试为 `roleplay-followup`、`task-result-timing` 与 `background-task-stop`。
- 对话节律与被敷衍情绪：承接角色约定/召唤的短确认（如「等我 / 我到了，出来吧」后的「嗯嗯 / 好的 / 收到」）由 [chat-rhythm.js](../src/chat/chat-rhythm.js) 的 `isExpectedAckForPrompt` 豁免，不误判成收尾或低信号。可选的「被敷衍会闷闷与生气」开关（`rules.brushoffMood.enabled`，默认关闭）由 [brushoff-mood.js](../src/chat/brushoff-mood.js) 维护在 `data/brushoff-mood.json`：6 小时滑动衰减内第 1 次闷闷不追问、第 2 次更失落、第 3 次生气（首轮说明原因、暂停 `share` 分享、普通 `chitchat` 带冷淡情绪、回复延迟 25–50 秒），补说在忙/上课理由或道歉可当轮消气。定向测试为 `chat-rhythm` 与 `brushoff-mood`。

## 自主探索的关键边界

- 自动、设置页试跑和触发探索的私聊任务最终交给 `runExploration`。它负责轮次 ID、控制器、总时限、提交和设置页状态。`exploreRound` 组织选题、资料和生成，返回待保存的探索状态。
- 中止从 `POST /explore/stop` 或授权私聊的明确指令进入，先释放当前轮次，再通知模型和工具。旧轮次没有保存新状态或清空 `nextTopic` 的权限。设置页应带上已有的 `runId`，避免旧界面误停新轮次。超时走同一机制，状态码为 `EXPLORATION_TIMEOUT`。
- `exploration.nextTopic` 优先于 `exploration.interest`。前者成功完成且仍是原值时才清空。候选仍需确认、需要登录、中止和跳过时保留原任务。多个长期兴趣中遇到未确认项，可以继续尝试其他可用项。
- `主题：…` 显式走普通主题。作品可用 `作品：《名称》 来源：https://…` 指定，或从 `exploration.workSources` 读取已确认来源。裸标题会查可信目录。当前精确的 B 漫作品页可自动选用，Bangumi 用于识别作品。需确认的状态由 `snapshot().exploration.topicIssue` 返回，选择通过 `POST /explore/topic` 保存。
- 作品来源限制沿检索结果、浏览器导航和 HTTP 重定向执行。读不到认可的来源时返回 `WORK_SOURCE_UNAVAILABLE`。登录提醒保留来源链接，续读沿原来源。浏览轮次管理自己创建的标签，手动打开的登录页有独立生命周期。

## 设置、接口与数据

- 设置的读取、保存和回显从 `GET /config`、`POST /config` 追到 `SCHEMA`。时间参数同时核对存储单位、界面换算、范围和执行层读取，按 [AGENTS.md](../AGENTS.md) 验证旧配置与非默认值。新装默认内部会话，已有配置缺主通道字段时会按兼容逻辑保留原 QQ 行为。
- 接口前缀为 `/api/dsh-drop-by`。入口在 `plugin.js` 的 `webServer.register`（路由分发在 `src/settings/plugin-http.js`），走既有宿主服务和请求校验。会话列表及绑定用 `/sessions`、`/chat/session`，接力用 `/rollover/switch`、`/rollover/dismiss`，中止用 `/explore/stop`、`/task/stop`，全屏检测重建用 `/fullscreen-guard/redeploy`。UI 用 `client.js` 的 `apiGet` 和 `apiPost`。
- 运行中的数据通常有两处。插件目录的 `config.json`、`state.json`、`logs/`、`data/` 保存设置、状态、探索与情绪记录。DSH 家目录的 `qq-bridge/last-in.json`、`last-out.json` 给私聊入站校验和出站观察使用。唯一写到插件目录外的是 Windows 全屏检测的 4 KB 编译缓存 `%TEMP%\dsh-drop-by-quns\`（由 `PG_QUNS_CACHE_DIR` 可覆盖），停用/卸载插件时由 `disposeFullscreenGuard()` 自动清理。排查数据路径从 `CONFIG_PATH`、`STATE_PATH`、`dshHome()` 和 `channelFile()` 追。敏感值留在本机，例如 `credentials.json`、人格原文和聊天记录。

## 验证

包声明 Node.js ≥20，仓库 CI 用 Node.js 22。定向测试可以从上表按名称组合。

```powershell
node --test tests/exploration-controls.test.mjs tests/exploration-target.test.mjs tests/exploration-work-page.test.mjs
node --test tests/settings-api.test.mjs tests/settings-units.test.mjs
git diff --check
```

本地开发目录同时是活动插件目录时，在单独 PowerShell 窗口从仓库根目录做一次隔离的全量运行。测试会用到工作区源码、构建相关静态文件和随仓库提供的测试数据。

```powershell
$tempRepo = Join-Path ([IO.Path]::GetTempPath()) ("dsh-drop-by-tests-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tempRepo | Out-Null
Copy-Item -Path src,tests,tools,docs -Destination $tempRepo -Recurse
Copy-Item -Path package.json,README.md,CHANGELOG.md,config.example.json,local-style.example.json,cordis.patch.yml,headless-overlay.yml -Destination $tempRepo
$env:PG_DSH_HOME = Join-Path $tempRepo 'dsh'
$env:DSH_HOME = $env:PG_DSH_HOME
$env:APPDATA = Join-Path $tempRepo 'appdata'
$pathOverrides = 'PG_CONFIG_PATH','PG_STATE_PATH','PG_LOG_DIR','PG_CHAT_DATA_DIR','PG_QUNS_CACHE_DIR',
  'PG_SECRETS_PATH','PG_FISH_LATEST_PATH','PG_VIDEO_CACHE','PG_LOCAL_STYLE','DSH_ELECTRON','DSH_CLI','PRESENCE_MAIL_AUTH'
foreach ($name in $pathOverrides) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
Set-Location $tempRepo
node --test tests/*.test.mjs
```

涉及接口、会话或异步生命周期时，沿真实入口走到最终状态。可参照 [exploration-controls.test.mjs](../tests/exploration-controls.test.mjs) 用最小宿主服务驱动 `apply()`，校验 HTTP 响应、取消信号和磁盘状态。线上行为仍要核对部署、当时的配置、日志和安装后的宿主接线。
