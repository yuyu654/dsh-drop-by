// settings.js —— 设置页能改哪些参数：白名单 + 校验 + 人话显示。
//
// 为什么要有这一层：插件对外多了一个 HTTP 写口（设置页调它），如果直接把
// `config.json` 当字典写，等于把 `content.llm.cli`、`mail.user` 这种也能被改——
// 前者能把生成指到任意脚本，后者是凭据。所以：
//   · **只有这里列出来的路径**能被写，别的路径一律 reject；
//   · 每个值都过一遍类型/范围校验，写进去的一定是能跑的值（不是"能存进去就行"）；
//   · 命令行的 `--set a.b=1` 不走这一层（它是给主人用的，本来就该什么都能改）。
//   · **凭据类**（现在的 `mail.authCode`）是特例：能写、**读不回来**。值不进 config.json，
//     而是落到 credentials.json；listForUi 只回「已设置/未设置」，value 永远是空串——
//     界面既显示不出来、也回写不回来（2026-11-04 加，之前连填的入口都没有）。
//
// 加一个新参数：在 SCHEMA 里加一行即可——设置页是照这份表**通用渲染**的，
// 客户端代码不用动。

import fs from 'node:fs';
import { CHARACTER_REST_DEFAULTS, explorationBiasForUi, getPath, STATE_WRITE_WAIT_MAX_MS, usesLegacyExplorationCadence } from './config.js';
import { normalizeWindows, fmtWindows } from './schedule.js';
import { SECRETS_PATH, saveSecrets, hostFor } from './fishmail.js';
import { detectSources, detectEmotionPortrait, douyinPluginPeer } from './detect.js';
import { detectMemory } from './memorysource.js';
import { parseAgenda, agendaSource, courseKey } from './agenda.js';
import { parseExams, examsSource } from './exams.js';
import { characterRestStatus } from './character-rest.js';
import { listRegisteredMemorySources, listRegisteredMoodSources } from './extensions.js';
import { getHostModelCatalog } from './hostllm.js';

/** 存凭据的位置（和 fishmail 用同一份）。读的时候永远只给「已设置/未设置」。 */
function secretFor(path) {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    if (path === 'mail.authCode') return String(j.authCode || j.mail?.authCode || '');
  } catch {
    /* 没有就是没设置 */
  }
  return '';
}

/**
 * 接入开关后面那半句「检测：……」。设置页是通用渲染的，没有地方挂徽标，
 * 所以把检测结果拼进 hint——主人一眼能看出「这条链路到底装了没有、通不通」。
 * 一次 listForUi 只扫一遍（detCache），别三个开关各扫一次。
 */
function detectHint(specPath, cfg, detCache) {
  if (specPath === 'exploration.portrait') {
    if (!detCache.emotion) detCache.emotion = detectEmotionPortrait();
    const d = detCache.emotion;
    const ver = d.version ? `（v${d.version}）` : '';
    return `｜检测：${d.note}${ver}`;
  }
  if (specPath === 'sources.memory.plugin') {
    if (!detCache.memory) detCache.memory = detectMemory(cfg);
    return `｜检测：${detCache.memory.note}`;
  }
  const key = specPath.split('.')[1];
  if (!detCache.value) detCache.value = detectSources(cfg);
  const d = detCache.value[key];
  if (!d) return '';
  const ver = d.version ? `（v${d.version}）` : '';
  return `｜检测：${d.note}${ver}`;
}

/** 设置页全局搜索用的 9 个场景关键词（跨分组聚合，不照抄折叠分组名）。 */
export const SEARCH_TAGS = [
  { id: 'channel', label: '主通道与续聊' },
  { id: 'pace', label: '频率与克制' },
  { id: 'rest', label: '角色作息' },
  { id: 'exploration', label: '自主探索' },
  { id: 'tasks', label: '任务与约定' },
  { id: 'schedule', label: '课表与节假日' },
  { id: 'memory', label: '记忆与心情' },
  { id: 'sensing', label: '手机与桌面感知' },
  { id: 'media', label: '视频与超时' },
];

const TIME_UNITS = new Set(['秒', '毫秒', '分钟', '小时', '天', '点', '时:分', '毫秒/字', '分钟（从 0 点算）']);

function ensureTimeUnitHint(spec, rawHint) {
  const hint = String(rawHint || '').trim();
  if (TIME_UNITS.has(spec.unit)) {
    const core = spec.unit === '分钟（从 0 点算）' ? '分钟' : spec.unit;
    if (!hint.includes(core)) {
      const prefix = `单位：${spec.unit}。`;
      return hint ? `${prefix}${hint}` : prefix;
    }
  } else if (spec.type === 'windows' && !hint) {
    return '单位：时段（HH:mm-HH:mm，多段用逗号隔开，可跨零点），留空 = 全天允许。';
  } else if (spec.type === 'hm' && !hint.includes('时:分') && !hint.includes('HH:mm')) {
    const prefix = '单位：时:分（00:00–23:59）。';
    return hint ? `${prefix}${hint}` : prefix;
  }
  return hint;
}

export function tagsForSpec(spec) {
  const p = String(spec?.path || '');
  const tags = [];
  const add = (id) => { if (!tags.includes(id)) tags.push(id); };

  if (p.startsWith('channels.') || p.startsWith('rules.qqRollover.') ||
      p.startsWith('sources.qq') || p.startsWith('sources.douyin') ||
      p === 'rules.qqTiming.debounceMs' || p === 'rules.qqTiming.inFlightSec') add('channel');

  if (p.startsWith('characterRest.') || p.startsWith('content.topics.characterRest')) add('rest');

  if ((p.startsWith('exploration.') && p !== 'exploration.portrait' && p !== 'exploration.portraitHours') ||
      p.startsWith('content.topics.share') || p.startsWith('rules.actionGate.')) add('exploration');

  if (p.startsWith('rules.qqCommands.') || p.startsWith('agreements.') ||
      p.startsWith('content.topics.noReply') || p === 'content.topics.followCasualSilence' ||
      p === 'rules.askProjectOnce' || p.startsWith('rules.projectTiming.') ||
      p === 'rules.qqTiming.pollSec') add('tasks');

  if (p.startsWith('content.agenda.') || p.startsWith('content.exams.') ||
      p.startsWith('content.topics.agenda') || p.startsWith('content.topics.exam') ||
      p === 'content.holidays' || p === 'content.workdays' || p.startsWith('content.calendar.') ||
      p.startsWith('rules.naturalTriggers.course')) add('schedule');

  if (p.startsWith('sources.memory.') || p.startsWith('exploration.mood') ||
      p.startsWith('exploration.portrait') || p === 'content.enabled' || p === 'content.mode' ||
      p === 'content.maxChars' || p.startsWith('content.prompt.') || p === 'content.llm.attempts' ||
      p.startsWith('rules.chitchat.seed') || p.startsWith('rules.feedback.')) add('memory');

  if (p.startsWith('sources.phone.') || p.startsWith('mail.') || p.startsWith('idle.') ||
      p.startsWith('perception.') || p.startsWith('content.topics.sleep') ||
      p.startsWith('content.topics.stress') || p.startsWith('content.topics.steps') ||
      p.startsWith('content.topics.screen') || p.startsWith('content.topics.late') ||
      p.startsWith('content.topics.longSit') || p.startsWith('content.topics.back') ||
      p.startsWith('content.topics.wellness')) add('sensing');

  if (p.startsWith('content.forward.') || p === 'content.topics.forward' ||
      p.startsWith('exploration.storyboard') || p === 'exploration.video' ||
      p.startsWith('logging.') || p === 'send.timeoutMs' || p === 'rules.stateWriteWaitMs' ||
      /(?:TimeoutMs|TimeoutSec|WaitMs|PollMs|ConnectMs|LookupMs|StopMs|AudioMs|CacheMs|CacheMin)$/i.test(p)) add('media');

  if (['enabled', 'dryRun', 'send.enabled', 'tickMinutes', 'startupDelaySec', 'tickJitterSec',
      'quietHours', 'busyHours', 'rules.proactive', 'rules.autoReply', 'rules.replyCooldownMin',
      'rules.replyGuard', 'rules.backfill', 'rules.backfillWindowMin', 'rules.dailyCap',
      'rules.minGapMin', 'rules.closingCooldownMin', 'rules.adaptiveGap', 'rules.qqContinuation',
      'rules.requirePcOnline', 'rules.presenceSignal.enabled', 'content.topics.reply',
      'content.topics.replyMaxAgeMin', 'content.topics.catchup', 'content.topics.catchupDays',
      'content.topics.shareGapMin'].includes(p) ||
      p.startsWith('send.split.') || p.startsWith('rules.qqTiming.') ||
      p.startsWith('rules.judge.') || p.startsWith('rules.chitchat.') ||
      p.startsWith('rules.gapByTier.') || p.startsWith('rules.naturalTriggers.') ||
      p.startsWith('rules.presenceSignal.')) add('pace');

  if (!tags.length) {
    const fallback = {
      日常: 'pace', 角色作息: 'rest', 决定TA粘不粘人: 'pace', 节奏: 'pace',
      说什么: 'memory', 数据从哪来: 'sensing', 课表与考试: 'schedule',
      自主探索: 'exploration', 聊天接口: 'channel', 时间间隔: 'media', 高级: 'pace',
    };
    add(fallback[spec?.group] || 'pace');
  }
  return tags;
}

/** 分组顺序 = 设置页从上到下的顺序：先日常、粘人程度，再具体，最后是平时别动的。 */
export const GROUP_ORDER = ['日常', '角色作息', '决定TA粘不粘人', '节奏', '说什么', '数据从哪来', '课表与考试', '时间间隔', '高级'];

/**
 * 分组顶部的一条说明（灰底小字）。目前只有「日常」有：反作弊提醒。
 * 写在这里而不是写死在 client 里 —— 以后加别组的说明只改这张表。
 */
export const GROUP_NOTES = {
  时间间隔: '聊天、探索、提醒与数据保留的时间设置。常用总节奏在「节奏」组。',
  日常:
    '带反作弊的游戏中：看屏幕（OCR）、看窗口和网页、抖音功能会自动避让或建议关闭；键鼠空闲不受影响。',
};
/** 这一组默认折起来：除了日常主控展开，其余各组默认折叠并显示人话摘要。 */
export const FOLDABLE_GROUPS = new Set(['角色作息', '决定TA粘不粘人', '节奏', '说什么', '数据从哪来', '课表与考试', '时间间隔', '高级']);

/**
 * 子项跟着父开关走：父开关关着，这一行就不显示（值还留在 config.json 里，开回来就恢复）。
 * dflt = 父开关在配置里没写时当作什么（默认开的父开关传 true）。
 */
function dep(path, dflt = true, on = true) {
  return { path, on, default: dflt };
}
const ON_JUDGE = dep('rules.judge.enabled', false);
const ON_JUDGE_SHADOW = dep('rules.judge.shadow', false);
const ON_CHITCHAT = dep('rules.chitchat.enabled', false);
const ON_NATURAL = dep('rules.naturalTriggers.enabled', false);
const ON_TIER = dep('rules.gapByTier.enabled', false);
const ON_FEEDBACK = dep('rules.feedback.enabled', true);
const ON_ADAPTIVE_GAP = dep('rules.adaptiveGap', true);
const ON_PRESENCE_SIGNAL = dep('rules.presenceSignal.enabled', false);
const ON_QQ_CMD = dep('rules.qqCommands.enabled', true);
const ON_ACTION_GATE = dep('rules.actionGate.enabled', true);
const ON_QQ_CONT = dep('rules.qqContinuation', false);
const ON_PROJECT = dep('rules.askProjectOnce', false);
const ON_PHONE = dep('sources.phone.enabled', true);
const ON_MEMORY = dep('sources.memory.enabled', true);
const ON_QQ = dep('sources.qq.enabled', true);
const ON_DOUYIN = dep('sources.douyin.enabled', false);
const ON_MAIL = dep('mail.enabled', false);
const ON_MAIL_OR_PHONE = { any: [ON_PHONE, ON_MAIL] };
const ON_PRIMARY_INTERNAL = dep('channels.primary', 'internal', 'internal');
const ON_PRIMARY_QQ = dep('channels.primary', 'qq', 'qq');
const ON_PRIMARY_DOUYIN = dep('channels.primary', 'qq', 'douyin');
const ON_MAIN_READ = dep('channels.main.read', false);
const ON_CONTENT = dep('content.enabled', true);
const ON_FORWARD = dep('content.forward.enabled', true);
const ON_EXP_AUTO = dep('exploration.auto', false);
const ON_EXP_MOOD = dep('exploration.mood', false);
const ON_EXP_PORTRAIT = dep('exploration.portrait', false);
const ON_EXP_WEB = dep('exploration.web', false);
const ON_EXP_VIDEO = dep('exploration.video', false);
const ON_VIDEO_OR_FORWARD = { any: [ON_FORWARD, ON_EXP_VIDEO] };
const ON_SPLIT = dep('send.split.enabled', true);
const ON_L3 = dep('perception.l3.enabled', false);
const ON_SIGNALS = dep('perception.signals.enabled', true);
const ON_SIGNALS_BROWSER = dep('perception.signals.browser', true);
const ON_FOLLOW_CASUAL = dep('content.topics.followCasualSilence', false);
const ON_NOREPLY_JUDGE = dep('content.topics.noReplyJudge', true);
const onTopic = (k) => dep(`content.topics.${k}`, true);

/**
 * 每一项：
 *   group   设置页哪一组（GROUP_ORDER 决定先后）
 *   path    config.json 里的点路径
 *   label   设置页上的名字
 *   type    bool | int | num | str | select | hm | windows | text | courses
 *   min/max int/num 的范围；str 的 max 是字数上限
 *   options select 的候选
 *   unit    显示用（分钟/字/次/条…）
 *   hint    一句话解释「改了会发生什么」，写清楚默认值
 *   dep     父开关（见上面的 dep()）：父开关关着就不显示
 */
export const SCHEMA = [
  { group: '高级', path: 'rules.qqRollover.enabled', label: '外部聊天到上下文阈值时预建续聊', type: 'bool', hint: '在同一工作区建新会话并经当前主通道提醒，旧会话可继续聊。建议在 dsh-fish-memory 开启按工作区共用记忆。' },
  { group: '高级', path: 'rules.qqRollover.thresholdPercent', label: '预建续聊的上下文占用率', type: 'int', min: 10, max: 95, unit: '%', dep: dep('rules.qqRollover.enabled', true), hint: '默认 80%。只在绑定会话完成一轮时检查，每个旧会话只预建一次。' },
  { group: '高级', path: 'rules.qqRollover.carryMessages', label: '新会话携带最近消息', type: 'int', min: 0, max: 50, unit: '条', dep: dep('rules.qqRollover.enabled', true), hint: '默认 10 条，用户和助手各自的一条都计数。填 0 只建立续聊会话。' },
  { group: '高级', path: 'rules.qqRollover.prepareBindingFile', label: '预备重启后自动切到续聊会话', type: 'bool', dep: dep('rules.qqRollover.enabled', true), hint: '预备当前主通道的磁盘绑定。当前聊天照常继续，重启 DSH 后启用。关闭后可手动切绑。' },
  { group: '说什么', path: 'rules.qqCommands.enabled', label: '接收私聊任务指令', type: 'bool', hint: '只接收主通道配置联系人的私聊。可以暂停探索方向、指定下轮题目、搜索公开网页、推进研究、整理笔记或跑插件快速测试。后台任务回传不受日常静默和配额限制。' },
  { group: '时间间隔', path: 'rules.qqCommands.intentTimeoutSec', label: '意图识别最多等多久', type: 'int', min: 1, max: 20, unit: '秒', dep: ON_QQ_CMD, hint: '默认 5 秒。模型超时或未给出可校验的任务时，直接走普通聊天。' },
  { group: '时间间隔', path: 'rules.qqCommands.timeoutSec', label: '任务多久先反馈超时', type: 'int', min: 5, max: 120, unit: '秒', dep: ON_QQ_CMD, hint: '默认 90 秒。任务到时限仍没结束会回一条状态。' },
  { group: '时间间隔', path: 'rules.qqCommands.freshSec', label: '任务指令最多多旧', type: 'int', min: 5, max: 900, unit: '秒', dep: ON_QQ_CMD, hint: '默认 120 秒。超过这个时间的补发消息不能启动后台任务。' },
  { group: '时间间隔', path: 'rules.actionGate.expiresMinutes', label: '动作提议多久内可确认', type: 'int', min: 1, max: 15, unit: '分钟', dep: ON_ACTION_GATE, hint: '默认 15 分钟，从动作请示送达时算。只使用主通道私聊中紧接着的一条消息。' },
  { group: '时间间隔', path: 'rules.actionGate.ackWaitSec', label: '换源结果最多等确认回复多久', type: 'int', min: 0, max: 120, unit: '秒', dep: ON_ACTION_GATE, hint: '默认 30 秒。搜索先结束时等待接单回复；已经回复就直接发结果。填 0 不等待。' },
  { group: '说什么', path: 'rules.actionGate.enabled', label: '确认后换源找正文', type: 'bool', hint: '仅当前研究确实没拿到正文、角色已提出具体换源请求时生效。需要开启探索网页、主动分享和真实发送，且当前主通道可回传结果。' },
  { group: '时间间隔', path: 'content.topics.agendaSoonMinLead', label: '临上课前少于多久就不再提醒', type: 'int', min: 0, max: 60, unit: '分钟', dep: onTopic('agenda') },
  { group: '时间间隔', path: 'content.topics.agendaTomorrowUntilHour', label: '明日早课提醒跨零点截止时间', type: 'int', min: 0, max: 6, unit: '点', dep: onTopic('agenda') },
  { group: '时间间隔', path: 'perception.probeCacheMs', label: '系统探针缓存时长', type: 'int', min: 0, max: 300, unit: '秒', scale: 1000 },
  { group: '时间间隔', path: 'perception.probeTimeoutMs', label: '系统探针调用超时', type: 'int', min: 1, max: 120, unit: '秒', scale: 1000 },
  { group: '时间间隔', path: 'sources.douyin.detectCacheMin', label: '抖音插件安装检测缓存时长', type: 'int', min: 0, max: 1440, unit: '分钟', dep: ON_DOUYIN },
  { group: '时间间隔', path: 'content.forward.visionInfoTimeoutMs', label: '查询看图模型能力超时', type: 'int', min: 1, max: 120, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.serviceConnectMs', label: '视频本地服务端口探测超时', type: 'int', min: 100, max: 30000, unit: '毫秒', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.asrPollMs', label: '转写服务启动后检查间隔', type: 'int', min: 100, max: 30000, unit: '毫秒', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.edgePollMs', label: 'Edge 启动后检查间隔', type: 'int', min: 100, max: 30000, unit: '毫秒', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.serviceLaunchMs', label: '运行本地视频服务启动脚本超时', type: 'int', min: 1, max: 300, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.asrLookupMs', label: '查询转写进程超时', type: 'int', min: 1, max: 120, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.asrStopMs', label: '关闭本轮启动的转写进程超时', type: 'int', min: 1, max: 120, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.extractAudioMs', label: '抽取视频音轨超时', type: 'int', min: 1, max: 900, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'startupDelaySec', default: 60, label: '启动后第一拍等待', type: 'int', min: 0, max: 3600, unit: '秒', hint: '下次启动 DSH 时使用。' },
  { group: '时间间隔', path: 'tickJitterSec', default: 30, label: '每拍额外随机等待上限', type: 'int', min: 0, max: 300, unit: '秒', hint: '填 0 完全按每拍间隔运行。' },
  { group: '时间间隔', path: 'mail.activeHours', label: '允许收邮件的时段', type: 'windows', dep: ON_MAIL_OR_PHONE },
  { group: '聊天接口', path: 'channels.primary', label: '主聊天接口', type: 'select', options: [['internal', '内部会话（DSH 桌面端）'], ['qq', 'QQ'], ['douyin', '抖音私信']], hint: '选择唯一的收发通道。新装默认「内部会话」，需在下方手动绑定或新建一个会话；三个通道共用同一个 DSH 会话，切换时会沿用。' },
  { group: '聊天接口', path: 'channels.internal.send', label: '往内部会话发', type: 'bool', dep: ON_PRIMARY_INTERNAL, hint: '主通道选内部会话时生效。开（默认）：允许主动开口、约定与补话投递到已绑定的 DSH 会话。' },
  { group: '聊天接口', path: 'channels.internal.read', label: '读内部会话', type: 'bool', dep: ON_PRIMARY_INTERNAL, hint: '开（默认）：读取已绑定 DSH 会话中的对话，用于判断互动节奏与回填接住率。' },
  { group: '聊天接口', path: 'channels.douyin.send', label: '往抖音发', type: 'bool', dep: ON_PRIMARY_DOUYIN, hint: '主通道选抖音私信时展示并生效。普通回复、主动开口、续聊提醒与任务回传都受发送总开关控制。' },
  { group: '聊天接口', path: 'channels.douyin.read', label: '读抖音私信', type: 'bool', dep: ON_PRIMARY_DOUYIN, hint: '开（默认）：读抖音私信和分享记录。关：抖音整块不读，TA在那边的消息不算「TA刚说话」' },
  { group: '聊天接口', path: 'channels.douyin.pollSec', label: '抖音私信轮询间隔', type: 'int', min: 10, max: 300, unit: '秒', dep: ON_PRIMARY_DOUYIN, hint: '默认 30 秒，最低 10 秒。抖音 IM 会检测请求模式，密集轮询或探测会触发 too many requests 限流。' },
  { group: '聊天接口', path: 'channels.douyin.peerSecUid', label: '抖音联系人 sec_uid', type: 'str', hint: '可在切到抖音前填写，例如 MS4wLjAB…；留空时从抖音插件（dsh-douyin-scroll）获取。' },
  { group: '聊天接口', path: 'channels.douyin.peerName', label: '抖音联系人昵称', type: 'str', dep: ON_PRIMARY_DOUYIN, hint: '留空 = 自动从抖音插件（dsh-douyin-scroll）获取。' },
  { group: '聊天接口', path: 'channels.qq.peerId', label: 'QQ 联系人', type: 'str', max: 16, hint: '填写目标联系人 QQ 号。从独立抖音或内部会话切到 QQ 前可先填写，已有共用绑定时会恢复原绑定。' },
  { group: '聊天接口', path: 'channels.qq.send', label: '往 QQ 发', type: 'bool', dep: [ON_QQ, ON_PRIMARY_QQ], hint: '开（默认）：这一侧才真发。关：判定照走、内容照写，但不往 QQ 发（配合演练模式看它会说什么）' },
  { group: '聊天接口', path: 'channels.qq.read', label: '读 QQ', type: 'bool', dep: [ON_QQ, ON_PRIMARY_QQ], hint: '开（默认）：读TA QQ 上的消息，用来判「TA刚说话」和回复。关：QQ 只当发送通道，不再读' },
  { group: '时间间隔', path: 'channels.douyin.readTimeoutSec', label: '抖音私信读取超时', type: 'int', min: 5, max: 120, unit: '秒', dep: ON_PRIMARY_DOUYIN, hint: '默认 30 秒。' },
  { group: '时间间隔', path: 'channels.douyin.sendTimeoutSec', label: '抖音私信发送超时', type: 'int', min: 10, max: 600, unit: '秒', dep: ON_PRIMARY_DOUYIN, hint: '默认 240 秒。首次启动浏览器可能更慢。' },
  { group: '时间间隔', path: 'channels.internal.activeHours', label: '允许读取内部会话的时段', type: 'windows', dep: ON_PRIMARY_INTERNAL },
  { group: '时间间隔', path: 'channels.qq.activeHours', label: '允许读取 QQ 的时段', type: 'windows', dep: [ON_QQ, ON_PRIMARY_QQ] },
  { group: '时间间隔', path: 'channels.douyin.activeHours', label: '允许读取抖音的时段', type: 'windows', dep: ON_PRIMARY_DOUYIN },
  { group: '时间间隔', path: 'channels.main.activeHours', label: '允许读取主会话的时段', type: 'windows', dep: ON_MAIN_READ },
  { group: '时间间隔', path: 'exploration.storyboardSeconds', label: '通用视频分镜取前多少秒', type: 'int', min: 1, max: 600, unit: '秒', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'exploration.moodReplyAgeMin', label: '调整心情语气最多参考多早的消息', type: 'int', min: 0, max: 1440, unit: '分钟', dep: ON_EXP_MOOD },
  { group: '时间间隔', path: 'exploration.planTimeoutMs', label: '探索选题生成超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒' },
  { group: '时间间隔', path: 'exploration.roundTimeoutMs', label: '探索进展生成超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒' },
  { group: '时间间隔', path: 'exploration.toolTimeoutMs', label: '探索搜索和读网页超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_EXP_WEB },
  { group: '时间间隔', path: 'exploration.extTimeoutMs', label: '外部探索源与扩展工具超时', type: 'int', min: 1, max: 120, scale: 1000, unit: '秒', hint: '单位：秒（默认 12 秒）。控制第三方探索扩展与额外只读宿主工具的单次调用超时。' },
  { group: '时间间隔', path: 'exploration.storyboardTimeoutMs', label: '探索视频分镜超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_EXP_VIDEO },
  { group: '时间间隔', path: 'exploration.moodDraftTimeoutMs', label: '探索心情润色超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_EXP_MOOD },
  { group: '时间间隔', path: 'exploration.portraitTimeoutMs', label: '心情判断超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_EXP_PORTRAIT },
  { group: '时间间隔', path: 'rules.qqTiming.generationTimeoutMs', label: '热聊补话生成超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_QQ_CONT },
  { group: '时间间隔', path: 'rules.projectTiming.generationTimeoutMs', label: '项目问候生成超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_PROJECT },
  { group: '时间间隔', path: 'rules.judge.timeoutMs', label: '主动开口判断超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_JUDGE },
  { group: '时间间隔', path: 'content.topics.noReplyJudgeTimeoutMs', label: '追问前判断超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: [onTopic('noReply'), ON_NOREPLY_JUDGE] },
  { group: '时间间隔', path: 'perception.l3.timeoutMs', label: '截图识别超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒', dep: ON_L3 },
  { group: '时间间隔', path: 'send.timeoutMs', label: '单条消息发送超时', type: 'int', min: 1, max: 900, scale: 1000, unit: '秒' },
  { group: '时间间隔', path: 'content.topics.wellnessCooldownHours', label: '步数、屏幕与久坐共用冷却', type: 'int', min: 0, max: 720, unit: '小时', dep: { any: [onTopic('steps'), onTopic('screen'), onTopic('longSit')] }, hint: '默认 96 小时。三类中任何一类发出后，其他两类也一起等。填 0 关闭跨类冷却，仍按各自规则去重。' },
  { group: '时间间隔', path: 'exploration.recentDays', label: '探索进展能用多久', type: 'int', min: 0, max: 90, unit: '天', hint: '适用于主动分享和私聊回复中的研究、休闲进展。填 0 不引用。' },
  { group: '时间间隔', path: 'exploration.moodHours', label: '探索心情保留多久', type: 'int', min: 0, max: 168, unit: '小时', dep: ON_EXP_MOOD, hint: '默认 2 小时。填 0 不引用探索心情。' },
  { group: '时间间隔', path: 'exploration.portraitHours', label: '聊天心情保留多久', type: 'int', min: 0, max: 168, unit: '小时', dep: ON_EXP_PORTRAIT, hint: '默认 2 小时，同时控制情绪回落速度。填 0 不引用。' },
  { group: '时间间隔', path: 'rules.qqTiming.debounceMs', label: '连发消息合并等待', type: 'int', min: 3000, max: 15000, unit: '毫秒', hint: '默认 3500 毫秒，最低 3000 毫秒。上限 15000 毫秒，为桥单次投递的 20000 毫秒超时留出余量。' },
  { group: '时间间隔', path: 'rules.qqTiming.pollSec', label: '补话与约定检查间隔', type: 'int', min: 1, max: 60, unit: '秒', dep: { any: [ON_QQ_CONT, dep('agreements.enabled', false)] }, hint: '默认 2 秒。检查热聊补话、短时来信和到期约定；与普通拍间隔独立。' },
  { group: '时间间隔', path: 'rules.qqTiming.windowSec', label: '热聊回看窗口', type: 'int', min: 1, max: 1800, unit: '秒', dep: ON_QQ_CONT, hint: '在这段时间里至少有两轮对话才算热聊。' },
  { group: '时间间隔', path: 'rules.qqTiming.pauseSec', label: '热聊补话先等多久', type: 'int', min: 0, max: 300, unit: '秒', dep: ON_QQ_CONT, hint: '从正常回复发送完成开始计时。' },
  { group: '时间间隔', path: 'rules.qqTiming.expireSec', label: '热聊补话超过多久作废', type: 'int', min: 1, max: 600, unit: '秒', dep: ON_QQ_CONT, hint: '从正常回复发送完成开始计时，须大于补话等待时间，并留出一次检查和生成的时间。' },
  { group: '时间间隔', path: 'rules.qqTiming.hotMinChars', label: '热聊补话最少回复字数', type: 'int', min: 0, max: 40, unit: '字', dep: ON_QQ_CONT, hint: '默认 6 字。对方最近回复过短或只是敷衍回应时不触发补话；填 0 不限字数。' },
  { group: '时间间隔', path: 'rules.qqTiming.inFlightSec', label: 'QQ 另一边正在回复时等多久', type: 'int', min: 1, max: 1800, unit: '秒', hint: '用于避免和 QQ 桥同时回复。' },
  { group: '时间间隔', path: 'rules.projectTiming.memoryDays', label: '项目回答保留为聊天背景多久', type: 'int', min: 0, max: 365, unit: '天', dep: ON_PROJECT, hint: '到期后不再带入聊天。' },
  { group: '时间间隔', path: 'rules.projectTiming.updateMin', label: '项目新进展多久内算刚提到', type: 'int', min: 0, max: 1440, unit: '分钟', dep: ON_PROJECT, hint: '跟进项目问题时只参考这个时间内的用户原话。' },
  { group: '时间间隔', path: 'rules.gapMaxX', label: '没回应时最多拉长间隔几倍', type: 'num', min: 1, max: 10, dep: ON_ADAPTIVE_GAP },
  { group: '时间间隔', path: 'rules.feedback.replyMatchSec', label: '配对回应时间戳的容差', type: 'int', min: 0, max: 600, unit: '秒', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.feedback.hitMin', label: '多久内回应算及时接住', type: 'int', min: 0, max: 720, unit: '分钟', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.feedback.windowMin', label: '等回应的统计窗口', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.feedback.keepHours', label: '待配对消息保留多久', type: 'int', min: 1, max: 168, unit: '小时', hint: '也用于判断私聊中「这类」能否引用上一条主动话题，引用最多回看 24 小时。' },
  { group: '时间间隔', path: 'rules.feedback.dayStartMin', label: '从几点开始统计无人回应', type: 'int', min: 0, max: 1439, unit: '分钟（从 0 点算）', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.feedback.dayEndMin', label: '回应统计当天几点截止', type: 'int', min: 1, max: 1440, unit: '分钟（从 0 点算）', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.feedback.coldDays', label: '接住率低的由头冷却多久', type: 'int', min: 1, max: 90, unit: '天', dep: ON_FEEDBACK },
  { group: '时间间隔', path: 'rules.chitchat.densityDays', label: '用几天的回应调整闲聊频率', type: 'int', min: 1, max: 90, unit: '天', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.strandHours', label: '多久未应算搁置闲聊', type: 'int', min: 0, max: 168, unit: '小时', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.pauseHours', label: '连续几次未应后暂停闲聊多久', type: 'int', min: 0, max: 336, unit: '小时', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.restHistoryDays', label: '推算休息时段回看几天', type: 'int', min: 3, max: 90, unit: '天', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.restPaddingMin', label: '推算休息时段前后多留多久', type: 'int', min: 0, max: 180, unit: '分钟', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.restFallbackStartMin', label: '休息记录不足时从几点起', type: 'int', min: 0, max: 1439, unit: '分钟（从 0 点算）', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.chitchat.restFallbackEndMin', label: '休息记录不足时到几点止', type: 'int', min: 0, max: 1439, unit: '分钟（从 0 点算）', dep: ON_CHITCHAT },
  { group: '时间间隔', path: 'rules.presenceSignal.recentChatMin', label: '多久内说过话算可能在场', type: 'int', min: 0, max: 720, unit: '分钟', dep: [ON_JUDGE, ON_PRESENCE_SIGNAL] },
  { group: '时间间隔', path: 'rules.presenceSignal.recentReturnMin', label: '离开后回来多久内算刚回来', type: 'int', min: 0, max: 720, unit: '分钟', dep: [ON_JUDGE, ON_PRESENCE_SIGNAL] },
  { group: '时间间隔', path: 'rules.presenceSignal.justActiveSec', label: '电脑多久没动仍算刚活跃', type: 'int', min: 0, max: 3600, unit: '秒', dep: [ON_JUDGE, ON_PRESENCE_SIGNAL] },
  { group: '时间间隔', path: 'rules.douyinStaleMin', label: '抖音数据多久无更新算过期', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_DOUYIN },
  { group: '时间间隔', path: 'sources.phone.replyContextMaxAgeMin', label: '普通回复最多参考多旧的手机数据', type: 'int', min: 0, max: 2880, unit: '分钟', dep: ON_PHONE },
  { group: '时间间隔', path: 'sources.memory.maxAgeDays', label: '外部记忆最多回看', type: 'int', min: 1, max: 3650, unit: '天', dep: ON_MEMORY },
  { group: '时间间隔', path: 'logging.reportDays', label: '近期日报回顾范围', type: 'int', min: 1, max: 7, unit: '天', hint: '默认 7 天（含当前记录日）。优先读取已归档日报，原始日志仍按单独的保留设置清理。' },
  { group: '时间间隔', path: 'agreements.aheadMin', label: '远期明确约定提前提醒', type: 'int', min: 0, max: 180, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 10 分钟。明确要求的短时约定到点才提醒，普通事项到点后才跟进。' },
  { group: '时间间隔', path: 'agreements.followUpMin', label: '约定到点后还能跟进多久', type: 'int', min: 0, max: 1440, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 60 分钟。静默、忙碌、角色睡眠或额度限制仍有效。填 0 只在到点的这一分钟内补发。' },
  { group: '时间间隔', path: 'agreements.expireHours', label: '到点后约定保留多久', type: 'int', min: 1, max: 168, unit: '小时', dep: dep('agreements.enabled', false), hint: '默认 24 小时。超过此时限从小本本清理。' },
  { group: '时间间隔', path: 'agreements.shortWithinMin', label: '相距多久内按短时约定处理', type: 'int', min: 1, max: 720, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 180 分钟，短时事项立即尝试抽取。日期未给具体时刻的按远期处理。' },
  { group: '时间间隔', path: 'agreements.slowIntervalMin', label: '远期约定合并抽取间隔', type: 'int', min: 1, max: 120, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 15 分钟，多条远期线索会合并抽取。' },
  { group: '时间间隔', path: 'agreements.extractTimeoutMs', label: '约定抽取超时', type: 'int', min: 1000, max: 20000, unit: '毫秒', dep: dep('agreements.enabled', false), hint: '默认 5000 毫秒。只在有时间线索时调用宿主模型，不等这一轮抽取才回私聊。' },
  { group: '时间间隔', path: 'agreements.soonMin', label: '「等会儿」按多久计算', type: 'int', min: 1, max: 60, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 10 分钟。仅用在等会儿、待会儿、一会儿等没有数字的时间。' },
  { group: '时间间隔', path: 'agreements.fewHoursMin', label: '「几小时后」按多久计算', type: 'int', min: 60, max: 360, unit: '分钟', dep: dep('agreements.enabled', false), hint: '默认 120 分钟。只用于没有给出确切数字的「几小时后」。' },
  { group: '时间间隔', path: 'agreements.dateTime', label: '只说日期时的跟进时间', type: 'hm', unit: '时:分', dep: dep('agreements.enabled', false), hint: '按时:分填写（00:00–23:59），默认 18:00。只说今晚但没给具体几点时也参考它。' },
  { group: '时间间隔', path: 'exploration.feedback.keepDays', label: '探索反馈与好奇候选保留多久', type: 'int', min: 1, max: 30, unit: '天', dep: dep('exploration.feedback.enabled', true), hint: '默认 7 天，到期自动淡出。' },
  { group: '时间间隔', path: 'exploration.feedback.warmMin', label: '探索分享与转发聊热的窗口', type: 'int', min: 1, max: 180, unit: '分钟', dep: dep('exploration.feedback.enabled', true), hint: '默认 30 分钟。只结合窗口内确实接着同一话题聊的来信。' },
  { group: '时间间隔', path: 'logging.keepDays', label: '日志保留多久', type: 'int', min: 1, max: 365, unit: '天' },
  { group: '时间间隔', path: 'logging.dayStartHour', label: '日志换日时间', type: 'int', min: 0, max: 23, unit: '点' },
  { group: '时间间隔', path: 'content.topics.replyMaxAgeMin', label: '消息超过多久不自动补回', type: 'int', min: 0, max: 10080, unit: '分钟', dep: dep('rules.autoReply', true) },
  { group: '时间间隔', path: 'content.topics.sleepFromHour', label: '睡眠提醒最早几点', type: 'num', min: 0, max: 23.99, unit: '点', dep: [ON_PHONE, onTopic('sleep')], hint: '支持小数，7.5 表示 07:30。' },
  { group: '时间间隔', path: 'content.topics.sleepToHour', label: '睡眠提醒最晚几点', type: 'num', min: 0, max: 23.99, unit: '点', dep: [ON_PHONE, onTopic('sleep')], hint: '支持小数，10.5 表示 10:30。' },
  { group: '时间间隔', path: 'content.topics.sleepDayStartHour', label: '睡眠、压力和步数从几点起算新一天', type: 'int', min: 0, max: 23, unit: '点', dep: [ON_PHONE, { any: [onTopic('sleep'), onTopic('stress'), onTopic('steps')] }] },
  { group: '时间间隔', path: 'content.topics.sleepMaxAgeH', label: '睡眠数据最多多旧', type: 'int', min: 1, max: 168, unit: '小时', dep: [ON_PHONE, onTopic('sleep')] },
  { group: '时间间隔', path: 'content.topics.sleepSameDayGraceMin', label: '跨换日的睡眠邮件允许回看多久', type: 'int', min: 0, max: 1440, unit: '分钟', dep: [ON_PHONE, onTopic('sleep')] },
  { group: '时间间隔', path: 'content.topics.stressFromHour', label: '压力提醒最早几点', type: 'int', min: 0, max: 23, unit: '点', dep: [ON_PHONE, onTopic('stress')] },
  { group: '时间间隔', path: 'content.topics.stressToHour', label: '压力提醒最晚几点', type: 'int', min: 0, max: 23, unit: '点', dep: [ON_PHONE, onTopic('stress')] },
  { group: '时间间隔', path: 'content.topics.stressMaxAgeH', label: '压力数据最多多旧', type: 'int', min: 1, max: 168, unit: '小时', dep: [ON_PHONE, onTopic('stress')] },
  { group: '时间间隔', path: 'content.topics.stressMinGapMin', label: '两次压力提醒至少隔多久', type: 'int', min: 0, max: 1440, unit: '分钟', dep: [ON_PHONE, onTopic('stress')] },
  { group: '时间间隔', path: 'content.topics.stepsMaxAgeMin', label: '步数邮件最多多旧', type: 'int', min: 1, max: 1440, unit: '分钟', dep: [ON_PHONE, onTopic('steps')] },
  { group: '时间间隔', path: 'content.topics.screenFromHour', label: '屏幕提醒最早几点', type: 'int', min: 0, max: 23, unit: '点', dep: [ON_PHONE, onTopic('screen')] },
  { group: '时间间隔', path: 'content.topics.screenMaxAgeH', label: '屏幕数据最多多旧', type: 'int', min: 1, max: 168, unit: '小时', dep: [ON_PHONE, onTopic('screen')] },
  { group: '时间间隔', path: 'content.topics.backCooldownMin', label: '两次回来提醒至少隔多久', type: 'int', min: 0, max: 1440, unit: '分钟', dep: onTopic('backHome') },
  { group: '时间间隔', path: 'content.topics.backRecentMin', label: '回来后多久还算刚回来', type: 'int', min: 1, max: 720, unit: '分钟', dep: onTopic('backHome') },
  { group: '时间间隔', path: 'content.topics.backUserQuietMin', label: '对方说完话多久后才能提刚回来', type: 'int', min: 0, max: 1440, unit: '分钟', dep: onTopic('backHome') },
  { group: '时间间隔', path: 'content.forward.maxAgeDays', label: '成功的视频观察缓存保留多久', type: 'int', min: 1, max: 365, unit: '天', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.failTtlHours', label: '视频观察失败后多久可重试', type: 'int', min: 1, max: 168, unit: '小时', dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'send.split.maxFirstMs', label: '首条等待上限', type: 'num', min: 0, max: 300, unit: '秒', scale: 1000, dep: ON_SPLIT, hint: '填 0 立即发送首条。' },
  { group: '时间间隔', path: 'send.split.maxGapMs', label: '分段之间等待上限', type: 'num', min: 0, max: 120, unit: '秒', scale: 1000, dep: ON_SPLIT, hint: '填 0 不在分段之间停顿。' },
  { group: '时间间隔', path: 'send.split.firstJitterMs', label: '首条额外随机等待上限', type: 'num', min: 0, max: 120, unit: '秒', scale: 1000, dep: ON_SPLIT, hint: '填 0 禁用首条随机等待。' },
  { group: '时间间隔', path: 'send.split.gapJitterMs', label: '分段额外随机等待上限', type: 'num', min: 0, max: 120, unit: '秒', scale: 1000, dep: ON_SPLIT, hint: '填 0 禁用分段随机等待。' },
  { group: '时间间隔', path: 'send.split.firstPerCharMs', label: '对方每个字增加首条等待', type: 'int', min: 0, max: 1000, unit: '毫秒/字', dep: ON_SPLIT },
  { group: '时间间隔', path: 'send.split.gapPerCharMs', label: '分段每个字增加等待', type: 'int', min: 0, max: 1000, unit: '毫秒/字', dep: ON_SPLIT },
  { group: '时间间隔', path: 'mail.timeoutMs', label: '邮件服务器超时', type: 'int', min: 3, max: 300, unit: '秒', scale: 1000, dep: ON_MAIL_OR_PHONE, hint: '超过该时间断开邮件连接。' },
  { group: '时间间隔', path: 'content.llm.timeoutMs', label: '模型请求默认超时', type: 'int', min: 1, max: 900, unit: '秒', scale: 1000, hint: '给没有指定专用超时的模型请求使用。' },
  { group: '时间间隔', path: 'content.forward.timeoutMs', label: '视频取流与转写超时', type: 'int', min: 30, max: 1800, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD, hint: '下载与转写各自可用的最长时间。' },
  { group: '时间间隔', path: 'content.forward.asrWaitMs', label: '等待转写服务启动', type: 'int', min: 10, max: 600, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'content.forward.edgeWaitMs', label: '等待 Edge 调试口启动', type: 'int', min: 5, max: 600, unit: '秒', scale: 1000, dep: ON_VIDEO_OR_FORWARD },
  { group: '时间间隔', path: 'perception.signals.timeoutMs', label: '读取浏览器信号超时', type: 'int', min: 100, max: 30000, unit: '毫秒', dep: [ON_SIGNALS, ON_SIGNALS_BROWSER] },
  // ================================================================ 自主探索（设置页显示在「自主探索」卡片底部）
  { group: '自主探索', path: 'exploration.auto', label: '自动自主探索', type: 'bool', hint: '默认关闭。角色按人设选择探索内容，探索结束保存收获和可选的分享候选。' },
  { group: '自主探索', path: 'exploration.mode', label: '探索方式', type: 'select', options: [['deep', '深度推进（保留研究线与下一步）'], ['light', '轻量化探索（单次简单小事，不推进长任务）']], hint: '深度推进会持续跟进研究线和下一步；轻量化探索每次只挑一件简单小事做一次浅显了解，不建长线任务、省 Token。' },
  { group: '自主探索', path: 'exploration.model', label: '探索使用的模型', type: 'select', options: [['', '跟随绑定会话（默认）']], hint: '默认跟随当前绑定的陪伴会话所使用的模型；也可切换当前账号下任意 API 供应商的模型。' },
  { group: '自主探索', path: 'exploration.bias', label: '探索倾向', type: 'select', options: [['leisure', '偏休闲'], ['balanced', '均衡'], ['research', '偏研究']], hint: '深度推进和轻量化都适用。默认均衡。常规自选轮中偏休闲约四分之三是休闲，偏研究约四分之三是研究；均衡各半。题材仍参考「最近对什么好奇」。' },
  { group: '自主探索', path: 'exploration.browseMode', label: '网页与看图方式', type: 'select', options: [['vision_light', '轻量看图'], ['browser_agent', '调网站浏览（会消耗更多 token）']], hint: '轻量看图：保持低开销，搜到漫画或图文页面后提取页面图片或截取公开画面，直接交给已配置的识图模型看图写感受，不跑多轮浏览器循环。' },
  { group: '自主探索', path: 'exploration.browseMaxSteps', label: '调网站浏览每轮步数上限', type: 'int', min: 5, max: 80, unit: '步', dep: dep('exploration.browseMode', 'vision_light', 'browser_agent'), hint: '默认 40 步（沿用旧版自主探索上限），到达上限自动收尾，避免在网站里反复翻页卡死或消耗过多 token。' },
  { group: '自主探索', path: 'exploration.intervalMinutes', label: '探索间隔', type: 'int', min: 30, max: 1440, unit: '分钟', dep: ON_EXP_AUTO, hint: '默认 180 分钟；静默、忙碌和角色睡眠时段不自动探索（若开启下方「只在谷时自动探索」，还会避开 DeepSeek API 高峰时段）。' },
  { group: '自主探索', path: 'exploration.offPeakOnly', label: '只在谷时自动探索', type: 'bool', dep: ON_EXP_AUTO, hint: '开：自动探索仅在 DeepSeek 谷时（5折空闲时段）运行——按北京时间结合日历判定，工作日非高峰时段（00:00–09:00、12:00–14:00、18:00–24:00）、周中法定节假日全天及周末（含调休上班周末）全天均为谷时；工作日 09:00–12:00 / 14:00–18:00 跳过。手动点「试跑一轮」不受限制。' },
  { group: '自主探索', path: 'exploration.nextTopic', label: '近一轮探索主题', type: 'str', max: 120, hint: '建议一次只填一个主题。单独指定下一轮要探索的具体题目（优先于下方「最近对什么好奇」）；成功跑完一轮后会自动清空恢复日常自选。' },
  { group: '自主探索', path: 'exploration.interest', label: '最近对什么好奇', type: 'text', max: 160, rows: 2, hint: '可写想长期追的作品、网站或主题，多个主题可用换行、顿号或逗号分隔，每轮会自动挑其中一个探索；研究和休闲都参考，留空按人设选。' },
  { group: '自主探索', path: 'exploration.offerShare', label: '让探索进展参与主动分享', type: 'bool', hint: '默认关闭。开启后，进展只是主动消息候选，仍走原有时段、额度和发送开关。' },
  // ================================================================ 日常
  { group: '日常', path: 'enabled', label: '总开关', type: 'bool', hint: '关掉就一拍都不跑（插件还在，只是不动）' },
  { group: '日常', path: 'dryRun', label: '演练模式', type: 'bool', hint: '开：只判定、只记日志，不真的发。关：判定通过就发（还要下面那条也开着）' },
  { group: '日常', path: 'debugMode', label: '调试模式', type: 'bool', hint: '默认关闭。开启后，即使最近两条属于同一类由头，也允许这类继续参与选题。发送开关、间隔和每日上限照常生效。' },
  { group: '日常', path: 'send.enabled', label: '允许真的发送', type: 'bool', hint: '和「演练模式」两个都放行才会发出去；只开这一个不会发' },
  { group: '日常', path: 'tickMinutes', label: '每拍间隔', type: 'int', min: 1, max: 120, unit: '分钟', hint: '多久醒一次看你在不在。改小不会更黏人，只是判定更及时' },
  { group: '角色作息', path: 'characterRest.bed', label: '角色入睡基准', type: 'hm', unit: '时:分', hint: '按时:分填写（00:00–23:59），默认 22:00。角色睡着时暂停主动开口和自动探索，私聊照常回复。修改后会立即按新基准重算今日作息。' },
  { group: '角色作息', path: 'characterRest.wake', label: '角色醒来基准', type: 'hm', unit: '时:分', hint: '按时:分填写（00:00–23:59），默认 06:30；早于入睡时间表示次日醒来。修改后会立即按新基准重算今日作息。' },
  { group: '角色作息', path: 'characterRest.jitterMin', label: '角色作息每日浮动', type: 'int', min: 0, max: 120, unit: '分钟', hint: '默认 30 分钟，入睡和醒来各自前后浮动，同一晚固定。填 0 取消随机浮动。' },
  { group: '角色作息', path: 'characterRest.windDownMin', label: '角色临睡前多久轻声说话', type: 'int', min: 0, max: 180, unit: '分钟', hint: '默认 30 分钟。主动消息变成一条更轻、更短的话。填 0 关闭临睡口吻。' },
  { group: '角色作息', path: 'content.topics.characterRestBeforeBedMin', label: '入睡前多久触发作息由头', type: 'int', min: 0, max: 120, unit: '分钟', dep: onTopic('characterRest'), hint: '默认 10 分钟。角色实际入睡前这段时间内可顺口道一声准备睡了；填 0 关闭睡前由头。' },
  { group: '角色作息', path: 'content.topics.characterRestAfterWakeMin', label: '醒来后多久触发作息由头', type: 'int', min: 0, max: 120, unit: '分钟', dep: onTopic('characterRest'), hint: '默认 10 分钟。角色实际醒来后这段时间内可顺口打个早安招呼；填 0 关闭醒后由头。' },
  { group: '角色作息', path: 'content.topics.characterRestGreetSkipMin', label: '刚互道早晚安多久内不重复', type: 'int', min: 0, max: 360, unit: '分钟', dep: onTopic('characterRest'), hint: '默认 120 分钟。这段时间内若刚互相说过对应的晚安或早安，就跳过本次作息由头；填 0 关闭此去重。' },
  { group: '日常', path: 'quietHours', label: '全局静默', type: 'windows', hint: '这几段里什么都不读不发；多段用逗号隔开（支持全角逗号/冒号），留空 = 全天不限' },
  { group: '日常', path: 'busyHours', label: '忙碌时段', type: 'windows', hint: 'TA上课/上班/开会的那几段，这几段里我不主动开口（TA先说话还是照常回）。和静默不一样：静默连数据都不读，这里只是我先不打扰。多段、可跨零点，留空 = 不忙' },
  { group: '日常', path: 'content.holidays', label: '额外放假的日子', type: 'text', max: 200, rows: 2, hint: '法定节假日（2026 全年）已经内置，节假日整天不按忙碌时段算，静默照旧。这里只补表里没有的，逗号分隔，如 2027-01-01,2027-01-02' },
  { group: '日常', path: 'content.workdays', label: '调休上班的周末', type: 'text', max: 200, rows: 2, hint: '调休上班日即使在周末也按工作日算，忙碌时段照常生效。逗号分隔，如 2027-02-07' },
  { group: '日常', path: 'content.calendar.url', label: '节假日日历接口', type: 'text', max: 300, rows: 2, hint: '填一个返回 JSON 的地址，{year} 会替换成4位年份；配好后让模型调 presence_holiday_calendar 刷新一次，缓存在 data/holidays-<年>.json。留空则只用内置表' },

  // ================================================================ 决定TA粘不粘人
  { group: '决定TA粘不粘人', path: 'rules.dailyCap', label: '每天最多几条', type: 'int', min: 0, max: 20, unit: '条', hint: '0 = 今天一条都不主动发。默认 3 条' },
  { group: '决定TA粘不粘人', path: 'rules.minGapMin', label: '两条之间至少隔', type: 'int', min: 0, max: 1440, unit: '分钟', hint: '默认 240 分钟（四小时）。改小会明显变黏；下面开了「间隔按由头分档」后，这条只在分档关着时用' },
  { group: '决定TA粘不粘人', path: 'content.topics.shareGapMin', label: '两条主动分享至少隔多久', type: 'int', min: 0, max: 43200, unit: '分钟', dep: onTopic('share'), hint: '单位：分钟（默认 1440 分钟，即 24 小时）。控制自主探索与个人判断类主动分享的最短间隔；填 0 不单独冷却。' },
  { group: '决定TA粘不粘人', path: 'rules.closingCooldownMin', label: '对方收尾后暂停主动多久', type: 'int', min: 0, max: 720, unit: '分钟', hint: '默认 120 分钟。检测到对方说去忙、晚安或连续简短收尾后，这段时间内不主动开口（对方先说话照常回）；填 0 关闭。' },
  { group: '决定TA粘不粘人', path: 'rules.adaptiveGap', label: '没人应时自己少说点', type: 'bool', hint: '开（默认）：连着两条没回，之后两条之间自动多等一会儿（最多拖成三倍）；关：永远按上面那个固定间隔' },
  { group: '决定TA粘不粘人', path: 'rules.qqContinuation', label: '热聊补一句', type: 'bool', hint: '刚来回聊了几轮，普通回复发完并等待设定时长后，可以顺着话题再补一句。有新消息就取消；没内容或没回应就停。遵守静默、忙碌时段和每日上限。' },
  { group: '决定TA粘不粘人', path: 'rules.feedback.enabled', label: '按TA的反应调由头', type: 'bool', hint: '开（默认）：记下哪一类发出去TA接住了、哪一类老没人应，老不接的先压几天；关：所有由头一视同仁' },
  { group: '决定TA粘不粘人', path: 'rules.judge.enabled', label: '让模型自己决定说不说', type: 'bool', hint: '关（默认）：规则挑到由头就写。开：模型从合格的由头里挑一条，或选择不说。草稿还会过长度、口吻和防重复检查。无合格由头时保持安静' },
  { group: '决定TA粘不粘人', path: 'rules.chitchat.enabled', label: '没什么事也可以说一句', type: 'bool', hint: '关（默认）：没有由头就不说话。开：可在合适的时候加入一个「随口话」候选（没有具体话题时，按下面设置的次数放行「在吗」「在干嘛」这类轻招呼）——只走模型，写不出来就不发。一天最多几条在下面的「随口话一天最多几条」里自己设；不说时段跟着全局静默和TA睡着的那段走。要「让模型自己决定说不说」也开着才生效' },
  { group: '决定TA粘不粘人', path: 'rules.chitchat.perDay', label: '随口话一天最多几条', type: 'int', min: 1, max: 10, unit: '条', dep: dep('rules.chitchat.enabled', true), hint: '默认 3 条。近期不足 5 条样本或接住率低于 30% 时，最多 1 条。30%–70% 时最多 2 条，超过 70% 时放到这里设的上限。随口话也计入每天总上限。' },
  { group: '决定TA粘不粘人', path: 'rules.chitchat.barePerDay', label: '轻招呼一天最多几次', type: 'int', min: 0, max: 10, unit: '次', dep: dep('rules.chitchat.enabled', true), hint: '默认 1 次（填 0 禁止「在吗」「在干嘛」这类空招呼）。仍受上面的随口话条数和每天总上限约束' },
  { group: '决定TA粘不粘人', path: 'rules.gapByTier.enabled', label: '间隔按由头分档', type: 'bool', hint: '关（默认）：所有由头共用 minGapMin 一刀切。开：回TA/接转发/追问 5 分钟，事件类（刚回来、深夜、久坐、self.md 新写入）60 分钟，其余闲聊 240 分钟——跨档至少隔回复档那么久' },
  { group: '决定TA粘不粘人', path: 'rules.gapByTier.replyMin', label: '回复档间隔', type: 'int', min: 1, max: 240, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：回TA、接住TA转来的东西、追问之间至少隔这么久（默认 5 分钟）。它也是所有档的全局地板' },
  { group: '决定TA粘不粘人', path: 'rules.gapByTier.eventMin', label: '事件档间隔', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：刚回来、深夜、久坐、self.md 新写入这类事件由头之间至少隔这么久（默认 60 分钟）' },
  { group: '决定TA粘不粘人', path: 'rules.gapByTier.chatMin', label: '闲聊档间隔', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：睡眠、压力、步数、屏幕、课表、考试这类闲聊由头之间至少隔这么久（默认 240 分钟）' },
  { group: '决定TA粘不粘人', path: 'rules.naturalTriggers.enabled', label: '事件也能挑开我', type: 'bool', hint: '关（默认）：只看时钟。开：一段活干完、刚下课、刚在 self.md 写一条，这几种时刻也算「可以开口」——静默、忙碌、离开、每日上限一概照旧拦着，间隔要不要让路看下面那条' },
  { group: '决定TA粘不粘人', path: 'rules.naturalTriggers.takeGap', label: '事件拍可以让间隔让路', type: 'bool', dep: ON_NATURAL, hint: '关（默认）：事件只是把开口提前到发生的那一秒，两条之间仍隔满 minGap。开：事件拍可以越过 minGap，但仍要隔够「事件拍最短间隔」——不会因为下课就紧跟着再说一句' },
  { group: '决定TA粘不粘人', path: 'rules.naturalTriggers.floorMin', label: '事件拍最短间隔', type: 'int', min: 1, max: 240, unit: '分钟', dep: ON_NATURAL, hint: '只在上面那条开着时生效：事件拍两次开口之间至少隔这么久（默认 20 分钟）。比 minGap 短，但仍是个地板' },
  { group: '决定TA粘不粘人', path: 'rules.requirePcOnline', label: '只在电脑前才主动开口', type: 'bool', hint: '关（默认）：多端聊天模式，QQ/抖音手机随时能收到，离开电脑或锁屏也照常主动找TA。开：只在电脑前且未锁屏时才主动开口' },
  { group: '决定TA粘不粘人', path: 'rules.presenceSignal.enabled', label: '人不在只当信号', type: 'bool', dep: ON_JUDGE, hint: '开启「只在电脑前才主动开口」后若同时打开此项：离开电脑不再硬拦截，改成把电脑状态写进快照让 judge 自己判断。只在 judge 也开着时生效' },

  // ================================================================ 节奏
  { group: '节奏', path: 'rules.replyCooldownMin', label: 'TA说完话先等几分钟', type: 'int', min: 0, max: 120, unit: '分钟', hint: '默认 5 分钟。TA刚说完你就回，等于抢话' },
  { group: '节奏', path: 'send.split.enabled', label: '一句一条分开发', type: 'bool', hint: '开（默认）：正文里空一行就算另一条，发的时候一条一条发，像人连着说几句。关：整段并成一条' },
  { group: '节奏', path: 'send.split.maxParts', label: '一轮最多拆几条', type: 'int', min: 1, max: 4, unit: '条', dep: dep('send.split.enabled', true), hint: '默认 4 条；多出来的并进最后一条' },
  { group: '节奏', path: 'send.split.minFirstMs', label: '第一条至少等几秒', type: 'num', scale: 1000, min: 0, max: 300, unit: '秒', dep: dep('send.split.enabled', true), hint: '填 0 立即发首条。等待从对方发消息时起算，按字数和随机量增加。' },
  { group: '节奏', path: 'send.split.minGapMs', label: '分段之间至少隔几秒', type: 'num', scale: 1000, min: 0, max: 120, unit: '秒', dep: dep('send.split.enabled', true), hint: '默认 1.2 秒。按字数和随机量增加，上限可另设。' },
  { group: '节奏', path: 'send.split.maxRoundMs', label: '一轮最多发多久', type: 'int', scale: 1000, min: 1, max: 300, unit: '秒', dep: dep('send.split.enabled', true), hint: '默认 90 秒。拆得太多、快超时了，剩下的几条并成一条发' },
  { group: '节奏', path: 'rules.proactive', label: '我会主动找你', type: 'bool', hint: '开（默认）：没人说话的时候也会按由头找你。关：只回你的话，不主动开口（安静模式）' },
  { group: '节奏', path: 'rules.autoReply', label: 'TA说话我自动回', type: 'bool', hint: '开（默认）：TA说完、隔了冷却时间就回。关：TA的话不自动回，只按「主动找TA」那条轨道走' },

  // ================================================================ 说什么
  { group: '说什么', path: 'content.enabled', label: '允许生成内容', type: 'bool', hint: '关掉 = 只判定不写句子（排障时用）' },
  { group: '说什么', path: 'content.mode', label: '怎么写', type: 'select', dep: ON_CONTENT, options: [['auto', '自动（能用模型就用）'], ['llm', '只用模型'], ['template', '只用模板'], ['fixed', '固定一句话（测试）']] },
  { group: '说什么', path: 'content.maxChars', label: '一句话最多', type: 'int', min: 10, max: 200, unit: '字', dep: ON_CONTENT, hint: '默认 60 字。超过这个长度 guard 会打回重写' },
  { group: '说什么', path: 'content.forward.enabled', label: '转发视频真的看', type: 'bool', dep: ON_CONTENT, hint: '开：下载转发视频。画面需要 dsh-video-storyboard 插件和支持图片的模型；画面不可用时用口播，缓存注明证据来源' },
  { group: '说什么', path: 'content.forward.asrAutostart', label: '转写服务按需起', type: 'bool', dep: [ON_CONTENT, ON_FORWARD], hint: '开：要转写时自己拉起 whisper，转完立刻关掉（常驻会和 Breeze 一起把内存吃满）；关：只在服务本来就在跑时才转写' },
  // —— 随口说话细节参数仍收进高级；主开关与每天几条放在「决定TA粘不粘人」。
  { group: '高级', path: 'rules.chitchat.dayStart', label: '最早几点', type: 'int', min: 0, max: 1439, unit: '分钟（从 0 点算）', dep: dep('rules.chitchat.enabled', true), hint: '默认 480 分钟（= 08:00）。也受休息时段限制，相关参数见「时间间隔」' },
  { group: '高级', path: 'rules.chitchat.dayEnd', label: '最晚几点', type: 'int', min: 0, max: 1439, unit: '分钟（从 0 点算）', dep: dep('rules.chitchat.enabled', true), hint: '默认 1410 分钟（= 23:30）；同时受「休息时段」限制（--health 能看到推导结果）' },
  { group: '高级', path: 'rules.chitchat.maxChars', label: '随口话最多几个字', type: 'int', min: 10, max: 80, unit: '字', dep: dep('rules.chitchat.enabled', true), hint: '默认 40 字。写在硬要求里，也要过 guard；超了打回重写，再超就不发' },
  { group: '高级', path: 'rules.chitchat.seedDays', label: '随口话从多久内的记忆里找话头', type: 'int', min: 1, max: 365, unit: '天', dep: dep('rules.chitchat.enabled', true), hint: '默认 30 天。随口话得落在一件具体的事上，太老的记忆翻出来会显得突兀' },
  { group: '高级', path: 'rules.chitchat.seedSkipPrivate', label: '别拿我瞒着TA的事当话头', type: 'bool', dep: dep('rules.chitchat.enabled', true), hint: '默认开。我自己标了「不给对方看」的记忆，不许拿来当搭话素材（方向上是我瞒着TA，不是TA瞒着我）' },
  { group: '高级', path: 'rules.stateWriteWaitMs', label: '状态写入冲突最多等待多久', type: 'int', min: 0, max: STATE_WRITE_WAIT_MAX_MS, unit: '毫秒', hint: '定时检查和私聊偏好同时保存时，短暂等待并重试。默认 120 毫秒，0 表示冲突时立即返回。' },
  { group: '高级', path: 'rules.feedback.testMode', label: '测试期：TA没回不算没接住', type: 'bool', hint: '开：发出去照样记「发过」、也能配对回看，但不进接住率、不动冷却——插件没完工时TA的沉默不代表这类话不行；正式跑起来记得关掉' },
  { group: '说什么', path: 'content.topics.reply', label: 'TA说完就回一句', type: 'bool', hidden: true, hint: '和「节奏」里的「TA说话我自动回」重复，界面不再单列；键还认，老配置照旧有效' },
  { group: '说什么', path: 'content.topics.forward', label: '接住TA转来的东西', type: 'bool', hint: '开（默认）：TA转来视频/链接、没人应时，我接一句。关：这类不算由头' },
  { group: '说什么', path: 'content.topics.sleep', label: '睡眠', type: 'bool', hint: '昨晚睡少/睡多/熬夜时提一句。只在早上，一天一次' },
  { group: '说什么', path: 'content.topics.stress', label: '压力', type: 'bool', hint: '压力高时提一句。白天 09:00-22:00，一天最多一次' },
  { group: '说什么', path: 'content.topics.steps', label: '步数', type: 'bool', hint: '18 点以后收到新邮件时看今天走了多少：太少或很多都提一句，中间那一段不打扰。一天最多一次' },
  { group: '说什么', path: 'content.topics.screen', label: '屏幕时间', type: 'bool', hint: '在电脑前坐太久时提一句。默认晚上 21 点后才算' },
  { group: '说什么', path: 'content.topics.share', label: '分享', type: 'bool', hint: '把我在 self.md 里私下记下的一句判断拿出来跟你说（≥40 字、按分享间隔发送、同一条不重复用；标了「不给TA看」的自动跳过）' },
  { group: '说什么', path: 'content.topics.catchup', label: '好几天没说话', type: 'bool', hint: '隔了几天TA没动静时找人。默认 2 天起' },
  { group: '说什么', path: 'content.topics.lateUp', label: '深夜了还没睡', type: 'bool', hint: '夜里TA还亮着屏幕、人在电脑前时提一句。一个晚上最多一次（跨零点算同一晚）' },
  { group: '说什么', path: 'content.topics.longSit', label: '坐太久了', type: 'bool', hint: '连续坐在电脑前、中间没离开过，到点说一句让TA起身。一天最多一次' },
  { group: '说什么', path: 'content.topics.backHome', label: 'TA刚回来', type: 'bool', hint: 'TA出去一阵又回到电脑前，接一句开场。TA两小时内说过话就不发' },
  { group: '说什么', path: 'content.topics.noReply', label: '按聊天约定跟进', type: 'bool', hint: '发过相关消息后，只有能核对到 TA 主动约好的提醒才会跟进，同一条最多一次。等 TA 发图或未回闲聊本身不构成提醒约定' },
  { group: '说什么', path: 'content.topics.agenda', label: '按课表说事', type: 'bool', hint: '明早有课就前一晚催一句；下一节在几十分钟内开始就提醒一句。课表在「课表与考试」里填' },
  { group: '说什么', path: 'content.topics.characterRest', label: '角色睡前与刚醒', type: 'bool', hint: '角色实际入睡前和刚醒来后的短窗口内，顺口说一句准备睡了或刚醒。每轮睡前、醒后各最多一次' },

  // ================================================================ 数据从哪来
  // 三条链路各自的总闸。关掉 = 这条链路当它不存在（不读、不判定、不发）。
  // hint 后面会动态接一句「检测：…」（listForUi 里拼），所以这里只写「关掉会发生什么」。
  { group: '数据从哪来', path: 'sources.phone.enabled', label: '手机数据', type: 'bool', hint: '睡眠、压力、步数和屏幕时间来自手机 App 发的邮件。关闭后停止收信，并暂停这四类由头。' },
  { group: '数据从哪来', path: 'sources.qq.enabled', label: 'QQ', type: 'bool', hint: '要 dsh-plugin-qq-bridge 装了并配对过才算通；关掉之后 QQ 侧的旧记录也不再当「TA刚说话」用' },
  { group: '数据从哪来', path: 'sources.douyin.enabled', label: '抖音', type: 'bool', hint: '主通道选抖音时由陪伴接管私信。需要安装 dsh-douyin-scroll，并配置抖音联系人 sec_uid。' },
  { group: '数据从哪来', path: 'sources.memory.enabled', label: '读记忆插件的记忆', type: 'bool', hint: '从下面这个记忆插件里读它记下来的长期记忆，当「我本来就知道的事」用（只读，不改它的文件）。读不到就照常说话' },
  { group: '数据从哪来', path: 'sources.memory.plugin', label: '用哪个记忆插件', type: 'select', options: [['fish-memory', '鱼的记忆（dsh-fish-memory）'], ['soul-md', 'Soul.md 记忆（dsh-soul-md）'], ['auto', '自动识别（兼容外部记忆插件）'], ['json-generic', '通用 JSON / JSONL 记忆'], ['markdown', 'Markdown 笔记目录']], dep: ON_MEMORY, hint: '支持鱼的记忆（session-*.json / ws_*.json）、dsh-soul-md（soul-md/memory）、自动识别以及通用 JSON/JSONL/Markdown 记忆目录；有特殊结构也能让大肥鱼在 src/memorysource.js 里加一条适配' },
  { group: '数据从哪来', path: 'sources.memory.dir', label: '外部记忆目录或文件', type: 'str', max: 260, dep: ON_MEMORY, hint: '留空按所选记忆插件的默认路径读取；接入其他记忆插件时可填它的目录或单个 .json / .jsonl / .md 文件路径' },
  { group: '数据从哪来', path: 'exploration.portrait', label: '延续聊天的心情（情绪插件）', type: 'bool', hint: '需要安装 emotion-state-portrait。打开后会按每条私聊实时打分即时心情，同时把私聊、指令与回复自动写入 emotion/inbox.jsonl 并在主动/被动对话里延续情绪画像' },
  { group: '数据从哪来', path: 'exploration.moodSource', label: '用哪个心情插件（防冲突）', type: 'select', options: [['auto', '自动防冲突（有第三方心情扩展时优先用它，否则用内置情绪插件）'], ['builtin', '只用内置情绪插件（emotion-state-portrait）'], ['external', '只用第三方心情扩展（插件或 data/extensions/mood.json）'], ['merge', '两者合并（适合「即时心情 + 好感度/羁绊」互补）']], hint: '避免同时装了内置情绪插件和第三方心情扩展时话风打架；默认自动防冲突，需要两边叠加时可切到「两者合并」。' },
  { group: '数据从哪来', path: 'mail.enabled', label: '读邮箱', type: 'bool', hint: '开：才会连 IMAP 把手机 App 发来的 FISH 邮件取回来；关着完全不联网。账号和授权码在「高级」里' },
  { group: '数据从哪来', path: 'channels.main.read', label: '读主会话', type: 'bool', hint: '开：把 DSH 主对话也当成一个通道读（TA在这儿说的话也算）。默认关，免得主对话被当成聊天记录反复读' },
  { group: '数据从哪来', path: 'content.topics.noReplyDouyin', label: '抖音分享也算没回', type: 'bool', dep: [ON_FOLLOW_CASUAL, ON_DOUYIN], hint: '还需启用「检查闲聊或分享中的提醒约定」才生效。没装抖音插件或关闭抖音来源时跳过。' },

  // ================================================================ 课表与考试
  { group: '课表与考试', path: 'content.agenda.text', label: '我的课表', type: 'text', max: 4000, rows: 8, hint: '一行一节：「周一 08:00-09:40 电机学」，也认「第3-4节」和「1-16周」「单周」。周几可以写「星期一」，冒号全角半角都认；空行和 # 开头的行会跳过。整学期的课表看不懂就直接截图发给我，我帮你整理成这里能认的格式' },
  { group: '课表与考试', path: 'content.agenda.off', label: '上课提醒', type: 'courses', hint: '展开看有没有认错的课。勾掉的课不算数——既不提醒，也不参与「上午的课上完了」「课上完了」这两个时刻的判断。认错的在课表里改一行，这里跟着变。要一节都不提醒，在最上面勾「全不选」' },
  { group: '课表与考试', path: 'content.agenda.periods', label: '上课时间表', type: 'text', max: 2000, rows: 5, hint: '一行一节：「1-2 08:00-09:40」。只有课表里写「第3-4节」的行才需要它；课表已经写了具体时间的不用填，留空就用内置作息' },
  { group: '课表与考试', path: 'content.agenda.termStart', label: '开学第一周的周一', type: 'str', max: 10, hint: '格式 2026-09-07。填了才按「第几周」筛课：带「1-8周」的课第 9 周就不会再提。留空 = 带周次的课也当每周都上' },
  { group: '课表与考试', path: 'content.exams.text', label: '我的考试', type: 'text', max: 4000, rows: 6, hint: '一行一场，时间写在前面：「2026-12-20 09:00 电机学 @教三201」。场地可以不写；没写年份按今年算（日子过了就算明年）。截图发给我，我帮你抄' },
  { group: '课表与考试', path: 'content.topics.examReview', label: '提前提醒复习', type: 'bool', hint: '开（默认）：考前那几天提一次「该开始复习了」。每场只提一次' },
  { group: '课表与考试', path: 'content.topics.examReviewDays', label: '提前几天提醒复习', type: 'int', min: 1, max: 60, unit: '天', dep: onTopic('examReview'), hint: '默认 7 天（按天算）。日历日差正好是这天时提一次，不按分钟' },
  { group: '课表与考试', path: 'content.topics.examSoon', label: '快开考时提一句', type: 'bool', hint: '开（默认）：进考前窗口提一次，提醒带证件、别慌。每场只提一次' },
  { group: '课表与考试', path: 'content.topics.examSoonMin', label: '考前多久提一句', type: 'int', min: 5, max: 1440, unit: '分钟', dep: onTopic('examSoon'), hint: '默认 60 分钟' },

  // ================================================================ 高级（平时不用动）
  // 开开关的细节参数：调得不合适会直接影响体感，所以默认收起来。
  { group: '高级', path: 'agreements.enabled', label: '约定小本本', type: 'bool', hint: '默认关闭。启用后，从配置的私聊捕捉有时间的未来事项。明确短时提醒可跳过普通消息间隔，仍遵守静默、忙碌、角色睡眠、每日上限和发送开关。' },
  { group: '高级', path: 'agreements.model', label: '约定抽取模型', type: 'str', max: 120, dep: dep('agreements.enabled', false), hint: '可填当前宿主供应商的轻量模型 ID。留空优先用同一供应商可用的 Flash、Mini、Lite 等轻量模型，否则用当前模型做短抽取。' },
  { group: '高级', path: 'agreements.maxItems', label: '小本本最多保留', type: 'int', min: 1, max: 24, unit: '条', dep: dep('agreements.enabled', false), hint: '默认 8 条。满了优先保留临近、明确请你提醒的事项。' },
  { group: '高级', path: 'exploration.feedback.enabled', label: '探索轻互动与好奇候选', type: 'bool', hint: '默认开启。按钮和聊热的分享只为下次选题提供有限参考；明确指定主题优先。' },
  { group: '高级', path: 'exploration.feedback.maxCandidates', label: '近期好奇候选最多保留', type: 'int', min: 1, max: 12, unit: '条', dep: dep('exploration.feedback.enabled', true), hint: '默认 6 条。新候选替换最旧的候选，不累加长期权重。' },
  { group: '高级', path: 'rules.backfill', label: '补记静默里说的话', type: 'bool', hint: '开（默认）：静默/断线期间TA说过的话，下一拍补算成「接住了我上一条」。关：只认这一拍之后的新消息' },
  { group: '高级', path: 'rules.backfillWindowMin', label: '补记往回找多久', type: 'int', min: 5, max: 120, unit: '分钟', dep: dep('rules.backfill', true), hint: '默认 30 分钟。TA的话离现在超过这么久就不补记了——太久以前的一句，接住也没意义' },
  { group: '高级', path: 'rules.replyGuard', label: '发之前再查一遍TA回没回', type: 'bool', hint: '开（默认）：开口前再查一遍 QQ / 抖音的最新出站记录，另一个值班会话已经回过了就不再回一次；关：只看这一拍开头读到的数据' },
  { group: '高级', path: 'rules.judge.attempts', label: '判坏了再问几次', type: 'int', min: 1, max: 3, unit: '次', dep: ON_JUDGE, hint: '模型偶尔会把「判断」直接写成一句回话（不是 JSON），那一次算判坏、再问一次；问这么多次还不行就退回规则链。设 1 = 不重试' },
  { group: '高级', path: 'rules.judge.shadow', label: '被拦的拍子也预演一次', type: 'bool', dep: ON_JUDGE, hint: '关（默认）：护栏拦下就结束。开：被拦的拍子按比例再问模型一次「你会不会说、会说什么」，只记不发——用来攒 judge 的真实判断分布。结果不进接住率（TA根本没收到）' },
  { group: '高级', path: 'rules.judge.shadowSampleRate', label: '预演采样比例', type: 'num', min: 0, max: 1, dep: [ON_JUDGE, ON_JUDGE_SHADOW], hint: '只在预演开着时生效（默认 0.25）：被拦的拍子只有这个比例会真问模型，其余直接丢——别一天烧一百次调用' },
  { group: '高级', path: 'rules.naturalTriggers.courseWindowMin', label: '课上完之后算多久', type: 'int', min: 1, max: 60, unit: '分钟', dep: ON_NATURAL, hint: '这一段的课都上完后的这段时间里都算「课上完了」（默认 20 分钟）。最后一节下课你可能正在收拾东西、在路上，窗口只有 5 分钟会天天错过。同一个时间段一天只算一次' },
  { group: '高级', path: 'rules.naturalTriggers.courseSplitMin', label: '上午和下午的分界', type: 'int', min: 0, max: 1440, unit: '分钟（从 0 点算）', dep: ON_NATURAL, hint: '默认 720 分钟（= 12:00）：开始时间在这之前算上午的课，之后算下午和晚上的课；上午的课上完提一句，剩下的课上完再提一句' },
  { group: '高级', path: 'content.llm.attempts', label: '写歪了重写几次', type: 'int', min: 1, max: 3, unit: '次', dep: ON_CONTENT, hint: '默认 2 次。重写一次大约多花一次生成的时间' },
  { group: '高级', path: 'content.prompt.recentOutbound', label: '让TA看见我最近说过什么', type: 'bool', dep: ON_CONTENT, hint: '开（默认）：写新的一句时，把我最近真发出去的 5 条也摆给模型看，免得连着几天一个开头、一个话题；关：当这些记录不存在，行为和没加这段之前一样' },
  { group: '高级', path: 'content.prompt.slotStats', label: '让TA看见话题接住率', type: 'bool', dep: ON_CONTENT, hint: '开（默认）：告诉模型哪类由头TA接住了、哪类老没人应；关：不摆这些数字，行为和没加这段之前一样' },
  { group: '高级', path: 'sources.phone.staleHours', label: '数据过期多久算停', type: 'int', min: 6, max: 168, unit: '小时', dep: ON_PHONE, hint: '默认 36 小时。鱼鱼那封邮件超过这么多小时没更新，睡眠/压力/步数/屏幕四类由头就停用——拿旧数据问「昨晚睡得好吗」比不说话更伤' },
  { group: '高级', path: 'sources.phone.staleGuard', label: '数据过期就停用', type: 'bool', dep: ON_PHONE, hint: '开（默认）：邮件太旧时上面那四类由头不参与判定，--why 里会写原因；关：不管多旧都照旧用（阈值还留着，想恢复不用重填）' },
  { group: '高级', path: 'sources.memory.max', label: '一次带几条', type: 'int', min: 1, max: 8, dep: ON_MEMORY, hint: '默认 3 条。长期画像（喜好、约定）优先，剩下给最近的事；带太多会把这一句挤成汇报' },
  { group: '高级', path: 'sources.memory.session', label: '读哪个会话的记忆', type: 'str', max: 80, dep: ON_MEMORY, hint: '留空 = 自动读取最近有记忆的文件（鱼的记忆会同时看工作区与最新旧会话）；填文件名或 id 前缀锁定某一份；填 all 全合并' },
  { group: '高级', path: 'mail.user', label: '邮箱账号', type: 'str', max: 120, dep: ON_MAIL_OR_PHONE, hint: '填完整地址（比如 123456@qq.com）。IMAP 服务器按域名自动猜，QQ/163/126/Gmail/Outlook 都在表里' },
  { group: '高级', path: 'mail.authCode', label: 'IMAP 授权码', type: 'secret', max: 200, dep: ON_MAIL_OR_PHONE, hint: '不是登录密码。QQ 邮箱：设置 → 账号 → 开启 IMAP 服务后生成的那串。只存进 credentials.json，界面永远只显示「已设置」' },
  { group: '高级', path: 'mail.host', label: 'IMAP 服务器', type: 'str', max: 120, dep: ON_MAIL_OR_PHONE, hint: '留空 = 按邮箱域名自动猜；猜不准才填，比如 imap.exmail.qq.com' },
  { group: '高级', path: 'mail.intervalMinutes', label: '多久读一次邮箱', type: 'int', min: 5, max: 1440, unit: '分钟', dep: ON_MAIL_OR_PHONE, hint: '默认 30 分钟。手机 App 大概一小时发一封，读太勤没意义' },
  { group: '高级', path: 'idle.onlineSec', label: '多久没动算在线', type: 'int', min: 5, max: 600, unit: '秒', hint: 'L1：鼠标键盘停了这么多秒之内，都算你还在电脑前。默认 30 秒' },
  { group: '高级', path: 'idle.awaySec', label: '多久没动算离开', type: 'int', min: 60, max: 3600, unit: '秒', hint: 'L1：停超过这么多秒就判「人不在」，这一拍直接跳过不打扰。默认 600 秒' },
  { group: '高级', path: 'perception.l2.enabled', label: '记下TA在做什么', type: 'bool', hint: '把前台窗口折成打游戏/写代码/看视频，只在判到要发的那一拍记一笔，不影响发不发。默认开' },
  { group: '高级', path: 'perception.l3.enabled', label: '看屏幕（OCR）', type: 'bool', hint: '截前台窗口做系统 OCR，约 1 秒。只在判到要发的那一拍才截，只当「当时我在干什么」的记录，不参与发不发。中文认错得厉害，结构化信号能说清时就不用它。默认关' },
  { group: '高级', path: 'rules.askProjectOnce', label: '问一次最近在忙的项目', type: 'bool', hint: '对当前主通道联系人只主动问一次；不催回复。读到相关回答才保存为本地记忆，近期聊天可参考。' },
  { group: '高级', path: 'exploration.mood', label: '探索心情', type: 'bool', hint: '探索时可顺手记一句感受，有效时长可在「时间间隔」调整。只影响已经决定要发的主动消息，不会主动多发一条。' },
  { group: '高级', path: 'content.topics.followCasualSilence', label: '检查闲聊或分享中的提醒约定', type: 'bool', hint: '默认关闭。开启后这几类消息也可检查是否含明确约定。单凭未回复不会追问。' },
  { group: '高级', path: 'exploration.web', label: '探索时搜索网页', type: 'bool', hint: '优先用 dsh-free-search，找不到结果时用 DSH 的 web_search。再用 web_fetch 读最多两页正文；仅搜到摘要时会标明。' },
  { group: '高级', path: 'exploration.video', label: '探索时找视频', type: 'bool', hint: '每轮最多看一条。画面需要 dsh-video-storyboard 和支持图片的模型；抖音还需要取流配置。有字幕或转写时可退回文字，只有标题会标明。' },
  { group: '高级', path: 'exploration.extraTools', label: '探索可调用的额外只读工具', type: 'str', max: 240, hint: '逗号分隔的宿主只读工具名（如 bilibili_hot, bilibili_search），让自主探索直接调用已装插件或 MCP 的查询工具；留空关闭。请仅填写只读查询工具，系统会自动拦截写/执行/发送类工具名。' },
  { group: '高级', path: 'perception.l3.everyMin', label: '看屏幕隔多久', type: 'int', min: 5, max: 720, unit: '分钟', dep: ON_L3, hint: '默认 30 分钟。上一次看屏幕不到这么久就跳过，免得同一张桌面反复截' },
  { group: '高级', path: 'perception.signals.enabled', label: '看窗口和网页（不截屏）', type: 'bool', hint: '只读前台窗口标题、进程名和浏览器当前标签页，不截屏、不 OCR、不联网。比 L3 准，默认开' },
  { group: '高级', path: 'perception.signals.browser', label: '读浏览器当前标签页', type: 'bool', dep: ON_SIGNALS, hint: '借桌面 Edge 的调试口（默认 9223）问它在看哪个页面；端口没开就跳过，不影响别的。默认开' },
  { group: '高级', path: 'perception.signals.port', label: '浏览器调试端口', type: 'int', min: 1024, max: 65535, dep: ON_SIGNALS, hint: '默认 9223（start-edge-debug.ps1 开的那个）。改了要对应 Edge 的 --remote-debugging-port' },
  // 由头细节：所属那一类关着就不显示，免得一堆用不上的阈值挡路。
  { group: '高级', path: 'content.topics.sleepShortMin', label: '算「睡少了」低于', type: 'int', min: 240, max: 600, unit: '分钟', dep: [ON_PHONE, onTopic('sleep')], hint: '默认 420 分钟（7 小时）。读得到深睡时要和「深睡少」同时满足才算；深睡没读到就只看这一条' },
  { group: '高级', path: 'content.topics.sleepDeepShortMin', label: '深睡低于', type: 'int', min: 30, max: 240, unit: '分钟', dep: [ON_PHONE, onTopic('sleep')], hint: '默认 120 分钟（2 小时）。深睡是拓展项——应用不报这个数时只按时长判；报的时候要和「睡少了」同时满足才算' },
  { group: '高级', path: 'content.topics.sleepLongMin', label: '算「睡多了」超过', type: 'int', min: 480, max: 900, unit: '分钟', dep: [ON_PHONE, onTopic('sleep')], hint: '默认 570 分钟（9.5 小时）。睡这么多只在真累到时才提' },
  { group: '高级', path: 'content.topics.sleepLateBed', label: '几点之后算熬夜', type: 'hm', dep: [ON_PHONE, onTopic('sleep')], hint: '默认 00:30。有「入睡时间」就直接用；大多数时候没有，拿睡眠反推入睡点（反推不含躺着没睡着那段，所以这条线定在「规定的时间 + 最近平均入睡耗时」）。06:00 后才睡着当数据异常，不算' },
  { group: '高级', path: 'content.topics.stressHighMin', label: '算「压力高」高于', type: 'int', min: 30, max: 100, dep: [ON_PHONE, onTopic('stress')], hint: '默认 59 分（严格大于）。0-100 的量表' },
  { group: '高级', path: 'content.topics.stressDailyMax', label: '压力一天最多提', type: 'int', min: 0, max: 6, unit: '次', dep: [ON_PHONE, onTopic('stress')], hint: '默认 1 次。提第二次要求压力不低于上次' },
  { group: '高级', path: 'content.topics.stepsLowMax', label: '算「没怎么动」低于', type: 'int', min: 0, max: 20000, unit: '步', dep: [ON_PHONE, onTopic('steps')], hint: '最多采用 600 步；低于门槛时也可能是漏记' },
  { group: '高级', path: 'content.topics.stepsHighMin', label: '算「活动量好」高于', type: 'int', min: 0, max: 50000, unit: '步', dep: [ON_PHONE, onTopic('steps')], hint: '最少采用 16000 步。两个门槛之间不发' },
  { group: '高级', path: 'content.topics.stepsFromHour', label: '步数从几点开始看', type: 'int', min: 0, max: 23, unit: '点', dep: [ON_PHONE, onTopic('steps')], hint: '默认 18 点。白天的步数还没走完，说得太早容易翻车' },
  { group: '高级', path: 'content.topics.screenHeavyMin', label: '屏幕用多久才考虑提醒', type: 'int', min: 1, max: 1440, unit: '分钟', dep: [ON_PHONE, onTopic('screen')], hint: '默认 720 分钟（12 小时）。和步数、久坐共享冷却。' },
  { group: '高级', path: 'content.topics.catchupDays', label: '算「几天没说话」', type: 'int', min: 1, max: 7, unit: '天', dep: onTopic('catchup'), hint: '默认 2 天' },
  { group: '高级', path: 'content.topics.lateFromHour', label: '深夜从几点算', type: 'int', min: 0, max: 23, unit: '点', dep: onTopic('lateUp'), hint: '默认 23 点是最早的一头' },
  { group: '高级', path: 'content.topics.lateToHour', label: '深夜到几点为止', type: 'int', min: 0, max: 23, unit: '点', dep: onTopic('lateUp'), hint: '默认 2 点。可以跨零点；跟「从几点算」相同则这一类失效' },
  { group: '高级', path: 'content.topics.longSitHours', label: '电脑连续活跃多久才考虑提醒', type: 'num', min: 0.25, max: 24, unit: '小时', dep: onTopic('longSit'), hint: '默认 5 小时。离开超过空闲判定时长会重新计时。' },
  { group: '高级', path: 'content.topics.backAfterMin', label: '离开多久才算「出去过」', type: 'int', min: 5, max: 480, unit: '分钟', dep: onTopic('backHome'), hint: '默认 30 分钟。太短就只是去倒水，不算' },
  { group: '高级', path: 'content.topics.noReplyMin', label: '隔多久没回才问', type: 'int', min: 30, max: 1440, unit: '分钟', dep: onTopic('noReply'), hint: '默认 120 分钟。指距我那条消息（或分享的视频）' },
  { group: '高级', path: 'content.topics.noReplyAfterHerMin', label: 'TA说话后至少隔', type: 'int', min: 0, max: 720, unit: '分钟', dep: onTopic('noReply'), hint: '默认 120 分钟。TA刚说完话就别追着问，这一条和上面的「隔多久」都要满足' },
  { group: '高级', path: 'content.topics.noReplyAfterBusyMin', label: 'TA忙完后等', type: 'int', min: 0, max: 240, unit: '分钟', dep: onTopic('noReply'), hint: '默认 20 分钟。模型判断TA那会儿在忙/睡了：等TA忙完（或忙碌时段结束）之后再等这么久才问' },
  { group: '高级', path: 'content.topics.noReplyJudge', label: '核对是否约好追问或提醒', type: 'bool', dep: onTopic('noReply'), hint: '开：先核对用户是否明确约好就这件事提醒，再按现有等待时间判断。关：停用这条自动追问。' },
  { group: '高级', path: 'content.topics.agendaTomorrowHour', label: '几点后说明天的课', type: 'int', min: 18, max: 23, unit: '点', dep: onTopic('agenda'), hint: '默认 21 点。太早说像通知，太晚TA已经睡了' },
  { group: '高级', path: 'content.topics.agendaEarlyBeforeHour', label: '几点前算早课', type: 'int', min: 6, max: 12, unit: '点', dep: onTopic('agenda'), hint: '默认 9 点。8:00 和 8:55 的课都会提醒，9:50 的不会' },
  { group: '高级', path: 'content.topics.agendaSoonMin', label: '课前多久提一句', type: 'int', min: 5, max: 120, unit: '分钟', dep: onTopic('agenda'), hint: '默认 20 分钟' },
];

const BY_PATH = new Map(SCHEMA.map((s) => [s.path, s]));

/** 这个参数在不在设置页白名单里（--set 用它区分「打错了」和「调试用没校验的路径」）。 */
export function isKnownPath(path) {
  return BY_PATH.has(String(path || ''));
}

const ALL_WORDS = /^(全天|不限|all|any)$/i;

function ok(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

const EXPLORATION_MODEL_RE = /^[a-zA-Z0-9_.-]{1,48}:[a-zA-Z0-9_./:-]{1,120}$/;

function buildExplorationModelOptions(cfg) {
  const cat = getHostModelCatalog();
  const follow = cat.boundModel || cat.defaultModel;
  const followLabel = cat.boundModel
    ? `跟随绑定会话（当前：${cat.boundModel.provider} / ${cat.boundModel.model}）`
    : follow
      ? `跟随绑定会话（未检出会话模型，暂用默认：${follow.provider} / ${follow.model}）`
      : '跟随绑定会话（默认）';
  const opts = [['', followLabel]];
  const seen = new Set(['']);
  for (const item of cat.models) {
    const key = `${item.provider}:${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pLabel = item.providerName && item.providerName !== item.provider ? `${item.providerName} (${item.provider})` : item.provider;
    const mLabel = item.modelName && item.modelName !== item.model ? `${item.modelName} (${item.model})` : item.model;
    opts.push([key, `${pLabel} / ${mLabel}`]);
  }
  const cur = String(cfg?.exploration?.model || '').trim();
  if (cur && !seen.has(cur)) {
    opts.push([cur, `${cur}（当前已选）`]);
  }
  return opts;
}

/** "7:5" / "07:05" / "7：05" → "07:05"；不可解析返回 null。 */
export function normalizeHm(v) {
  const m = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(mi)) return null;
  if (h < 0 || h > 24 || mi < 0 || mi > 59) return null;
  if (h === 24 && mi !== 0) return null;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

/** 数组/字符串 → 人类可读的一段话（设置页只负责显示）。 */
export function display(spec, value) {
  switch (spec.type) {
    case 'bool':
      return value ? '开' : '关';
    case 'windows': {
      const { windows } = normalizeWindows(value);
      return windows.length ? fmtWindows(windows) : '全天不限';
    }
    case 'select': {
      const hit = (spec.options || []).find(([k]) => k === value);
      return hit ? hit[1] : String(value ?? '');
    }
    case 'hm':
      return normalizeHm(value) || String(value ?? '');
    case 'secret':
      return secretFor(spec.path) ? '已设置' : '未设置';
    default:
      return spec.unit ? `${value} ${spec.unit}` : String(value ?? '');
  }
}

/**
 * 把用户/界面给的值校成一个**能跑**的值。
 * 返回 { ok:true, path, value } 或 { ok:false, error }。
 */
export function coerce(path, raw) {
  const spec = BY_PATH.get(String(path || ''));
  if (!spec) return { ok: false, error: `这个参数不开放修改：${path}` };

  const bad = (why) => ({ ok: false, error: `${spec.label}：${why}` });

  switch (spec.type) {
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, path: spec.path, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (['true', '1', 'on', 'yes', '是', '开'].includes(s)) return { ok: true, path: spec.path, value: true };
      if (['false', '0', 'off', 'no', '否', '关', ''].includes(s)) return { ok: true, path: spec.path, value: false };
      return bad('只认 开/关');
    }
    case 'int':
    case 'num': {
      if (raw === '' || raw === null || raw === undefined) return bad('不能空着');
      if (!ok(raw)) return bad('要填数字');
      const n = Object.is(Number(raw), -0) ? 0 : Number(raw);
      if (spec.type === 'int' && !Number.isInteger(n)) return bad('要整数');
      if (spec.min !== undefined && n < spec.min) return bad(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return bad(`不能大于 ${spec.max}`);
      // 毫秒类的参数在界面上按秒填（scale=1000），存回配置还是毫秒。
      return { ok: true, path: spec.path, value: spec.scale ? Math.round(n * spec.scale) : n };
    }
    case 'text':
    case 'str': {
      const s = String(raw == null ? '' : raw);
      if (s.length > (spec.max || 200)) return bad(`最多 ${spec.max || 200} 个字`);
      // 邮箱当场拦：写成 `12345678@qq/com`（斜杠）不报错的话，要等下一拍联网
      // 才炸成 `getaddrinfo ENOTFOUND imap.qq/com`，看不出是哪儿写错了。
      if (spec.path === 'channels.qq.peerId') {
        const value = s.trim();
        if (value && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)) {
          return bad('请填写联系人的 QQ 号，只填数字');
        }
        return { ok: true, path: spec.path, value };
      }
      if (spec.path === 'mail.user') {
        const v = s.trim();
        if (v && !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) {
          return bad('要写成 name@qq.com 这样（@ 后面是域名，别把点打成斜杠）');
        }
        return { ok: true, path: spec.path, value: v };
      }
      if (spec.path === 'channels.douyin.peerSecUid' || spec.path === 'channels.douyin.peerName' || spec.path === 'sources.memory.dir') {
        return { ok: true, path: spec.path, value: s.trim() };
      }
      return { ok: true, path: spec.path, value: s };
    }
    case 'secret': {
      // 只收值本身：留空 = 不改（界面上永远是空的，不会把掩码写回来）
      const s = String(raw == null ? '' : raw).trim();
      if (!s) return bad('不能空着；不打算改就别动这一栏');
      if (s.length > (spec.max || 200)) return bad(`最多 ${spec.max || 200} 个字`);
      return { ok: true, path: spec.path, value: s, secret: true };
    }
    case 'select': {
      const s = String(raw).trim();
      if (spec.path === 'exploration.model') {
        const opts = buildExplorationModelOptions();
        if (opts.some(([k]) => k === s) || EXPLORATION_MODEL_RE.test(s)) {
          return { ok: true, path: spec.path, value: s };
        }
        return bad('请选择列表中的模型，或使用 provider:model 格式');
      }
      const rawStr = String(raw);
      const opts = spec.path === 'sources.memory.plugin'
        ? [...(spec.options || []), ...listRegisteredMemorySources().map((m) => [m.id, `${m.label}（扩展）`])]
        : spec.path === 'exploration.moodSource'
          ? [...(spec.options || []), ...listRegisteredMoodSources().map((m) => [m.id, `${m.label}（仅此扩展）`])]
          : (spec.options || []);
      if (!opts.some(([k]) => k === rawStr)) return bad(`只能是 ${opts.map(([k]) => k).join(' / ')}`);
      return { ok: true, path: spec.path, value: rawStr };
    }
    case 'hm': {
      const v = normalizeHm(raw);
      if (!v || (spec.path === 'agreements.dateTime' && v === '24:00')) return bad('要写成 00:30 这种');
      return { ok: true, path: spec.path, value: v };
    }
    case 'windows': {
      // 空 = 全天不限；写了就得每段都看得懂（看不懂就整条拒绝，别默默丢掉一段）
      const text = Array.isArray(raw) ? raw : String(raw == null ? '' : raw);
      if (typeof text === 'string' && (!text.trim() || ALL_WORDS.test(text.trim()))) {
        return { ok: true, path: spec.path, value: [] };
      }
      const { windows, errors } = normalizeWindows(text);
      if (errors.length) return bad(errors[0]);
      if (!windows.length) return { ok: true, path: spec.path, value: [] };
      return { ok: true, path: spec.path, value: windows };
    }
    case 'courses': {
      // 课程列表提交的是「取消勾选的那些 key」；界面传数组，命令行可以传逗号分隔
      let arr = raw;
      if (typeof raw === 'string') {
        const s = raw.trim();
        if (!s) arr = [];
        else {
          try {
            arr = JSON.parse(s);
          } catch {
            arr = s.split(/[,，\n]/);
          }
        }
      }
      if (!Array.isArray(arr)) return bad('要一个列表');
      const list = arr.map((x) => String(x).trim()).filter(Boolean);
      if (list.length > 300) return bad('最多 300 项');
      if (list.some((x) => x.length > 80)) return bad('每项最多 80 字');
      return { ok: true, path: spec.path, value: list };
    }
    default:
      return bad('这个类型还没实现');
  }
}

const WD_LABEL = { 1: '周一', 2: '周二', 3: '周三', 4: '周四', 5: '周五', 6: '周六', 7: '周日' };
const hmLabel = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function weekLabel(w) {
  if (!w) return '';
  const parts = [];
  if (w.ranges) parts.push(w.ranges.map(([a, b]) => (a === b ? `${a}周` : `${a}-${b}周`)).join(','));
  if (w.parity === 'odd') parts.push('单周');
  if (w.parity === 'even') parts.push('双周');
  return parts.length ? `（${parts.join(' ')}）` : '';
}

/** 设置页那个可折叠列表：课表读出来是什么就列什么，提交的是「取消勾选的那些 key」。 */
export function courseItems(cfg) {
  const src = agendaSource(cfg);
  const list = parseAgenda(src.text, { periods: String(cfg?.content?.agenda?.periods || '') });
  const off = Array.isArray(cfg?.content?.agenda?.off) ? cfg.content.agenda.off : [];
  return list.map((c) => {
    const key = courseKey(c);
    return {
      key,
      checked: !off.includes(key),
      label:
        `${WD_LABEL[c.weekday]} ${hmLabel(c.fromMin)}-${hmLabel(c.toMin)} ${c.name || '（没写课名）'}` +
        `${c.room ? ` @${c.room}` : ''}${weekLabel(c.weeks)}`,
    };
  });
}

function groupItemsForUi(cfg, name, detCache = { value: null }) {
  return SCHEMA.filter((s) => s.group === name && !s.hidden && depVisible(cfg, s.dep)).map((s) => {
    const secret = s.type === 'secret';
    const value = s.path === 'exploration.bias' ? explorationBiasForUi(cfg.exploration) : secret ? '' : getPath(cfg, s.path, s.default);
    // scale 把存储单位换成界面单位（毫秒 → 秒），读出来和显示都要换。
    const shown = value == null || !s.scale ? value : (s.type === 'int' ? Math.round(Number(value) / s.scale) : Number(value) / s.scale);
    let hint = (s.path.startsWith('sources.') || s.path === 'exploration.portrait') ? `${s.hint || ''}${detectHint(s.path, cfg, detCache)}` : s.hint;
    if (s.path === 'exploration.bias' && usesLegacyExplorationCadence(cfg.exploration)) {
      hint += ' 旧设置仍按原规则运行，改选后应用新倾向。';
    }
    if (s.path === 'exploration.browseMode') {
      hint = shown === 'browser_agent'
        ? '调网站浏览（会消耗更多 token）：用本机浏览器真正打开目标站点，支持多步搜索、点击进入章节/详情页、滚动翻页并结合识图模型阅读画面，达到下方步数上限自动收尾。'
        : '轻量看图：保持低开销，搜到漫画或图文页面后提取页面图片或截取公开画面，直接交给已配置的识图模型看图写感受，不跑多轮浏览器循环。';
    }
    const extra = {};
    // 课程勾选列表：课表里有什么就列什么（读不出来的行已经跳过了）
    if (s.type === 'courses') {
      extra.items = courseItems(cfg);
      extra.display = extra.items.length
        ? `${extra.items.filter((i) => i.checked).length}/${extra.items.length} 节在提醒`
        : '还没填课表';
    }
    // 考试正文后面接一句「认出来几场」，让人知道格式有没有写对
    if (s.path === 'content.exams.text') {
      try {
        const list = parseExams(examsSource(cfg).text, {});
        if (list.length) hint = `${hint}｜已识别 ${list.length} 场，最近一场 ${list[0].date} ${list[0].hm} ${list[0].subject || ''}`.trim();
      } catch {
        /* 认不出来就不多嘴 */
      }
    }
    // 抖音联系人：留空时展示从抖音插件自动识别到的结果
    if (s.path === 'channels.douyin.peerSecUid' || s.path === 'channels.douyin.peerName') {
      if (!detCache.douyinPeer) detCache.douyinPeer = douyinPluginPeer();
      const auto = detCache.douyinPeer;
      const cur = String(value || '').trim();
      if (!cur) {
        if (s.path === 'channels.douyin.peerSecUid') {
          hint = `${hint || ''}｜${auto.secUid ? `已自动获取：${auto.nick ? `${auto.nick} · ` : ''}${auto.secUid}` : '未检测到：请先在 dsh-douyin-scroll 选择私信对象或手填'}`;
        } else {
          hint = `${hint || ''}｜${auto.nick ? `已自动获取：${auto.nick}` : '未检测到：留空将只用 sec_uid'}`;
        }
      } else if (s.path === 'channels.douyin.peerSecUid' && !cur.startsWith('MS4w')) {
        hint = `${hint || ''}｜注意：当前填的值不像 sec_uid（通常以 MS4w 开头），清空留空即可自动从抖音插件获取`;
      }
    }
    const options = s.path === 'sources.memory.plugin'
      ? [...(s.options || []), ...listRegisteredMemorySources().map((m) => [m.id, `${m.label}（扩展）`])]
      : s.path === 'exploration.moodSource'
        ? [...(s.options || []), ...listRegisteredMoodSources().map((m) => [m.id, `${m.label}（仅此扩展）`])]
        : s.path === 'exploration.model'
          ? buildExplorationModelOptions(cfg)
          : s.options;
    hint = ensureTimeUnitHint(s, hint);
    return {
      path: s.path,
      label: s.label,
      group: s.group,
      tags: tagsForSpec(s),
      type: s.type,
      ...(s.min !== undefined ? { min: s.min } : {}),
      ...(s.max !== undefined ? { max: s.max } : {}),
      ...(s.unit ? { unit: s.unit } : {}),
      ...(options ? { options } : {}),
      ...(s.rows ? { rows: s.rows } : {}),
      ...(hint ? { hint } : {}),
      ...(secret ? { secret: true, set: Boolean(secretFor(s.path)) } : {}),
      ...extra,
      value: s.type === 'windows' ? normalizeWindows(value).windows : shown,
      display:
        extra.display !== undefined
          ? extra.display
          : display(s, s.type === 'windows' ? value : shown),
    };
  });
}

function depLabelsOf(d) {
  if (!d) return [];
  const items = Array.isArray(d) ? d : Array.isArray(d.any) ? d.any : [d];
  const labels = [];
  for (const item of items) {
    if (!item?.path) continue;
    const spec = BY_PATH.get(item.path);
    const label = spec?.label || item.path;
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** 当前被父开关隐藏、但可供全局搜索提示的设置清单。 */
export function hiddenItemsForSearch(cfg) {
  return SCHEMA.filter((s) => !s.hidden && !depVisible(cfg, s.dep)).map((s) => ({
    path: s.path,
    label: s.label,
    group: s.group,
    tags: tagsForSpec(s),
    ...(s.unit ? { unit: s.unit } : {}),
    hint: ensureTimeUnitHint(s, s.hint),
    depLabels: depLabelsOf(s.dep),
  }));
}

/** 自主探索卡片底部的直出配置项。 */
export function explorationItemsForUi(cfg) {
  return groupItemsForUi(cfg, '自主探索');
}

/** 自主探索下方「聊天接口切换」卡片的直出配置项。 */
export function channelItemsForUi(cfg) {
  return groupItemsForUi(cfg, '聊天接口');
}

/**
 * 设置页要的一份清单：分组 → 项 → 当前值。
 * 只暴露白名单里的路径；其余（CLI 路径、通道 id…）**不出现在界面上**。
 * 凭据类（type=secret）例外：出现，但 value 恒为空串、只给一句 display。
 */
export function listForUi(cfg) {
  const groups = [];
  const detCache = { value: null };
  for (const name of GROUP_ORDER) {
    const items = groupItemsForUi(cfg, name, detCache);
    if (items.length) {
      const group = { name, items };
      if (GROUP_NOTES[name]) group.note = GROUP_NOTES[name];
      if (FOLDABLE_GROUPS.has(name)) {
        group.foldable = true;
        group.summary = groupSummary(cfg, name, items);
      }
      const innerNote = groupInnerNote(cfg, name);
      if (innerNote) group.innerNote = innerNote;
      groups.push(group);
    }
  }
  return groups;
}

/**
 * 子项要不要显示：父开关关着就把这一行藏起来（值还在，开回来原样恢复）。
 * 父开关在配置里没写时按 dep.default（默认开的开关传 true）。
 */
function depVisible(cfg, d) {
  if (!d) return true;
  if (Array.isArray(d)) return d.every((item) => depVisible(cfg, item));
  if (Array.isArray(d.any)) return d.any.some((item) => depVisible(cfg, item));
  return getPath(cfg, d.path, d.default) === d.on;
}

function groupInnerNote(cfg, name) {
  if (name !== '角色作息') return '';
  const st = characterRestStatus(cfg);
  const stateTag = st.asleep ? '（当前休息中）' : st.windDown ? '（当前临睡轻声期）' : '';
  const actual = `今日实际作息：${st.bedHm} 入睡 – ${st.wakeHm} 醒来${stateTag}`;
  const jitter = st.jitterMin ? `，含每日浮动 ±${st.jitterMin} 分钟` : '';
  return `${actual}（预设基准 ${st.baseBedHm}–${st.baseWakeHm}${jitter}）。`;
}

/** 折起来的标题旁边那一句概括人话：节奏、由头、数据源、课表与考试、高级。 */
function groupSummary(cfg, name, items = []) {
  if (name === '角色作息') {
    const st = characterRestStatus(cfg);
    return `今日实际 ${st.bedHm}–${st.wakeHm} · 基准 ${st.baseBedHm}–${st.baseWakeHm}`;
  }
  if (name === '高级') {
    return `${items.length} 项 · 平时不用动`;
  }
  if (name === '决定TA粘不粘人') {
    const cap = cfg?.rules?.dailyCap ?? 3;
    const tiered = cfg?.rules?.gapByTier?.enabled === true;
    const gap = tiered
      ? `分档 ${cfg?.rules?.gapByTier?.eventMin ?? 60}/${cfg?.rules?.gapByTier?.chatMin ?? 240} 分钟`
      : `至少隔 ${cfg?.rules?.minGapMin ?? 240} 分钟`;
    const chitchat = cfg?.rules?.chitchat?.enabled === true ? ' · 可随口搭话' : '';
    return `每天最多 ${cap} 条 · ${gap}${chitchat}`;
  }
  if (name === '节奏') {
    const wait = cfg?.rules?.replyCooldownMin ?? 5;
    const auto = cfg?.rules?.autoReply !== false ? '自动回TA' : '不自动回';
    const split = cfg?.send?.split?.enabled !== false ? '一句一条分开发' : '整段一次发';
    return `回复先等 ${wait} 分钟 · ${auto} · ${split}`;
  }
  if (name === '说什么') {
    const t = cfg?.content?.topics || {};
    const topicKeys = ['forward', 'sleep', 'stress', 'steps', 'screen', 'share', 'catchup', 'lateUp', 'longSit', 'backHome', 'noReply', 'agenda', 'characterRest'];
    const onCount = topicKeys.filter((k) => t[k] !== false).length;
    const mode = cfg?.content?.mode || 'auto';
    const modeLabel = mode === 'auto' ? '智能' : mode === 'llm' ? '模型' : '模板';
    return `${onCount} 类由头启用 · ${modeLabel}模式`;
  }
  if (name === '数据从哪来') {
    const parts = [];
    if (cfg?.sources?.qq?.enabled !== false) parts.push('QQ');
    if (cfg?.sources?.phone?.enabled !== false) parts.push('手机邮件');
    if (cfg?.sources?.douyin?.enabled !== false) parts.push('抖音');
    if (cfg?.sources?.memory?.enabled !== false) parts.push('记忆');
    if (cfg?.exploration?.portrait === true) parts.push('QQ情绪');
    return parts.length ? `已启用：${parts.join(' / ')}` : '未启用任何数据源';
  }
  if (name === '课表与考试') {
    let courseText = '课表还没填';
    try {
      const list = courseItems(cfg);
      if (list.length) {
        const on = list.filter((i) => i.checked).length;
        courseText = on < list.length ? `课表 ${list.length} 节（提醒 ${on} 节）` : `课表 ${list.length} 节`;
      }
    } catch {
      /* 认不出课表就照「还没填」说 */
    }
    let examText = '考试还没填';
    try {
      const list = parseExams(examsSource(cfg).text, {});
      if (list.length) examText = `考试 ${list.length} 场`;
    } catch {
      /* 同上 */
    }
    return `${courseText} · ${examText}`;
  }
  return '';
}

/**
 * 凭据类落盘（写 credentials.json，不进 config.json）。
 * 只认表里 type=secret 的路径，别的一律拒。
 */
export function saveSecret(path, raw) {
  const spec = BY_PATH.get(String(path || ''));
  if (!spec || spec.type !== 'secret') return { ok: false, error: `不是凭据类参数：${path}` };
  const r = coerce(spec.path, raw);
  if (!r.ok) return r;
  if (spec.path === 'mail.authCode') {
    saveSecrets({ authCode: r.value });
    return { ok: true, path: spec.path, secret: true };
  }
  return { ok: false, error: `凭据类参数还没接上落盘：${path}` };
}

/**
 * 改一项：改完返回**新的 cfg**（原对象不动），由调用方决定要不要落盘。
 * 返回 { ok, cfg, path, value } 或 { ok:false, error }。
 */
export function applyChange(cfg, path, raw) {
  const r = coerce(path, raw);
  if (!r.ok) return r;
  // 凭据类不进 config.json：只回一句「这个得走 saveSecret」，cfg 原样返回
  if (r.secret) return { ok: true, cfg, path: r.path, value: r.value, secret: true };
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const parts = r.path.split('.');
  let cur = next;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = r.value;
  if (r.path === 'exploration.bias') delete next.exploration.leisureEvery;
  if (r.path === 'content.topics.shareGapMin') delete next.content.topics.shareGapH;
  if (r.path === 'characterRest.bed' || r.path === 'characterRest.wake') {
    const { bed, wake } = { ...CHARACTER_REST_DEFAULTS, ...next.characterRest };
    if (bed === '24:00' || wake === '24:00') return { ok: false, error: '请填写 00:00–23:59 之间的时间' };
    if (normalizeHm(bed) === normalizeHm(wake)) return { ok: false, error: '入睡和醒来时间不能相同' };
  }
  if (r.path === 'rules.qqTiming.pauseSec' || r.path === 'rules.qqTiming.expireSec') {
    const { pauseSec = 15, expireSec = 55 } = next.rules.qqTiming;
    if (expireSec <= pauseSec) return { ok: false, error: '热聊补话的作废时间须大于补话等待时间' };
  }
  if (r.path === 'rules.feedback.dayStartMin' || r.path === 'rules.feedback.dayEndMin') {
    const { dayStartMin = 510, dayEndMin = 1410 } = next.rules.feedback;
    if (dayEndMin <= dayStartMin) return { ok: false, error: '回应统计的截止时间须晚于开始时间' };
  }
  // 接入总闸和通道开关是「同一个决定」：写总闸时把对应通道一起开/关。
  // 不然会出现「总闸开着、通道关着、什么都没发生」这种看不懂的状态。
  const CHANNEL_OF = { 'sources.qq.enabled': 'channels.qq.enabled', 'sources.douyin.enabled': 'channels.douyin.enabled' };
  if (CHANNEL_OF[r.path]) {
    const cp = CHANNEL_OF[r.path].split('.');
    let c = next;
    for (let i = 0; i < cp.length - 1; i++) {
      if (!c[cp[i]] || typeof c[cp[i]] !== 'object') c[cp[i]] = {};
      c = c[cp[i]];
    }
    c[cp[cp.length - 1]] = r.value;
  }
  // 换了邮箱账号：写死的 IMAP 服务器会盖过按域名猜，猜出来的和它不一样就清掉
  // （不这么做的话，本来是 QQ 的 imap.qq.com 会一直被拿去连 163 的账号）
  let hostReset = null;
  if (r.path === 'mail.user') {
    const want = hostFor(r.value);
    const had = String(next.mail?.host || '').trim();
    if (want && had && had.toLowerCase() !== want.toLowerCase()) {
      next.mail.host = '';
      hostReset = { from: had, to: want };
    }
  }
  return { ok: true, cfg: next, path: r.path, value: r.value, ...(hostReset ? { hostReset } : {}) };
}
