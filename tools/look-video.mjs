#!/usr/bin/env node
// look-video —— 「这条视频到底讲了什么」的命令行入口。
//
// 抖音值班那个 headless 会话里没有 video_storyboard 工具（那个插件只装在桌面 profile），
// 但它可以跑这条命令：给一个 aweme_id，回两三句话。链路全部在 src/videosum.js 里：
//   桌面 Edge(9223) 下载 → ffmpeg 抽音轨 → 按需拉起 whisper 转写 → 用完关掉 → 模型压成两三句
//
// 用法：
//   node tools/look-video.mjs <aweme_id> [--force] [--json] [--out-dir <目录>]
//
//   --force        不看缓存，重新看一遍
//   --json         连同 cache 记录一起打（调试用）
//   --out-dir      缓存目录（默认 data/videos；headless 会话要写在自己工作目录里时用它）
//
// 退出码：0 看成功；1 看不了（原因打在 stderr）。
import { loadConfig } from '../src/settings/config.js';
import { generate } from '../src/decision/llm.js';
import { CACHE_DIR, summarizeVideo } from '../src/perception/videosum.js';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : '';
};
const id = String(argv.find((a) => /^\d{6,30}$/.test(a)) || val('--video') || '').trim();

if (!id) {
  console.error('用法：node tools/look-video.mjs <aweme_id> [--force] [--json] [--out-dir <目录>]');
  process.exit(2);
}

const cfg = loadConfig();
const dir = String(val('--out-dir') || process.env.PG_VIDEO_CACHE || CACHE_DIR).trim();

const r = await summarizeVideo(id, {
  cfg,
  now: Date.now(),
  force: has('--force'),
  dir,
  llm: (args) => generate(args),
});

if (has('--json')) console.log(JSON.stringify(r, null, 2));

if (!r.ok) {
  // 说清楚是哪一步没成：下载不了 / 没声音 / 转写失败 / 起不来服务
  console.error(`看不了这条（${r.reason || 'UNKNOWN'}）${r.note ? '：' + String(r.note).slice(0, 160) : ''}`);
  process.exit(1);
}

console.log(r.summary);
if (has('--json')) console.log(`(# ${r.source} · ${r.durSec ? Math.round(r.durSec / 1000) + 's' : '?'} · 转写 ${r.transcriptChars} 字)`);