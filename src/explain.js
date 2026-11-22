// Pure presentation of decisions and diagnostic codes.
import { normalizeWindows, inWindows } from './schedule.js';
import { SLOTS } from './topics.js';
import { REASONS } from './decide.js';

const DAILY = '陪伴 → 日常';
const PACE = '陪伴 → 决定TA粘不粘人';
const TIMING = '陪伴 → 时间间隔';
const ADVANCED = '陪伴 → 高级';
const CONTENT = '陪伴 → 说什么';
const CHANNEL = '陪伴 → 主聊天接口与通道开关';
const CHECK = '陪伴 → 快速引导与自检';
export const PHONE_FIX_HINT = '检查手机端「鱼鱼状态」有没有发信，再到「数据从哪来」和「高级」核对读邮箱开关、账号与 IMAP 授权码。';

export const PHONE_SLOTS = ['sleep', 'stress', 'steps', 'screen'];

const shortLabels = {
  sleep: '睡眠', stress: '压力', steps: '步数', screen: '屏幕时间',
  chitchat: '随口话', reply: '回话', forward: '接转发', fixed: '固定测试句',
  agenda: '课表', characterRest: '角色作息招呼', examSoon: '考前提醒', examReview: '复习提醒',
  lateUp: '深夜提醒', longSit: '久坐提醒', backHome: '刚回来',
  share: '分享', qqContinuation: '热聊补话', catchup: '久未聊天', noReply: '跟进约定', agreement: '约定小本本', projectCheckIn: '问候项目近况',
};

export function topicLabel(slot) {
  return shortLabels[slot] || SLOTS[slot]?.label || '其他话题';
}

export function phonePauseText(info) {
  if (!info?.missing && !info?.stale) return '';
  const problem = info.missing ? '还没收到可用的鱼鱼邮件'
    : `手机数据已 ${Math.round(info.ageHours)} 小时未更新（超过 ${info.limitHours} 小时）`;
  return `${problem}，睡眠、压力、步数、屏幕时间 4 类话题已暂停。`;
}

const misses = {
  disabled: ['已关闭', CONTENT],
  fish_stale: ['手机数据过期', PHONE_FIX_HINT],
  fish_missing: ['还没收到鱼鱼邮件', PHONE_FIX_HINT],
  phone_disabled: ['手机端数据已关闭', '陪伴 → 数据从哪来 → 手机数据'],
  out_of_window: ['还没到适用时段', TIMING],
  cooldown: ['还在冷却中', TIMING],
  already_used: ['这次已经提过了', '等下一次有新情况时再试。'],
  preference_muted: ['按用户偏好暂停主动提起', '在当前私聊中声明恢复正常即可恢复默认。'],
  no_data: ['暂时没有可用的资料', CONTENT],
  condition_not_met: ['当前情况没达到提醒条件', CONTENT],
  reply_pending: ['优先等这轮聊天结束', '等这轮聊天结束后再试。'],
  feedback_cooldown: ['最近接住得少，暂时少提这类话题', PACE],
  repeated: ['最近提过类似话题，先缓一缓', '等有新的由头时再试。'],
  no_agreement: ['聊天里没有明确的跟进约定', '有约定时才会跟进。'],
  followup_unconfirmed: ['暂时无法确认是否约好了跟进', CONTENT],
  forward_unavailable: ['暂时读不到转发内容', CONTENT],
  chitchat_budget: ['随口话已到今天的生效上限', `${PACE} → 随口话一天最多几条`],
  chitchat_window: ['现在不在随口话时段', `${ADVANCED} → 随口话的「最早几点」「最晚几点」`],
  chitchat_cooldown: ['随口话最近多次没被接住，先停一会儿', TIMING],
  chitchat_no_judge: ['随口话需要开启模型判断', PACE],
  chitchat_judge_no: ['模型判断这次适合保持安静', PACE],
  chitchat_reply_pending: ['随口话让这轮聊天先结束', '等这轮聊天结束后再试。'],
};

export function isSpecificTopicMiss(reason) {
  return typeof reason === 'string' && reason.length > 0 &&
    !['no_data', 'disabled', 'phone_disabled'].includes(reason);
}

export function topicMissText(reason) {
  return misses[reason]?.[0] || '这次没有满足开口条件';
}

const reasons = {
  SEND: ['这一拍可以开口。', ''],
  PLUGIN_DISABLED: ['陪伴的总开关关着。', `${DAILY} → 总开关`],
  DATA_UNAVAILABLE: ['这一拍没读到可用的聊天数据。', `${CHECK} → 连通测试`],
  CHARACTER_ASLEEP: ['角色现在在休息，这一拍暂停主动开口。', '陪伴 → 角色作息'],
  USER_WINDING_DOWN: ['对方刚才在收尾或要去忙，先留出安静时间。', `${TIMING} → 对方收尾后暂停主动多久`],
  GLOBAL_QUIET: ['现在是全局静默时段，这一拍跳过。', `${DAILY} → 全局静默`],
  QUIET_HOURS: ['现在是全局静默时段，这一拍跳过。', `${DAILY} → 全局静默`],
  BUSY_HOURS: ['现在是忙碌时段，先等你有空。', `${DAILY} → 忙碌时段`],
  PROACTIVE_OFF: ['主动找你的开关关着。', '陪伴 → 节奏 → 我会主动找你'],
  AWAY: ['设置要求你在电脑前才主动开口。当前检测到离开或锁屏。', PACE],
  REPLY_WAIT: ['你刚发完消息，等一会儿再回。', '陪伴 → 节奏 → TA说完话先等几分钟'],
  REPLY_ALREADY_ANSWERED: ['那条消息已经回复过了。', ''],
  REPLY_IN_FLIGHT: ['主通道正在回复你刚才那条消息。', ''],
  REPLY_ON_OTHER_CHANNEL: ['消息来自另一个通道，当前主通道不会接过去回复。', CHANNEL],
  GAP_TOO_SHORT: ['离上一条消息还没隔够时间。', `${PACE} → 两条之间至少隔，或查看分档间隔。`],
  CHANNEL_SWITCH_PENDING: ['主聊天通道还在等待完成切换。', `${CHANNEL} → 确认绑定，按页面提示重启 DSH。`],
  DAILY_CAP: ['今天的主动消息次数已到上限。', `${PACE} → 每天最多几条`],
  FOLLOWUP_CONTEXT_CHANGED: ['写草稿时收到新消息，之前的跟进已过时。', ''],
  JUDGE_NO_SEND: ['有可以聊的由头，模型判断现在适合保持安静。', `${PACE} → 让模型自己决定说不说`],
  JUDGE_INVALID_CANDIDATE: ['模型这次没选中可用的由头。', `${CHECK} → 检查宿主模型，或再试一次。`],
  NO_TOPIC: ['这一拍没有找到合适的由头。', CONTENT],
  PROJECT_HELP_WITHOUT_REQUEST: ['近期没有看到你提出需要排查的请求或补充进展。', '有新进展时，可以在聊天里说一声。'],
  PROJECT_QUESTION_OUTSIDE_SLOT: ['项目近况只通过一次性问候发起。', PACE],
  CHITCHAT_NO_JUDGE: ['随口话需要开启模型判断。', PACE],
  CHITCHAT_LOW_PRIORITY: ['这一拍有更具体的话题，随口话先让位。', ''],
  CHITCHAT_JUDGE_NO: ['模型读完这一拍的情况，决定先安静。', `${PACE} → 让模型自己决定说不说`],
  NO_CHITCHAT_BUDGET: ['今天的随口话已到生效上限。', `${PACE} → 随口话一天最多几条`],
  NO_CHITCHAT_WINDOW: ['现在不在随口话的时段。', misses.chitchat_window[1]],
  CHITCHAT_REPLY_PENDING: ['你刚说完，随口话先等这轮聊天结束。', TIMING],
  NO_CHITCHAT_COOLDOWN: ['随口话最近多次没被接住，暂时停一会儿。', TIMING],
  CHITCHAT_NO_MODEL: ['随口话需要模型，这次模型没有就绪。', `${CHECK} → 连通测试`],
  CHITCHAT_GUARD_REJECTED: ['随口话草稿没通过字数、口吻或重复检查。', PACE],
  CHITCHAT_NO_OUTPUT: ['模型这次没写出可用的随口话。', `${CHECK} → 连通测试`],
  LLM_NOT_READY: ['这一拍没有可用的模型来写草稿。', `${CHECK} → 连通测试`],
  LLM_NO_OUTPUT: ['模型这次没有写出可用的草稿。', `${CHECK} → 连通测试`],
  JUDGE_EMPTY_DRAFT: ['模型选中了话题，但没有写出草稿。', `${CHECK} → 连通测试`],
  PROJECT_NO_NATURAL_QUESTION: ['这一拍没有写出合适的项目问候。', CONTENT],
  NO_CONTENT: ['这一拍没有写出可以发送的内容。', `${CONTENT} → 怎么写`],
  TEMPLATE_CANT_WRITE: ['现有模板写不出这类话。', `${CONTENT} → 怎么写 → 自动或只用模型`],
  GUARD_REJECTED: ['这句草稿没通过内容检查。', CONTENT],
  TOPIC_PREFERENCE_MUTED: ['这个话题已按你的偏好暂停。', '在当前私聊中声明恢复正常即可恢复默认。'],
  CONTENT_DISABLED: ['写消息的开关关着。', `${CONTENT} → 允许生成内容`],
  SEND_DISABLED: ['准备发出时，发送模式已经改变。', `${DAILY} → 允许真的发送`],
  SEND_FAILED: ['尝试发送失败。这一次没有占用发送额度。', `${CHECK} → 检查主通道`],
};

function explainMisses(topicMisses, phone) {
  const detail = [phonePauseText(phone)].filter(Boolean);
  let hint = detail.length ? PHONE_FIX_HINT : '';
  const groups = new Map();
  for (const { slot, reason } of topicMisses) {
    if (reason === 'no_data' || (detail.length && (reason === 'fish_stale' || reason === 'fish_missing'))) continue;
    const slots = groups.get(reason) || [];
    slots.push(slot);
    groups.set(reason, slots);
  }
  if (!detail.length && ![...groups.keys()].some(isSpecificTopicMiss)) {
    return { detail: '当前没有待回复消息、待提醒日程或新的可分享进展。', actionHint: '' };
  }
  // 具体原因优先，已关闭的项目放在末尾。
  const ordered = [...groups].sort(([a], [b]) => Number(isSpecificTopicMiss(b)) - Number(isSpecificTopicMiss(a)));
  for (const [reason, slots] of ordered) {
    detail.push(reason.startsWith('chitchat_') ? `${topicMissText(reason)}。` : `${slots.map(topicLabel).join('、')}${topicMissText(reason)}。`);
    if (!hint && reason === 'disabled' && slots.length === 1 && slots[0] === 'chitchat') {
      hint = `${PACE} → 没什么事也可以说一句`;
    }
    hint ||= misses[reason]?.[1] || '';
  }
  return { detail: detail.join(' '), actionHint: hint };
}

export function explainRun({ record = {}, cfg = {}, health = null, preview = false } = {}) {
  const reason = record.reason;
  let [summary, actionHint] = reasons[reason] || [REASONS[reason] || '这一拍停下了。', CHECK];
  let detail = '';
  if (reason === 'GLOBAL_QUIET' || reason === 'QUIET_HOURS') {
    const windows = normalizeWindows(cfg.quietHours).windows;
    const active = Number.isFinite(record.ts) ? windows.filter(w => inWindows(record.ts, [w], cfg.timezone)) : windows;
    if (active.length) summary = `现在在全局静默时段（${active.map(w => w.join('–')).join('、')}），所以跳过。`;
  }
  if (reason === 'GAP_TOO_SHORT' && record.gap?.needMin != null) detail = `这一档需要至少间隔 ${record.gap.needMin} 分钟。`;
  if (reason === 'DAILY_CAP' && cfg.rules?.dailyCap != null) detail = `当前上限是 ${cfg.rules.dailyCap} 条。`;
  if (reason === 'NO_TOPIC') {
    const info = explainMisses(record.topicMisses || [], record.phone || health?.phone);
    detail = info.detail;
    actionHint = info.actionHint || actionHint;
  }
  if (reason === 'CHITCHAT_JUDGE_NO' || reason === 'NO_CHITCHAT_BUDGET') detail = record.chitchat?.why || '';
  if (['DATA_UNAVAILABLE', 'CHITCHAT_NO_MODEL', 'SEND_FAILED', 'LLM_NOT_READY'].includes(reason)) {
    const key = reason === 'CHITCHAT_NO_MODEL' || reason === 'LLM_NOT_READY' ? 'llm' : 'channel';
    const issue = health?.items?.find(item => item.key === key && item.level !== 'ok');
    if (issue) ({ detail, actionHint } = issue);
  }
  if (reason === 'SEND') {
    if (preview) summary = '安全试跑已生成草稿。';
    else if (record.delivery?.ok) summary = '这一拍已发送。';
    else if (record.delivery?.reason === 'DRY_RUN') summary = '演练已写出草稿。';
    else if (record.delivery?.reason === 'SEND_DISABLED') {
      summary = '写出了草稿，正式发送开关关着。';
      actionHint = `${DAILY} → 允许真的发送`;
    }
    if (record.topic?.slot || record.content?.slot) detail = `命中由头：${topicLabel(record.topic?.slot || record.content.slot)}。`;
  }
  return { summary, detail, actionHint };
}
