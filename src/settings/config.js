// config.js —— 配置读写。所有阈值都从这里出，代码里不出现魔法数字。
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 路径允许被环境变量顶掉。
 * 为什么要这个：插件里加了一个「设置页直接写 config.json」的 HTTP 口，测试必须能把它
 * 指到临时目录——否则跑一次 `npm test` 就把主人的真实配置改了。顺带也支持「同一台机器
 * 跑两份不同配置」（PG_CONFIG_PATH=... node src/run.js --once）。
 */
function pathFromEnv(key, fallback) {
  const v = String(process.env[key] || '').trim();
  return v ? path.resolve(v) : fallback;
}

export const CONFIG_PATH = pathFromEnv('PG_CONFIG_PATH', path.join(ROOT, 'config.json'));
export const STATE_PATH = pathFromEnv('PG_STATE_PATH', path.join(ROOT, 'state.json'));
export const LOG_DIR = pathFromEnv('PG_LOG_DIR', path.join(ROOT, 'logs'));

export const CHARACTER_REST_DEFAULTS = Object.freeze({
  bed: '22:00', wake: '06:30', jitterMin: 30, windDownMin: 30,
});

export const AGREEMENT_DEFAULTS = Object.freeze({
  enabled: false, maxItems: 8, aheadMin: 10, followUpMin: 60, expireHours: 24,
  shortWithinMin: 180, slowIntervalMin: 15, extractTimeoutMs: 5000, soonMin: 10, fewHoursMin: 120, dateTime: '18:00', model: '',
});
export const ROLEPLAY_FOLLOWUP_DEFAULTS = Object.freeze({ enabled: true, minMinutes: 10, maxMinutes: 20 });
export const BRUSHOFF_MOOD_DEFAULTS = Object.freeze({ enabled: false, decayHours: 6, noReplyMin: 90, angryDelayMinSec: 25, angryDelayMaxSec: 50 });
export const CURIOSITY_DEFAULTS = Object.freeze({ enabled: true, maxCandidates: 6, keepDays: 7, warmMin: 30 });
export const RECEPTIVITY_DEFAULTS = Object.freeze({ mode: 'shadow', threshold: 0.28, minSamples: 12 });

const EXPLORATION_BIASES = new Set(['leisure', 'balanced', 'research']);

export function usesLegacyExplorationCadence(exploration) {
  return exploration?.leisureEvery != null && !EXPLORATION_BIASES.has(exploration.bias);
}

export function explorationBiasForUi(exploration) {
  if (EXPLORATION_BIASES.has(exploration?.bias)) return exploration.bias;
  if (!usesLegacyExplorationCadence(exploration)) return DEFAULTS.exploration.bias;
  const cadence = Number(exploration.leisureEvery);
  return cadence === 1 ? 'leisure' : cadence === 2 || cadence === 3 ? 'balanced' : 'research';
}

/** 缺字段时的兜底，避免旧配置升级后崩。 */
const DEFAULTS = {
  enabled: true,
  dryRun: true,
  debugMode: false,
  tickMinutes: 10,

  timezone: 'Asia/Shanghai',
  presets: { active: 'custom', customSnapshot: null, overrides: {} },
  characterRest: { ...CHARACTER_REST_DEFAULTS },
  agreements: { ...AGREEMENT_DEFAULTS },
  exploration: { feedback: { ...CURIOSITY_DEFAULTS }, auto: false, mode: 'deep', model: '', offerShare: false, mood: false, portrait: false, moodSource: 'auto', web: false, video: false, builtinFeeds: false, rssUrls: '', syncToSharedMemory: false, extraTools: '', bias: 'balanced', browseMode: 'vision_light', browseMaxSteps: 40, interest: '', nextTopic: '', workSources: '', offPeakOnly: false, intervalMinutes: 180, recentDays: 3, moodHours: 2, portraitHours: 2, roundBudgetMs: 300000, planTimeoutMs: 30000, roundTimeoutMs: 45000, toolTimeoutMs: 18000, extTimeoutMs: 12000, storyboardTimeoutMs: 65000, storyboardSeconds: 60, moodReplyAgeMin: 30, moodDraftTimeoutMs: 15000, portraitTimeoutMs: 12000 },
  // 全局静默：这一段里所有功能都不读不发（含邮箱不联网）。多段、可跨零点。
  quietHours: [['22:30', '07:30']],
  quietHoursNote: '全局静默，多段，空数组=不静默',
  // 忙碌时段：她上课/上班/开会的那几段。这些时段里我不主动开口（她主动发消息还是照常回）。
  // 和静默的区别：静默是连读都不读，忙碌只是「我不先说话」。
  busyHours: [],
  busyHoursNote: '她忙的时候不主动开口（她先说话照常回），多段，空数组=不忙',
  idle: { onlineSec: 30, awaySec: 600 },
  // replyGuard：开口前再翻一遍最新的出站记录（QQ history / qq-reply.out.txt / 抖音 dm 记忆），
  // 只要发现「我最后一次说话已经晚于她那条消息」，这一拍就不回——插件可能已经替我们回过了。
  rules: { gapMaxX: 3, replyCooldownMin: 5, minGapMin: 240, dailyCap: 3, backfillWindowMin: 30, douyinStaleMin: 10, replyGuard: true, autoReply: true, proactive: true, backfill: true, feedback: { enabled: true, coldAfter: 6, coldRate: 0.25, coldDays: 3, testMode: false, replyMatchSec: 60, hitMin: 45, windowMin: 240, keepHours: 24, dayStartMin: 510, dayEndMin: 1410 }, adaptiveGap: true,
    stateWriteWaitMs: 120,
    // judge：护栏放行之后，再让模型看一眼整份处境，自己决定这一拍说不说、说什么。
    // 默认关 = 完全按规则链走（pickTopic 挑到由头就写）；开着也只是「多问一次」——
    // 静默/间隔/上限/guard 全在外面，模型说不说都越不过它们；判断失败一律退回规则链。
    // attempts：模型把「判断」写成一句回话时（角色人格大概三成会这样），再问一次；默认 2 次就够了。
    // 阶段 4：shadow = 被护栏拦下的拍子也随机抽一部分交给模型预演（只记不发，不碰 feedback）。
    // shadowSampleRate 默认 0.25：一天被拦一百来拍，只烧二三十次调用。
    judge: { enabled: false, attempts: 2, shadow: false, shadowSampleRate: 0.25, timeoutMs: 90000 },
    receptivity: { ...RECEPTIVITY_DEFAULTS },
    askProjectOnce: false,
    qqContinuation: false,
    roleplayFollowup: { ...ROLEPLAY_FOLLOWUP_DEFAULTS },
    actionGate: { enabled: true, expiresMinutes: 15, ackWaitSec: 30 },
    qqCommands: { enabled: true, extended: false, intentTimeoutSec: 5, timeoutSec: 90, freshSec: 120 },
    chatSession: { maxToolCallsPerTurn: 0, notifyOnToolLimit: true },
    qqRollover: { enabled: true, thresholdPercent: 80, carryMessages: 10, prepareBindingFile: true },
    exposeMaintenanceTools: false,
    compactChatTools: false,
    qqTiming: { debounceMs: 3500, pollSec: 2, windowSec: 180, pauseSec: 15, expireSec: 55, inFlightSec: 180, generationTimeoutMs: 20000, hotMinChars: 6 },
    closingCooldownMin: 120,
    projectTiming: { memoryDays: 14, updateMin: 30, generationTimeoutMs: 20000 },
    // 随口说话：没有由头时，也可以说一句。**默认关**——要 judge 也开着才生效，
    // 因为它靠 judge 判「这一拍要不要说」。生成只走模型：模板写不出自然的无由头话，
    // 写不出来就不发（绝不 fallback），废话比沉默差。
    // perDay 独立计数、不占由头额度，但照旧计入每日总上限。
    // dayStart/dayEnd 是允许时段（分钟数或 HH:mm）；全局静默和她睡着的那段一律不说。
    chitchat: {
      enabled: false,
      perDay: 3,
      barePerDay: 1,
      dayStart: 480,
      dayEnd: 1410,
      maxChars: 40,
      seedDays: 30,
      densityDays: 7,
      strandHours: 12,
      pauseHours: 48,
      restHistoryDays: 7,
      restPaddingMin: 30,
      restFallbackStartMin: 1380,
      restFallbackEndMin: 420,
      // 记忆种子要不要跳过我自己标了「不给对方看」的条目。
      // 注意方向：那是**我**瞒着对方的东西（self.md 里的 PRIVATE_MARK），不是对方瞒着我；
      // 默认跳过——瞒着她的事不能反过来拿去当搭话的素材。
      seedSkipPrivate: true,
    },
    // 被敷衍或无理由不回引发的闷闷与生气状态机（默认关闭）：
    // 默认 6 小时滑动衰减内，不回（默认 90 分钟）或敷衍（随口话敷衍不计、随口话不回计入）第 1 次有点闷不追问、
    // 第 2 次更失落、第 3 次生气（暂停分享、闲聊带情绪、慢回 25–50s）。同一段聊天（30 分钟内）认真回过一次不计入并抵消之前攒的次数。
    brushoffMood: { ...BRUSHOFF_MOOD_DEFAULTS },
    // 阶段 3：自然触发时刻（默认关）。关着 = 只看时钟；开着 = 一段活干完、一段课上完、
    // self.md 刚写一条，这几种时刻也算「可以开口」。静默/忙碌/离开/每日上限一概不动。
    // takeGap：事件拍能不能越过 minGap。默认 false（间隔地板照旧，事件只是提前到那一秒）；
    // 开着就按 floorMin 留一个更短的地板——两次开口之间至少这么久，绝不密密地连着说。
    // 课上完只给两个时刻：上午段（开始时间 ≤ courseSplitMin）整段上完、当天最后一节上完；
    // 段中间下课不算，一天最多两次。courseWindowMin 是「刚上完」的窗口（默认 20 分钟）。
    naturalTriggers: { enabled: false, takeGap: false, floorMin: 20, courseWindowMin: 20, courseSplitMin: 720 },
    // 阶段 1（0.14）：间隔分档。关着 = 单一 minGapMin 一刀切（0.13 行为）。
    // 开着按由头分三档：回她/接转发/追问 5 分钟，事件类 60 分钟，其余闲聊 240 分钟。
    // 跨档只兜 replyMin（回复档）这道全局地板——否则 chat 的 240 会把 event 压死，分档就没意义。
    gapByTier: { enabled: false, replyMin: 5, eventMin: 60, chatMin: 240 },
    // 多端（QQ/抖音）默认允许不在电脑前也主动开口；开启 requirePcOnline 后才恢复「人不在电脑前就拦截」。
    requirePcOnline: false,
    // 阶段 1（0.14）：「人不在」从硬拦截降级成快照里的一个信号，交给 judge 判断。
    // 只在 judge 也开着时生效——没有软决策层就不许放开硬闸（防止规则裸奔）。
    presenceSignal: { enabled: false, recentChatMin: 30, recentReturnMin: 30, justActiveSec: 120 } },
  channels: {
    primary: 'internal',
    // activeHours 空数组 = 全天；多段、可跨零点。与 quietHours 冲突会在 --windows 里报。
    internal: { enabled: true, read: true, send: true, activeHours: [] },
    qq: { enabled: true, read: true, send: true, peerId: '', activeHours: [] },
    main: { enabled: false, read: true, send: false, activeHours: [] },
    douyin: { enabled: false, read: true, send: true, activeHours: [], peerSecUid: '', peerName: '', pollSec: 30, readTimeoutSec: 30, sendTimeoutSec: 240 },
  },
  // 三条链路的总闸（比 channels.*.enabled 高一层）：关掉就当这条链路不存在。
  // 手机端不是插件——手机 App 发 FISH 邮件 → 本机 IMAP 取回，所以它管的是睡眠/压力/屏幕这三类数据。
  // 抖音默认关：它读的是私信记忆，开着会把抖音那边的对话也当成「她刚说话」（想开就在设置页「接入」里开，
  // 那个开关会连带把 channels.douyin.enabled 一起改，不会出现两个开关打架）。
  sources: {
    // staleHours：鱼鱼数据超过这么多小时没更新，睡眠/压力/步数/屏幕四类由头停用（拿旧数据问「昨晚睡得好吗」比不说更伤）。
    // dateTs 缺失或为 0 时视为新鲜——宁可照旧，也别因为读不到邮件头就把四类全停。
    // staleGuard：数据过期检查本身的总闸。关掉 = 不管邮件多旧都照旧用（阈值仍留着，方便只关不删）。
    phone: { enabled: true, staleHours: 36, staleGuard: true, replyContextMaxAgeMin: 240 },
    qq: { enabled: true },
    douyin: { enabled: false, detectCacheMin: 10 },
    // 别的记忆插件：只读它记下来的长期记忆，当「我本来就知道的事」用。
    // plugin 目前只有 fish-memory；session 留空 = 最近改过的那份会话，填 id 前缀就锁一份，填 all 全合并。
    // 想接别的记忆插件：在 memorysource.js 的 MEMORY_PLUGINS 里加一项（告诉你的大肥鱼就行）。
    memory: { enabled: true, plugin: 'fish-memory', dir: '', session: '', max: 3, maxAgeDays: 120 },
  },
  // signals：不截屏的那一路——前台窗口标题/进程名 + 浏览器当前标签页（本机 CDP 调试口）+ 编辑器里的文件。
  // 比 L3 的 OCR 准：读的是程序本来就有的字，不是认出来的。默认开，但只在真要发的那一拍读。
  perception: {
    l2: { enabled: true },
    probeCacheMs: 5000,
    probeTimeoutMs: 4000,
    l3: { enabled: false, everyMin: 30, timeoutMs: 12000, skipFg: ['lockapp', 'logonui'] },
    signals: { enabled: true, browser: true, port: 9223, timeoutMs: 600 },
    // 反作弊与全屏游戏保护：常见国服/外服反作弊进程或全屏游戏在跑时，不读窗口标题、不读浏览器标签、不截屏，
    // 只留「键鼠多久没动」（GetLastInputInfo，跟游戏无关）。
    anticheat: {
      skip: true,
      skipFullscreen: true,
      fullscreenCooldownMin: 10,
      procs: [
        'wegame', 'tencentdl', 'tcls', 'crossproxy', 'leagueclient', 'lolex',
        'dnf', 'cf', 'valorant', 'vgtray', 'vgc', 'gamecoach',
        'tenprotect', 'tesafe', 'ace-tray', 'sguard64', 'sguardsvc64',
        '5eclient', '5earena', 'pwclient', 'b5client',
        'easyanticheat', 'easyanticheat_eos', 'beservice', 'bedaisy', 'battleye',
        'faceitclient', 'faceitservice', 'gamemon', 'gamemon64', 'npggnt',
        'xigncode', 'xxd-0', 'pnkbstra', 'pnkbstrb',
        'eaanticheat', 'eaanticheat.gameservice', 'mhyprot2', 'hoyokprotect',
        'nexongamesecurity', 'blackcipher', 'blackcipher64',
      ],
    },
  },
  send: { enabled: false, requireConfirm: true, timeoutMs: 8000, split: { enabled: true, maxParts: 4,
    minFirstMs: 6000, minGapMs: 1200, maxRoundMs: 90000, maxFirstMs: 60000, maxGapMs: 5000,
    firstJitterMs: 12000, gapJitterMs: 2200, firstPerCharMs: 60, gapPerCharMs: 90 } },
  logging: { keepDays: 2, reportDays: 7, dayStartHour: 7, mailUpdateMode: 'merge' },
  // 本机私有规则：禁用词、只有这台机器成立的事实。文件不在就是空的（= 通用插件）。
  // 格式见 src/local.js 顶部注释；也可以用 content.local 直接塞。
  local: { file: 'local-style.json' },
  // 人格：借 dsh-agent-md 的 AGENT.md；没有就用自己的 persona.md
  persona: {
    enabled: true,
    note: '优先读 dsh-agent-md 的全局人格（<DSH_HOME>/AGENT.md）；没有插件或插件关掉时读本目录 persona.md',
    dshHome: '',
    includeGlobal: true,
    includeProject: false,
    projectCwd: '',
    localFile: 'persona.md',
  },
  // 内容：任何一步算不出来就不发，绝不硬凑
  content: {
    enabled: true,
    // auto（有 CLI 就用 llm）| template | llm | fixed（测试通道：不看由头、不叫模型，固定发一句）
    mode: 'auto',
    // mode='fixed' 时发这句。用来验证「判定 → 发送」这段链路能不能通，不关心说了什么
    fixedText: '1',
    maxChars: 60,
    // 法定节假日表（src/holidays.js）之外的补充：逗号分隔的 YYYY-MM-DD。
    // holidays = 额外放假的日子；workdays = 调休上班的周末（优先于 holidays）。
    holidays: '',
    workdays: '',
    // 节假日日历接口：URL 里 {year} 会替换成四位数年份。
    // 配好之后让模型调 presence_holiday_calendar(action=refresh) 拉一次，写进 data/holidays-<年>.json；
    // 留空 = 只用 src/holidays.js 内置表 + 上面手填的日期。
    calendar: { url: '', auto: true },
    // 写给模型的素材，各自一个开关（默认开）。关掉那一段就整段不进 prompt，行为和加它之前完全一样。
    // recentOutbound：我最近真发出去的 5 条（防连着几天一个开头、一个话题）。
    // slotStats：每类由头的接住率（她接没接）。后者还受 rules.feedback.enabled 约束。
    prompt: { recentOutbound: true, slotStats: true },
    llm: { electron: '', cli: '', profile: 'headless', timeoutMs: 90000 },
    // 她转来的视频：真的看一遍（下载 → 口播转写 → 两三行摘要）再说话。
    // 关掉就退回「只看标题」，而引擎在看不到内容时干脆不拿这条当由头。
    // 依赖：桌面 Edge 开着 9223（登录态）、本机已有 ffmpeg 与 whisper 服务。
    // 转写服务不常驻（会和 Breeze 一起把内存吃满）：需要时自己拉起，转完自己关掉。
    forward: {
      enabled: true,
      // 看视频用的取数脚本（本机路径自己填；留空 = 不下载视频，只看标题）。
      fetchScript: '',
      asrUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
      asrModel: 'whisper-small',
      asrAutostart: true, // 关掉就只在服务本来就在跑时才转写（不替你起进程）
      asrScript: '', // 空 = ~/.dsh/start-asr.ps1
      asrWaitMs: 180000, // 从拉起等到端口能连（模型加载慢）
      timeoutMs: 600000, // 一条 3 分钟的口播：下载 + 转写 + 摘要合计
      failTtlHours: 6,
      maxAgeDays: 30, // 同一条视频只认真看一次
      // 调试口没开时按脚本起一个独立 profile 的 Edge（默认 ~/.dsh/start-edge-debug.ps1）。
      edgePort: 9223,
      edgeScript: '', // 空 = ~/.dsh/start-edge-debug.ps1
      edgeAutostart: true, // 关掉就只在口子本来开着时下载
      edgeWaitMs: 25000,
      visionInfoTimeoutMs: 10000,
      serviceConnectMs: 800,
      asrPollMs: 1500,
      edgePollMs: 500,
      serviceLaunchMs: 60000,
      asrLookupMs: 20000,
      asrStopMs: 15000,
      extractAudioMs: 120000,
    },
    topics: {
      reply: true,
      forward: true,
      sleep: true,
      // 步数：18 点以后看今天走了多少。两头都是由头，中间那一段不打扰。
      // 两个判断值都能在设置页改（默认 <2000 = 一整天没怎么动，>8000 = 活动量好）。
      steps: true,
      stepsFromHour: 18,
      stepsLowMax: 2000,
      stepsHighMin: 8000,
      stepsMaxAgeMin: 120, // 只认新到的邮件：晚上替中午的步数发言就是重播
      screen: true,
      share: true,
      catchup: true,
      replyMaxAgeMin: 720,
      stressMinGapMin: 180,
      stressMaxAgeH: 12,
      stressFromHour: 9,
      stressToHour: 22,
      sleepShortMin: 390,
      sleepLongMin: 570,
      sleepFromHour: 7,
      sleepToHour: 10.5,
      sleepMaxAgeH: 14,
      sleepSameDayGraceMin: 360,
      sleepDayStartHour: 7,
      sleepDeepShortMin: 120,
      sleepLateBed: '00:30',
      screenHeavyMin: 720,
      screenMaxAgeH: 14,
      wellnessCooldownHours: 96,
      screenFromHour: 21,
      shareGapMin: 1440,
      shareMinChars: 40,
      catchupDays: 2,
      // —— 只看电脑的三个由头：不接手机 App 时睡眠/压力/步数/屏幕全哑，就靠这些撑着
      lateUp: true, // 深夜还亮着；一个晚上只提一次（跨零点算同一晚）
      lateFromHour: 23,
      lateToHour: 2, // 23:00–02:00
      longSit: true, // 连续坐在电脑前不动
      longSitHours: 5,
      backHome: true, // 离开一阵又回来
      backCooldownMin: 120,
      backRecentMin: 20,
      backUserQuietMin: 120,
      backAfterMin: 30, // 离开超过这么久才算「出去过」，不是去倒杯水
      // 课表：唯一往前看的由头（设置页多行框，或 data/agenda.txt）
      agenda: true,
      agendaTomorrowHour: 21,
      agendaEarlyBeforeHour: 9,
      agendaSoonMinLead: 5,
      agendaTomorrowUntilHour: 2,
      agendaSoonMin: 20, // 提前多少分钟提「快上课了」（按分钟算）
      // 考试：也只吃设置页那份表（或 data/exams.txt）
      examSoon: true,
      examSoonMin: 60, // 考前多少分钟提「快考了」（按分钟算）
      examReview: true,
      examReviewDays: 7, // 考前多少天提「该复习了」（按天算）
      // 角色作息招呼：角色实际入睡前和刚醒来后的短窗口内顺口打声招呼
      characterRest: true,
      characterRestBeforeBedMin: 10,
      characterRestAfterWakeMin: 10,
      characterRestGreetSkipMin: 120,
      // 追问：我主动发过、她一直没回的那条，隔多久可以问一句「怎么没回」
      noReply: true,
      noReplyMin: 120, // 距我那条至少这么多分钟没动静
      noReplyAfterHerMin: 120, // 她最后一次说话之后至少隔这么久才追（别她刚说完就问）
      noReplyAfterBusyMin: 20, // 模型判「她在忙/睡了」：等她忙完 / 忙碌时段结束后再等这么久
      followCasualSilence: false,
      noReplyDouyin: true, // 仅在允许追问闲聊或分享时参与。
      noReplyJudge: true,
      noReplyJudgeTimeoutMs: 90000, // 核对用户是否约好提醒及当前是否在忙
    },
    // 课表正文：一行一节，比如「周一 08:00-09:40 电机学 @教三201」
    // termStart = 开学第一周的周一（YYYY-MM-DD）；填了才按「第几周」过滤带周次的课
    // periods  = 作息表（第几节对应几点），课表里直接写了时间的行不需要它
    // off      = 设置页课程列表里被取消勾选的课（不提醒），空 = 全都提
    agenda: { text: '', termStart: '', periods: '', off: [] },
    // 考试正文：一行一场，比如「2026-12-20 09:00 电机学 @教三201」
    exams: { text: '' },
  },
  // 邮箱读取（IMAP）：默认关，开之前不联网；凭据另存 credentials.json
  mail: {
    enabled: false,
    note: '需要手机 App「鱼鱼状态」配好邮箱并在采集后发信；本插件只读不发',
    user: '',
    host: '',
    port: 993,
    tls: true,
    mailbox: 'INBOX',
    intervalMinutes: 30,
    activeHours: [], // 空数组=全天；只在这几段里才连 IMAP
    fetchCount: 5,
    subjectPattern: '^\\s*FISH',
    timeoutMs: 20000,
  },
};

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

export function loadConfig() {
  let raw = {};
  let hasFile = false;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    hasFile = Boolean(raw && typeof raw === 'object' && Object.keys(raw).length > 0);
  } catch {
    raw = {};
  }
  const cfg = merge(DEFAULTS, raw);
  const rawPrimary = raw?.channels?.primary;
  if (rawPrimary === 'internal' || rawPrimary === 'qq' || rawPrimary === 'douyin') {
    cfg.channels.primary = rawPrimary;
  } else if (hasFile) {
    // 升级旧配置时未写 channels.primary 的文件保持原 QQ 主通道行为，避免静默切换。
    cfg.channels.primary = 'qq';
  } else {
    cfg.channels.primary = 'internal';
  }
  if (usesLegacyExplorationCadence(raw?.exploration)) delete cfg.exploration.bias;
  else if (!EXPLORATION_BIASES.has(cfg.exploration?.bias)) {
    cfg.exploration = { ...DEFAULTS.exploration, ...cfg.exploration, bias: DEFAULTS.exploration.bias };
  }
  if (Object.hasOwn(raw?.content?.topics || {}, 'shareGapH') && !Object.hasOwn(raw?.content?.topics || {}, 'shareGapMin')) {
    const legacyH = Number(raw.content.topics.shareGapH);
    if (Number.isFinite(legacyH) && legacyH >= 0) {
      cfg.content = { ...cfg.content, topics: { ...cfg.content.topics, shareGapMin: Math.round(legacyH * 60) } };
    }
  }
  // 老版本会钳制这两个门槛。第一次加载显示过去实际生效的数值。
  if (cfg.timingVersion !== 1) {
    cfg.content = { ...cfg.content, topics: { ...cfg.content.topics } };
    const topics = cfg.content.topics;
    topics.screenHeavyMin = Math.max(720, Number(topics.screenHeavyMin) || 0);
    topics.longSitHours = Math.max(5, Number(topics.longSitHours) || 0);
    if (!Object.hasOwn(raw?.content?.topics || {}, 'screenMaxAgeH')) topics.screenMaxAgeH = topics.sleepMaxAgeH;
    const legacyFirst = Number(raw?.send?.split?.firstDelayMs);
    if (legacyFirst > 0) cfg.send = { ...cfg.send, split: { ...cfg.send.split, minFirstMs: legacyFirst } };
    cfg.timingVersion = 1;
  }
  // 升级旧配置里的默认 11 项腾讯系反作弊名单：未自定义过的用户自动补充外服/Steam 反作弊进程。
  const rawAcProcs = raw?.perception?.anticheat?.procs;
  const LEGACY_AC_11 = ['wegame', 'tencentdl', 'tcls', 'crossproxy', 'leagueclient', 'lolex', 'dnf', 'cf', 'valorant', 'vgtray', 'gamecoach'];
  if (Array.isArray(rawAcProcs) && rawAcProcs.length === LEGACY_AC_11.length &&
      LEGACY_AC_11.every((name, idx) => String(rawAcProcs[idx] || '').toLowerCase() === name)) {
    cfg.perception = {
      ...cfg.perception,
      anticheat: { ...cfg.perception.anticheat, procs: [...DEFAULTS.perception.anticheat.procs] },
    };
  }
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

/** 支持 "idle.awaySec" 这种路径读。 */
export function getPath(obj, dotted, fallback) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (const p of parts) {
    if (!isObj(cur) || !(p in cur)) return fallback;
    cur = cur[p];
  }
  return cur;
}

/** 支持 "idle.awaySec=900" 这种路径写，值按 JSON 解析，失败当字符串。 */
export function setPath(obj, dotted, rawValue) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!isObj(cur[parts[i]])) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  let v = rawValue;
  try {
    v = JSON.parse(rawValue);
  } catch {
    v = rawValue;
  }
  cur[parts[parts.length - 1]] = v;
  return obj;
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function readStateForWrite() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function writeStateAtomic(st) {
  const tmp = STATE_PATH + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, STATE_PATH);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const STATE_WRITE_WAIT_MAX_MS = 500;
const STATE_LOCK_RETRIES = 4;
const stateLockWait = new Int32Array(new SharedArrayBuffer(4));

function linkStateLock(lock, owner) {
  try {
    fs.linkSync(owner, lock);
    return true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    return false;
  }
}

function tryAcquireStateLock(lock, owner) {
  if (linkStateLock(lock, owner)) return true;
  try {
    const before = fs.statSync(lock);
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return false;
    } catch (check) {
      if (check.code !== 'ESRCH') return false;
    }
    const current = fs.statSync(lock);
    if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) return false;
    // Orphaned lock from a process that did not survive to release it.
    fs.unlinkSync(lock);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The other writer may have released the lock since linkSync.
  }
  return linkStateLock(lock, owner);
}

function acquireStateLock(lock, owner) {
  if (tryAcquireStateLock(lock, owner)) return;
  const fallback = DEFAULTS.rules.stateWriteWaitMs;
  const configured = Number(loadConfig().rules?.stateWriteWaitMs ?? fallback);
  const waitMs = Number.isFinite(configured) ? Math.max(0, Math.min(STATE_WRITE_WAIT_MAX_MS, configured)) : fallback;
  const deadline = performance.now() + waitMs;
  for (let i = 0; i < STATE_LOCK_RETRIES; i++) {
    const delay = Math.min(waitMs / STATE_LOCK_RETRIES, deadline - performance.now());
    if (delay <= 0) break;
    // Keep the state transaction synchronous while letting the other process finish.
    Atomics.wait(stateLockWait, 0, 0, delay);
    if (tryAcquireStateLock(lock, owner)) return;
  }
  throw new Error('STATE_WRITE_BUSY: 另一进程正在保存状态');
}

function withStateWrite(update) {
  const lock = STATE_PATH + '.lock.tmp';
  const owner = lock + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(owner, String(process.pid), { flag: 'wx', mode: 0o600 });
    acquireStateLock(lock, owner);
    try {
      return update(readStateForWrite());
    } finally {
      fs.unlinkSync(lock);
    }
  } finally {
    fs.rmSync(owner, { force: true });
  }
}

const separatelyWrittenFeedback = ['preferences', 'receiptOverrides'];

export function saveState(st) {
  return withStateWrite(current => {
    const next = { ...st };
    const disk = current?.feedback;
    if (st.feedback || disk?.lastProactive || separatelyWrittenFeedback.some(key => Object.hasOwn(disk || {}, key))) {
      next.feedback = { ...st.feedback };
      for (const key of separatelyWrittenFeedback) {
        if (Object.hasOwn(disk || {}, key)) next.feedback[key] = disk[key];
        else delete next.feedback[key];
      }
      if (Number(disk?.lastProactive?.ts) > (Number(next.feedback.lastProactive?.ts) || 0)) {
        next.feedback.lastProactive = disk.lastProactive;
      }
    }
    writeStateAtomic(next);
  });
}

function updateFeedbackField(key, update) {
  return withStateWrite(st => {
    const change = update(st);
    if (!change) return null;
    st.feedback = { ...st.feedback, [key]: change[key] };
    writeStateAtomic(st);
    return change.result;
  });
}

export function updateStatePreferences(update) {
  return updateFeedbackField('preferences', update);
}

export function updateStateReceiptOverrides(update) {
  return updateFeedbackField('receiptOverrides', update);
}
