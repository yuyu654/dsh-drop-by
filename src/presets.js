// presets.js —— 一键节奏套餐（自定义 + 安静克制 / 日常陪伴 / 粘人热聊 / 极简省流）。
//
// 行为约束：
//   1. 默认模式为 'custom'（保留用户已有配置，不覆盖安全闸、通道、作息、课表、人设、兴趣）；
//   2. 从 'custom' 首次切到任意套餐前，自动把用户原参数快照到 cfg.presets.customSnapshot；
//      之后随时点回「自定义」，即可一键恢复原来的个人设置；
//   3. 在下方手动调整任意套餐管辖的参数后，改动正常生效，模式自动切回 'custom' 并更新快照；
//   4. 在「高级」里可选择任一套餐、选中其子参数进行自定义修改（带单位与范围校验）；
//      若修改的正是当前激活套餐，新值同步立即生效到当前配置（保持该套餐激活状态）。

export const PRESET_ORDER = ['quiet', 'daily', 'clingy', 'lite'];

export const PRESET_FIELDS = [
  { path: 'rules.dailyCap', label: '每日主动上限', type: 'int', min: 1, max: 30, unit: '条' },
  { path: 'rules.minGapMin', label: '主动最短间隔', type: 'int', min: 5, max: 1440, unit: '分钟' },
  { path: 'rules.gapByTier.enabled', label: '间隔按由头分档', type: 'bool' },
  { path: 'rules.gapByTier.eventMin', label: '事件档间隔', type: 'int', min: 1, max: 1440, unit: '分钟' },
  { path: 'rules.gapByTier.chatMin', label: '闲聊档间隔', type: 'int', min: 1, max: 1440, unit: '分钟' },
  { path: 'rules.judge.enabled', label: '让模型自己决定说不说', type: 'bool' },
  {
    path: 'rules.receptivity.mode',
    label: '本地看眼色小算盘',
    type: 'select',
    options: [['off', '关闭'], ['shadow', '只记分观察'], ['gate', '启用低分拦截']],
  },
  { path: 'rules.receptivity.threshold', label: '小算盘低分拦截门槛', type: 'num', min: 0.05, max: 0.7, unit: '分' },
  { path: 'rules.chitchat.enabled', label: '没什么事也可以说一句', type: 'bool' },
  { path: 'rules.chitchat.perDay', label: '随口话每天上限', type: 'int', min: 1, max: 10, unit: '条' },
  { path: 'rules.closingCooldownMin', label: '对方收尾后冷静期', type: 'int', min: 0, max: 720, unit: '分钟' },
  { path: 'rules.qqContinuation', label: '热聊补一句', type: 'bool' },
  { path: 'exploration.auto', label: '自动自主探索', type: 'bool' },
  { path: 'exploration.intervalMinutes', label: '自动探索间隔', type: 'int', min: 15, max: 1440, unit: '分钟' },
  {
    path: 'exploration.mode',
    label: '探索方式',
    type: 'select',
    options: [['deep', '深度推进'], ['light', '轻量化探索']],
  },
  {
    path: 'exploration.bias',
    label: '探索倾向',
    type: 'select',
    options: [['leisure', '偏休闲'], ['balanced', '均衡'], ['research', '偏研究']],
  },
  {
    path: 'exploration.browseMode',
    label: '网页与看图方式',
    type: 'select',
    options: [['vision_light', '轻量看图'], ['browser_agent', '调网站浏览']],
  },
  { path: 'exploration.offPeakOnly', label: '只在谷时自动探索', type: 'bool' },
  { path: 'exploration.builtinFeeds', label: '启用内置轻量探索源', type: 'bool' },
  { path: 'exploration.offerShare', label: '让探索进展参与主动分享', type: 'bool' },
];

const FIELD_MAP = new Map(PRESET_FIELDS.map((f) => [f.path, f]));

export const DEFAULT_PRESETS = Object.freeze({
  quiet: {
    id: 'quiet',
    label: '安静克制',
    desc: '每天最多 2 条 · 间隔 6 小时 · 仅真有事才开口，关掉随口搭话与自动探索',
    values: {
      'rules.dailyCap': 2,
      'rules.minGapMin': 360,
      'rules.gapByTier.enabled': false,
      'rules.gapByTier.eventMin': 60,
      'rules.gapByTier.chatMin': 360,
      'rules.judge.enabled': true,
      'rules.receptivity.mode': 'gate',
      'rules.receptivity.threshold': 0.38,
      'rules.chitchat.enabled': false,
      'rules.chitchat.perDay': 1,
      'rules.closingCooldownMin': 180,
      'rules.qqContinuation': false,
      'exploration.auto': false,
      'exploration.intervalMinutes': 240,
      'exploration.mode': 'deep',
      'exploration.bias': 'balanced',
      'exploration.browseMode': 'vision_light',
      'exploration.offPeakOnly': false,
      'exploration.builtinFeeds': true,
      'exploration.offerShare': false,
    },
  },
  daily: {
    id: 'daily',
    label: '日常陪伴',
    desc: '每天最多 4 条 · 分档间隔 · 开深度探索与轻分享，像正常熟人聊天',
    values: {
      'rules.dailyCap': 4,
      'rules.minGapMin': 180,
      'rules.gapByTier.enabled': true,
      'rules.gapByTier.eventMin': 60,
      'rules.gapByTier.chatMin': 180,
      'rules.judge.enabled': true,
      'rules.receptivity.mode': 'shadow',
      'rules.receptivity.threshold': 0.28,
      'rules.chitchat.enabled': true,
      'rules.chitchat.perDay': 2,
      'rules.closingCooldownMin': 120,
      'rules.qqContinuation': false,
      'exploration.auto': true,
      'exploration.intervalMinutes': 180,
      'exploration.mode': 'deep',
      'exploration.bias': 'balanced',
      'exploration.browseMode': 'vision_light',
      'exploration.offPeakOnly': false,
      'exploration.builtinFeeds': true,
      'exploration.offerShare': true,
    },
  },
  clingy: {
    id: 'clingy',
    label: '粘人热聊',
    desc: '每天最多 8 条 · 间隔 1.5 小时 · 开热聊补一句、高频随口话与休闲探索',
    values: {
      'rules.dailyCap': 8,
      'rules.minGapMin': 90,
      'rules.gapByTier.enabled': true,
      'rules.gapByTier.eventMin': 45,
      'rules.gapByTier.chatMin': 90,
      'rules.judge.enabled': true,
      'rules.receptivity.mode': 'shadow',
      'rules.receptivity.threshold': 0.2,
      'rules.chitchat.enabled': true,
      'rules.chitchat.perDay': 4,
      'rules.closingCooldownMin': 60,
      'rules.qqContinuation': true,
      'exploration.auto': true,
      'exploration.intervalMinutes': 120,
      'exploration.mode': 'deep',
      'exploration.bias': 'leisure',
      'exploration.browseMode': 'vision_light',
      'exploration.offPeakOnly': false,
      'exploration.builtinFeeds': true,
      'exploration.offerShare': true,
    },
  },
  lite: {
    id: 'lite',
    label: '极简省流',
    desc: '省 Token 优先 · 关每拍模型判断改用本地小算盘 · 仅谷时轻量化探索',
    values: {
      'rules.dailyCap': 3,
      'rules.minGapMin': 240,
      'rules.gapByTier.enabled': false,
      'rules.gapByTier.eventMin': 60,
      'rules.gapByTier.chatMin': 240,
      'rules.judge.enabled': false,
      'rules.receptivity.mode': 'gate',
      'rules.receptivity.threshold': 0.3,
      'rules.chitchat.enabled': false,
      'rules.chitchat.perDay': 1,
      'rules.closingCooldownMin': 120,
      'rules.qqContinuation': false,
      'exploration.auto': true,
      'exploration.intervalMinutes': 240,
      'exploration.mode': 'light',
      'exploration.bias': 'balanced',
      'exploration.browseMode': 'vision_light',
      'exploration.offPeakOnly': true,
      'exploration.builtinFeeds': true,
      'exploration.offerShare': true,
    },
  },
});

export function isPresetFieldPath(p) {
  return FIELD_MAP.has(String(p || ''));
}

function readPath(obj, dotted) {
  let cur = obj;
  for (const part of String(dotted).split('.')) {
    if (!cur || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function writePath(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

export function coercePresetFieldValue(fieldPath, raw) {
  const spec = FIELD_MAP.get(String(fieldPath || ''));
  if (!spec) return { ok: false, error: `未知套餐参数：${fieldPath}` };
  if (spec.type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true' || raw === 1 || raw === '1') return { ok: true, value: true };
    if (raw === 'false' || raw === 0 || raw === '0') return { ok: true, value: false };
    return { ok: false, error: `${spec.label} 须为开关值` };
  }
  if (spec.type === 'select') {
    const allowed = spec.options.map(([v]) => v);
    const s = String(raw ?? '').trim();
    if (!allowed.includes(s)) return { ok: false, error: `${spec.label} 选项无效` };
    return { ok: true, value: s };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, error: `${spec.label} 须为有效数字` };
  const val = spec.type === 'int' ? Math.round(n) : Number(n.toFixed(2));
  if (spec.min != null && val < spec.min) return { ok: false, error: `${spec.label} 不能小于 ${spec.min}${spec.unit || ''}` };
  if (spec.max != null && val > spec.max) return { ok: false, error: `${spec.label} 不能大于 ${spec.max}${spec.unit || ''}` };
  return { ok: true, value: val };
}

export function extractPresetValues(cfg) {
  const out = {};
  for (const f of PRESET_FIELDS) {
    const v = readPath(cfg, f.path);
    if (v !== undefined) out[f.path] = v;
  }
  const exp = cfg?.exploration;
  if (exp && typeof exp === 'object' && Object.hasOwn(exp, 'leisureEvery') && !Object.hasOwn(exp, 'bias')) {
    out['exploration.leisureEvery'] = exp.leisureEvery;
  }
  return out;
}

export function effectivePresetValues(cfg, presetId) {
  const base = DEFAULT_PRESETS[presetId];
  if (!base) return null;
  const over = cfg?.presets?.overrides?.[presetId];
  const merged = { ...base.values };
  if (over && typeof over === 'object') {
    for (const [k, v] of Object.entries(over)) {
      if (FIELD_MAP.has(k)) merged[k] = v;
    }
  }
  return merged;
}

export function activePresetId(cfg) {
  const raw = String(cfg?.presets?.active || 'custom');
  return raw === 'custom' || Object.hasOwn(DEFAULT_PRESETS, raw) ? raw : 'custom';
}

function ensurePresetsObj(next) {
  if (!next.presets || typeof next.presets !== 'object') {
    next.presets = { active: 'custom', customSnapshot: null, overrides: {} };
  }
  if (!next.presets.overrides || typeof next.presets.overrides !== 'object') {
    next.presets.overrides = {};
  }
  if (!next.presets.active) next.presets.active = 'custom';
  return next.presets;
}

/**
 * 切换套餐或切回「自定义」。
 * - 从 custom 切到某套餐时，先自动保存当前参数快照到 customSnapshot；
 * - 切回 custom 时，从 customSnapshot 恢复用户原来的参数。
 */
export function applyPresetToConfig(cfg, targetId) {
  const id = String(targetId || '').trim();
  if (id !== 'custom' && !Object.hasOwn(DEFAULT_PRESETS, id)) {
    return { ok: false, error: `未知套餐：${id}` };
  }
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const p = ensurePresetsObj(next);
  const prevActive = activePresetId(next);

  if (id === 'custom') {
    const snap = p.customSnapshot && typeof p.customSnapshot === 'object' ? p.customSnapshot : null;
    if (snap) {
      for (const f of PRESET_FIELDS) {
        if (Object.hasOwn(snap, f.path)) writePath(next, f.path, snap[f.path]);
      }
      if (Object.hasOwn(snap, 'exploration.leisureEvery') && !Object.hasOwn(snap, 'exploration.bias')) {
        writePath(next, 'exploration.leisureEvery', snap['exploration.leisureEvery']);
        if (next.exploration && Object.hasOwn(next.exploration, 'bias')) {
          delete next.exploration.bias;
        }
      } else if (next.exploration && Object.hasOwn(next.exploration, 'leisureEvery') && Object.hasOwn(snap, 'exploration.bias')) {
        delete next.exploration.leisureEvery;
      }
    }
    p.active = 'custom';
    return { ok: true, cfg: next, active: 'custom', restored: Boolean(snap) };
  }

  if (prevActive === 'custom' || !p.customSnapshot) {
    p.customSnapshot = extractPresetValues(next);
  }
  const values = effectivePresetValues(next, id);
  for (const [k, v] of Object.entries(values)) {
    writePath(next, k, v);
  }
  if (next.exploration && Object.hasOwn(next.exploration, 'leisureEvery')) {
    delete next.exploration.leisureEvery;
  }
  p.active = id;
  return { ok: true, cfg: next, active: id, restored: false };
}

/**
 * 修改某个套餐模板里的单个参数。
 * 选项 A：若修改的正是当前激活套餐，同时同步生效到当前配置并保持该套餐激活状态。
 */
export function updatePresetOverride(cfg, presetId, fieldPath, rawValue) {
  const id = String(presetId || '').trim();
  if (!Object.hasOwn(DEFAULT_PRESETS, id)) return { ok: false, error: `未知套餐：${id}` };
  const coerced = coercePresetFieldValue(fieldPath, rawValue);
  if (!coerced.ok) return coerced;

  const next = JSON.parse(JSON.stringify(cfg || {}));
  const p = ensurePresetsObj(next);
  p.overrides[id] = { ...(p.overrides[id] || {}), [fieldPath]: coerced.value };
  const syncedLive = activePresetId(next) === id;
  if (syncedLive) {
    writePath(next, fieldPath, coerced.value);
    if (fieldPath === 'exploration.bias' && next.exploration) delete next.exploration.leisureEvery;
  }
  return { ok: true, cfg: next, presetId: id, path: fieldPath, value: coerced.value, syncedLive };
}

/** 恢复某个套餐为内置默认参数；若正处于该套餐激活态，同步应用到当前配置。 */
export function resetPresetOverride(cfg, presetId) {
  const id = String(presetId || '').trim();
  if (!Object.hasOwn(DEFAULT_PRESETS, id)) return { ok: false, error: `未知套餐：${id}` };
  const next = JSON.parse(JSON.stringify(cfg || {}));
  const p = ensurePresetsObj(next);
  delete p.overrides[id];
  const syncedLive = activePresetId(next) === id;
  if (syncedLive) {
    for (const [k, v] of Object.entries(DEFAULT_PRESETS[id].values)) {
      writePath(next, k, v);
    }
  }
  return { ok: true, cfg: next, presetId: id, syncedLive };
}

/**
 * 在下方手动修改了某项普通设置时调用：
 * 若修改的是套餐管辖的参数，自动将模式切换为 'custom' 并刷新 customSnapshot。
 */
export function markCustomOnManualChange(nextCfg, changedPath) {
  if (!isPresetFieldPath(changedPath)) return false;
  const p = ensurePresetsObj(nextCfg);
  p.active = 'custom';
  p.customSnapshot = extractPresetValues(nextCfg);
  return true;
}

export function presetsForUi(cfg) {
  const active = activePresetId(cfg);
  const overrides = cfg?.presets?.overrides || {};
  return {
    active,
    hasCustomSnapshot: Boolean(cfg?.presets?.customSnapshot && typeof cfg.presets.customSnapshot === 'object'),
    fields: PRESET_FIELDS,
    presets: PRESET_ORDER.map((id) => {
      const def = DEFAULT_PRESETS[id];
      const over = overrides[id] && typeof overrides[id] === 'object' ? overrides[id] : {};
      return {
        id: def.id,
        label: def.label,
        desc: def.desc,
        customized: Object.keys(over).length > 0,
        values: effectivePresetValues(cfg, id),
      };
    }),
  };
}
