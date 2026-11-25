// health.js —— 阶段 5.1：一屏红绿。
//
// 只做「读不读得到」，不替人修：每行一句事实 + 绿/黄/红。
// 黄 = 数据过旧（>staleHours），红 = 读不到。有红项时 CLI 退出码非 0，方便外部盯梢。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLatest } from './fishmail.js';
import { readMemory } from '../decision/memorysource.js';
import { dshHome } from '../chat/outbound.js';
import { fishStale } from '../decision/topics.js';

const MIN = 60_000;

/** 距今的人话（健康检查里只到小时，不必更细）。 */
export function agoText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '时间不明';
  const min = Math.floor(ms / MIN);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/** QQ 出站记录：存在且能解析成对象就算可读（空文件也算，只是没聊过）。 */
export function readQQHistory({ env = process.env } = {}) {
  const file = path.join(dshHome(env), 'autonomy', 'qq-history.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw || '{}');
    const n = Array.isArray(j?.turns) ? j.turns.length : 0;
    return { ok: true, file, turns: n };
  } catch (e) {
    return { ok: false, file, error: e?.code === 'ENOENT' ? '文件不存在' : '解析失败' };
  }
}

/** 桌面 Edge 的调试口（默认 9223）。只连一下 /json/version，不碰页面。 */
export async function probePort(port, timeoutMs = 1200) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, error: String(e?.cause?.code || e?.name || e?.message || e).slice(0, 60) };
  }
}

/** whisper 二进制在不在（不真转写）。找 PATH、显式配置、启动脚本三处。 */
export function findWhisper({ env = process.env } = {}) {
  const hits = [];
  const bin = String(env.PG_WHISPER_BIN || '').trim();
  if (bin && fs.existsSync(bin)) hits.push(bin);
  const script = bin || path.join(dshHome(env), 'start-asr.ps1');
  if (!bin && fs.existsSync(script)) hits.push(script);
  return { ok: hits.length > 0, hit: hits[0] || '', checked: [bin, script].filter(Boolean) };
}

/**
 * 体检。deps 全可注入：测试里不碰真端口、真文件、真插件。
 * 返回 { at, items: [{key,label,level,detail}], bad, warn, ok }，level ∈ ok|warn|bad。
 */
export async function checkHealth({ cfg = {}, now = Date.now(), env = process.env, deps = {}, only = null } = {}) {
  const doReadLatest = deps.readLatest || readLatest;
  const doReadQQ = deps.readQQ || (() => readQQHistory({ env }));
  const doProbePort = deps.probePort || probePort;
  const doFindWhisper = deps.findWhisper || (() => findWhisper({ env }));
  const doReadMemory = deps.readMemory || ((x) => readMemory(x));

  const items = [];
  const push = (key, label, level, detail) => items.push({ key, label, level, detail });

  const wants = (key) => !only || only.includes(key);
  let phone = null;

  // 1) 鱼鱼邮件：最近一封距今
  if (wants("fish")) {
    try {
      const latest = doReadLatest();
      const info = fishStale({ ...latest, ok: Boolean(latest) }, cfg, now);
      phone = { ...info, missing: !latest };
      if (info.ageHours == null) {
        push('fish', '鱼鱼邮件', 'bad', '没读到带有效日期的鱼鱼邮件缓存');
      } else {
        const ageMs = Math.max(0, info.ageHours * 3_600_000);
        const old = info.ageHours > info.limitHours;
        push('fish', '鱼鱼邮件', old ? 'warn' : 'ok',
          `最近一封邮件在 ${agoText(ageMs)}收到${old ? `，超过 ${info.limitHours} 小时` : ''}`);
      }
    } catch {
      phone = { missing: true, ageHours: null, limitHours: fishStale(null, cfg, now).limitHours };
      push('fish', '鱼鱼邮件', 'bad', '读取邮件缓存失败');
    }
  }

  // 2) QQ 出站记录
  if (wants("qq")) {
    try {
      const q = doReadQQ();
      if (q?.ok) push('qq', 'QQ 出站记录', 'ok', `${q.turns} 轮（${q.file}）`);
      else push('qq', 'QQ 出站记录', 'bad', `${q?.error || '读不到'}（${q?.file || 'qq-history.json'}）`);
    } catch (e) {
      push('qq', 'QQ 出站记录', 'bad', `读取抛错：${String(e?.message || e).slice(0, 60)}`);
    }
  }

  // 3) 抖音 Edge 调试口。没开不等于坏了：抖音没启用时只算黄（提醒一句），
  if (wants("douyin")) {
    //    channels.douyin.enabled=true 说明真的要用它，这时连不上才是红。
    const port = Number(cfg?.perception?.signals?.port ?? 9223) || 9223;
    const douyinOn = cfg?.channels?.douyin?.enabled === true;
    try {
      const p = await doProbePort(port);
      if (p?.ok) push('douyin', '抖音 Edge 调试口', 'ok', `127.0.0.1:${port} 通`);
      else if (douyinOn) push('douyin', '抖音 Edge 调试口', 'bad', `127.0.0.1:${port} 连不上（${p?.error || p?.status || '没开'}），抖音开着，用不了`);
      else push('douyin', '抖音 Edge 调试口', 'warn', `127.0.0.1:${port} 没开（抖音没启用，暂时不用管）`);
    } catch (e) {
      if (douyinOn) push('douyin', '抖音 Edge 调试口', 'bad', `探测抛错：${String(e?.message || e).slice(0, 60)}`);
      else push('douyin', '抖音 Edge 调试口', 'warn', `127.0.0.1:${port} 没开（抖音没启用，暂时不用管）`);
    }
  }

  // 4) whisper（查二进制在不在，不转写）
  if (wants("whisper")) {
    try {
      const w = doFindWhisper();
      if (w?.ok) push('whisper', 'whisper 转写', 'ok', `找到：${w.hit}`);
      else push('whisper', 'whisper 转写', 'bad', `没找到 whisper 或启动脚本（查过 ${(w?.checked || []).join('、') || 'PATH'}）`);
    } catch (e) {
      push('whisper', 'whisper 转写', 'bad', `查找抛错：${String(e?.message || e).slice(0, 60)}`);
    }
  }

  // 5) 记忆插件
  if (wants("memory")) {
    try {
      if (cfg?.sources?.memory?.enabled === false) {
        push('memory', '记忆插件', 'warn', '关着（sources.memory.enabled=false）');
      } else {
        const m = doReadMemory({ cfg, now });
        if (m?.ok) push('memory', '记忆插件', 'ok', `${m.items?.length ?? 0} 条（${m.plugin || '—'}）`);
        else push('memory', '记忆插件', 'bad', `${m?.reason || '读不到'}${m?.dir ? `（${m.dir}）` : ''}`);
      }
    } catch (e) {
      push('memory', '记忆插件', 'bad', `读取抛错：${String(e?.message || e).slice(0, 60)}`);
    }
  }

  const bad = items.filter((i) => i.level === 'bad').length;
  const warn = items.filter((i) => i.level === 'warn').length;
  return { at: now, items, bad, warn, ok: bad === 0, phone };
}

/** 画成几行文本：绿 ✔ / 黄 ! / 红 ✘。 */
export function healthLines(res) {
  const mark = { ok: '✔', warn: '!', bad: '✘' };
  const lines = res.items.map((i) => `${mark[i.level] || '?'} ${i.label}  ${i.detail}`);
  lines.push(
    res.bad
      ? `→ ${res.bad} 项红${res.warn ? `、${res.warn} 项黄` : ''}：先把红的修掉，再看黄的。`
      : res.warn
        ? `→ 全绿，${res.warn} 项黄（数据旧了，还能跑）。`
        : '→ 全绿。',
  );
  return lines;
}