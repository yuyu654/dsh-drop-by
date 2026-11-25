import { loadConfig } from '../settings/config.js';
import { abortable } from '../explore/exploration-abort.js';
import { makeHostLlm } from '../decision/hostllm.js';
import { downloadVideo, observeDownloadedVideo, summarizeVideo } from './videosum.js';

const watching = new Map();
let watchQueue = Promise.resolve();

/** Both plugins share the downloader and ASR, so only run one video job at a time. */
export function watchVideo(id, { cfg, now, llm, host, node, ctx, signal } = {}) {
  const key = String(id || '').trim();
  const current = watching.get(key);
  if (current && !current.signal?.aborted) return abortable(() => current.promise, signal);
  const promise = watchQueue.then(() => summarizeVideo(key, {
    cfg, now, llm, signal,
    fetchVideo: node ? (key, options) => downloadVideo(key, { ...options, node }) : undefined,
    vision: ctx ? (input) => observeDownloadedVideo(input, { ctx, observe: host?.observeVideo, signal }) : null,
    visionMethod: 'storyboard',
  })).finally(() => { if (watching.get(key)?.promise === promise) watching.delete(key); });
  watchQueue = promise.catch(() => {});
  watching.set(key, { promise, signal });
  return abortable(() => promise, signal);
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
