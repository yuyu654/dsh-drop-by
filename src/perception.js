// perception.js —— 三层感知。各自独立，上一层不通不影响下一层。
//
//   L1  系统信号   空闲时长 / 前台窗口 / 音频峰值 / 进程集合     ~380ms
//   L2  在干什么   把 L1 折成 coding / game / media / browsing  纯函数，0ms
//   L3  看屏幕     前台窗口截图 + 系统 OCR，读出屏幕上的字        ~900ms
//
// 三条约束：
//   1) L3 不影响前台工作：CopyFromScreen 是 BitBlt，只读像素，不激活窗口、不移动鼠标；
//   2) 任何一层失败都只是这一层 ok=false，不抛异常、不拖住判定；
//   3) L1/L2 参与判定（空闲 → 人不在），L3 **不参与**决定发不发，只作为「我在干什么」的记录。
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './config.js';
import { probe, classifyActivity } from './probe.js';

const L3_SCRIPT = path.join(ROOT, 'tools', 'screen-ocr.ps1');
const L3_TIMEOUT_MS = 12_000;

/** L3：截前台窗口 + 系统 OCR。失败只返回原因，不重试。 */
export function l3Screen(cfg, { timeoutMs = cfg?.perception?.l3?.timeoutMs ?? L3_TIMEOUT_MS } = {}) {
  const l3 = cfg?.perception?.l3 || {};
  const skip = (l3.skipFg || []).map((s) => String(s).toLowerCase());
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', L3_SCRIPT],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve({ ok: false, reason: 'L3_SCRIPT_FAILED', note: String(err.message || err).slice(0, 160) });
          return;
        }
        try {
          const line = String(stdout).trim().split('\n').pop();
          const j = JSON.parse(line);
          // 锁屏 / 登录页这类不给看
          if (skip.includes('__never__')) {
            resolve({ ok: false, reason: 'L3_SKIPPED' });
            return;
          }
          resolve(j);
        } catch (e) {
          resolve({ ok: false, reason: 'L3_BAD_OUTPUT', note: String(e?.message || e).slice(0, 120) });
        }
      }
    );
  });
}

/** 从 OCR 文本里挑出可能的「在做什么」线索：标题栏、文件名、报错行。 */
export function screenHints(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const uniq = [];
  const seen = new Set();
  for (const l of lines) {
    const k = l.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(l);
    if (uniq.length >= 12) break;
  }
  return uniq;
}

/**
 * 把 OCR 线索收成能进 prompt 的短句。
 *
 * 系统 OCR 在中文上认得很碎，实测会把一整行标题拆成「应 甲 缤 辑 deepseel」这种
 * 带空格的碎字——直接塞给模型等于喂噪声，它会照着编。所以这里只留「字挨得紧、
 * 像一句话」的行，最多 max 条，每条截短。
 */
export function screenFacts(hints, max = 2) {
  const out = [];
  for (const raw of Array.isArray(hints) ? hints : []) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!s || s.length < 4) continue;
    // 只有标点/符号的行没有信息
    if (!/[\p{L}\p{N}]/u.test(s)) continue;
    // 空格占比高 = 逐字拆开
    const sp = (s.match(/ /g) || []).length;
    if (sp / s.length > 0.2) continue;
    // 大多是一个字一个字的 token（「应 甲 缤 辑 deepseel」那种）= OCR 碎了
    const tokens = s.split(' ').filter(Boolean);
    if (tokens.length >= 3) {
      const single = tokens.filter((t) => t.length === 1).length;
      if (single / tokens.length >= 0.5) continue;
    }
    s = s.slice(0, 40).trim();
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 跑一次三层感知。L3 默认跟随 cfg.perception.l3.enabled，也可强制。
 * 返回 { at, l1, l2, l3 }
 */
export async function perceive(cfg, { l3 = null, force = false } = {}) {
  const at = Date.now();
  const sys = await probe(force);

  const l1 = sys?.ok
    ? {
        ok: true,
        idle_ms: sys.idle_ms,
        fg_name: sys.fg_name || '',
        fg_title: sys.fg_title || '',
        fg_pid: sys.fg_pid || 0,
        audio_peak: typeof sys.audio_peak === 'number' ? sys.audio_peak : -1,
        procs: (sys.procs || []).length,
      }
    : { ok: false, reason: sys?.err || 'PROBE_FAILED' };

  const l2cfg = cfg?.perception?.l2 || {};
  const activity = l2cfg.enabled === false ? null : classifyActivity(sys, l2cfg);
  const l2 = activity
    ? {
        ok: true,
        kind: activity.kind,
        speaking: activity.speaking,
        opened: activity.opened,
      }
    : { ok: false, reason: 'L2_DISABLED' };

  let l3out;
  const wantL3 = l3 === null ? cfg?.perception?.l3?.enabled === true : Boolean(l3);
  if (!wantL3) {
    l3out = { ok: false, reason: 'L3_DISABLED' };
  } else if (!sys?.ok) {
    // L1 都读不到，说明系统层面就不对劲，别再去截屏
    l3out = { ok: false, reason: 'L3_NO_L1' };
  } else {
    l3out = await l3Screen(cfg);
  }

  if (l3out.ok) {
    l3out.hints = screenHints(l3out.text);
    l3out.text = String(l3out.text || '').slice(0, 2000);
  }

  return { at, l1, l2, l3: l3out };
}

/** 一次感知结果落一行 JSONL，供事后复盘「当时我在干嘛」。 */
export function appendPerception(rec, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}
