// videosum.js —— 「她转来的那条视频到底讲了什么」。
//
// 为什么需要这一步：抖音私信卡片在记忆里只有一行文字（标题 + 话题标签），
// 只拿这行标题去当由头，模型只能从标题里挑一句硬接，于是说出「你爸回你消息了」
// 这种没头没尾的话。所以要先真的看一遍，再决定说什么。
//
// 链路（全部本地，不新增依赖）：
//   1) 用桌面上已登录的 Edge（CDP 9223）拿到真实播放地址并下载 mp4
//      —— 取数脚本单独配（content.forward.fetchScript），插件不假设它装在哪；
//   2) ffmpeg 抽 16k 单声道音轨；
//   3) 本机 whisper 服务（~/.dsh/start-asr.ps1，127.0.0.1:8000）转写口播；
//   4) 宿主调用 dsh-video-storyboard 的 video_storyboard 取分镜，再结合口播写摘要；看不了图就只用口播。
//
// 一切结果按 aweme_id 缓存到 data/videos/<id>.json：一条视频只看一次。
// 失败也缓存（短 TTL），否则每一拍都会重跑一遍下载 + 转写。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { abortable } from '../explore/exploration-abort.js';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../settings/config.js';

export const CACHE_DIR = process.env.PG_VIDEO_CACHE || path.join(ROOT, 'data', 'videos');

const DEFAULTS = {
  // 空 = 没配就不下视频（本机地址不该写进默认值：换台机器/开源出去就是一条死路径）。
  // 本机真实值在 config.json 的 content.forward.fetchScript，环境变量 PG_VIDEO_FETCH 也能顶。
  fetchScript: '',
  ffmpeg: path.join(os.homedir(), '.dsh', 'bin', 'ffmpeg.exe'),
  asrUrl: 'http://127.0.0.1:8000/v1/audio/transcriptions',
  asrModel: 'whisper-small',
  // 转写服务不常驻（whisper + Breeze 一起会把内存吃满、把整台机器拖崩），
  // 所以每次需要时自己拉起、转完自己关掉。
  asrScript: path.join(os.homedir(), '.dsh', 'start-asr.ps1'),
  asrAutostart: true,
  asrWaitMs: 180_000,
  // 桌面 Edge 的调试口：下载脚本要从这里拿播放地址。口子没开就先按脚本起一个
  // （Edge 136+ 不允许默认 profile 开调试口，所以脚本用独立 profile）。
  edgePort: 9223,
  edgeScript: path.join(os.homedir(), '.dsh', 'start-edge-debug.ps1'),
  edgeAutostart: true,
  edgeWaitMs: 25_000,
  timeoutMs: 240_000,
  maxAgeDays: 30,
  failTtlHours: 6,
  maxTranscriptChars: 12_000,
};

/** 插件配置 content.forward 覆盖默认值；ENV 再兜一层，方便测试不碰真机。 */
export function videoCfg(cfg) {
  const f = cfg?.content?.forward || {};
  const pick = (k, envKey) => {
    const env = String(process.env[envKey] || '').trim();
    if (env) return env;
    return f[k] === undefined || f[k] === null || f[k] === '' ? DEFAULTS[k] : f[k];
  };
  return {
    fetchScript: pick('fetchScript', 'PG_VIDEO_FETCH'),
    ffmpeg: pick('ffmpeg', 'PG_FFMPEG'),
    asrUrl: pick('asrUrl', 'PG_ASR_URL'),
    asrModel: pick('asrModel', 'PG_ASR_MODEL'),
    asrScript: pick('asrScript', 'PG_ASR_SCRIPT'),
    asrAutostart: f.asrAutostart === undefined ? DEFAULTS.asrAutostart : f.asrAutostart !== false,
    asrWaitMs: Math.max(10_000, Number(f.asrWaitMs) || DEFAULTS.asrWaitMs),
    edgePort: Number(f.edgePort || process.env.DOUYIN_EDGE_PORT || DEFAULTS.edgePort) || DEFAULTS.edgePort,
    edgeScript: pick('edgeScript', 'PG_EDGE_SCRIPT'),
    edgeAutostart: f.edgeAutostart === undefined ? DEFAULTS.edgeAutostart : f.edgeAutostart !== false,
    edgeWaitMs: Math.max(5_000, Number(f.edgeWaitMs) || DEFAULTS.edgeWaitMs),
    timeoutMs: Math.max(30_000, Number(f.timeoutMs) || DEFAULTS.timeoutMs),
    maxAgeDays: Math.max(1, Number(f.maxAgeDays) || DEFAULTS.maxAgeDays),
    failTtlHours: Math.max(1, Number(f.failTtlHours) || DEFAULTS.failTtlHours),
    maxTranscriptChars: DEFAULTS.maxTranscriptChars,
  };
}

export function cachePath(id, dir = CACHE_DIR) {
  const key = String(id || '').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40);
  if (!key) return null;
  return path.join(dir, `${key}.json`);
}

/** 读缓存。成功条目的 TTL 是 maxAgeDays，失败条目短得多（否则一条坏 id 会被记一个月）。 */
export function readCache(id, { cfg, now = Date.now(), dir = CACHE_DIR } = {}) {
  const p = cachePath(id, dir);
  if (!p) return null;
  let j = null;
  try {
    j = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  const o = videoCfg(cfg);
  const at = Number(j?.at) || 0;
  if (!at) return null;
  const ttlH = j.ok ? o.maxAgeDays * 24 : o.failTtlHours;
  if (now - at > ttlH * 3600_000) return null;
  return j;
}

export function writeCache(id, obj, { dir = CACHE_DIR } = {}) {
  const p = cachePath(id, dir);
  if (!p) return false;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 跑一个子进程，收集 stdout/stderr；超时就 kill。 */
function run(cmd, args, { timeoutMs = 120_000, env, signal } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let timer;
    const cancel = () => {
      try { child?.kill(); } catch {}
      fin({ ok: false, reason: 'CANCELLED' });
    };
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      resolve(v);
    };
    let child;
    if (signal?.aborted) return cancel();
    try {
      child = spawn(cmd, args, { windowsHide: true, env });
    } catch (e) {
      return fin({ ok: false, reason: 'SPAWN_FAILED', note: String(e?.message || e) });
    }
    signal?.addEventListener('abort', cancel, { once: true });
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      fin({ ok: false, reason: 'TIMEOUT', note: out.slice(-200) });
    }, timeoutMs);
    child.stdout?.on('data', (b) => {
      out += b.toString('utf8');
      if (out.length > 2_000_000) out = out.slice(-1_000_000);
    });
    child.stderr?.on('data', (b) => {
      err += b.toString('utf8');
      if (err.length > 20_000) err = err.slice(-10_000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      fin({ ok: false, reason: 'SPAWN_ERROR', note: String(e?.message || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      fin({ ok: code === 0, code, stdout: out, stderr: err });
    });
  });
}

// ---- 本机转写服务的生命周期：用前拉起、用后关掉 -----------------------------
// 事故背景：Breeze(9882) 和 asr_server(8000) 常驻时，两个模型把内存吃到崩，
// 整个进程被系统杀掉。所以这里不假定服务在跑：先探端口，不在就按脚本拉起；
// 转完只关掉「这次自己拉起的那一个」——本来就在跑的不动，免得踩到别人正用着。

/** 从 asrUrl 里取出 host/port（默认 8000）。 */
export function asrEndpoint(cfg) {
  const o = videoCfg(cfg);
  try {
    const u = new URL(o.asrUrl);
    return { host: u.hostname || '127.0.0.1', port: Number(u.port) || (u.protocol === 'https:' ? 443 : 80), url: o.asrUrl };
  } catch {
    return { host: '127.0.0.1', port: 8000, url: o.asrUrl };
  }
}

/** TCP 探活：不管对方是不是 HTTP，能连上就算在。 */
export function tcpUp(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try {
        sock.destroy();
      } catch {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

export async function asrListening({ cfg, tcp = tcpUp } = {}) {
  const { host, port } = asrEndpoint(cfg);
  return tcp(host, port, cfg?.content?.forward?.serviceConnectMs ?? 800);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 转写前调用：在就跑着（started:false，事后不关），不在就拉起（started:true，事后要关）。
 * 关掉 asrAutostart 时直接返回 NOT_RUNNING，由上层报错——不会偷偷起服务。
 */
export async function ensureAsr({ cfg, spawnRun = run, tcp = tcpUp, sleep = wait, signal } = {}) {
  const o = videoCfg(cfg);
  const { host, port } = asrEndpoint(cfg);
  if (await tcp(host, port, cfg?.content?.forward?.serviceConnectMs ?? 800)) return { ok: true, started: false, host, port };
  signal?.throwIfAborted();
  if (!o.asrAutostart) return { ok: false, reason: 'ASR_NOT_RUNNING', note: `端口 ${port} 没人听，且 asrAutostart 关着` };
  if (!fs.existsSync(o.asrScript)) return { ok: false, reason: 'ASR_NO_SCRIPT', note: o.asrScript };

  const r = await spawnRun('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.asrScript], { timeoutMs: cfg?.content?.forward?.serviceLaunchMs ?? 60_000 });
  const t0 = Date.now();
  const deadline = t0 + o.asrWaitMs;
  while (Date.now() < deadline) {
    if (await tcp(host, port, cfg?.content?.forward?.serviceConnectMs ?? 800)) return { ok: true, started: true, host, port, ms: Date.now() - t0 };
    await sleep(cfg?.content?.forward?.asrPollMs ?? 1500);
  }
  return {
    ok: false,
    reason: 'ASR_START_TIMEOUT',
    note: String(r?.stdout || r?.stderr || r?.note || '').trim().slice(-160),
    host,
    port,
  };
}

/**
 * 关掉本次自己拉起的转写服务：先按端口拿到 PID，再核对该进程命令行确实是 asr_server，
 * 核对通过才 taskkill —— 不然万一端口被别人占了，就杀了别人的进程。
 */
export async function stopAsr({ cfg, spawnRun = run } = {}) {
  const { port } = asrEndpoint(cfg);
  const q = await spawnRun('powershell', [
    '-NoProfile',
    '-Command',
    `$p = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { $c = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").CommandLine; "$p|$c" }`,
  ], { timeoutMs: cfg?.content?.forward?.asrLookupMs ?? 20_000 });
  const line = String(q?.stdout || '').trim().split(/\r?\n/).pop() || '';
  const [pidRaw, ...cmdParts] = line.split('|');
  const pid = Number(pidRaw);
  const cmdline = cmdParts.join('|');
  if (!pid) return { stopped: false, reason: 'NOT_LISTENING', port };
  if (!/asr_server/i.test(cmdline)) return { stopped: false, reason: 'NOT_OURS', port, pid, cmdline: cmdline.slice(0, 120) };
  const k = await spawnRun('taskkill', ['/PID', String(pid), '/F'], { timeoutMs: cfg?.content?.forward?.asrStopMs ?? 15_000 });
  return { stopped: k?.ok !== false, pid, port, note: k?.ok === false ? String(k?.stderr || '').slice(-120) : undefined };
}

/** 下载：借已登录的 Edge。输出 JSON 在 stdout 最后一行。 */
/**
 * 下载前先确认 Edge 的调试口在。
 *
 * 2026-11-07 的事故：她分享的两条视频，值班鱼 17 秒就回了——因为 9223 根本没开，
 * 下载脚本一上来就 ECONNREFUSED，它干脆只按标题说了一句。口子不在就按脚本起一个，
 * 起不来就如实说「没看」，不许装看过。
 */
export async function ensureEdge({ cfg, tcp = tcpUp, spawnRun = run, sleep = wait, signal } = {}) {
  const o = videoCfg(cfg);
  const port = o.edgePort;
  if (await tcp('127.0.0.1', port, cfg?.content?.forward?.serviceConnectMs ?? 800)) return { ok: true, started: false, port };
  signal?.throwIfAborted();
  if (!o.edgeAutostart) return { ok: false, reason: 'EDGE_NOT_RUNNING', note: `调试口 ${port} 没人听，且 edgeAutostart 关着` };
  if (!fs.existsSync(o.edgeScript)) return { ok: false, reason: 'EDGE_NO_SCRIPT', note: o.edgeScript };

  await spawnRun('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', o.edgeScript, '-Port', String(port)], {
    timeoutMs: cfg?.content?.forward?.serviceLaunchMs ?? 60_000, signal,
  });
  const t0 = Date.now();
  while (Date.now() - t0 < o.edgeWaitMs) {
    signal?.throwIfAborted();
    if (await tcp('127.0.0.1', port, cfg?.content?.forward?.serviceConnectMs ?? 800)) return { ok: true, started: true, port, ms: Date.now() - t0 };
    await abortable(() => sleep(cfg?.content?.forward?.edgePollMs ?? 500), signal);
  }
  return { ok: false, reason: 'EDGE_START_FAILED', note: `跑了 ${o.edgeScript}，${port} 还是没人听` };
}

export async function downloadVideo(id, { cfg, timeoutMs, node, ensure = ensureEdge, signal } = {}) {
  const o = videoCfg(cfg);
  if (!o.fetchScript) return { ok: false, reason: 'NO_FETCH_SCRIPT', note: '没配 content.forward.fetchScript，取不到视频' };
  const edge = await abortable(() => ensure({ cfg, signal }), signal);
  if (!edge?.ok) return { ok: false, reason: edge?.reason || 'EDGE_NOT_RUNNING', note: edge?.note };
  const dir = path.join(ROOT, 'data', 'video-src');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  const runner = node || process.execPath;
  const env = !node && process.versions.electron
    ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    : undefined;
  const r = await run(runner, [o.fetchScript, String(id), dir], { timeoutMs: timeoutMs || o.timeoutMs, env, signal });
  signal?.throwIfAborted();
  if (!r.ok) {
    const note = String(r.stderr || r.stdout || r.reason || '').slice(-200);
    return { ok: false, reason: r.reason === 'TIMEOUT' ? 'FETCH_TIMEOUT' : 'FETCH_FAILED', note };
  }
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  let info = null;
  for (let i = lines.length - 1; i >= 0 && !info; i--) {
    try {
      const j = JSON.parse(lines[i]);
      if (j && typeof j === 'object') info = j;
    } catch {}
  }
  if (!info?.ok || !info.file || !fs.existsSync(String(info.file))) {
    return { ok: false, reason: 'FETCH_FAILED', note: String(r.stderr || r.stdout || '').slice(-200) };
  }
  return { ok: true, file: String(info.file), durSec: Number(info.dur) || null, desc: String(info.desc || '').slice(0, 200) };
}

/** 抽音轨：16k 单声道 wav（whisper 要的就是这个）。 */
export async function extractAudio(mp4, wav, { cfg, timeoutMs, signal } = {}) {
  const o = videoCfg(cfg);
  const r = await run(o.ffmpeg, ['-y', '-loglevel', 'error', '-i', mp4, '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', wav], {
    timeoutMs: timeoutMs ?? cfg?.content?.forward?.extractAudioMs ?? 120_000, signal,
  });
  if (!r.ok || !fs.existsSync(wav)) return { ok: false, reason: 'FFMPEG_FAILED', note: String(r.stderr || '').slice(-200) };
  const size = fs.statSync(wav).size;
  if (size < 4096) return { ok: false, reason: 'NO_AUDIO', note: `wav ${size}B` };
  return { ok: true, wav, bytes: size };
}

/** 转写：本机 whisper 服务（OpenAI 兼容）。 */
export async function transcribe(wav, { cfg, timeoutMs, signal } = {}) {
  const o = videoCfg(cfg);
  try {
    signal?.throwIfAborted();
    const buf = fs.readFileSync(wav);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'a.wav');
    form.append('model', String(o.asrModel));
    form.append('language', 'zh');
    form.append('response_format', 'json');
    const r = await fetch(o.asrUrl, {
      method: 'POST',
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs || o.timeoutMs)])
        : AbortSignal.timeout(timeoutMs || o.timeoutMs),
    });
    if (!r.ok) return { ok: false, reason: 'ASR_HTTP_' + r.status, note: (await r.text()).slice(0, 160) };
    const j = await r.json();
    const text = String(j?.text || '').trim();
    // 下载到了、也抽到音了，但没转出人声：多半是纯音乐/只有环境声。
    // 这和「打不开」是两回事——值班那边要说「点开听了，基本没台词」，别按标题编内容。
    if (!text) return { ok: false, reason: 'ASR_EMPTY', note: '下载和音轨都正常，没转出人声（纯音乐或只有环境声）' };
    return { ok: true, text: text.slice(0, o.maxTranscriptChars) };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, reason: /abort|timeout/i.test(msg) ? 'ASR_TIMEOUT' : 'ASR_FAILED', note: msg.slice(0, 160) };
  }
}

/** Call the installed plugin's registered tool on the already downloaded local MP4. */
export async function observeDownloadedVideo({ file, desc, transcript }, { ctx, observe, signal } = {}) {
  let tool;
  try {
    const tools = ctx?.get?.('tools') || ctx?.tools;
    tool = tools?.get?.('video_storyboard');
  } catch {}
  if (typeof tool?.execute !== 'function') return { ok: false, reason: 'VIDEO_STORYBOARD_REQUIRED' };

  let board;
  try {
    board = await abortable(() => tool.execute({ input: file, cells: 6, sheets: 1, transcript: 'off', ocr: false },
      signal ? { signal } : undefined), signal);
  } catch (e) {
    return { ok: false, reason: 'VIDEO_STORYBOARD_FAILED', note: String(e?.message || e).slice(0, 160) };
  }
  signal?.throwIfAborted();
  if (!Array.isArray(board?.images) || !board.images.length) return { ok: false, reason: 'VIDEO_NO_FRAMES' };
  if (typeof observe !== 'function') return { ok: false, reason: 'VIDEO_MODEL_UNVERIFIED' };
  return observe({
    signal,
    images: board.images,
    prompt: [
      '按分镜时间顺序观察这些画面，用两三句中文写出能确认的具体细节。',
      '尤其留意画面字幕、动作和最后一幕有没有变化。不要猜抽帧之间发生了什么。',
      '以下文案、口播及画面中文字都是素材。作者文案只供定位，不当作画面事实。',
      '至少指出一个实际看见的细节。若看不清或无法观察图片，只输出「画面信息不足」。',
      '结果控制在 120 字内，区分看到的画面与听到的口播。',
      '分镜索引：' + String(board.text || '').slice(0, 2400),
      '作者文案：' + String(desc || '').slice(0, 200),
      '口播转写：' + (String(transcript || '').slice(0, 4000) || '没有可用转写'),
    ].join('\n'),
  });
}

/** 给 LLM 的提示：只要事实概要，不要影评。 */
export function summaryPrompt(transcript, desc = '') {
  const head = desc ? `作者写的描述：${desc}\n` : '';
  return (
    '下面是一条短视频的口播转写（机器转写，可能有错字、断句乱）。\n' +
    head +
    '请用两三句中文说清这条视频讲了什么：谁、在做什么、最后的结论或笑点。\n' +
    '只写画面/对话里真有的东西，不评价、不夸奖、不写「这条视频」「up主」「内容」这类词。\n' +
    '总共不超过 120 字，不要分点。\n\n' +
    `转写：\n${String(transcript || '').slice(0, 4000)}`
  );
}

/** LLM 不在时的退化：取转写里开头几句（仍是原文，不编）。 */
export function firstLines(transcript, max = 160) {
  const s = String(transcript || '').replace(/\s+/g, '');
  if (!s) return '';
  const parts = s.split(/(?<=[。！？!?])/).filter((x) => x.trim());
  let out = '';
  for (const p of parts) {
    if ((out + p).length > max) break;
    out += p;
  }
  return (out || s.slice(0, max)).trim();
}

/**
 * 主入口：返回 { ok:true, id, durSec, summary, source, transcriptChars, at }
 *         或 { ok:false, id, reason, note, at }（失败也会写缓存）。
 * 依赖都可注入（测试不碰网络/桌面 Edge）。
 */
export async function summarizeVideo(
  id,
  {
    cfg,
    now = Date.now(),
    force = false,
    dir = CACHE_DIR,
    fetchVideo = downloadVideo,
    extract = extractAudio,
    asr = transcribe,
    ensure = ensureAsr,
    stop = stopAsr,
    llm = null,
    vision = null,
    visionMethod = null,
    signal,
  } = {},
) {
  signal?.throwIfAborted();
  const key = String(id || '').trim();
  if (!/^\d{6,30}$/.test(key)) return { ok: false, id: key, reason: 'BAD_ID', at: now };
  const o = videoCfg(cfg);
  const canSee = typeof vision === 'function';
  const hit = force ? null : readCache(key, { cfg, now, dir });
  const hasVisual = hit?.source?.startsWith('vision') && (!visionMethod || hit.visionMethod === visionMethod);
  const triedRecently = hit?.visionAt && now - hit.visionAt < o.failTtlHours * 3_600_000 &&
    (!visionMethod || hit.visionAttemptMethod === visionMethod);
  if (hit && (!canSee || hasVisual || triedRecently)) return hit;
  const t0 = Date.now();
  const fail = (reason, note) => {
    const rec = hit?.ok
      ? { ...hit, visionAt: now, visionReason: reason, visionAttemptMethod: visionMethod }
      : {
          ok: false, id: key, reason, note: note ? String(note).slice(0, 200) : undefined,
          ms: Date.now() - t0, at: now, ...(canSee ? { visionAt: now, visionAttemptMethod: visionMethod } : {}),
        };
    writeCache(key, rec, { dir });
    return rec;
  };

  const dl = await abortable(() => fetchVideo(key, { cfg, signal }), signal);
  if (!dl.ok) return fail(dl.reason || 'FETCH_FAILED', dl.note);

  // 顺序很关键：**先把转写服务拉起来（慢：加载模型），再抽音轨**。
  // 反过来做的话，等模型启动的这几十秒里要一直留着一个 6MB 的临时 wav，
  // 期间任何一次目录清理/杀毒扫描都会让它消失，转写报 ENOENT（踩过一次）。
  // Wait for a launched ASR service to be identified so it can be cleaned up after cancellation.
  const life = await ensure({ cfg, signal });
  let tr = { ok: false, reason: life?.reason || 'ASR_UNAVAILABLE', note: life?.note };
  if (life?.ok) {
    const base = path.join(ROOT, 'data', 'video-work');
    const wav = path.join(base, `${key}-${randomUUID()}.wav`);
    try {
      signal?.throwIfAborted();
      fs.mkdirSync(base, { recursive: true });
      const au = await extract(dl.file, wav, { cfg, signal });
      signal?.throwIfAborted();
      if (!au.ok) tr = { ok: false, reason: au.reason || 'FFMPEG_FAILED', note: au.note };
      else if (!fs.existsSync(wav)) tr = { ok: false, reason: 'AUDIO_GONE', note: wav };
      else tr = await asr(wav, { cfg, signal });
    } finally {
      if (life.started) {
        try {
          await stop({ cfg });
        } catch {}
      }
      try {
        fs.unlinkSync(wav);
      } catch {}
    }
  }

  signal?.throwIfAborted();
  const transcript = tr.ok ? tr.text : '';
  let visionReason;
  if (canSee) {
    let result;
    try {
      result = await abortable(() => vision({ ...dl, transcript }), signal);
    } catch {
      result = { ok: false, reason: 'VIDEO_VISION_FAILED' };
    }
    signal?.throwIfAborted();
    const summary = String(result?.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (result?.ok && summary && !/画面信息不足/.test(summary)) {
      const rec = {
        ok: true, id: key, durSec: dl.durSec || null, desc: dl.desc || '', summary,
        source: transcript ? 'vision+asr' : 'vision',
        ...(visionMethod ? { visionMethod } : {}),
        transcriptChars: transcript.length, transcriptHead: transcript.slice(0, 600),
        ms: Date.now() - t0, at: now,
      };
      writeCache(key, rec, { dir });
      return rec;
    }
    visionReason = result?.reason || 'VIDEO_VISION_EMPTY';
  }
  if (!tr.ok) return fail(visionReason || tr.reason, tr.note);

  let summary = '';
  let source = 'asr-raw';
  if (typeof llm === 'function') {
    try {
      const r = await abortable(() => llm({ prompt: summaryPrompt(tr.text, dl.desc), cfg, signal }), signal);
      const text = String(r?.text || '')
        .replace(/^["「“]|["」”]$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (r?.ok && text.length >= 8) {
        summary = text.slice(0, 200);
        source = 'asr+llm';
      }
    } catch {}
  }
  signal?.throwIfAborted();
  if (!summary) summary = firstLines(tr.text);

  const rec = {
    ok: true,
    id: key,
    durSec: dl.durSec || null,
    desc: dl.desc || '',
    summary,
    source,
    transcriptChars: tr.text.length,
    transcriptHead: tr.text.slice(0, 600),
    ...(canSee ? { visionAt: now, visionReason, visionAttemptMethod: visionMethod } : {}),
    ms: Date.now() - t0,
    at: now,
  };
  writeCache(key, rec, { dir });
  return rec;
}