// tests/imap.test.mjs —— IMAP 客户端：握手、登录、SELECT、带字面量的 FETCH。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImapClient } from '../src/perception/imap.js';
import { startFakeImap } from './fake-imap.mjs';
import { buildFishMail, buildOtherMail } from './fixtures.mjs';

test('登录 → 选箱 → 取最近 2 封（字面量不被截断）', async () => {
  const messages = [
    { uid: 101, raw: buildOtherMail() },
    { uid: 102, raw: buildFishMail({ subject: 'FISH 11-03 20:00' }) },
    { uid: 103, raw: buildFishMail({ subject: 'FISH 11-03 22:04' }) },
  ];
  const fake = await startFakeImap({ messages });
  const client = await ImapClient.connect({ host: '127.0.0.1', port: fake.port, secure: false });

  try {
    await client.login('123456@qq.com', 'authcode');
    const { exists } = await client.select('INBOX');
    assert.equal(exists, 3);

    const got = await client.fetchRecent(2, exists);
    assert.equal(got.length, 2);
    assert.deepEqual(got.map((m) => m.uid), [102, 103]);
    // 原文按字节完整取回（长度一致，且能解出中文）
    assert.equal(got[1].raw.length, messages[2].raw.length);
    assert.ok(got[1].raw.toString('utf8').includes('RklTSC'));
    for (const m of got) assert.ok(m.raw.length > 100);
  } finally {
    await client.logout();
    await fake.close();
  }
});

test('认证失败带出「用授权码」的提示', async () => {
  const fake = await startFakeImap({ messages: [], invalidAuth: true });
  const client = await ImapClient.connect({ host: '127.0.0.1', port: fake.port, secure: false });
  try {
    await assert.rejects(() => client.login('a@qq.com', 'wrong'), (e) => {
      assert.equal(e.name, 'ImapError');
      assert.match(e.message, /授权码/);
      return true;
    });
  } finally {
    client.destroy();
    await fake.close();
  }
});

test('邮箱为空时 fetchRecent 直接返回 []', async () => {
  const fake = await startFakeImap({ messages: [] });
  const client = await ImapClient.connect({ host: '127.0.0.1', port: fake.port, secure: false });
  try {
    await client.login('a@qq.com', 'x');
    await client.select('INBOX');
    assert.deepEqual(await client.fetchRecent(5), []);
  } finally {
    await client.logout();
    await fake.close();
  }
});
