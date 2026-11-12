import { loadConfig } from './config.js';
import { makeHostLlm } from './hostllm.js';
import { downloadVideo, observeDownloadedVideo, summarizeVideo } from './videosum.js';

const watching = new Map();
let watchQueue = Promise.resolve();

/** Both plugins share the downloader and ASR, so only run one video job at a time. */
export function watchVideo(id, { cfg, now, llm, host, node, ctx } = {}) {
  const key = String(id || '').trim();
  if (watching.has(key)) return watching.get(key);
  const promise = watchQueue.then(() => summarizeVideo(key, {
    cfg, now, llm,
    fetchVideo: node ? (key, options) => downloadVideo(key, { ...options, node }) : undefined,
    vision: ctx ? (input) => observeDownloadedVideo(input, { ctx, observe: host?.observeVideo }) : null,
    visionMethod: 'storyboard',
  })).finally(() => watching.delete(key));
  watchQueue = promise.catch(() => {});
  watching.set(key, promise);
  return promise;
}

/** Evidence for an incoming Douyin card. This entry point never sends a reply. */
export function observeSharedVideo(ctx, id, { node } = {}) {
  const cfg = loadConfig();
  if (cfg.enabled === false || cfg.content?.forward?.enabled === false) {
    return Promise.resolve({ ok: false, reason: 'FORWARD_DISABLED' });
  }
  const host = makeHostLlm(ctx, { cfg });
  return watchVideo(id, { cfg, host, llm: host.generate, node, ctx });
}
