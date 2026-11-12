// probe.js —— 调 winprobe.ps1 拿系统信号。一次约 300ms，读不到就返回 null，绝不阻塞判定。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './config.js';

const SCRIPT = path.join(ROOT, 'tools', 'winprobe.ps1');
const TIMEOUT_MS = 4000;

let cache = null; // { at, data }

export function probeCached(maxAgeMs = 5000) {
  if (cache && Date.now() - cache.at < maxAgeMs) return cache.data;
  return null;
}

export function probe(force = false) {
  if (!force && cache && Date.now() - cache.at < 5000) return Promise.resolve(cache.data);
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({
            ok: false,
            err: String(err.message || err).slice(0, 200),
            idle_ms: -1,
            fg_title: '',
            fg_pid: 0,
            audio_peak: -1,
            procs: [],
          });
          return;
        }
        try {
          const data = JSON.parse(String(stdout).trim().split('\n').pop());
          data.procs = Array.isArray(data.procs) ? data.procs : [];
          cache = { at: Date.now(), data };
          resolve(data);
        } catch (e) {
          resolve({
            ok: false,
            err: '探针输出解析失败',
            idle_ms: -1,
            fg_title: '',
            fg_pid: 0,
            audio_peak: -1,
            procs: [],
          });
        }
      }
    );
  });
}

/** 反作弊名单：这些进程在跑的时候，读窗口标题、读浏览器标签、截屏都可能被当成外挂行为。 */
export const ANTICHEAT_DEFAULT = [
  'wegame', 'tencentdl', 'tcls', 'crossproxy', 'leagueclient', 'lolex',
  'dnf', 'cf', 'valorant', 'vgtray', 'gamecoach',
];

/**
 * 反作弊保护（2026-11-08 她提的）：WeGame 在进程里时，某些操作可能触发反作弊。
 * 命中就返回进程名，没命中返回 null；`perception.anticheat.skip === false` 时永远 null。
 */
export function anticheatRunning(sys, cfg) {
  const ac = cfg?.perception?.anticheat || {};
  if (ac.skip === false) return null;
  const list = (Array.isArray(ac.procs) && ac.procs.length ? ac.procs : ANTICHEAT_DEFAULT)
    .map((n) => String(n).toLowerCase());
  const procs = new Set((sys?.procs || []).map((n) => String(n).toLowerCase()));
  return list.find((n) => procs.has(n)) || null;
}

/** L2：判断「在干什么」。只在真正要发的时候才需要，不参与 send/skip。 */
export function classifyActivity(data, l2cfg) {
  if (!data || !data.ok) return null;
  const procs = new Set(data.procs || []);
  const lower = (list) => (list || []).map((n) => String(n).toLowerCase());
  const fgName = String(data.fg_name || '').toLowerCase();
  const has = (list) => lower(list).some((n) => procs.has(n));
  const fgIn = (list) => Boolean(fgName) && lower(list).includes(fgName);

  const speaking = typeof data.audio_peak === 'number' && data.audio_peak > 0.0005;

  // 「前台就是它」才算在干这件事；只是后台开着只记 opened，不硬判
  let kind = 'other';
  if (fgIn(l2cfg?.gameProcs)) kind = 'game';
  else if (fgIn(l2cfg?.ideProcs)) kind = 'coding';
  else if (fgIn(l2cfg?.mediaProcs)) kind = 'media';
  else if (speaking && !fgName) kind = 'media';
  else if (has(l2cfg?.gameProcs)) kind = 'game-open';
  else if (has(l2cfg?.ideProcs)) kind = 'ide-open';

  return {
    kind,
    speaking,
    fgTitle: data.fg_title || '',
    fgName,
    opened: {
      ide: has(l2cfg?.ideProcs),
      game: has(l2cfg?.gameProcs),
      media: has(l2cfg?.mediaProcs),
    },
  };
}
