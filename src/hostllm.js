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
export function makeHostLlm(ctx, { cfg, log = () => {} } = {}) {
  const llm = serviceOf(ctx, 'llm');
  if (!llm || typeof llm.stream !== 'function') {
    return { ready: false, reason: 'HOST_LLM_MISSING' };
  }

  const prefer = cfg?.content?.llm?.provider && cfg?.content?.llm?.model
    ? { provider: cfg.content.llm.provider, model: cfg.content.llm.model }
    : null;
  const target = pickTarget(ctx, prefer);
  if (!target) return { ready: false, reason: 'HOST_LLM_NO_MODEL' };

  const maxTokens = Math.max(32, Number(cfg?.content?.llm?.maxTokens) || 220);
  const temperature = Number.isFinite(Number(cfg?.content?.llm?.temperature))
    ? Number(cfg.content.llm.temperature)
    : 0.85;

  // 一次尝试：失败就地返回结果，重试由下面的 generate() 统一做。
  async function attemptOnce({ prompt, timeoutMs, images, modelTarget = target, minOutputTokens = 0 } = {}) {
    const t0 = Date.now();
    let out = '';
    const ac = new AbortController();
    // 宿主没有超时保护的话，一句生成能把这一拍挂死。给个上限，别让 tick 叠在那儿。
    const ms = Math.max(1000, Number(timeoutMs) || Number(cfg?.content?.llm?.timeoutMs) || 60_000);
    const killer = setTimeout(() => ac.abort(new Error('HOST_LLM_TIMEOUT')), ms);
    killer.unref?.();

    try {
      const stream = llm.stream({
        provider: modelTarget.provider,
        model: modelTarget.model,
        messages: [userMessage(prompt, images)],
        maxTokens: Math.max(maxTokens, minOutputTokens),
        temperature,
        signal: ac.signal,
      });
      let finishKind;
      for await (const chunk of stream) {
        if (!chunk) continue;
        if (chunk.type === 'finish') finishKind = chunk.reason?.kind;
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
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
      if (!text) return { ok: false, reason: 'HOST_LLM_EMPTY', note: finishKind ? `finish=${finishKind}` : '',
        provider: modelTarget.provider, model: modelTarget.model };
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
   * 重试只会继续堵着 tick。次数由 content.llm.retries 控制，默认 1（多试一次）。
   */
  const retries = Math.max(0, Math.min(3, Number(cfg?.content?.llm?.retries ?? 1)));
  async function generate(opts = {}) {
    let r = await attemptOnce(opts);
    for (let i = 0; i < retries && !r.ok; i += 1) {
      if (r.reason === 'HOST_LLM_TIMEOUT') break;
      log(`生成失败（${r.reason}${r.note ? `：${r.note}` : ''}），重试第 ${i + 1} 次`);
      r = await attemptOnce(opts);
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

  return {
    ready: true,
    observeVideo,
    provider: target.provider,
    model: target.model,
    from: target.from,
    generate,
  };
}
