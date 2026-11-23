// hostllm.js —— 用宿主自己的模型生成一句话（插件专用）。
//
// 为什么要有这一条路：命令行版本的 llm.js 会 spawn 一整个 Electron 进程跑 headless
// CLI，一次 12~17 秒，重写一次实测 60 秒。插件本来就在宿主进程里，直接把请求交给
// `ctx.llm` 就行——不用另开进程、不用管 profile overlay、也不额外花一份钱。
//
// 只做「把 prompt 变成一句话」这一件事，跟 llm.js 的 generate() 同形：
//   { ok:true, text, ms } / { ok:false, reason, note }
// 这样 compose.js 不用知道调用方是谁。
//
// 取服务一律走 ctx.get()：cordis 的 ctx 是 Proxy，服务没在 inject 里声明时
// 属性访问会**直接抛**（"cannot get property … without inject"），`?.` 挡不住。

import { randomUUID } from 'node:crypto';
import { sharedSessionId, extractSessionModelFromEvents } from './channels/internal.js';
import { readChatData } from './channels/douyin-im.js';

/** 取一个可选服务，取不到返回 null，绝不抛。 */
function serviceOf(ctx, name) {
  if (!ctx) return null;
  try {
    if (typeof ctx.get === 'function') {
      const v = ctx.get(name);
      if (v) return v;
    }
  } catch {
    /* 没声明 inject 时 get 会抛，往下走 */
  }
  try {
    return ctx[name] ?? null;
  } catch {
    return null;
  }
}

/** DSH 的 MessageBase 最小形状。宿主自带的 createUserMessage 也就是这几项。 */
function userMessage(text, images = []) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text ?? '') }, ...images],
    source: { kind: 'plugin', plugin: 'dsh-drop-by' },
  };
}

let activeHostCtx = null;
let cachedModels = [];

export function setHostLlmContext(ctx) {
  activeHostCtx = ctx || null;
}

export function parseExplorationModelSpec(raw, catalog = []) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const idx = s.indexOf(':');
  if (idx > 0 && idx < s.length - 1) {
    return { provider: s.slice(0, idx).trim(), model: s.slice(idx + 1).trim() };
  }
  const hit = (Array.isArray(catalog) ? catalog : []).find((m) => m.model === s);
  return hit ? { provider: hit.provider, model: hit.model } : { provider: '', model: s };
}

export function resolveBoundSessionModel(ctx = activeHostCtx) {
  const sid = sharedSessionId();
  if (!sid) return null;
  try {
    const events = serviceOf(ctx, 'sessions')?.get?.(sid)?.snapshotEvents?.();
    const picked = extractSessionModelFromEvents(events);
    if (picked?.provider && picked?.model) return { ...picked, from: 'bound-session' };
  } catch { /* ignore */ }
  try {
    const saved = readChatData('external-chat')?.sessionModel;
    if (saved?.provider && saved?.model && (!saved.sessionId || saved.sessionId === sid)) {
      return { provider: saved.provider, model: saved.model, from: 'bound-session' };
    }
  } catch { /* ignore */ }
  try {
    const opt = serviceOf(ctx, 'agents')?.get?.(sid)?.options;
    if (opt?.provider && opt?.model) {
      return { provider: String(opt.provider), model: String(opt.model), from: 'bound-session' };
    }
  } catch { /* ignore */ }
  return null;
}

function collectModelsFromList(providerId, providerName, rows, out, seen) {
  for (const m of Array.isArray(rows) ? rows.slice(0, 200) : []) {
    if (m?.provider && m.provider !== providerId) continue;
    const mid = typeof m === 'string' ? m.trim() : String(m?.id || m?.model || '').trim();
    if (!mid) continue;
    const key = `${providerId}:${mid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      provider: providerId,
      providerName: providerName || providerId,
      model: mid,
      modelName: String((typeof m === 'object' ? (m?.name || m?.label) : '') || mid).trim(),
    });
  }
}

function collectSyncModelsFromLlm(ctx) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm) return [];
  const out = [];
  const seen = new Set();
  try {
    const providers = (typeof llm.listProviders === 'function' ? llm.listProviders() : null) || [];
    for (const p of Array.isArray(providers) ? providers.slice(0, 32) : []) {
      const pid = String(p?.id || p?.provider || '').trim();
      if (!pid) continue;
      const pName = String(p?.displayName || p?.name || pid).trim();
      if (Array.isArray(p?.models)) collectModelsFromList(pid, pName, p.models, out, seen);
      if (typeof llm.listModels === 'function') {
        try {
          const maybe = llm.listModels(pid);
          if (Array.isArray(maybe)) {
            collectModelsFromList(pid, pName, maybe, out, seen);
          } else if (maybe && typeof maybe.then === 'function') {
            maybe.then((rows) => {
              if (!Array.isArray(rows) || !rows.length) return;
              const next = [...cachedModels];
              const mergedSeen = new Set(next.map((m) => `${m.provider}:${m.model}`));
              collectModelsFromList(pid, pName, rows, next, mergedSeen);
              cachedModels = next;
            }).catch(() => {});
          }
        } catch { /* ignore sync listModels failure */ }
      }
    }
  } catch { /* ignore */ }
  return out;
}

export async function refreshHostModelCatalog(ctx = activeHostCtx) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm || typeof llm.listProviders !== 'function') return getHostModelCatalog(ctx);
  const out = [];
  const seen = new Set();
  try {
    const providers = (await Promise.resolve(llm.listProviders())) || [];
    for (const p of Array.isArray(providers) ? providers.slice(0, 32) : []) {
      const pid = String(p?.id || p?.provider || '').trim();
      if (!pid) continue;
      const pName = String(p?.displayName || p?.name || pid).trim();
      if (Array.isArray(p?.models)) collectModelsFromList(pid, pName, p.models, out, seen);
      if (typeof llm.listModels === 'function') {
        let timer;
        try {
          const rows = await Promise.race([
            Promise.resolve().then(() => llm.listModels(pid)),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1500); timer.unref?.(); }),
          ]);
          if (Array.isArray(rows)) collectModelsFromList(pid, pName, rows, out, seen);
        } catch { /* ignore provider failure */ }
        finally { clearTimeout(timer); }
      }
    }
    if (out.length) cachedModels = out;
  } catch { /* ignore */ }
  return getHostModelCatalog(ctx);
}

export function getHostModelCatalog(ctx = activeHostCtx) {
  const merged = [];
  const seen = new Set();
  for (const item of [...collectSyncModelsFromLlm(ctx), ...cachedModels]) {
    const key = `${item.provider}:${item.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return {
    models: merged,
    boundModel: resolveBoundSessionModel(ctx),
    defaultModel: pickTarget(ctx, null),
  };
}

/**
 * 这一轮用哪个模型。
 * 顺序：插件配置指定 → 宿主的全局默认（设置页里选的）→ 第一个可用 provider 的第一个模型。
 * 都拿不到就返回 null（调用方据此判定 "llm 不可用"，退回 spawn 或模板）。
 */
function pickTarget(ctx, prefer) {
  if (prefer && prefer.provider && prefer.model) return { provider: prefer.provider, model: prefer.model, from: 'config' };

  const dm = serviceOf(ctx, 'agentDefaultModel');
  try {
    const sel = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : null;
    if (sel && sel.provider && sel.model) return { provider: sel.provider, model: sel.model, from: 'default-model' };
  } catch {
    /* 宿主版本不同，换下一条 */
  }

  const llm = serviceOf(ctx, 'llm');
  try {
    const providers = (llm && typeof llm.listProviders === 'function' ? llm.listProviders() : null) || [];
    for (const p of providers) {
      const id = p && (p.id || p.provider);
      if (!id) continue;
      // listModels 可能是异步的；pickTarget 保持同步，所以这里只认已经同步给出来的
      if (Array.isArray(p.models) && p.models.length) {
        const m = p.models[0];
        const mid = typeof m === 'string' ? m : m && m.id;
        if (mid) return { provider: id, model: mid, from: 'first-provider' };
      }
    }
  } catch {
    /* 没有就算了 */
  }
  return null;
}

/**
 * 造一个 llm.js 同形的生成器。
 * @returns {{ready:boolean, reason?:string, provider?:string, model?:string, generate?:Function}}
 */
export function makeHostLlm(ctx, { cfg, log = () => {}, forExploration = false } = {}) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ready: false, reason: 'HOST_LLM_MISSING' };
  }

  const prefer = cfg?.content?.llm?.provider && cfg?.content?.llm?.model
    ? { provider: cfg.content.llm.provider, model: cfg.content.llm.model }
    : null;
  let target = null;
  if (forExploration) {
    const explicit = parseExplorationModelSpec(cfg?.exploration?.model, getHostModelCatalog(ctx).models);
    if (explicit?.model) {
      const fallbackProvider = resolveBoundSessionModel(ctx)?.provider || pickTarget(ctx, prefer)?.provider || '';
      if (explicit.provider || fallbackProvider) {
        target = { provider: explicit.provider || fallbackProvider, model: explicit.model, from: 'exploration-config' };
      }
    }
    if (!target) {
      target = resolveBoundSessionModel(ctx) || pickTarget(ctx, prefer);
    }
  } else {
    target = pickTarget(ctx, prefer);
  }
  if (!target) return { ready: false, reason: 'HOST_LLM_NO_MODEL' };

  // 默认上限放宽到 1024：带思考/reasoning 的模型（如 deepseek-v4.1-flash）会把推理过程也计入 maxTokens，
  // 220 极易在正文还没吐出前就被 max-tokens 截断。
  const maxTokens = Math.max(32, Number(cfg?.content?.llm?.maxTokens) || 1024);
  const temperature = Number.isFinite(Number(cfg?.content?.llm?.temperature))
    ? Number(cfg.content.llm.temperature)
    : 0.85;

  // 一次尝试：失败就地返回结果，重试由下面的 generate() 统一做。
  async function attemptOnce({ prompt, timeoutMs, images, modelTarget = target, minOutputTokens = 0 } = {}) {
    const t0 = Date.now();
    let out = '';
    let reasoningChars = 0;
    let outputTokens = null;
    const ac = new AbortController();
    // 宿主没有超时保护的话，一句生成能把这一拍挂死。给个上限，别让 tick 叠在那儿。
    const ms = Math.max(1000, Number(timeoutMs) || Number(cfg?.content?.llm?.timeoutMs) || 60_000);
    const killer = setTimeout(() => ac.abort(new Error('HOST_LLM_TIMEOUT')), ms);
    killer.unref?.();
    const effectiveMaxTokens = Math.max(maxTokens, Number(minOutputTokens) || 0);

    try {
      const stream = llm.stream({
        provider: modelTarget.provider,
        model: modelTarget.model,
        messages: [userMessage(prompt, images)],
        maxTokens: effectiveMaxTokens,
        temperature,
        signal: ac.signal,
      });
      let finishKind;
      for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.type === 'finish') finishKind = chunk.reason?.kind;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
        if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') reasoningChars += chunk.text.length;
        if (chunk.type === 'usage' && chunk.usage && Number.isFinite(Number(chunk.usage.outputTokens))) {
          outputTokens = Number(chunk.usage.outputTokens);
        }
        if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
          const f = chunk.reason.failure || {};
          return {
            ok: false,
            reason: 'HOST_LLM_ERROR',
            note: String(f.message || f.code || '？').slice(0, 200),
            provider: modelTarget.provider,
            model: modelTarget.model,
          };
        }
      }
      const text = String(out || '').trim();
      if (!text) {
        const parts = [];
        if (finishKind) parts.push(`finish=${finishKind}`);
        if (reasoningChars > 0) parts.push(`reasoning=${reasoningChars}字`);
        if (outputTokens != null) parts.push(`outTokens=${outputTokens}`);
        parts.push(`maxTokens=${effectiveMaxTokens}`);
        return {
          ok: false,
          reason: 'HOST_LLM_EMPTY',
          note: parts.join(' · '),
          finishKind,
          reasoningChars,
          maxTokens: effectiveMaxTokens,
          provider: modelTarget.provider,
          model: modelTarget.model,
        };
      }
      return { ok: true, text, ms: Date.now() - t0, provider: modelTarget.provider, model: modelTarget.model, via: 'host' };
    } catch (e) {
      const timeout = ac.signal.aborted;
      log(`生成失败：${String(e?.message || e).slice(0, 160)}`);
      return {
        ok: false,
        reason: timeout ? 'HOST_LLM_TIMEOUT' : 'HOST_LLM_ERROR',
        note: String(e?.message || e).slice(0, 200),
        provider: modelTarget.provider,
        model: modelTarget.model,
      };
    } finally {
      clearTimeout(killer);
    }
  }

  /**
   * 失败再试一次：模型侧偶发的报错/空文本，隔一两秒往往就好了（2026-11-09 17:24
   * 那拍就是一次服务端错误、一次空文本）。超时不重试——那一拍已经等得太久，
   * 重试只会继续堵着 tick。若因思考耗尽 maxTokens 返回空，重试时顺手翻倍预算。
   * 次数由 content.llm.retries 控制，默认 1（多试一次）。
   */
  const retries = Math.max(0, Math.min(3, Number(cfg?.content?.llm?.retries ?? 1)));
  async function generate(opts = {}) {
    let attemptOpts = { ...opts };
    let r = await attemptOnce(attemptOpts);
    for (let i = 0; i < retries && !r.ok; i += 1) {
      if (r.reason === 'HOST_LLM_TIMEOUT') break;
      if (r.reason === 'HOST_LLM_EMPTY' && (r.finishKind === 'max-tokens' || r.reasoningChars > 0)) {
        const currentBudget = Math.max(maxTokens, Number(attemptOpts.minOutputTokens) || 0, 512);
        attemptOpts = { ...attemptOpts, minOutputTokens: Math.min(8192, currentBudget * 2) };
      }
      log(`生成失败（${r.reason}${r.note ? `：${r.note}` : ''}），重试第 ${i + 1} 次`);
      r = await attemptOnce(attemptOpts);
    }
    if (!r.ok) {
      log(`生成最终失败（${r.reason}${r.note ? `：${r.note}` : ''}，model=${target.provider}:${target.model}）`);
    }
    return r;
  }

  const forward = cfg?.content?.forward || {};
  const visionTarget = forward.visionModel
    ? { provider: forward.visionProvider || target.provider, model: forward.visionModel }
    : target;
  async function observeVideo({ prompt, images, timeoutMs }) {
    let info;
    try {
      info = await llm.resolveModelInfo?.(visionTarget.provider, visionTarget.model, AbortSignal.timeout(forward.visionInfoTimeoutMs ?? 10_000));
    } catch {
      return { ok: false, reason: 'VIDEO_MODEL_UNVERIFIED' };
    }
    // DSH 会把不支持图片的请求转成纯文本。必须在调用前核对能力。
    if (!Array.isArray(info?.inputModalities)) return { ok: false, reason: 'VIDEO_MODEL_UNVERIFIED' };
    if (!info.inputModalities.includes('image')) return { ok: false, reason: 'VIDEO_MODEL_NO_IMAGE' };
    const content = images.map((attachment) => ({ type: 'image', attachment }));
    return attemptOnce({ prompt, images: content, timeoutMs, modelTarget: visionTarget });
  }

  async function saveImage({ data, mediaType = 'image/jpeg', name = 'explore-page.jpg' } = {}) {
    const attachments = serviceOf(ctx, 'attachments');
    if (!attachments || typeof attachments.saveImage !== 'function' || !data) return null;
    try {
      return await attachments.saveImage.call(attachments, { data, mediaType, name });
    } catch {
      return null;
    }
  }

  return {
    ready: true,
    observeVideo,
    saveImage,
    provider: target.provider,
    model: target.model,
    from: target.from,
    generate,
  };
}
