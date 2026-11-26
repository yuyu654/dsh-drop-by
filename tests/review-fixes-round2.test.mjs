import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-r2-fixes-'));
process.env.PG_CONFIG_PATH = path.join(dir, 'config.json');
process.env.PG_CHAT_DATA_DIR = path.join(dir, 'chat');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { loadConfig, saveConfig } = await import('../src/settings/config.js');
const {
  handleAgreementChatCommand,
  handleAgreementChatCommandWithLlm,
  listAgreements,
  observeAgreement,
} = await import('../src/chat/agreements.js');
const {
  evaluateBrushoffTurn,
  evaluateBrushoffTurnWithLlm,
  isBusyExcuse,
} = await import('../src/chat/brushoff-mood.js');
const { buildReplyContext } = await import('../src/chat/qq-reply.js');
const {
  disposeFullscreenGuard,
  fullscreenGuardStatus,
  isFullscreenBlocked,
  resetFullscreenGuardForTest,
} = await import('../src/perception/fullscreen-guard.js');

function makeCfg() {
  const base = loadConfig();
  const next = {
    ...base,
    enabled: true,
    dryRun: false,
    quietHours: [],
    busyHours: [],
    timezone: 'Asia/Shanghai',
    channels: { ...base.channels, primary: 'qq', qq: { ...base.channels.qq, enabled: true, read: true, send: true, peerId: '728361417' } },
    agreements: { ...base.agreements, enabled: true },
    rules: {
      ...base.rules,
      brushoffMood: { enabled: true, decayHours: 6, angryDelayMinSec: 25, angryDelayMaxSec: 50 },
    },
    content: { ...base.content, agenda: { ...base.content.agenda, text: '' } },
  };
  saveConfig(next);
  return loadConfig();
}

test('P1-1: 假设句「如果取消所有提醒会怎么样」不清空待办（本地规则与轻量模型均拦截）', async () => {
  const cfg = makeCfg();
  const t0 = Date.UTC(2026, 10, 26, 6, 0, 0);
  await observeAgreement({
    cfg, peer: '728361417', channel: 'qq', at: t0, now: t0,
    text: '十分钟后提醒我喝水',
    generate: async () => ({ ok: true, text: JSON.stringify({ items: [{ index: 0, anchor: '十分钟后', title: '喝水', quote: '十分钟后提醒我喝水' }] }) }),
  });
  assert.equal(listAgreements(cfg, t0).length, 1);

  assert.equal(handleAgreementChatCommand({
    text: '如果取消所有提醒会怎么样', peer: '728361417', channel: 'qq', cfg, now: t0 + 1000,
  }), '');
  assert.equal(listAgreements(cfg, t0 + 1000).length, 1);

  const llmRes = await handleAgreementChatCommandWithLlm({
    text: '如果取消所有提醒会怎么样', peer: '728361417', channel: 'qq', cfg, now: t0 + 2000,
    generate: async () => ({ ok: true, text: '{"action":"none"}' }),
  });
  assert.equal(llmRes, '');
  assert.equal(listAgreements(cfg, t0 + 2000).length, 1);
});

test('P1-2: 确认「已全部取消」后，在途异步抽取的旧提醒不会再写回待办', async () => {
  const cfg = makeCfg();
  const t0 = Date.UTC(2026, 10, 26, 6, 10, 0);
  let resolveExtract;
  const inflight = observeAgreement({
    cfg, peer: '728361417', channel: 'qq', at: t0, now: t0,
    text: '十分钟后提醒我带钥匙',
    generate: () => new Promise((resolve) => { resolveExtract = resolve; }),
  });

  // 抽取尚未完成时，用户执行「取消所有提醒」
  const cleared = handleAgreementChatCommand({
    text: '取消所有提醒', peer: '728361417', channel: 'qq', cfg, now: t0 + 5000,
  });
  assert.match(cleared, /已全部取消|没有待办/);

  // 旧抽取随后完成：不得把「带钥匙」写回
  resolveExtract({ ok: true, text: JSON.stringify({ items: [{ index: 0, anchor: '十分钟后', title: '带钥匙', quote: '十分钟后提醒我带钥匙' }] }) });
  await inflight;
  assert.equal(listAgreements(cfg, t0 + 6000).length, 0);
});

test('P1-3: 同时存在「喝水」和「喝水打卡」时，指明「取消喝水打卡的提醒」精准删掉后者', async () => {
  const cfg = makeCfg();
  const t0 = Date.UTC(2026, 10, 26, 6, 20, 0);
  await observeAgreement({
    cfg, peer: '728361417', channel: 'qq', at: t0, now: t0,
    text: '五分钟后提醒我喝水',
    generate: async () => ({ ok: true, text: JSON.stringify({ items: [{ index: 0, anchor: '五分钟后', title: '喝水', quote: '五分钟后提醒我喝水' }] }) }),
  });
  await observeAgreement({
    cfg, peer: '728361417', channel: 'qq', at: t0 + 1000, now: t0 + 1000,
    text: '十分钟后提醒我喝水打卡',
    generate: async () => ({ ok: true, text: JSON.stringify({ items: [{ index: 0, anchor: '十分钟后', title: '喝水打卡', quote: '十分钟后提醒我喝水打卡' }] }) }),
  });
  assert.deepEqual(listAgreements(cfg, t0 + 2000).map((x) => x.title), ['喝水', '喝水打卡']);

  const res = handleAgreementChatCommand({
    text: '取消喝水打卡的提醒', peer: '728361417', channel: 'qq', cfg, now: t0 + 3000,
  });
  assert.match(res, /喝水打卡/);
  assert.deepEqual(listAgreements(cfg, t0 + 4000).map((x) => x.title), ['喝水']);
});

test('P2-4: 连发合并（提醒 + 谢谢）时仍保留「约定小本本已接管」提示', async () => {
  const cfg = makeCfg();
  const t0 = Date.UTC(2026, 10, 26, 6, 30, 0);
  await observeAgreement({
    cfg, peer: '728361417', channel: 'qq', at: t0, now: t0,
    text: '十分钟后提醒我喝水',
    generate: async () => ({ ok: true, text: JSON.stringify({ items: [{ index: 0, anchor: '十分钟后', title: '喝水', quote: '十分钟后提醒我喝水' }] }) }),
  });
  const ctx = {};
  const replyCtx = await buildReplyContext(ctx, {
    peer: '728361417',
    kind: 'private',
    text: '十分钟后提醒我喝水\n谢谢',
    bridgeText: '谢谢',
    at: t0 + 2000,
    cfg,
    messageTimes: [t0, t0 + 2000],
    burstMessages: [
      { text: '十分钟后提醒我喝水', at: t0 },
      { text: '谢谢', at: t0 + 2000 },
    ],
    observed: true,
    skipAngryDelay: true,
  });
  assert.match(replyCtx, /约定小本本已接管/);
});

test('P2-5: 全屏检测编译期间停用插件，不会在编译完成后启动助手进程', async () => {
  if (process.platform !== 'win32') return;
  const prevDir = process.env.PG_QUNS_CACHE_DIR;
  const isolated = path.join(os.tmpdir(), `dsh-quns-race-${process.pid}-${Date.now()}`);
  fs.mkdirSync(isolated, { recursive: true });
  fs.writeFileSync(path.join(isolated, 'keep.txt'), 'keep');
  process.env.PG_QUNS_CACHE_DIR = isolated;
  resetFullscreenGuardForTest();
  try {
    const cfg = { perception: { anticheat: { skip: true, skipFullscreen: true, fullscreenCooldownMin: 10 } } };
    const pending = isFullscreenBlocked(cfg);
    // 立刻在编译完成前停用
    disposeFullscreenGuard();
    await pending;
    const st = fullscreenGuardStatus(cfg);
    assert.equal(st.ready, false);
    assert.equal(fs.existsSync(path.join(isolated, 'keep.txt')), true);
  } finally {
    resetFullscreenGuardForTest();
    if (prevDir === undefined) delete process.env.PG_QUNS_CACHE_DIR;
    else process.env.PG_QUNS_CACHE_DIR = prevDir;
    try { fs.rmSync(isolated, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

test('P2-6 & P2-7: A -> B -> 重试 A 不重复计成 3 次；「我刚才没在上课，也没在开会」不误消气', async () => {
  const cfg = makeCfg();
  const peer = 'peer-r2';
  const t0 = Date.UTC(2026, 10, 26, 7, 0, 0);

  assert.equal(isBusyExcuse('我刚才没在上课，也没在开会'), false);
  assert.equal(isBusyExcuse('我刚才在上课，没来得及看'), true);

  // A -> B -> 重试 A：只能算 2 次，不能进生气
  evaluateBrushoffTurn({ cfg, peer, prevMeText: '今天看到一部挺有意思的漫画想跟你聊聊。', userText: '哦', at: t0 + 1000, now: t0 + 1000 });
  evaluateBrushoffTurn({ cfg, peer, prevMeText: '刚才又去翻了第二话，讲主角怎么回绝别人。', userText: '嗯', at: t0 + 2000, now: t0 + 2000 });
  const retryA = evaluateBrushoffTurn({ cfg, peer, prevMeText: '今天看到一部挺有意思的漫画想跟你聊聊。', userText: '哦', at: t0 + 1000, now: t0 + 3000 });
  assert.equal(retryA.count, 2);
  assert.equal(retryA.level, 'sulking');

  // 第 3 条不同消息才真正进入生气
  const c = evaluateBrushoffTurn({ cfg, peer, prevMeText: '外面降温了，下午打算煮点热汤喝。', userText: '行吧', at: t0 + 4000, now: t0 + 4000 });
  assert.equal(c.level, 'angry');

  // 明确说没在上课也没在开会（本地与轻量模型均不消气）
  const deniedLocal = evaluateBrushoffTurn({ cfg, peer, prevMeText: '哼', userText: '我刚才没在上课，也没在开会', at: t0 + 5000, now: t0 + 5000 });
  assert.equal(deniedLocal.level, 'angry');
  assert.equal(deniedLocal.recovered, null);

  const deniedLlm = await evaluateBrushoffTurnWithLlm({
    cfg, peer, prevMeText: '哼', userText: '我刚才没在上课，也没在开会', at: t0 + 6000, now: t0 + 6000,
    generate: async () => ({ ok: true, text: '{"kind":"other"}' }),
  });
  assert.equal(deniedLlm.level, 'angry');
  assert.equal(deniedLlm.recovered, null);
});
