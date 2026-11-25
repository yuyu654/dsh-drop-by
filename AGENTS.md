# dsh-drop-by 开发约定

新增或修改插件控制的时间间隔、等待、冷却、时段、有效期、缓存或超时时，同一变更必须提供「陪伴」设置页入口。优先复用已有设置。新增独立参数时，在 `src/settings/config.js` 提供默认值，在 `src/settings/settings.js` 提供可编辑字段、单位、范围和说明，再让运行逻辑读取该值。涉及升级时保留旧配置的实际行为。验证设置页保存和回显，并验证至少一个不同于默认值的配置会改变运行结果。

修改前端设置页分片（`src/settings/client/*.js`）后，运行 `npm run build:client` 重新生成 `src/client.js` 并做 `node --check src/client.js` 语法检查。

## 分区导航表

| 功能区 | 目录 / 入口 | 职责与核心文件 |
|---|---|---|
| **顶层入口** | `src/plugin.js` / `src/run.js` / `src/client.js` | DSH 插件编排入口（~810 行）、CLI 入口、浏览器设置页产物（由 `src/settings/client/` 拼接） |
| **自主探索** | `src/explore/` | 探索主循环 `explore.js`、调度器 `plugin-exploration.js`、浏览器看图 `explore-browser.js`、信源/媒体 `explore-feeds.js` / `explore-media.js`、记忆与反馈 `exploration-memory.js` / `exploration-feedback.js`、作品定位 `exploration-target.js` / `exploration-work-page.js` |
| **私聊与小本本** | `src/chat/` | 回复上下文与防重复定时器 `qq-reply.js`、约定小本本 `agreements.js` & 到点自然提醒 `due-agreement.js`、后台派活 `qq-command.js` / `command-matcher.js`、会话监听与工具上限 `plugin-session.js`、精简工具 `compact-chat-tools.js`、热聊补话 `qq-continuation.js` / `qq-continuation-tick.js`、自动续聊 `session-rollover.js` |
| **判定与写稿** | `src/decision/` | 主动拍引擎 `engine.js`、规则判定 `decide.js`、选题 `topics.js`、写稿与红线护栏 `compose.js`、处境判断 `judge.js`、反馈闭环 `feedback.js`、小算盘 `receptivity.js`、人格与宿主模型 `persona.js` / `hostllm.js`、情绪与记忆 `emotion-portrait.js` / `emotion-sync.js` / `memorysource.js` |
| **感知与日程** | `src/perception/` | Windows 探针与反作弊 `probe.js` / `perception.js` / `signals.js`、手机健康邮件 `fishmail.js` / `fishparse.js` / `health.js`、课表/考试/节假日 `schedule.js` / `agenda.js` / `exams.js` / `holidays.js` / `calendar.js`、视频观察 `video-host.js` / `videosum.js` |
| **配置与设置页** | `src/settings/` | 配置读写 `config.js`、参数白名单 `settings.js`、一键套餐 `presets.js`、HTTP 路由 `plugin-http.js`、诊断自检 `diagnostics.js` / `detect.js`、扩展注册 `extensions.js`、前端源码分片 `client/*.js` |
| **消息通道** | `src/channels/` | QQ 桥 `qq.js`、抖音私信 `douyin-im.js` / `douyin-session.js`、内部共用会话 `internal.js`、主通道切换 `chat-switch.js`、统一出站 `external.js` |

## 开发入口

按问题查代码入口、状态字段和定向测试，见 [开发速查](docs/DEVELOPMENT.md)。涉及 DSH 宿主、私聊派活、自主探索或设置保存时，沿真实入口核对运行路径和最终状态。
