// tests/fixtures.mjs —— 造一封和鱼鱼状态 App 发出来一模一样的邮件。
// 头部按 App 的 SMTP 写法（RFC 2047 主题 + base64 正文），用来验证解析链路。
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap = (s, n = 76) => s.replace(/(.{1,76})/g, '$1\r\n');

export const SUMMARY = [
  '睡眠：深睡 1小时05分 浅睡 3小时20分 快速眼动 45分',
  '总时长：5小时12分',
  '屏幕时间：4小时38分（微信 48分，Bilibili 1小时02分）',
].join('\n');

export const RAW_TAIL = [
  '',
  '---- 本次的原始页面文字（排查用）----',
  '睡眠 比例',
  '2 小时 34 分钟',
  '3 小时 20 分钟',
  '45 分钟',
  '',
  '---- 睡眠详情页原始文字 ----',
  '夜间睡眠 5 小时 12 分钟',
].join('\n');

export function buildFishMail({
  subject = 'FISH 11-03 22:04',
  body = SUMMARY + RAW_TAIL,
  from = '123456@qq.com',
  date = 'Tue, 03 Nov 2026 22:04:31 +0800',
} = {}) {
  const head = [
    `From: Fish Condition <${from}>`,
    `To: <${from}>`,
    `Subject: =?UTF-8?B?${b64(subject)}?=`,
    `Date: ${date}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    '',
  ].join('\r\n');
  return Buffer.from(head + wrap(b64(body)), 'utf8');
}

/** 造一封和鱼鱼状态无关的邮件，用来验证主题过滤。 */
export function buildOtherMail({ subject = 'Re: 周报', body = '这周没什么事。' } = {}) {
  const head = [
    'From: someone@example.com',
    'Subject: ' + subject,
    'Date: Tue, 03 Nov 2026 21:00:00 +0800',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    '',
  ].join('\r\n');
  return Buffer.from(head + body, 'utf8');
}
