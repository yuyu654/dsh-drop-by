// fullscreen-guard.js —— 轻量全屏游戏避让守卫（零进程枚举、零外部依赖）。
//
// 优先把 tools/quns-helper.cs 用 Windows 自带 .NET Framework csc.exe 静默编译一次，
// 常驻一个极小辅助进程通过 stdin/stdout 查询 SHQueryUserNotificationState()，
// 游戏期间 0 次 powershell.exe、0 新进程创建；编译或启动失败时自动无感退回带缓存的 PowerShell 检查。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { ROOT } from '../settings/config.js';

const CS_SOURCE = path.join(ROOT, 'tools', 'quns-helper.cs');
const HELPER_ARTIFACT = /^quns-helper-[a-f0-9]{12}\.exe(?:\.\d+\.tmp\.exe)?$/iu;
const DEFAULT_CACHE_DIR = path.join(os.tmpdir(), 'dsh-drop-by-quns');

function cacheDir() {
  const custom = String(process.env.PG_QUNS_CACHE_DIR || '').trim();
  return custom ? path.resolve(custom) : DEFAULT_CACHE_DIR;
}

// SHQueryUserNotificationState 返回值：
// 2 = QUNS_BUSY（全屏应用 / 无边框全屏游戏）
// 3 = QUNS_RUNNING_D3D_FULL_SCREEN（Direct3D 独占全屏游戏）
// 4 = QUNS_PRESENTATION_MODE（演示全屏）
// 5 = QUNS_ACCEPTS_NOTIFICATIONS（正常桌面）
export const FULLSCREEN_QUNS_STATES = new Set([2, 3, 4]);

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];

const NATIVE_CACHE_MS = 15_000;
const FALLBACK_CACHE_MS = 60_000;
const QUERY_TIMEOUT_MS = 3_000;

let helperProc = null;
let helperExe = '';
let helperFailed = false;
let compilePromise = null;
let pendingQueue = [];
let stdoutBuf = '';
let mode = 'idle'; // 'idle' | 'native' | 'powershell' | 'off'
let lastCheckAt = 0;
let lastQuns = 5;
let lastFullscreenAt = 0;
let cleanupGen = 0;

function pruneStaleCache(dir, keepBasename) {
  let retry = false;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === keepBasename || !entry.isFile() || !HELPER_ARTIFACT.test(entry.name)) continue;
      try { fs.unlinkSync(path.join(dir, entry.name)); }
      catch (error) { if (error.code !== 'ENOENT') retry = true; }
    }
  } catch { /* Cache is absent or inaccessible. */ }
  return retry;
}

function cleanupCacheDir(gen, dir, retries = 4, delayMs = 80) {
  if (gen !== cleanupGen) return;
  const retry = pruneStaleCache(dir);
  try { fs.rmdirSync(dir); } catch { /* Shared cache can still contain unrelated files. */ }
  if (retry && retries > 0) {
    const timer = setTimeout(() => cleanupCacheDir(gen, dir, retries - 1, delayMs * 2), delayMs);
    timer.unref?.();
  }
}

function findCsc() {
  if (process.platform !== 'win32') return '';
  for (const p of CSC_CANDIDATES) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* ignore */ }
  }
  return '';
}

function sourceHash() {
  const src = fs.readFileSync(CS_SOURCE, 'utf8');
  return createHash('sha256').update(src).digest('hex').slice(0, 12);
}

function ensureCompiled({ force = false } = {}) {
  if (process.platform !== 'win32') return Promise.resolve('');
  const myGen = ++cleanupGen;
  if (compilePromise && !force) return compilePromise;
  compilePromise = new Promise((resolve) => {
    try {
      if (!fs.existsSync(CS_SOURCE)) { resolve(''); return; }
      const dir = cacheDir();
      const hash = sourceHash();
      const exeName = `quns-helper-${hash}.exe`;
      const exePath = path.join(dir, exeName);
      if (!force && fs.existsSync(exePath)) {
        if (myGen !== cleanupGen) { resolve(''); return; }
        helperExe = exePath;
        pruneStaleCache(dir, exeName);
        resolve(exePath);
        return;
      }
      const csc = findCsc();
      if (!csc) { resolve(''); return; }
      fs.mkdirSync(dir, { recursive: true });
      const tmpExe = `${exePath}.${process.pid}.tmp.exe`;
      execFile(
        csc,
        ['/nologo', '/optimize+', '/target:exe', `/out:${tmpExe}`, CS_SOURCE],
        { timeout: 15_000, windowsHide: true },
        (err) => {
          if (myGen !== cleanupGen) {
            try { fs.unlinkSync(tmpExe); } catch { /* ignore */ }
            pruneStaleCache(dir);
            try { fs.rmdirSync(dir); } catch { /* ignore */ }
            resolve('');
            return;
          }
          if (err || !fs.existsSync(tmpExe)) {
            try { fs.unlinkSync(tmpExe); } catch { /* ignore */ }
            resolve('');
            return;
          }
          try {
            if (fs.existsSync(exePath)) fs.unlinkSync(exePath);
            fs.renameSync(tmpExe, exePath);
            if (myGen !== cleanupGen) {
              try { fs.unlinkSync(exePath); } catch { /* ignore */ }
              resolve('');
              return;
            }
            helperExe = exePath;
            pruneStaleCache(dir, exeName);
            resolve(exePath);
          } catch {
            if (myGen !== cleanupGen) {
              try { fs.unlinkSync(tmpExe); } catch { /* ignore */ }
              resolve('');
              return;
            }
            // 文件可能被已有进程占用，直接用编译产物或已有 exe
            resolve(fs.existsSync(exePath) ? exePath : tmpExe);
          }
        },
      );
    } catch {
      resolve('');
    }
  }).finally(() => {
    compilePromise = null;
  });
  return compilePromise;
}

function flushPending(val) {
  const q = pendingQueue;
  pendingQueue = [];
  for (const item of q) {
    clearTimeout(item.timer);
    item.resolve(val);
  }
}

function stopHelper() {
  const proc = helperProc;
  helperProc = null;
  stdoutBuf = '';
  flushPending(-1);
  if (proc) {
    proc.stdin?.destroy();
    proc.stdout?.destroy();
    try { proc.kill(); } catch { /* ignore */ }
  }
}

function spawnHelper(exePath) {
  if (helperProc && !helperProc.killed && helperProc.exitCode === null) return helperProc;
  try {
    const child = spawn(exePath, [], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.unref?.();
    // Each pending query has a deadline that keeps Node alive. Idle pipes must not.
    child.stdin.unref?.();
    child.stdout.unref?.();
    child.stdin.on('error', () => {
      if (helperProc === child) stopHelper();
    });
    stdoutBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (helperProc !== child) return;
      stdoutBuf += chunk;
      let idx;
      while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        const next = pendingQueue.shift();
        if (next) {
          clearTimeout(next.timer);
          const n = Number(line);
          next.resolve(Number.isFinite(n) ? n : -1);
        }
      }
    });
    child.on('error', () => {
      if (helperProc !== child) return;
      helperFailed = true;
      stopHelper();
    });
    child.on('exit', () => {
      if (helperProc === child) stopHelper();
    });
    helperProc = child;
    return child;
  } catch {
    helperFailed = true;
    return null;
  }
}

async function queryNative() {
  if (helperFailed || process.platform !== 'win32') return -1;
  const genBefore = cleanupGen;
  const exe = helperExe && fs.existsSync(helperExe) ? helperExe : await ensureCompiled();
  if (!exe || (helperExe && cleanupGen !== genBefore + 1 && cleanupGen !== genBefore)) {
    if (!exe && cleanupGen === genBefore) helperFailed = true;
    return -1;
  }
  if (!helperExe || !fs.existsSync(exe)) return -1;
  const proc = spawnHelper(exe);
  if (!proc || !proc.stdin || proc.stdin.destroyed) return -1;
  return new Promise((resolve) => {
    const entry = {
      resolve,
      timer: setTimeout(() => {
        const i = pendingQueue.indexOf(entry);
        if (i >= 0) pendingQueue.splice(i, 1);
        resolve(-1);
      }, QUERY_TIMEOUT_MS),
    };
    pendingQueue.push(entry);
    try {
      proc.stdin.write('q\n');
    } catch {
      const i = pendingQueue.indexOf(entry);
      if (i >= 0) pendingQueue.splice(i, 1);
      clearTimeout(entry.timer);
      resolve(-1);
    }
  });
}

function queryPowerShellFallback() {
  if (process.platform !== 'win32') return Promise.resolve(5);
  const ps = 'Add-Type -Name Q -Namespace N -MemberDefinition \'[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);\'; $s=0; if ([N.Q]::SHQueryUserNotificationState([ref]$s) -eq 0) { $s } else { -1 }';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) { resolve(-1); return; }
        const n = Number(String(stdout || '').trim().split(/\r?\n/).pop());
        resolve(Number.isFinite(n) ? n : -1);
      },
    );
  });
}

export function cooldownMsOf(cfg) {
  const raw = cfg?.perception?.anticheat?.fullscreenCooldownMin;
  const min = raw === undefined || raw === null || raw === '' ? 10 : Number(raw);
  return Math.max(0, Math.min(120, Number.isFinite(min) ? min : 10)) * 60_000;
}

export function guardEnabled(cfg) {
  const ac = cfg?.perception?.anticheat;
  return ac?.skip !== false && ac?.skipFullscreen !== false;
}

/**
 * 检查当前是否应避让敏感动作（全屏游戏中，或退出全屏后的缓冲期内）。
 * 可传入自定义 query() 便于单测不碰真实 Win32 API。
 */
export async function isFullscreenBlocked(cfg, { now = Date.now(), query = null, maxCacheMs = null } = {}) {
  if (!guardEnabled(cfg)) {
    return { blocked: false, inFullscreen: false, inCooldown: false, reason: null, remainingMs: 0, mode: 'off', lastFullscreenAt };
  }
  const cooldownMs = cooldownMsOf(cfg);
  const inCooldownNow = lastFullscreenAt > 0 && cooldownMs > 0 && now >= lastFullscreenAt && (now - lastFullscreenAt) < cooldownMs;

  // 兜底 PowerShell 模式下，处于缓冲期内直接内存短路，不启动新进程
  if (!query && helperFailed && inCooldownNow) {
    return {
      blocked: true,
      inFullscreen: false,
      inCooldown: true,
      reason: 'FULLSCREEN_COOLDOWN',
      remainingMs: Math.max(0, cooldownMs - (now - lastFullscreenAt)),
      mode: 'powershell',
      lastFullscreenAt,
    };
  }

  const defaultCacheMs = mode === 'native' ? NATIVE_CACHE_MS : FALLBACK_CACHE_MS;
  const cacheMs = query ? 0 : (maxCacheMs != null && mode === 'native' ? Math.max(0, Number(maxCacheMs)) : defaultCacheMs);
  let quns = lastQuns;
  if (query || !lastCheckAt || now - lastCheckAt >= cacheMs) {
    if (typeof query === 'function') {
      quns = await query();
      mode = 'custom';
    } else {
      const n = await queryNative();
      if (n >= 0) {
        quns = n;
        mode = 'native';
      } else {
        quns = await queryPowerShellFallback();
        mode = 'powershell';
      }
    }
    lastQuns = quns;
    lastCheckAt = now;
  }

  const inFullscreen = FULLSCREEN_QUNS_STATES.has(quns);
  if (inFullscreen) {
    lastFullscreenAt = now;
    return {
      blocked: true,
      inFullscreen: true,
      inCooldown: false,
      reason: 'FULLSCREEN_GAME',
      remainingMs: cooldownMs,
      mode,
      lastFullscreenAt,
    };
  }

  if (lastFullscreenAt > 0 && cooldownMs > 0 && now >= lastFullscreenAt && (now - lastFullscreenAt) < cooldownMs) {
    return {
      blocked: true,
      inFullscreen: false,
      inCooldown: true,
      reason: 'FULLSCREEN_COOLDOWN',
      remainingMs: Math.max(0, cooldownMs - (now - lastFullscreenAt)),
      mode,
      lastFullscreenAt,
    };
  }

  return {
    blocked: false,
    inFullscreen: false,
    inCooldown: false,
    reason: null,
    remainingMs: 0,
    mode,
    lastFullscreenAt,
  };
}

export function fullscreenGuardStatus(cfg, { now = Date.now() } = {}) {
  if (!guardEnabled(cfg)) return { enabled: false, mode: 'off', blocked: false, remainingMs: 0 };
  const cooldownMs = cooldownMsOf(cfg);
  const remainingMs = lastFullscreenAt > 0 && cooldownMs > 0 && now >= lastFullscreenAt
    ? Math.max(0, cooldownMs - (now - lastFullscreenAt))
    : 0;
  return {
    enabled: true,
    mode,
    ready: mode === 'native' && Boolean(helperProc && !helperProc.killed),
    exePath: helperExe,
    inFullscreen: FULLSCREEN_QUNS_STATES.has(lastQuns) && (now - lastCheckAt < NATIVE_CACHE_MS * 2),
    inCooldown: remainingMs > 0,
    remainingMs,
    lastFullscreenAt,
  };
}

export async function redeployFullscreenHelper() {
  stopHelper();
  helperFailed = false;
  helperExe = '';
  lastCheckAt = 0;
  const exe = await ensureCompiled({ force: true });
  if (!exe) {
    helperFailed = true;
    mode = 'powershell';
    return { ok: false, mode: 'powershell' };
  }
  const q = await queryNative();
  mode = q >= 0 ? 'native' : 'powershell';
  return { ok: q >= 0, mode, exePath: exe, quns: q };
}

export function disposeFullscreenGuard() {
  const gen = ++cleanupGen;
  const dir = helperExe ? path.dirname(helperExe) : cacheDir();
  const proc = helperProc;
  helperExe = '';
  if (proc && proc.exitCode === null) {
    proc.once('exit', () => cleanupCacheDir(gen, dir));
  }
  stopHelper();
  cleanupCacheDir(gen, dir);
}

export function resetFullscreenGuardForTest() {
  disposeFullscreenGuard();
  helperFailed = false;
  mode = 'idle';
  lastCheckAt = 0;
  lastQuns = 5;
  lastFullscreenAt = 0;
}
