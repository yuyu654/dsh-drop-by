// videosum.test.mjs —— 「她转来的视频真的看一遍」这一步的零件测试。
// 全程注入假依赖：不联网、不开 Edge、不跑 ffmpeg/whisper。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cachePath,
  readCache,
  writeCache,
  summarizeVideo,
  firstLines,
  summaryPrompt,
  videoCfg,
  asrEndpoint,
  ensureAsr,
  stopAsr,
} from '../src/perception/videosum.js';
import { withForwardContent, pickTopic } from '../src/decision/topics.js';
import { buildPrompt } from '../src/decision/compose.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pg-video-'));

test('缓存文件名：只留安全字符，空 id 返回 null', () => {
  assert.equal(cachePath(''), null);
  assert.equal(cachePath('...'), null);
  assert.ok(!cachePath('..\\..\\etc').includes('..'));
  assert.match(cachePath('7703237248204000521'), /7703237248204000521\.json$/);
});

test('缓存：成功条目按 maxAgeDays 过期，失败条目按 failTtlHours 过期', () => {
  const dir = tmp();
  const now = Date.UTC(2026, 10, 5, 5, 0, 0);
  const cfg = { content: { forward: { maxAgeDays: 30, failTtlHours: 6 } } };
  writeCache('7703237248204000521', { ok: true, summary: '讲了什么', at: now }, { dir });
  assert.equal(readCache('7703237248204000521', { cfg, now: now + 29 * 86400_000, dir })?.ok, true);
  assert.equal(readCache('7703237248204000521', { cfg, now: now + 31 * 86400_000, dir }), null);

  writeCache('7703237248204000522', { ok: false, reason: 'FETCH_FAILED', at: now }, { dir });
  assert.equal(readCache('7703237248204000522', { cfg, now: now + 3600_000, dir })?.reason, 'FETCH_FAILED');
  assert.equal(readCache('7703237248204000522', { cfg, now: now + 7 * 3600_000, dir }), null);
});

test('id 不像 aweme_id 就直接拒绝，不下载', async () => {
  const dir = tmp();
  let called = 0;
  const r = await summarizeVideo('abc', {
    cfg: {},
    dir,
    fetchVideo: async () => {
      called++;
      return { ok: true };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'BAD_ID');
  assert.equal(called, 0);
});

test('看成功：下载 → 抽音轨 → 转写 → 摘要，并写缓存；第二次直接读缓存', async () => {
  const dir = tmp();
  const calls = { fetch: 0, extract: 0, asr: 0, llm: 0 };
  const deps = {
    dir,
    fetchVideo: async (id) => {
      calls.fetch++;
      return { ok: true, file: 'D:/fake.mp4', durSec: 205.056, desc: '大肥鱼' };
    },
    extract: async (src, out) => {
      calls.extract++;
      fs.writeFileSync(out, 'RIFF....WAVE');
      return { ok: true, wav: out };
    },
    asr: async () => {
      calls.asr++;
      return { ok: true, text: '小黑你爸回你消息了。冰箱里全是白饭。' };
    },
    // 转写服务的启停这里不碰真机：假装端口本来就在听。
    ensure: async () => ({ ok: true, started: false }),
    stop: async () => {
      throw new Error('本来就在跑的服务不该被关');
    },
    llm: async ({ prompt }) => {
      calls.llm++;
      assert.match(prompt, /小黑你爸/);
      return { ok: true, text: '「大肥鱼」在评论区排队要饭，被人做了屏蔽插件，家里冰箱还是堆满白饭。' };
    },
  };
  const r = await summarizeVideo('7703237248204000521', { cfg: {}, now: 1_000_000, ...deps });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'asr+llm');
  assert.match(r.summary, /屏蔽插件/);
  assert.equal(r.durSec, 205.056);
  assert.deepEqual(calls, { fetch: 1, extract: 1, asr: 1, llm: 1 });

  const again = await summarizeVideo('7703237248204000521', { cfg: {}, now: 1_000_000 + 1000, ...deps });
  assert.equal(again.summary, r.summary);
  assert.deepEqual(calls, { fetch: 1, extract: 1, asr: 1, llm: 1 }, '第二次不该重跑');
});

test('模型不在：退化成转写前几句，source=asr-raw（不编内容）', async () => {
  const dir = tmp();
  const r = await summarizeVideo('7703237248204000523', {
    cfg: {},
    dir,
    fetchVideo: async () => ({ ok: true, file: 'D:/fake.mp4', durSec: 10 }),
    extract: async (src, out) => { fs.writeFileSync(out, 'RIFF....WAVE'); return { ok: true, wav: out }; },
    asr: async () => ({ ok: true, text: '第一句。第二句。第三句。' }),
    ensure: async () => ({ ok: true, started: false }),
    stop: async () => {},
    llm: async () => ({ ok: false, reason: 'LLM_NO_ELECTRON' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'asr-raw');
  assert.match(r.summary, /第一句/);
});

test('下载失败：写失败缓存，reason 透出来，不往下走', async () => {
  const dir = tmp();
  let extracted = 0;
  const r = await summarizeVideo('7703237248204000524', {
    cfg: {},
    dir,
    fetchVideo: async () => ({ ok: false, reason: 'FETCH_FAILED', note: '开不了 tab' }),
    extract: async () => {
      extracted++;
      return { ok: true };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'FETCH_FAILED');
  assert.equal(extracted, 0);
  assert.equal(readCache('7703237248204000524', { cfg: {}, dir })?.reason, 'FETCH_FAILED');
});

test('firstLines / summaryPrompt：只用原文，提示里明确「只有口播」', () => {
  assert.equal(firstLines(''), '');
  const p = summaryPrompt('他说了句话。', '大肥鱼');
  assert.match(p, /口播转写/);
  assert.match(p, /作者写的描述：大肥鱼/);
});

test('withForwardContent：摘要接进由头，brief 从「只有标题」换成「内容是」', () => {
  const topic = {
    slot: 'forward',
    evidence: { herText: '小黑你爸回你消息了', item: '7703237248204000521', hasContent: false },
    brief: '她转来一条内容：「小黑你爸回你消息了」。我手里只有这一行标题，没看过里面的内容。',
  };
  const out = withForwardContent(topic, { ok: true, summary: '讲评论区排队要饭', source: 'asr+llm', durSec: 205 });
  assert.equal(out.evidence.hasContent, true);
  assert.equal(out.evidence.contentSummary, '讲评论区排队要饭');
  assert.match(out.brief, /口播摘要（没有画面）：讲评论区排队要饭/);
  assert.doesNotMatch(out.brief, /只有这一行标题/);
  // 失败时原样返回：不装作看过
  assert.equal(withForwardContent(topic, { ok: false, reason: 'FETCH_FAILED' }), topic);
});

function ctxOf(extra = {}) {
  return {
    tz: 'Asia/Shanghai',
    her: { lastTs: Date.UTC(2026, 10, 5, 4, 0, 0), lastText: '小黑你爸回你消息了 #deepseek', lastAgoSec: 600, count: 1 },
    me: { lastTs: null, lastText: '', lastAgoSec: null, count: 0 },
    recent: [],
    fish: { ok: false },
    ...extra,
  };
}

test('pickTopic：forward 带 item；skipSlots 跳过转发（读不到就不拿这条当由头）', () => {
  const now = Date.UTC(2026, 10, 5, 5, 0, 0);
  const cfg = { timezone: 'Asia/Shanghai', content: { topics: {} } };
  const ctx = ctxOf({ her: { ...ctxOf().her, forwardItem: '7703237248204000521' } });
  const t = pickTopic(ctx, cfg, now, {});
  assert.equal(t.slot, 'forward');
  assert.equal(t.evidence.item, '7703237248204000521');

  const skipped = pickTopic(ctx, cfg, now, { skipSlots: ['forward'] });
  assert.notEqual(skipped?.slot, 'forward');
});

test('compose：看过视频的 prompt 只许用口播、别的规则不许让她复述', () => {
  const cfg = { content: { maxChars: 60 } };
  const topic = {
    slot: 'forward',
    label: '她转来的',
    why: '想接一句',
    evidence: {
      herText: '小黑你爸回你消息了',
      item: '7703237248204000521',
      hasContent: true,
      contentSummary: '评论区排队要饭，有人做了屏蔽插件',
      contentSource: 'asr+llm',
    },
    brief: '她转来一条内容：「小黑你爸回你消息了」。这条我看过了，内容是：评论区排队要饭',
  };
  const p = buildPrompt({ ctx: ctxOf(), topic, persona: { text: '人格' }, cfg, now: Date.now() });
  assert.match(p, /口播转写/);
  assert.match(p, /不许把摘要原样念一遍/);
  assert.match(p, /评论区排队要饭/);
});

test('compose：没看过视频的 prompt 里不再出现「问她哪段」', () => {
  const cfg = { content: { maxChars: 60 } };
  const topic = {
    slot: 'forward',
    label: '她转来的',
    why: '想接一句',
    evidence: { herText: '小黑你爸回你消息了', hasContent: false },
    brief: '只有一行标题',
  };
  const p = buildPrompt({ ctx: ctxOf(), topic, persona: { text: '人格' }, cfg, now: Date.now() });
  assert.doesNotMatch(p, /问她哪段|哪段|讲了什么/);
});

test('videoCfg：env 能顶掉脚本路径与 ASR 地址（测试不碰真机）', () => {
  process.env.PG_VIDEO_FETCH = 'D:/x/fetch.mjs';
  process.env.PG_ASR_URL = 'http://127.0.0.1:9/v1/audio/transcriptions';
  try {
    const o = videoCfg({ content: { forward: { timeoutMs: 60000 } } });
    assert.ok(o.fetchScript.endsWith('fetch.mjs'));
    assert.match(o.asrUrl, /:9\/v1/);
    assert.equal(o.timeoutMs, 60000);
  } finally {
    delete process.env.PG_VIDEO_FETCH;
    delete process.env.PG_ASR_URL;
  }
});

test('转写服务：这次自己拉起的，转完必须关掉', async () => {
  const dir = tmp();
  let stopped = 0;
  const r = await summarizeVideo('7703237248204000525', {
    cfg: {},
    dir,
    fetchVideo: async () => ({ ok: true, file: 'D:/f.mp4' }),
    extract: async (src, out) => { fs.writeFileSync(out, 'RIFF....WAVE'); return { ok: true, wav: out }; },
    ensure: async () => ({ ok: true, started: true }),
    stop: async () => {
      stopped++;
    },
    asr: async () => ({ ok: true, text: '一句话。' }),
  });
  assert.equal(r.ok, true);
  assert.equal(stopped, 1, '自己起的服务要自己关（内存会被吃满）');
});

test('转写服务起不来：不假装看过，写失败缓存并带出原因', async () => {
  const dir = tmp();
  let asrCalled = 0;
  const r = await summarizeVideo('7703237248204000526', {
    cfg: {},
    dir,
    fetchVideo: async () => ({ ok: true, file: 'D:/f.mp4' }),
    extract: async (src, out) => { fs.writeFileSync(out, 'RIFF....WAVE'); return { ok: true, wav: out }; },
    ensure: async () => ({ ok: false, reason: 'ASR_START_TIMEOUT', started: false }),
    asr: async () => {
      asrCalled++;
      return { ok: true, text: '不该走到这' };
    },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ASR_START_TIMEOUT');
  assert.equal(asrCalled, 0);
  assert.equal(readCache('7703237248204000526', { cfg: {}, dir })?.reason, 'ASR_START_TIMEOUT');
});

test('ensureAsr：端口在听就不动；不在且 autostart 关着就报错、不起进程', async () => {
  const cfg = { content: { forward: { asrAutostart: false } } };
  let spawned = 0;
  const tcpYes = async () => true;
  const r1 = await ensureAsr({ cfg, tcp: tcpYes, spawnRun: async () => (spawned++, { ok: true }) });
  assert.equal(r1.ok, true);
  assert.equal(r1.started, false);
  const r2 = await ensureAsr({ cfg, tcp: async () => false, spawnRun: async () => (spawned++, { ok: true }) });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ASR_NOT_RUNNING');
  assert.equal(spawned, 0, '关掉自动拉起就一条进程都不许起');
});

test('ensureAsr：不在就按脚本拉起，等到端口通才算成功（started:true）', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'start-asr.ps1');
  fs.writeFileSync(script, '# mock asr launcher\n', 'utf8');
  let n = 0;
  let ranScript = false;
  const r = await ensureAsr({
    cfg: { content: { forward: { asrScript: script } } },
    tcp: async () => ++n > 2,
    spawnRun: async (cmd, args) => {
      ranScript = cmd === 'powershell' && args.includes('-File') && args.includes(script);
      return { ok: true, stdout: 'asr-server: STARTED 8000' };
    },
    sleep: async () => {},
  });
  assert.equal(r.ok, true);
  assert.equal(r.started, true);
  assert.equal(ranScript, true);
});

test('asrEndpoint：端口从转写地址里取，缺省 8000', () => {
  assert.equal(asrEndpoint({ content: { forward: { asrUrl: 'http://127.0.0.1:8123/v1/audio/transcriptions' } } }).port, 8123);
  process.env.PG_ASR_URL = 'http://127.0.0.1/v1/audio/transcriptions';
  try {
    assert.equal(asrEndpoint({}).port, 80);
  } finally {
    delete process.env.PG_ASR_URL;
  }
});

test('stopAsr：端口上的不是 asr_server 就不杀；是的话按 PID 杀掉', async () => {
  const bad = await stopAsr({
    cfg: {},
    spawnRun: async () => ({ ok: true, stdout: '4242|D:\\node\\node.exe index.mjs' }),
  });
  assert.equal(bad.stopped, false);
  assert.equal(bad.reason, 'NOT_OURS');

  let killed = null;
  const good = await stopAsr({
    cfg: {},
    spawnRun: async (cmd, args) => {
      if (cmd === 'taskkill') {
        killed = args.join(' ');
        return { ok: true };
      }
      return { ok: true, stdout: '777|D:\\tools\\cv3-venv\\Scripts\\python.exe D:\\dsh-work\\voice\\asr_server.py --port 8000' };
    },
  });
  assert.equal(good.stopped, true);
  assert.equal(good.pid, 777);
  assert.equal(killed, '/PID 777 /F');
});
test('visual forwarding upgrades an audio-only cache and handles videos without speech', async (t) => {
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = '7703237248204000529';
  const now = 1_000_000;
  writeCache(id, { ok: true, source: 'asr+llm', summary: '旧口播摘要', at: now }, { dir });
  let seen = 0;
  const options = {
    cfg: {}, dir, now,
    fetchVideo: async () => ({ ok: true, file: 'D:/fake.mp4', durSec: 12, desc: '文案' }),
    extract: async (_src, wav) => { fs.writeFileSync(wav, 'RIFF'); return { ok: true }; },
    asr: async () => ({ ok: false, reason: 'ASR_EMPTY' }),
    ensure: async () => ({ ok: true, started: false }),
    vision: async ({ file, durSec, transcript }) => {
      seen++;
      assert.equal(file, 'D:/fake.mp4');
      assert.equal(durSec, 12);
      assert.equal(transcript, '');
      return { ok: true, text: '最后一幕，猫从纸箱里探出头。' };
    },
  };

  const r = await summarizeVideo(id, options);
  assert.equal(r.source, 'vision');
  assert.match(r.summary, /纸箱/);
  assert.equal((await summarizeVideo(id, options)).source, 'vision');
  assert.equal(seen, 1);
  const topic = withForwardContent({ slot: 'forward', evidence: {} }, r);
  const prompt = buildPrompt({ ctx: ctxOf(), topic, cfg: { content: {} }, now });
  assert.match(prompt, /抽帧/);
  assert.doesNotMatch(prompt, /没有画面/);
});

test('QQ video replies use the current link rather than an older Douyin card', () => {
  const now = Date.UTC(2026, 10, 5, 5);
  const cfg = { timezone: 'Asia/Shanghai', content: { topics: {} } };
  const her = { ...ctxOf().her, lastChannel: 'qq', forwardItem: '7703237248204000521' };
  const ctx = ctxOf({ her: { ...her, lastText: '看这个 https://www.douyin.com/video/7703237248204000530?share=1' } });
  assert.equal(pickTopic(ctx, cfg, now, {}).evidence.item, '7703237248204000530');
  ctx.her.lastText = '看这个 https://example.com/video/123456';
  assert.equal(pickTopic(ctx, cfg, now, {}).evidence.item, null);
});

test('the downloader uses the Node runner supplied by the desktop plugin', async (t) => {
  const { downloadVideo } = await import('../src/perception/videosum.js');
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fetchScript = path.join(dir, 'fetch.mjs');
  fs.writeFileSync(fetchScript, 'console.log(JSON.stringify({ ok: true, file: process.argv[1] }))');
  const options = { cfg: { content: { forward: { fetchScript } } }, ensure: async () => ({ ok: true }) };
  const missing = await downloadVideo('7700000000000000001', { ...options, node: path.join(dir, 'missing-node.exe') });
  assert.equal(missing.ok, false);
  assert.equal((await downloadVideo('7700000000000000001', { ...options, node: process.execPath })).ok, true);
});

test('host observation calls the registered storyboard tool with the downloaded MP4', async () => {
  const { observeDownloadedVideo } = await import('../src/perception/videosum.js');
  const image = { attachmentId: 'storyboard-sheet' };
  const calls = [];
  const ctx = { get: (key) => key === 'tools' ? {
    get: (name) => ({
      execute: async (args) => {
        calls.push({ name, args });
        return { images: [image], text: 'cell 6 @ 00:09' };
      },
    }),
  } : null };
  const out = await observeDownloadedVideo({ file: 'D:/cached/share.mp4', transcript: '口播' }, {
    ctx,
    observe: async ({ prompt, images }) => {
      assert.match(prompt, /cell 6 @ 00:09/);
      assert.match(prompt, /口播/);
      assert.deepEqual(images, [image]);
      return { ok: true, text: '看到了最后一幕。' };
    },
  });
  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'video_storyboard');
  assert.equal(calls[0].args.input, 'D:/cached/share.mp4');
  assert.equal(calls[0].args.transcript, 'off');
  const missing = await observeDownloadedVideo({ file: 'D:/cached/share.mp4' }, { ctx: {} });
  assert.equal(missing.reason, 'VIDEO_STORYBOARD_REQUIRED');
});
