// sources.test.mjs —— 三条链路的总闸在「通道层 / 由头层」到底有没有真的生效。
// 只验开关语义，不联网、不扫真机（detect 结果用手写的桩传进去）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { readChannels } from '../src/channels/index.js';
import { pickTopic } from '../src/decision/topics.js';

const TZ = 'Asia/Shanghai';
const at = (h, m = 0) => Date.UTC(2026, 10, 4, h - 8, m);
const MIN = 60_000;

const cfgOf = (o = {}) => ({
  timezone: TZ,
  quietHours: [],
  sources: o.sources || {},
  channels: {
    qq: { enabled: true, read: true, send: true, peerId: '1', activeHours: [] },
    main: { enabled: false, read: true, send: false, activeHours: [] },
    douyin: { enabled: false, read: true, send: false, activeHours: [] },
  },
  rules: { douyinStaleMin: 10 },
  content: { tools: {}, topics: {} },
});

const detOk = { qq: { installed: true, paired: true, ready: true, note: '已装、已配对' }, douyin: { installed: true, listening: true, ready: true, note: 'ok' } };

test('QQ 总闸关着：通道层直接 off，理由 SOURCE_OFF（不读任何文件）', () => {
  const ch = readChannels(cfgOf({ sources: { qq: { enabled: false } } }), at(15), { quiet: false, detect: detOk });
  const qq = ch.list.find((c) => c.channel === 'qq');
  assert.equal(qq.state, 'off');
  assert.equal(qq.reason, 'SOURCE_OFF');
});

test('QQ 插件没装：不再是「读到了」，理由 QQ_PLUGIN_MISSING', () => {
  const det = { ...detOk, qq: { installed: false, paired: false, ready: false, note: '没装 dsh-plugin-qq-bridge' } };
  const ch = readChannels(cfgOf(), at(15), { quiet: false, detect: det });
  const qq = ch.list.find((c) => c.channel === 'qq');
  assert.equal(qq.ok, false);
  assert.equal(qq.reason, 'QQ_PLUGIN_MISSING');
  assert.match(qq.note, /没装/);
});

test('QQ 插件装了但没配对：理由 QQ_PLUGIN_UNPAIRED', () => {
  const det = { ...detOk, qq: { installed: true, paired: false, ready: false, note: '插件在，但还没配对' } };
  const ch = readChannels(cfgOf(), at(15), { quiet: false, detect: det });
  assert.equal(ch.list.find((c) => c.channel === 'qq').reason, 'QQ_PLUGIN_UNPAIRED');
});

test('抖音总闸关着：通道层 off', () => {
  const cfg = cfgOf({ sources: { douyin: { enabled: false } } });
  cfg.channels.douyin.enabled = true;
  const ch = readChannels(cfg, at(15), { quiet: false, detect: detOk });
  const d = ch.list.find((c) => c.channel === 'douyin');
  assert.equal(d.state, 'off');
  assert.equal(d.reason, 'SOURCE_OFF');
});

test('手机端总闸关着：睡眠/压力/屏幕三类由头全部不参与判定', () => {
  const now = at(15);
  const fish = { ok: true, sleepMin: 300, deepMin: 60, stress: 90, screenMin: 700, fetchedAt: now - 3 * 60 * MIN };
  const ctx = {
    tz: TZ,
    her: { lastTs: null, lastText: '' },
    me: { lastTs: null, lastText: '' },
    fish,
    recent: [],
  };
  const on = cfgOf({ sources: { phone: { enabled: true } } });
  on.content.topics = { reply: false, forward: false, share: false, catchup: false, sleepFromHour: 0, sleepToHour: 23, screenFromHour: 0 };
  const picked = pickTopic({ ...ctx, clockMin: 15 * 60 }, on, now, { fishDayTs: now, todayKey: '2026-11-04' });
  assert.ok(picked, '开着的时候应该能由睡眠/压力/屏幕起一个由头');
  assert.ok(['sleep', 'stress', 'screen'].includes(picked.slot), `实际 ${picked?.slot}`);

  const off = cfgOf({ sources: { phone: { enabled: false } } });
  off.content.topics = on.content.topics;
  const none = pickTopic({ ...ctx, clockMin: 15 * 60 }, off, now, { fishDayTs: now, todayKey: '2026-11-04' });
  assert.equal(none, null, '手机端关掉后这三类一个都不该冒出来');
});

test('手机端默认（没写 sources）算开着——老配置升级不会突然哑掉', () => {
  const cfg = cfgOf({});
  delete cfg.sources;
  const now = at(15);
  const fish = { ok: true, sleepMin: 300, deepMin: 60, fetchedAt: now - 3 * 60 * MIN };
  cfg.content.topics = { reply: false, forward: false, share: false, catchup: false, sleepFromHour: 0, sleepToHour: 23 };
  const t = pickTopic({ tz: TZ, her: {}, me: {}, fish, recent: [] }, cfg, now, { fishDayTs: now, todayKey: '2026-11-04' });
  assert.equal(t?.slot, 'sleep');
});