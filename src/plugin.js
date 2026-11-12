// plugin.js —— presence-gate 的 dsh 插件壳（宿主半侧）。
//
// 它做的事和 `node src/run.js --loop` 一模一样，只是**不再另开进程**：
//   · 定时器在宿主里每 tickMinutes 敲一拍，调 engine.tick()（和命令行共用同一份判定/生成/发送逻辑）；
//   · 生成走宿主自己的 ctx.llm（hostllm.js），不再 spawn 一个 Electron 跑 headless CLI；
//   · 发送还是走 qq-bridge 的 OneBot HTTP 口（send.js），这条路本来就不依赖进程边界。
//
// 为什么值得搬进来：命令行版本每次生成都要冷启动一次 Electron（12~17s，重写一次 60s），
// 而且得靠 Windows 计划任务 / 开机脚本保证「它一直活着」。住在宿主里这两件事都没了。
//
// 设计上的几条硬规矩：
//   1. **一条 inject 都不声明**。声明即硬依赖——宿主少一个服务，整条插件就不激活。
//      所有服务一律 ctx.get() 取，取不到就降级（没有 llm 就退回 spawn，没有 webServer 就没有状态接口）。
//      ⚠️ 2026-11-04 补：`apply()` 跑的那一刻服务往往**还没 provide**（webServer 由 web-app 稍后提供），
//      这时候 ctx.get() 只能拿到 undefined，而且之后不会有人再来问一次——老写法就是这样把
//      状态接口和 presence_status 全丢掉的（设置页 HTTP 404 的根因）。需要「晚点再挂」的东西
//      一律用 whenService()（内部是 cordis 的 ctx.inject），别在 apply 里取一次就完事。
//   2. **绝不把宿主带崩**。定时器用 setTimeout 链（不是 setInterval），上一拍没跑完不会叠上去；
//      每一拍整体包 try/catch，出错只记一行日志。
//   3. **配置只有一份**。还是仓库里的 config.json，`node src/run.js --set/--live/--stress-set`
//      改的就是它，插件下一拍自动生效（每拍重新读盘，不做缓存）。
//   4. 默认不改行为：dryRun=true 时只记日志、不发消息。

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, saveConfig, loadState, CONFIG_PATH, LOG_DIR } from './config.js';
import { tick } from './engine.js';
import { makeHostLlm } from './hostllm.js';
import { listForUi, applyChange, saveSecret } from './settings.js';
import { detectSources } from './detect.js';
import { watchVideo } from './video-host.js';

export const name = 'presence-gate';

/** 不声明任何必需服务（见文件头第 1 条）。 */
export const inject = [];

/** 状态接口前缀（浏览器/curl 都能看）。 */
const API_PREFIX = '/api/presence-gate';

const DEFAULTS = {
  enabled: true,
  // 覆盖 config.json 的 tickMinutes（一般不用动，留在这里是为了调试时想快跑）
  tickMinutes: 0,
  // 宿主刚起来那会儿会话/模型都还没热，先让一拍
  startupDelaySec: 60,
  // 每拍随机抖 0~jitterSec 秒：避免每次开机都在整点同一秒打模型
  jitterSec: 30,
  // 用宿主自己的模型；关掉就退回 llm.js（spawn dsh CLI）
  hostLlm: true,
  // 给模型一个 presence_status 工具
  tool: true,
  // 注册 /api/presence-gate/state
  statusApi: true,
};

/** 取可选服务（cordis 的 ctx 没有对应 inject 时属性访问会抛，必须走 get + try）。 */
function serviceOf(ctx, key) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(key);
      if (v) return v;
    }
  } catch {
    /* 没 inject，往下走 */
  }
  try {
    return ctx[key] ?? null;
  } catch {
    return null;
  }
}

/**
 * 等一个服务就绪再干活（cordis 的延迟注入）。
 *
 * ⚠️ 为什么必须有这个：`apply()` 是在插件**装载那一刻**跑的，而 `webServer` / `tools`
 * 这些服务由别的插件稍后 provide。那时 `ctx.get('webServer')` 还是 undefined，
 * 老写法（apply 里直接取一次，取不到就算了）就永远挂不上 —— 表现是设置页
 * `GET /api/presence-gate/state` 落到宿主鉴权层，浏览器只看到 HTTP 404。
 * `ctx.inject(deps, cb)` 是 cordis 官方的解法：服务一提供，cb 自己会被调起来。
 *
 * 没有 `ctx.inject`（老宿主 / 裸调用）就退回「当场试一次」，行为跟以前一样。
 */
function whenService(ctx, name, cb, log) {
  if (typeof ctx?.inject === 'function') {
    try {
      ctx.inject([name], (c) => cb(c || ctx));
      return;
    } catch (e) {
      log?.warn?.(`${name} 延迟注入失败：${String(e?.message || e).slice(0, 120)}`);
    }
  }
  cb(ctx);
}

/** 往 logs/plugin.log 记一行（宿主 console 拿不到，只能自己留痕）。 */
function noteMount(msg) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, 'plugin.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8');
  } catch {
    /* 日志不该影响主流程 */
  }
}

/** 打日志：宿主有 logger 就用它，没有就退 console（headless 调试时看得见）。 */
function makeLog(ctx) {
  const logger = serviceOf(ctx, 'logger');
  const tag = '[presence-gate]';
  const emit = (level, msg) => {
    try {
      if (logger && typeof logger[level] === 'function') return logger[level](msg);
      if (logger && typeof logger === 'function') return logger(msg);
    } catch {
      /* 日志永远不该影响主流程 */
    }
    const line = `${tag} ${msg}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
  };
}

const hhmmss = (ts) => {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** 读请求体（设置页最多几十字节；给 64KB 上限，别让人拿它当上传口）。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        try {
          req.destroy?.();
        } catch {
          /* 已经断了 */
        }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 一拍的人话摘要（写日志用）。 */
function summaryLine(r, ms) {
  const rec = r?.record || {};
  const bits = [hhmmss(rec.ts), rec.decision || '?', rec.reason || ''];
  const slot = rec.topic?.slot;
  if (slot) bits.push(`由头 ${slot}`);
  const text = rec.content?.text || '';
  if (text) bits.push(`${rec.content.chars} 字「${text.slice(0, 40)}」`);
  const dl = rec.delivery;
  if (dl) bits.push(dl.attempted ? (dl.ok ? '已发' : `发送失败 ${dl.error || ''}`) : `未发 ${dl.reason || ''}`);
  bits.push(`${Math.round(ms / 100) / 10}s`);
  return bits.filter(Boolean).join(' · ');
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config 来自 cordis.patch.yml 的 `config:`（全部可选）
 */
export function apply(ctx, config = {}) {
  const opt = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
  const log = makeLog(ctx);

  let disposed = false;
  let running = false;
  let timer = null;
  let ticks = 0;
  let lastAt = 0;
  let nextAt = 0;
  let lastError = null;
  let lastRun = null;

  const tickMinutes = () => {
    const fromOpt = Number(opt.tickMinutes) || 0;
    if (fromOpt > 0) return fromOpt;
    return Math.max(1, Number(loadConfig().tickMinutes) || 10);
  };

  /** 现在的生成器：优先宿主模型，不可用就返回 null（让 compose 走 llm.js 那条老路）。 */
  function llmNow(cfg) {
    if (opt.hostLlm === false) return { ready: false, reason: 'HOST_LLM_OFF' };
    const h = makeHostLlm(ctx, { cfg, log: log.warn });
    if (!h.ready) return h;
    return h;
  }

  /** 跑一拍。绝不抛。 */
  async function runOnce(reason = 'timer') {
    if (disposed) return { ok: false, skipped: 'disposed' };
    if (running) return { ok: false, skipped: 'busy' };

    running = true;
    const t0 = Date.now();
    try {
      const cfg = loadConfig();
      if (opt.enabled === false || cfg.enabled === false) {
        return { ok: false, skipped: 'disabled' };
      }

      const host = llmNow(cfg);
      if (!host.ready) log.info(`宿主模型不可用（${host.reason || '?'}），这一拍退回命令行生成器`);

      const r = await tick({
        generate: host.ready ? host.generate : null,
        llmReady: host.ready ? true : null,
        watchVideo: (id, options) => watchVideo(id, { ...options, host, ctx }),
      });

      ticks += 1;
      lastAt = Date.now();
      lastRun = {
        at: lastAt,
        reason,
        decision: r?.record?.decision || null,
        why: r?.record?.reason || null,
        slot: r?.record?.topic?.slot || null,
        chars: r?.record?.content?.chars || 0,
        text: r?.record?.content?.text || '',
        delivery: r?.record?.delivery || null,
        mail: r?.record?.mail || null,
        llm: host.ready ? { via: 'host', provider: host.provider, model: host.model } : { via: 'cli' },
        ms: lastAt - t0,
      };
      lastError = null;
      log.info(summaryLine(r, lastAt - t0));
      return { ok: true, run: lastRun };
    } catch (e) {
      lastError = String(e?.message || e).slice(0, 300);
      log.error(`这一拍出错（已兜住）：${lastError}`);
      return { ok: false, error: lastError };
    } finally {
      running = false;
    }
  }

  function intervalMs() {
    const base = tickMinutes() * 60_000;
    const jitter = Math.max(0, Number(opt.jitterSec) || 0) * 1000;
    return base + (jitter ? Math.floor(Math.random() * jitter) : 0);
  }

  function schedule(delayMs) {
    if (disposed) return;
    nextAt = Date.now() + delayMs;
    timer = setTimeout(async () => {
      timer = null;
      await runOnce('timer');
      schedule(intervalMs());
    }, Math.max(0, delayMs));
    // 不阻止宿主退出（Node 的 unref；Electron 里同样有效）
    timer.unref?.();
  }

  /** 状态快照：状态接口、工具、以及 --status 之外的自检都用它。 */
  function snapshot() {
    const cfg = loadConfig();
    let st = {};
    try {
      st = loadState();
    } catch {
      st = {};
    }
    const llm = lastRun?.llm || null;
    return {
      plugin: name,
      enabled: opt.enabled !== false && cfg.enabled !== false,
      dryRun: cfg.dryRun !== false,
      tickMinutes: tickMinutes(),
      ticks,
      running,
      lastAt: lastAt ? new Date(lastAt).toISOString() : null,
      nextAt: nextAt ? new Date(nextAt).toISOString() : null,
      lastError,
      last: lastRun,
      today: {
        real: Number(st?.real?.todaySent) || 0,
        sim: Number(st?.sim?.todaySent) || 0,
      },
      content: {
        mode: String(cfg?.content?.mode || 'auto'),
        llm,
      },
      send: {
        enabled: cfg?.send?.enabled === true,
        peer: cfg?.channels?.qq?.peerId || '',
      },
      mail: {
        enabled: cfg?.mail?.enabled === true,
        last: lastRun?.mail || null,
      },
      // 三条链路：开关 + 实测（插件装没装、配对没、盯梢开着没、手机端配置齐没）
      sources: {
        switches: {
          phone: cfg?.sources?.phone?.enabled !== false,
          qq: cfg?.sources?.qq?.enabled !== false,
          douyin: cfg?.sources?.douyin?.enabled !== false,
        },
        detect: detectSources(cfg),
      },
    };
  }

  /**
   * 设置页存一项。
   * 只认 settings.js 白名单里的路径；值先过校验再落盘，写进去的一定能跑。
   * 落盘用 saveConfig（和命令行 --set 写的是同一个文件），下一拍自动生效——
   * tick 每拍都重新读盘，不做缓存，所以不用重启。
   */
  async function saveFromBody(req) {
    let body = null;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch {
      return { ok: false, error: '请求体不是 JSON' };
    }
    if (!body || typeof body.path !== 'string' || !body.path) return { ok: false, error: '缺 path' };

    const r = applyChange(loadConfig(), body.path, body.value);
    if (!r.ok) return r;
    // 凭据类（IMAP 授权码）不进 config.json，单独落 credentials.json，且读了也不回显
    if (r.secret) {
      const s = saveSecret(r.path, r.value);
      if (!s.ok) return { ok: false, error: s.error };
      return {
        ok: true,
        path: r.path,
        value: '',
        secret: true,
        notes: ['授权码已存进 credentials.json（界面上只显示「已设置」，不会再显示出来）'],
        groups: listForUi(loadConfig()),
        state: snapshot(),
      };
    }
    try {
      saveConfig(r.cfg);
    } catch (e) {
      return { ok: false, error: `写 config.json 失败：${String(e?.message || e).slice(0, 120)}` };
    }

    const notes = [];
    if (r.path === 'dryRun' && r.value === true) notes.push('演练模式开着：之后只判定、不发');
    if (r.path === 'send.enabled' && r.value === true && r.cfg.dryRun !== false) {
      notes.push('「允许真的发送」开了，但演练模式还开着——两个都放行才会发出去');
    }
    if (r.path === 'enabled' && r.value === false) notes.push('总开关关掉了，这一拍之后就不动了');
    if (r.hostReset) {
      notes.push(`换了邮箱：IMAP 服务器原来是 ${r.hostReset.from}，已清成自动（会连 ${r.hostReset.to}）`);
    }
    if (r.path === 'mail.enabled' && r.value === true) {
      notes.push('读邮箱开了：下一次到间隔就去收信（填了账号和授权码才会真连）');
    }

    return { ok: true, path: r.path, value: r.value, notes, groups: listForUi(loadConfig()), state: snapshot() };
  }

  // ---------------------------------------------------------------- 可选：状态接口
  //
  // 挂路由要等 webServer 就绪（见 whenService 的注释）：apply 那一刻它还没 provide，
  // 直接取只会拿到 null，然后设置页永远 404。
  if (opt.statusApi !== false) {
    let apiMounted = false;
    const mountApi = (c) => {
      if (apiMounted) return;
      const ws = serviceOf(c, 'webServer');
      if (!ws || typeof ws.register !== 'function') {
        noteMount('api: webServer 拿不到，跳过');
        return;
      }
      try {
        // 用注入后的子 ctx 管生命周期（跟 dsh-client-modules 的写法一致）：
        // webServer 被替换时，路由会跟着一起卸掉再挂。
        const eff = (c || ctx).effect || ctx.effect;
        eff(() =>
          ws.register({
            kind: 'prefix',
            path: API_PREFIX,
            handler: async (req, res) => {
              const url = req.url || '/';
              const route = url.split('?')[0].slice(API_PREFIX.length) || '/';
              const json = (code, body) => {
                res.statusCode = code;
                res.setHeader('content-type', 'application/json; charset=utf-8');
                res.setHeader('cache-control', 'no-store');
                res.end(JSON.stringify(body, null, 2));
              };
              try {
                if (route === '/state' && (req.method || 'GET') === 'GET') return json(200, snapshot());
                if (route === '/config' && (req.method || 'GET') === 'GET') {
                  return json(200, { ok: true, path: CONFIG_PATH, groups: listForUi(loadConfig()) });
                }
                if (route === '/config' && req.method === 'POST') {
                  return json(200, await saveFromBody(req));
                }
                if (route === '/tick' && req.method === 'POST') {
                  if (running) return json(409, { ok: false, error: 'BUSY' });
                  const r = await runOnce('api');
                  return json(200, { ...r, state: snapshot() });
                }
                return json(404, { ok: false, error: 'NOT_FOUND' });
              } catch (e) {
                return json(500, { ok: false, error: String(e?.message || e).slice(0, 200) });
              }
            },
          })
        );
        apiMounted = true;
        noteMount(`api: 已挂上 ${API_PREFIX}`);
        log.info(`状态接口：GET ${API_PREFIX}/state，POST ${API_PREFIX}/tick`);
      } catch (e) {
        noteMount(`api: 挂载失败 ${String(e?.message || e).slice(0, 160)}`);
        log.warn(`状态接口没挂上：${String(e?.message || e).slice(0, 160)}`);
      }
    };
    whenService(ctx, 'webServer', mountApi, log);
  }

  // ---------------------------------------------------------------- 可选：给模型的工具
  // 同样要等 tools 就绪（apply 那一刻 tools 服务通常还没 provide，直接取会静默跳过）。
  if (opt.tool !== false) {
    let toolMounted = false;
    const mountTool = (c) => {
      if (toolMounted) return;
      const tools = serviceOf(c, 'tools');
      if (!tools || typeof tools.register !== 'function') {
        noteMount('tool: tools 拿不到，跳过');
        return;
      }
      toolMounted = true;
      (async () => {
        try {
          let defineTool = null;
          try {
            const mod = await import('@deepseek-ai/dsh-tools');
            defineTool = mod?.defineTool || null;
          } catch {
            defineTool = null;
          }
          // 拿不到宿主的 defineTool 就用等价实现（它只是补一次 schema 校验）
          const spec = (o) => (defineTool ? defineTool(o) : o);
          const tool = spec({
            name: 'presence_status',
            description:
              '看 presence-gate（主动找她说话的那个插件）现在是什么状态：开着没有、演练还是真发、' +
              '上一拍判了什么、今天已经发过几条、用的是哪个模型。' +
              'action="tick" 会在当前时刻立刻跑一拍（会真的生成一句话、dryRun 时不会发出去）。' +
              '只在用户问「你还在盯着我吗 / 刚才那条是你发的吗 / 今天发了几条」时调用；' +
              '不要用它去主动发消息——发不发由插件自己按由头判断。',
            parameters: {
              action: {
                type: 'string',
                enum: ['status', 'tick'],
                description: 'status=只看状态（默认）；tick=立刻跑一拍',
              },
            },
            async execute(args) {
              const action = String(args?.action || 'status');
              if (action === 'tick') {
                const r = await runOnce('tool');
                return { ok: Boolean(r?.ok), result: r, state: snapshot() };
              }
              return snapshot();
            },
            // ⚠️ 2026-11-04：DSH 的 tools.register 要求每个工具声明 output
            // （`{ schema, render }`），缺了直接 TypeError：must declare output。
            // 老版本没有这条，所以以前这段代码「看着能跑」。
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
            },
          });
          const dispose = tools.register(tool);
          if (typeof dispose === 'function') (c?.effect || ctx.effect)(() => dispose);
          const disposeWatch = tools.register(spec({
            name: 'presence_watch_video',
            description: '按抖音视频 ID 观察用户分享的视频。画面需要 dsh-video-storyboard 插件和支持图片的模型；不可用时返回可用口播及原因。此工具只观察，不发消息。',
            parameters: {
              id: { type: 'string', description: '分享卡片中的抖音视频 ID（aweme_id）' },
            },
            async execute(args) {
              const cfg = loadConfig();
              if (opt.enabled === false || cfg.enabled === false || cfg.content?.forward?.enabled === false) {
                return { ok: false, reason: 'FORWARD_DISABLED' };
              }
              const host = llmNow(cfg);
              const r = await watchVideo(args?.id, { cfg, host, llm: host.generate, ctx });
              // 只回有值的字段：undefined 会让工具的 output 校验报
              // 「value is not lossless JSON」，整次调用直接作废。
              const out = {
                ok: !!r.ok, id: r.id, source: r.source, summary: r.summary,
                reason: r.reason, visionReason: r.visionReason, durSec: r.durSec,
              };
              for (const k of Object.keys(out)) {
                if (out[k] === undefined || out[k] === null) delete out[k];
              }
              if (Array.isArray(r.frames) && r.frames.length) out.frames = r.frames.length;
              return out;
            },
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
            },
          }));
          if (typeof disposeWatch === 'function') (c?.effect || ctx.effect)(() => disposeWatch);
          noteMount('tool: presence_status、presence_watch_video 已挂上');
        } catch (e) {
          toolMounted = false;
          noteMount(`tool: 挂载失败 ${String(e?.message || e).slice(0, 160)}`);
          log.warn(`工具没挂上：${String(e?.message || e).slice(0, 160)}`);
        }
      })();
    };
    whenService(ctx, 'tools', mountTool, log);
  }

  // ---------------------------------------------------------------- 起钟
  const api = {
    snapshot,
    runOnce,
    stop() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      nextAt = 0;
    },
  };

  const firstDelay = Math.max(0, Number(opt.startupDelaySec) || 0) * 1000;
  schedule(firstDelay);
  log.info(
    `插件已激活：每 ${tickMinutes()} 分钟一拍，首拍 +${Math.round(firstDelay / 1000)}s，` +
      `dryRun=${loadConfig().dryRun !== false}${opt.hostLlm === false ? '，宿主模型已关（走 spawn）' : ''}`
  );

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => api.stop());
  } else if (typeof ctx.on === 'function') {
    try {
      ctx.on('dispose', () => api.stop());
    } catch {
      /* 老宿主没有 dispose 事件就算了；定时器已 unref，不会吊住退出 */
    }
  }

  // cordis 不要求返回值，但测试与自检需要拿到 api
  try {
    if (typeof ctx.set === 'function') ctx.set('presenceGate', api);
  } catch {
    /* 服务名被占了也不影响插件本身 */
  }

  return api;
}
