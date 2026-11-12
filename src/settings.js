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
import { getPath } from './config.js';
import { normalizeWindows, fmtWindows } from './schedule.js';
import { SECRETS_PATH, saveSecrets, hostFor } from './fishmail.js';
import { detectSources } from './detect.js';
import { parseAgenda, agendaSource, courseKey } from './agenda.js';
import { parseExams, examsSource } from './exams.js';

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
  const key = specPath.split('.')[1];
  if (!detCache.value) detCache.value = detectSources(cfg);
  const d = detCache.value[key];
  if (!d) return '';
  const ver = d.version ? `（v${d.version}）` : '';
  return `｜检测：${d.note}${ver}`;
}

/** 分组顺序 = 设置页从上到下的顺序：先日常，再具体，最后是平时别动的。 */
export const GROUP_ORDER = ['日常', '节奏', '说什么', '数据从哪来', '课表与考试', '高级'];

/**
 * 分组顶部的一条说明（灰底小字）。目前只有「日常」有：反作弊提醒。
 * 写在这里而不是写死在 client 里 —— 以后加别组的说明只改这张表。
 */
export const GROUP_NOTES = {
  日常:
    '玩带反作弊的游戏时，建议先关掉「高级」里的这几项：①「看屏幕（OCR）」——截屏最容易踩线，默认就关着；' +
    '②「看窗口和网页（不截屏）」——读前台窗口标题、浏览器标签（要开 Edge 调试口）、编辑器文件名；' +
    '③抖音视频的下载与转写（走 Edge 调试口 + 转码）。只读键鼠空闲不受影响。' +
    'WeGame/腾讯系进程在跑时这些会自动跳过，但名单外的游戏认不出来。',
};
/** 这一组默认折起来：课表按内容折，高级是「平时不用动」的那一堆。 */
export const FOLDABLE_GROUPS = new Set(['课表与考试', '高级']);

/**
 * 子项跟着父开关走：父开关关着，这一行就不显示（值还留在 config.json 里，开回来就恢复）。
 * dflt = 父开关在配置里没写时当作什么（默认开的父开关传 true）。
 */
function dep(path, dflt = true) {
  return { path, on: true, default: dflt };
}
const ON_JUDGE = dep('rules.judge.enabled', false);
const ON_NATURAL = dep('rules.naturalTriggers.enabled', false);
const ON_TIER = dep('rules.gapByTier.enabled', false);
const ON_PHONE = dep('sources.phone.enabled', true);
const ON_MEMORY = dep('sources.memory.enabled', true);
const ON_QQ = dep('sources.qq.enabled', true);
const ON_DOUYIN = dep('sources.douyin.enabled', true);
const ON_CONTENT = dep('content.enabled', true);
const ON_L3 = dep('perception.l3.enabled', false);
const ON_SIGNALS = dep('perception.signals.enabled', true);
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
  // ================================================================ 日常
  { group: '日常', path: 'enabled', label: '总开关', type: 'bool', hint: '关掉就一拍都不跑（插件还在，只是不动）' },
  { group: '日常', path: 'dryRun', label: '演练模式', type: 'bool', hint: '开：只判定、只记日志，不真的发。关：判定通过就发（还要下面那条也开着）' },
  { group: '日常', path: 'send.enabled', label: '允许真的发送', type: 'bool', hint: '和「演练模式」两个都放行才会发出去；只开这一个不会发' },
  { group: '日常', path: 'tickMinutes', label: '每拍间隔', type: 'int', min: 1, max: 120, unit: '分钟', hint: '多久醒一次看你在不在。改小不会更黏人，只是判定更及时' },
  { group: '日常', path: 'quietHours', label: '全局静默', type: 'windows', hint: '这几段里什么都不读不发；多段用逗号隔开（支持全角逗号/冒号），留空 = 全天不限' },
  { group: '日常', path: 'busyHours', label: '忙碌时段', type: 'windows', hint: 'TA上课/上班/开会的那几段，这几段里我不主动开口（TA先说话还是照常回）。和静默不一样：静默连数据都不读，这里只是我先不打扰。多段、可跨零点，留空 = 不忙' },

  // ================================================================ 节奏
  { group: '节奏', path: 'rules.dailyCap', label: '每天最多几条', type: 'int', min: 0, max: 20, unit: '条', hint: '0 = 今天一条都不主动发。默认 3 条' },
  { group: '节奏', path: 'rules.minGapMin', label: '两条之间至少隔', type: 'int', min: 10, max: 1440, unit: '分钟', hint: '默认 240 分钟（四小时）。改小会明显变黏；「高级」里开了间隔分档后，这条只在分档关着时用' },
  { group: '节奏', path: 'rules.replyCooldownMin', label: 'TA说完话先等几分钟', type: 'int', min: 1, max: 120, unit: '分钟', hint: '默认 5 分钟。TA刚说完你就回，等于抢话' },
  { group: '节奏', path: 'send.split.enabled', label: '一句一条分开发', type: 'bool', hint: '开（默认）：正文里空一行就算另一条，发的时候一条一条发，像人连着说几句。关：整段并成一条' },
  { group: '节奏', path: 'send.split.maxParts', label: '一轮最多拆几条', type: 'int', min: 1, max: 4, unit: '条', dep: dep('send.split.enabled', true), hint: '默认 4 条；多出来的并进最后一条' },
  { group: '节奏', path: 'send.split.minFirstMs', label: '第一条至少等几秒', type: 'int', scale: 1000, min: 0, max: 60, unit: '秒', dep: dep('send.split.enabled', true), hint: '默认 6 秒。她那条字数越多等得越久（最多 60 秒），不是固定值；填 0 = 不等' },
  { group: '节奏', path: 'send.split.minGapMs', label: '几条之间隔几秒', type: 'int', scale: 1000, min: 1, max: 5, unit: '秒', dep: dep('send.split.enabled', true), hint: '默认 1.2 秒（界面上填整数秒，填 1 就是 1 秒）。字数越多隔得越久，封顶 5 秒' },
  { group: '节奏', path: 'send.split.maxRoundMs', label: '一轮最多发多久', type: 'int', scale: 1000, min: 10, max: 300, unit: '秒', dep: dep('send.split.enabled', true), hint: '默认 90 秒。拆得太多、快超时了，剩下的几条并成一条发' },
  { group: '节奏', path: 'rules.proactive', label: '我会主动找你', type: 'bool', hint: '开（默认）：没人说话的时候也会按由头找你。关：只回你的话，不主动开口（安静模式）' },
  { group: '节奏', path: 'rules.autoReply', label: 'TA说话我自动回', type: 'bool', hint: '开（默认）：TA说完、隔了冷却时间就回。关：TA的话不自动回，只按「主动找TA」那条轨道走' },
  { group: '节奏', path: 'rules.feedback.enabled', label: '按TA的反应调由头', type: 'bool', hint: '开（默认）：记下哪一类发出去TA接住了、哪一类老没人应，老不接的先压几天；关：所有由头一视同仁' },
  { group: '节奏', path: 'rules.adaptiveGap', label: '没人应时自己少说点', type: 'bool', hint: '开（默认）：连着两条没回，之后两条之间自动多等一会儿（最多拖成三倍）；关：永远按上面那个固定间隔' },

  // ================================================================ 说什么
  { group: '说什么', path: 'content.enabled', label: '允许生成内容', type: 'bool', hint: '关掉 = 只判定不写句子（排障时用）' },
  { group: '说什么', path: 'content.mode', label: '怎么写', type: 'select', options: [['auto', '自动（能用模型就用）'], ['llm', '只用模型'], ['template', '只用模板'], ['fixed', '固定一句话（测试）']] },
  { group: '说什么', path: 'content.maxChars', label: '一句话最多', type: 'int', min: 10, max: 200, unit: '字', hint: '默认 60 字。超过这个长度 guard 会打回重写' },
  { group: '说什么', path: 'content.forward.enabled', label: '转发视频真的看', type: 'bool', hint: '开：下载转发视频。画面需要 dsh-video-storyboard 插件和支持图片的模型；画面不可用时用口播，缓存注明证据来源' },
  { group: '说什么', path: 'content.forward.asrAutostart', label: '转写服务按需起', type: 'bool', dep: dep('content.forward.enabled', true), hint: '开：要转写时自己拉起 whisper，转完立刻关掉（常驻会和 Breeze 一起把内存吃满）；关：只在服务本来就在跑时才转写' },
  // —— 随口说话：没有由头时也可以说一句。主开关放首屏，细节收进高级。
  { group: '说什么', path: 'rules.chitchat.enabled', label: '没什么事也可以说一句', type: 'bool', hint: '关（默认）：没有由头就不说话。开：别的由头都挑不出来时，让模型判一句「随口话」（「在吗」那种空招呼不算）——只走模型，写不出来就不发。一天最多几条在下面的「随口话一天最多几条」里自己设；不说时段跟着全局静默和TA睡着的那段走。要「让模型自己决定说不说」也开着才生效' },
  { group: '高级', path: 'rules.chitchat.perDay', label: '随口话一天最多几条', type: 'int', min: 1, max: 10, unit: '条', dep: dep('rules.chitchat.enabled', true), hint: '默认 3 条。这是上限：设 5 也不会一天真发 5 条——实际从 1 条起，最近TA接得住才往上放，老被晾着就收回 1 条。独立计数，但照旧计入每天总上限' },
  { group: '高级', path: 'rules.chitchat.dayStart', label: '最早几点', type: 'int', min: 420, max: 1439, unit: '分钟（从 0 点算）', dep: dep('rules.chitchat.enabled', true), hint: '默认 480 分钟（= 08:00）。TA睡着的那段（鱼鱼邮件 7 天中位数推出来的，不够 3 天按 23:00–07:00）一律不说，深夜的关心走「深夜没睡」' },
  { group: '高级', path: 'rules.chitchat.dayEnd', label: '最晚几点', type: 'int', min: 420, max: 1439, unit: '分钟（从 0 点算）', dep: dep('rules.chitchat.enabled', true), hint: '默认 1410 分钟（= 23:30）；真正不说的时间以「睡着时段」为准（设置页不单列，--health 能看到推导结果）' },
  { group: '高级', path: 'rules.chitchat.maxChars', label: '随口话最多几个字', type: 'int', min: 10, max: 80, unit: '字', dep: dep('rules.chitchat.enabled', true), hint: '默认 40 字。写在硬要求里，也要过 guard；超了打回重写，再超就不发' },
  { group: '高级', path: 'rules.chitchat.seedDays', label: '随口话从多久内的记忆里找话头', type: 'int', min: 1, max: 365, unit: '天', dep: dep('rules.chitchat.enabled', true), hint: '默认 30 天。随口话得落在一件具体的事上，太老的记忆翻出来会显得突兀' },
  { group: '高级', path: 'rules.chitchat.seedSkipPrivate', label: '别拿我瞒着TA的事当话头', type: 'bool', dep: dep('rules.chitchat.enabled', true), hint: '默认开。我自己标了「不给对方看」的记忆，不许拿来当搭话素材（方向上是我瞒着TA，不是TA瞒着我）' },
  { group: '高级', path: 'rules.feedback.testMode', label: '测试期：TA没回不算没接住', type: 'bool', hint: '开：发出去照样记「发过」、也能配对回看，但不进接住率、不动冷却——插件没完工时TA的沉默不代表这类话不行；正式跑起来记得关掉' },
  { group: '说什么', path: 'content.topics.reply', label: 'TA说完就回一句', type: 'bool', hidden: true, hint: '和「节奏」里的「TA说话我自动回」重复，界面不再单列；键还认，老配置照旧有效' },
  { group: '说什么', path: 'content.topics.forward', label: '接住TA转来的东西', type: 'bool', hint: '开（默认）：TA转来视频/链接、没人应时，我接一句。关：这类不算由头' },
  { group: '说什么', path: 'content.topics.sleep', label: '睡眠', type: 'bool', hint: '昨晚睡少/睡多/熬夜时提一句。只在早上，一天一次' },
  { group: '说什么', path: 'content.topics.stress', label: '压力', type: 'bool', hint: '压力高时提一句。白天 09:00-22:00，一天最多一次' },
  { group: '说什么', path: 'content.topics.steps', label: '步数', type: 'bool', hint: '18 点以后收到新邮件时看今天走了多少：太少或很多都提一句，中间那一段不打扰。一天最多一次' },
  { group: '说什么', path: 'content.topics.screen', label: '屏幕时间', type: 'bool', hint: '在电脑前坐太久时提一句。默认晚上 21 点后才算' },
  { group: '说什么', path: 'content.topics.share', label: '分享', type: 'bool', hint: '把我在 self.md 里私下记下的一句判断拿出来跟你说（≥40 字、隔 24 小时、同一条不重复用；标了「不给TA看」的自动跳过）' },
  { group: '说什么', path: 'content.topics.catchup', label: '好几天没说话', type: 'bool', hint: '隔了几天TA没动静时找人。默认 2 天起' },
  { group: '说什么', path: 'content.topics.lateUp', label: '深夜了还没睡', type: 'bool', hint: '夜里TA还亮着屏幕、人在电脑前时提一句。一个晚上最多一次（跨零点算同一晚）' },
  { group: '说什么', path: 'content.topics.longSit', label: '坐太久了', type: 'bool', hint: '连续坐在电脑前、中间没离开过，到点说一句让TA起身。一天最多一次' },
  { group: '说什么', path: 'content.topics.backHome', label: 'TA刚回来', type: 'bool', hint: 'TA出去一阵又回到电脑前，接一句开场。TA两小时内说过话就不发' },
  { group: '说什么', path: 'content.topics.noReply', label: '那条还没回', type: 'bool', hint: '我主动发过去、TA隔很久没回时问一句「在忙还是睡了」。同一条只问一次；先让模型结合最近的对话判断TA是不是去忙了/睡了' },
  { group: '说什么', path: 'content.topics.agenda', label: '按课表说事', type: 'bool', hint: '明早有课就前一晚催一句；下一节在几十分钟内开始就提醒一句。课表在「课表与考试」里填' },

  // ================================================================ 数据从哪来
  // 三条链路各自的总闸。关掉 = 这条链路当它不存在（不读、不判定、不发）。
  // hint 后面会动态接一句「检测：…」（listForUi 里拼），所以这里只写「关掉会发生什么」。
  { group: '数据从哪来', path: 'sources.phone.enabled', label: '手机数据', type: 'bool', hint: '睡眠、压力、屏幕时间都来自手机 App 发的邮件。关掉就不连邮箱，这三类由头全部停用' },
  { group: '数据从哪来', path: 'sources.qq.enabled', label: 'QQ', type: 'bool', hint: '要 dsh-plugin-qq-bridge 装了并配对过才算通；关掉之后 QQ 侧的旧记录也不再当「TA刚说话」用' },
  { group: '数据从哪来', path: 'sources.douyin.enabled', label: '抖音', type: 'bool', hint: '要 dsh-douyin-scroll 装了、并且它的聊天盯梢开着才算通。开着会读抖音私信，那边说的话也算「TA刚说话」' },
  { group: '数据从哪来', path: 'sources.memory.enabled', label: '读记忆插件的记忆', type: 'bool', hint: '从下面那个记忆插件里读它记下来的长期记忆，当「我本来就知道的事」用（只读，不改它的文件）。读不到就照常说话' },
  { group: '数据从哪来', path: 'mail.enabled', label: '读邮箱', type: 'bool', hint: '开：才会连 IMAP 把手机 App 发来的 FISH 邮件取回来；关着完全不联网。账号和授权码在「高级」里' },
  { group: '数据从哪来', path: 'channels.qq.read', label: '读 QQ', type: 'bool', dep: ON_QQ, hint: '开（默认）：读TA QQ 上的消息，用来判「TA刚说话」和回复。关：QQ 只当发送通道，不再读' },
  { group: '数据从哪来', path: 'channels.douyin.read', label: '读抖音私信', type: 'bool', dep: ON_DOUYIN, hint: '开（默认）：读抖音私信和分享记录。关：抖音整块不读，TA在那边的消息不算「TA刚说话」' },
  { group: '数据从哪来', path: 'channels.main.read', label: '读主会话', type: 'bool', hint: '开：把 DSH 主对话也当成一个通道读（TA在这儿说的话也算）。默认关，免得主对话被当成聊天记录反复读' },
  { group: '数据从哪来', path: 'content.topics.noReplyDouyin', label: '抖音分享也算没回', type: 'bool', dep: ON_DOUYIN, hint: '我分享给TA的视频TA一直没看/没回，也拿来当追问的由头。没装抖音插件、或上面那一行关着，这一项自动不参与' },

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
  { group: '高级', path: 'rules.backfill', label: '补记静默里说的话', type: 'bool', hint: '开（默认）：静默/断线期间TA说过的话，下一拍补算成「接住了我上一条」。关：只认这一拍之后的新消息' },
  { group: '高级', path: 'rules.backfillWindowMin', label: '补记往回找多久', type: 'int', min: 5, max: 120, unit: '分钟', dep: dep('rules.backfill', true), hint: '默认 30 分钟。TA的话离现在超过这么久就不补记了——太久以前的一句，接住也没意义' },
  { group: '高级', path: 'rules.replyGuard', label: '发之前再查一遍TA回没回', type: 'bool', hint: '开（默认）：开口前再查一遍 QQ / 抖音的最新出站记录，另一个值班会话已经回过了就不再回一次；关：只看这一拍开头读到的数据' },
  { group: '高级', path: 'rules.judge.enabled', label: '让模型自己决定说不说', type: 'bool', hint: '关（默认）：规则挑到由头就写。开：规则只提一条建议，把整份处境交给模型——它可以说不说，也可以换个角度；它写好的句子仍要过长度/口吻/防重复那些护栏，判坏了就退回规则链' },
  { group: '高级', path: 'rules.judge.attempts', label: '判坏了再问几次', type: 'int', min: 1, max: 3, unit: '次', dep: ON_JUDGE, hint: '模型偶尔会把「判断」直接写成一句回话（不是 JSON），那一次算判坏、再问一次；问这么多次还不行就退回规则链。设 1 = 不重试' },
  { group: '高级', path: 'rules.judge.shadow', label: '被拦的拍子也预演一次', type: 'bool', dep: ON_JUDGE, hint: '关（默认）：护栏拦下就结束。开：被拦的拍子按比例再问模型一次「你会不会说、会说什么」，只记不发——用来攒 judge 的真实判断分布。结果不进接住率（TA根本没收到）' },
  { group: '高级', path: 'rules.judge.shadowSampleRate', label: '预演采样比例', type: 'number', min: 0, max: 1, dep: ON_JUDGE, hint: '只在预演开着时生效（默认 0.25）：被拦的拍子只有这个比例会真问模型，其余直接丢——别一天烧一百次调用' },
  { group: '高级', path: 'rules.naturalTriggers.enabled', label: '事件也能挑开我', type: 'bool', hint: '关（默认）：只看时钟。开：一段活干完、刚下课、刚在 self.md 写一条，这几种时刻也算「可以开口」——静默、忙碌、离开、每日上限一概照旧拦着，间隔要不要让路看下面那条' },
  { group: '高级', path: 'rules.naturalTriggers.takeGap', label: '事件拍可以让间隔让路', type: 'bool', dep: ON_NATURAL, hint: '关（默认）：事件只是把开口提前到发生的那一秒，两条之间仍隔满 minGap。开：事件拍可以越过 minGap，但仍要隔够「事件拍最短间隔」——不会因为下课就紧跟着再说一句' },
  { group: '高级', path: 'rules.naturalTriggers.floorMin', label: '事件拍最短间隔', type: 'int', min: 1, max: 240, unit: '分钟', dep: ON_NATURAL, hint: '只在上面那条开着时生效：事件拍两次开口之间至少隔这么久（默认 20 分钟）。比 minGap 短，但仍是个地板' },
  { group: '高级', path: 'rules.naturalTriggers.courseWindowMin', label: '课上完之后算多久', type: 'int', min: 1, max: 60, unit: '分钟', dep: ON_NATURAL, hint: '这一段的课都上完后的这段时间里都算「课上完了」（默认 20 分钟）。最后一节下课你可能正在收拾东西、在路上，窗口只有 5 分钟会天天错过。同一个时间段一天只算一次' },
  { group: '高级', path: 'rules.naturalTriggers.courseSplitMin', label: '上午和下午的分界', type: 'int', min: 0, max: 1440, unit: '分钟（从 0 点算）', dep: ON_NATURAL, hint: '默认 720 分钟（= 12:00）：开始时间在这之前算上午的课，之后算下午和晚上的课；上午的课上完提一句，剩下的课上完再提一句' },
  { group: '高级', path: 'rules.gapByTier.enabled', label: '间隔按由头分档', type: 'bool', hint: '关（默认）：所有由头共用 minGapMin 一刀切。开：回TA/接转发/追问 5 分钟，事件类（刚回来、深夜、久坐、self.md 新写入）60 分钟，其余闲聊 240 分钟——跨档至少隔回复档那么久' },
  { group: '高级', path: 'rules.gapByTier.replyMin', label: '回复档间隔', type: 'int', min: 1, max: 240, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：回TA、接住TA转来的东西、追问之间至少隔这么久（默认 5 分钟）。它也是所有档的全局地板' },
  { group: '高级', path: 'rules.gapByTier.eventMin', label: '事件档间隔', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：刚回来、深夜、久坐、self.md 新写入这类事件由头之间至少隔这么久（默认 60 分钟）' },
  { group: '高级', path: 'rules.gapByTier.chatMin', label: '闲聊档间隔', type: 'int', min: 1, max: 1440, unit: '分钟', dep: ON_TIER, hint: '只在分档开着时生效：睡眠、压力、步数、屏幕、课表、考试这类闲聊由头之间至少隔这么久（默认 240 分钟）' },
  { group: '高级', path: 'rules.presenceSignal.enabled', label: '人不在只当信号', type: 'bool', dep: ON_JUDGE, hint: '关（默认）：电脑判定TA不在就不主动开口。开：不再拦截，改成写进快照让 judge 自己判断（电脑不在证明不了TA不在手机前）。只在 judge 也开着时生效——没有软决策层就不放开硬闸' },
  { group: '高级', path: 'content.llm.attempts', label: '写歪了重写几次', type: 'int', min: 1, max: 3, unit: '次', dep: ON_CONTENT, hint: '默认 2 次。重写一次大约多花一次生成的时间' },
  { group: '高级', path: 'content.prompt.recentOutbound', label: '让TA看见我最近说过什么', type: 'bool', dep: ON_CONTENT, hint: '开（默认）：写新的一句时，把我最近真发出去的 5 条也摆给模型看，免得连着几天一个开头、一个话题；关：当这些记录不存在，行为和没加这段之前一样' },
  { group: '高级', path: 'content.prompt.slotStats', label: '让TA看见话题接住率', type: 'bool', dep: ON_CONTENT, hint: '开（默认）：告诉模型哪类由头TA接住了、哪类老没人应；关：不摆这些数字，行为和没加这段之前一样' },
  { group: '高级', path: 'sources.phone.staleHours', label: '数据过期多久算停', type: 'int', min: 6, max: 168, unit: '小时', dep: ON_PHONE, hint: '默认 36 小时。鱼鱼那封邮件超过这么多小时没更新，睡眠/压力/步数/屏幕四类由头就停用——拿旧数据问「昨晚睡得好吗」比不说话更伤' },
  { group: '高级', path: 'sources.phone.staleGuard', label: '数据过期就停用', type: 'bool', dep: ON_PHONE, hint: '开（默认）：邮件太旧时上面那四类由头不参与判定，--why 里会写原因；关：不管多旧都照旧用（阈值还留着，想恢复不用重填）' },
  { group: '高级', path: 'sources.memory.plugin', label: '用哪个记忆插件', type: 'select', options: [['fish-memory', '鱼的记忆（dsh-fish-memory）']], dep: ON_MEMORY, hint: '目前只认鱼的记忆。它按会话分开存，一个会话一个文件。用别的记忆插件也能接：跟你的大肥鱼说一声，让它在 src/memorysource.js 里加一条适配就行' },
  { group: '高级', path: 'sources.memory.max', label: '一次带几条', type: 'int', min: 1, max: 8, dep: ON_MEMORY, hint: '默认 3 条。长期画像（喜好、约定）优先，剩下给最近的事；带太多会把这一句挤成汇报' },
  { group: '高级', path: 'sources.memory.session', label: '读哪个会话的记忆', type: 'str', max: 80, dep: ON_MEMORY, hint: '留空 = 最近改过的那一份（一般就是现在这个会话）；填会话 id 前几位锁一份；填 all 把全部会话合并' },
  { group: '高级', path: 'channels.qq.send', label: '往 QQ 发', type: 'bool', dep: ON_QQ, hint: '开（默认）：这一侧才真发。关：判定照走、内容照写，但不往 QQ 发（配合演练模式看它会说什么）' },
  { group: '高级', path: 'channels.douyin.send', label: '往抖音发', type: 'bool', dep: ON_DOUYIN, hint: '默认关。抖音那边目前是另一个值班会话在回，这里开了一般也用不上' },
  { group: '高级', path: 'mail.user', label: '邮箱账号', type: 'str', max: 120, hint: '填完整地址（比如 123456@qq.com）。IMAP 服务器按域名自动猜，QQ/163/126/Gmail/Outlook 都在表里' },
  { group: '高级', path: 'mail.authCode', label: 'IMAP 授权码', type: 'secret', max: 200, hint: '不是登录密码。QQ 邮箱：设置 → 账号 → 开启 IMAP 服务后生成的那串。只存进 credentials.json，界面永远只显示「已设置」' },
  { group: '高级', path: 'mail.host', label: 'IMAP 服务器', type: 'str', max: 120, hint: '留空 = 按邮箱域名自动猜；猜不准才填，比如 imap.exmail.qq.com' },
  { group: '高级', path: 'mail.intervalMinutes', label: '多久读一次邮箱', type: 'int', min: 5, max: 1440, unit: '分钟', hint: '默认 30 分钟。手机 App 大概一小时发一封，读太勤没意义' },
  { group: '高级', path: 'idle.onlineSec', label: '多久没动算在线', type: 'int', min: 5, max: 600, unit: '秒', hint: 'L1：鼠标键盘停了这么多秒之内，都算你还在电脑前。默认 30 秒' },
  { group: '高级', path: 'idle.awaySec', label: '多久没动算离开', type: 'int', min: 60, max: 3600, unit: '秒', hint: 'L1：停超过这么多秒就判「人不在」，这一拍直接跳过不打扰。默认 600 秒' },
  { group: '高级', path: 'perception.l2.enabled', label: '记下TA在做什么', type: 'bool', hint: '把前台窗口折成打游戏/写代码/看视频，只在判到要发的那一拍记一笔，不影响发不发。默认开' },
  { group: '高级', path: 'perception.l3.enabled', label: '看屏幕（OCR）', type: 'bool', hint: '截前台窗口做系统 OCR，约 1 秒。只在判到要发的那一拍才截，只当「当时我在干什么」的记录，不参与发不发。中文认错得厉害，结构化信号能说清时就不用它。默认关' },
  { group: '高级', path: 'perception.l3.everyMin', label: '看屏幕隔多久', type: 'int', min: 5, max: 720, unit: '分钟', dep: ON_L3, hint: '默认 30 分钟。上一次看屏幕不到这么久就跳过，免得同一张桌面反复截' },
  { group: '高级', path: 'perception.signals.enabled', label: '看窗口和网页（不截屏）', type: 'bool', hint: '只读前台窗口标题、进程名和浏览器当前标签页，不截屏、不 OCR、不联网。比 L3 准，默认开' },
  { group: '高级', path: 'perception.signals.browser', label: '读浏览器当前标签页', type: 'bool', dep: ON_SIGNALS, hint: '借桌面 Edge 的调试口（默认 9223）问它在看哪个页面；端口没开就跳过，不影响别的。默认开' },
  { group: '高级', path: 'perception.signals.port', label: '浏览器调试端口', type: 'int', min: 1024, max: 65535, dep: ON_SIGNALS, hint: '默认 9223（start-edge-debug.ps1 开的那个）。改了要对应 Edge 的 --remote-debugging-port' },
  // 由头细节：所属那一类关着就不显示，免得一堆用不上的阈值挡路。
  { group: '高级', path: 'content.topics.sleepShortMin', label: '算「睡少了」低于', type: 'int', min: 240, max: 600, unit: '分钟', dep: onTopic('sleep'), hint: '默认 420 分钟（7 小时）。读得到深睡时要和「深睡少」同时满足才算；深睡没读到就只看这一条' },
  { group: '高级', path: 'content.topics.sleepDeepShortMin', label: '深睡低于', type: 'int', min: 30, max: 240, unit: '分钟', dep: onTopic('sleep'), hint: '默认 120 分钟（2 小时）。深睡是拓展项——应用不报这个数时只按时长判；报的时候要和「睡少了」同时满足才算' },
  { group: '高级', path: 'content.topics.sleepLongMin', label: '算「睡多了」超过', type: 'int', min: 480, max: 900, unit: '分钟', dep: onTopic('sleep'), hint: '默认 570 分钟（9.5 小时）。睡这么多只在真累到时才提' },
  { group: '高级', path: 'content.topics.sleepLateBed', label: '几点之后算熬夜', type: 'hm', dep: onTopic('sleep'), hint: '默认 00:30。有「入睡时间」就直接用；大多数时候没有，拿睡眠反推入睡点（反推不含躺着没睡着那段，所以这条线定在「规定的时间 + 最近平均入睡耗时」）。06:00 后才睡着当数据异常，不算' },
  { group: '高级', path: 'content.topics.stressHighMin', label: '算「压力高」高于', type: 'int', min: 30, max: 100, dep: onTopic('stress'), hint: '默认 59 分（严格大于）。0-100 的量表' },
  { group: '高级', path: 'content.topics.stressDailyMax', label: '压力一天最多提', type: 'int', min: 0, max: 6, unit: '次', dep: onTopic('stress'), hint: '默认 1 次。提第二次要求压力不低于上次' },
  { group: '高级', path: 'content.topics.stepsLowMax', label: '算「没怎么动」低于', type: 'int', min: 0, max: 20000, unit: '步', dep: onTopic('steps'), hint: '默认 2000 步。低于它 → 今天几乎没活动' },
  { group: '高级', path: 'content.topics.stepsHighMin', label: '算「活动量好」高于', type: 'int', min: 0, max: 50000, unit: '步', dep: onTopic('steps'), hint: '默认 8000 步。高于它 → 今天活动量不错。两个值之间不发' },
  { group: '高级', path: 'content.topics.stepsFromHour', label: '步数从几点开始看', type: 'int', min: 0, max: 23, unit: '点', dep: onTopic('steps'), hint: '默认 18 点。白天的步数还没走完，说得太早容易翻车' },
  { group: '高级', path: 'content.topics.screenHeavyMin', label: '算「坐太久」超过', type: 'int', min: 60, max: 900, unit: '分钟', dep: onTopic('screen'), hint: '默认 480 分钟（8 小时）' },
  { group: '高级', path: 'content.topics.catchupDays', label: '算「几天没说话」', type: 'int', min: 1, max: 7, unit: '天', dep: onTopic('catchup'), hint: '默认 2 天' },
  { group: '高级', path: 'content.topics.lateFromHour', label: '深夜从几点算', type: 'int', min: 0, max: 23, unit: '点', dep: onTopic('lateUp'), hint: '默认 23 点是最早的一头' },
  { group: '高级', path: 'content.topics.lateToHour', label: '深夜到几点为止', type: 'int', min: 0, max: 23, unit: '点', dep: onTopic('lateUp'), hint: '默认 2 点。可以跨零点；跟「从几点算」相同则这一类失效' },
  { group: '高级', path: 'content.topics.longSitHours', label: '连续坐多久才算', type: 'int', min: 1, max: 12, unit: '小时', dep: onTopic('longSit'), hint: '默认 3 小时。离开超过「空闲判定」的时长会重新计时' },
  { group: '高级', path: 'content.topics.backAfterMin', label: '离开多久才算「出去过」', type: 'int', min: 5, max: 480, unit: '分钟', dep: onTopic('backHome'), hint: '默认 30 分钟。太短就只是去倒水，不算' },
  { group: '高级', path: 'content.topics.noReplyMin', label: '隔多久没回才问', type: 'int', min: 30, max: 1440, unit: '分钟', dep: onTopic('noReply'), hint: '默认 120 分钟。指距我那条消息（或分享的视频）' },
  { group: '高级', path: 'content.topics.noReplyAfterHerMin', label: 'TA说话后至少隔', type: 'int', min: 0, max: 720, unit: '分钟', dep: onTopic('noReply'), hint: '默认 120 分钟。TA刚说完话就别追着问，这一条和上面的「隔多久」都要满足' },
  { group: '高级', path: 'content.topics.noReplyAfterBusyMin', label: 'TA忙完后等', type: 'int', min: 0, max: 240, unit: '分钟', dep: onTopic('noReply'), hint: '默认 20 分钟。模型判断TA那会儿在忙/睡了：等TA忙完（或忙碌时段结束）之后再等这么久才问' },
  { group: '高级', path: 'content.topics.noReplyJudge', label: '先判断TA是不是去忙了', type: 'bool', dep: onTopic('noReply'), hint: '开：叫一次模型看最近的对话，判「忙/睡了」还是「在回避」。判不准就按「不是忙」处理，不会凭空压着不问' },
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
      // 邮箱当场拦：写成 `3316765302@qq/com`（斜杠）不报错的话，要等下一拍联网
      // 才炸成 `getaddrinfo ENOTFOUND imap.qq/com`，看不出是哪儿写错了。
      if (spec.path === 'mail.user') {
        const v = s.trim();
        if (v && !/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(v)) {
          return bad('要写成 name@qq.com 这样（@ 后面是域名，别把点打成斜杠）');
        }
        return { ok: true, path: spec.path, value: v };
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
      const s = String(raw);
      if (!(spec.options || []).some(([k]) => k === s)) return bad(`只能是 ${(spec.options || []).map(([k]) => k).join(' / ')}`);
      return { ok: true, path: spec.path, value: s };
    }
    case 'hm': {
      const v = normalizeHm(raw);
      if (!v) return bad('要写成 00:30 这种');
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

/**
 * 设置页要的一份清单：分组 → 项 → 当前值。
 * 只暴露白名单里的路径；其余（CLI 路径、通道 id…）**不出现在界面上**。
 * 凭据类（type=secret）例外：出现，但 value 恒为空串、只给一句 display。
 */
export function listForUi(cfg) {
  const groups = [];
  const detCache = { value: null };
  for (const name of GROUP_ORDER) {
    const items = SCHEMA.filter((s) => s.group === name && !s.hidden && depVisible(cfg, s.dep)).map((s) => {
      const secret = s.type === 'secret';
      const value = secret ? '' : getPath(cfg, s.path, undefined);
      // scale 把存储单位换成界面单位（毫秒 → 秒），读出来和显示都要换。
      const shown = value == null || !s.scale ? value : Math.round(Number(value) / s.scale);
      let hint = s.path.startsWith('sources.') ? `${s.hint || ''}${detectHint(s.path, cfg, detCache)}` : s.hint;
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
      return {
        path: s.path,
        label: s.label,
        type: s.type,
        ...(s.min !== undefined ? { min: s.min } : {}),
        ...(s.max !== undefined ? { max: s.max } : {}),
        ...(s.unit ? { unit: s.unit } : {}),
        ...(s.options ? { options: s.options } : {}),
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
    if (items.length) {
      const group = { name, items };
      if (GROUP_NOTES[name]) group.note = GROUP_NOTES[name];
      if (FOLDABLE_GROUPS.has(name)) {
        group.foldable = true;
        group.summary = name === '高级' ? `${items.length} 项 · 平时不用动` : groupSummary(cfg);
      }
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
  return getPath(cfg, d.path, d.default) === d.on;
}

/** 折起来的标题旁边那一句：课表几节、考试几场。读不出来也只说没填，不报错。 */
function groupSummary(cfg) {
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
