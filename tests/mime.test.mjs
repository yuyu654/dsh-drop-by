// tests/mime.test.mjs —— 邮件解析：主题 RFC2047、base64 正文、摘要裁剪。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/perception/mime.js';
import { summaryOf } from '../src/perception/fishmail.js';
import { buildFishMail, SUMMARY } from './fixtures.mjs';

/** 按 RFC 2047 / QP 的规则把字节写成 =XX=XX。 */
const qp = (s) =>
  [...Buffer.from(s, 'utf8')].map((b) => '=' + b.toString(16).toUpperCase().padStart(2, '0')).join('');

test('解析鱼鱼状态的 FISH 邮件', () => {
  const m = parseMessage(buildFishMail());
  assert.equal(m.subject, 'FISH 11-03 22:04');
  assert.equal(m.from, 'Fish Condition <123456@qq.com>');
  assert.ok(m.text.includes('总时长：5小时12分'));
  assert.ok(m.dateTs > 0);
});

test('摘要裁掉「原始页面文字」排查段', () => {
  const m = parseMessage(buildFishMail());
  const s = summaryOf(m.text);
  assert.equal(s, SUMMARY);
  assert.ok(!s.includes('排查用'));
  assert.ok(!s.includes('睡眠 比例'));
});

test('非 FISH 邮件也能解析（主题过滤在别处做）', () => {
  const raw = Buffer.from(
    [
      'From: a@b.com',
      'Subject: =?UTF-8?B?' + Buffer.from('中文主题测试').toString('base64') + '?=',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      qp('授权码'),
    ].join('\r\n'),
    'utf8'
  );
  const m = parseMessage(raw);
  assert.equal(m.subject, '中文主题测试');
  assert.equal(m.text, '授权码');
});

test('multipart/alternative 取 text/plain 段', () => {
  const boundary = 'BOUND123';
  const raw = Buffer.from(
    [
      'Subject: multi',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('纯文本段', 'utf8').toString('base64'),
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>html 段</p>',
      `--${boundary}--`,
      '',
    ].join('\r\n'),
    'utf8'
  );
  const m = parseMessage(raw);
  assert.equal(m.subject, 'multi');
  assert.ok(m.text.includes('纯文本段'));
  assert.ok(!m.text.includes('html 段'));
});

test('CRLF/多余空行归一化', () => {
  const raw = Buffer.from('Subject: x\r\n\r\n\r\n第一行\r\n\r\n\r\n\r\n第二行  \r\n', 'utf8');
  const m = parseMessage(raw);
  assert.equal(m.text, '第一行\n\n\n\n第二行');
});
