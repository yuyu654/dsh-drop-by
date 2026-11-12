// llm.js —— 借用宿主已有的 dsh CLI 生成一句话。
//
// 为什么不用 HTTP API：这台机器上已经有一套能跑的人格注入链路（dsh CLI + AGENT.md），
// 再要求用户填 key、选模型、维护第二套人格，纯属重复。这里只 spawn 一个 headless 进程，
// 由它带着人格生成，结果写文件再读回来（stdout 会有工具调用噪声，不能直接信）。
//
// 默认关闭：content.mode='template' 时根本不会走到这里，不花 token。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './config.js';

// 这两个路径跟着安装位置走，不该成为代码的一部分：
// 优先环境变量（DSH_ELECTRON / DSH_CLI），没有才用这台机器上见过的默认值。
const ENV_ELECTRON = String(process.env.DSH_ELECTRON || '').trim();
const ENV_CLI = String(process.env.DSH_CLI || '').trim();

const DEFAULTS = {
  electron: ENV_ELECTRON || 'D:\\DeepSeek Harness\\DeepSeek Harness.exe',
  cli: ENV_CLI || 'D:\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
  profile: 'headless',
  // 不带 --patch 走的是 deepseek-official 路由，要求环境里有 DEEPSEEK_API_KEY，
  // 而这台机器上只有桌面端登录态的 deepseek-account。overlay 负责把路由换过去。
  patch: path.join(ROOT, 'headless-overlay.yml'),
};

export const OUT_FILE = path.join(ROOT, 'data', 'compose-out.txt');

/**
 * overlay 里的工作目录/sandbox 根写死的是「这份插件装在哪」。
 * 换台机器/换个家目录时，把那段换成当前 ROOT 再落一份生成文件——
 * 不然 CLI 会去一个不存在的路径里跑，取不到人格也写不出结果。
 */
export function materializeOverlayText(raw) {
  const posix = String(raw || '').replace(/\\/g, '/');
  return posix.replaceAll(/C:\/Users\/[^/]+\/\.dsh\/presence-gate/g, ROOT.replace(/\\/g, '/'));
}

function overlayPathFor(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const fixed = materializeOverlayText(raw);
    if (fixed === raw) return file;
    const out = path.join(ROOT, 'data', 'headless-overlay.generated.yml');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, fixed);
    return out;
  } catch {
    return file;
  }
}

function llmCfg(cfg) {
  const l = cfg?.content?.llm || {};
  return {
    electron: String(l.electron || DEFAULTS.electron),
    cli: String(l.cli || DEFAULTS.cli),
    profile: String(l.profile || DEFAULTS.profile),
    patch: String(l.patch === undefined ? DEFAULTS.patch : l.patch),
    timeoutMs: Math.max(15_000, Number(l.timeoutMs) || 90_000),
  };
}

/** 能不能用 LLM：路径不在就直接说缺什么，别等跑到一半才报错。 */
export function llmAvailable(cfg) {
  const c = llmCfg(cfg);
  if (!fs.existsSync(c.electron)) return { ok: false, reason: 'LLM_NO_ELECTRON', electron: c.electron, cli: c.cli };
  // cli.js 在 app.asar 里面：普通 Node 的 existsSync 看不见，Electron 自己能读（asar 补丁）。
  // 所以只要路径形状对（.js 或 asar 内）就放行，真跑不起来时由 spawn 的 exit 报错。
  const cliOk = fs.existsSync(c.cli) || /app\.asar/i.test(c.cli) || c.cli.endsWith('.js');
  if (!cliOk) return { ok: false, reason: 'LLM_NO_CLI', electron: c.electron, cli: c.cli };
  return {
    ok: true,
    electron: c.electron,
    cli: c.cli,
    profile: c.profile,
    patch: c.patch && fs.existsSync(c.patch) ? overlayPathFor(c.patch) : '',
    timeoutMs: c.timeoutMs,
  };
}

/**
 * 跑一次生成。prompt 里已经含人格与约束；这里只负责「把结果拿回来」。
 * 返回 { ok, text, reason, ms, raw }
 */
export async function generate({ prompt, cfg, timeoutMs } = {}) {
  const avail = llmAvailable(cfg);
  if (!avail.ok) return { ok: false, reason: avail.reason };

  try {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, '', 'utf8');
  } catch (e) {
    return { ok: false, reason: 'LLM_OUT_UNWRITABLE', note: String(e?.message || e) };
  }

  const full =
    `${prompt}\n\n写完把这句话单独写进这个文件（只写那一句，不加引号、不加前缀）：\n${OUT_FILE}\n` +
    '不需要输出到聊天里，也不要调用别的工具，写完就结束。';

  const args = [avail.cli, '--profile', avail.profile];
  if (avail.patch) args.push('--patch', avail.patch);
  args.push(full);
  const t0 = Date.now();

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn(avail.electron, args, {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // 实测：不加这个会被 Chromium 的磁盘缓存在无控制台环境里卡死
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
    } catch (e) {
      resolve({ ok: false, reason: 'LLM_SPAWN_FAILED', note: String(e?.message || e) });
      return;
    }

    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经没了 */
      }
    }, Math.max(15_000, Number(timeoutMs) || avail.timeoutMs));

    child.stdout?.on('data', (b) => {
      out += String(b);
    });
    child.stderr?.on('data', (b) => {
      out += String(b);
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, reason: 'LLM_ERROR', note: String(e?.message || e) });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      let text = '';
      try {
        text = fs.readFileSync(OUT_FILE, 'utf8').trim();
      } catch {
        /* 没写就是失败 */
      }
      if (text) {
        resolve({ ok: true, text, ms: Date.now() - t0, code, raw: out.slice(-400) });
      } else {
        const hint = /MISSING_CREDENTIAL/i.test(out)
          ? 'MISSING_CREDENTIAL (检查 headless-overlay.yml 里的 provider，或给 CLI 配 DEEPSEEK_API_KEY)'
          : '';
        resolve({
          ok: false,
          reason: /MISSING_CREDENTIAL/i.test(out) ? 'LLM_NO_CREDENTIAL' : timeoutGuard(out, t0, avail.timeoutMs) ? 'LLM_TIMEOUT' : 'LLM_NO_OUTPUT',
          ms: Date.now() - t0,
          code,
          hint,
          raw: out.slice(-400),
        });
      }
    });
  });
}

function timeoutGuard(out, t0, timeoutMs) {
  return Date.now() - t0 >= timeoutMs - 1000 && !out.trim();
}
