// emotion-sync.js —— 本机自动对齐 emotion-state-portrait 配置，并打通 QQ 对话投喂与状态回读。
// 不硬编码任何用户路径，换电脑/换 DSH_HOME/换 profile 都按运行环境动态发现。
import fs from 'node:fs';
import path from 'node:path';
import { dshHome, detectPlugin } from './detect.js';

const AUTHOR_MARKER = /yangxinyuan/i;
const AUTHOR_QQ = '3425023826';
const AUTHOR_KEY_PATTERN = 'QWEN_TOKEN_PLAN_CN_API_KEY';
const VALID_MS = 6 * 3_600_000;
const INBOX_COMPACT_BYTES = 512 * 1024;
const recentInbox = new Map();

const portablePath = (p) => path.resolve(String(p)).replace(/\\/g, '/');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function exists(file) {
  try { return Boolean(file) && fs.existsSync(file); } catch { return false; }
}

function writeAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 根据安装目录反推出所属 profile 目录；找不到时回退到第一个带 cordis.patch.yml 的 profile。 */
function resolveProfileDir(home, pluginDir) {
  const rel = path.relative(path.join(home, 'profiles'), pluginDir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
    const profName = rel.split(path.sep)[0];
    if (profName) return path.join(home, 'profiles', profName);
  }
  const desktop = path.join(home, 'profiles', 'desktop');
  if (exists(path.join(desktop, 'cordis.patch.yml'))) return desktop;
  try {
    for (const name of fs.readdirSync(path.join(home, 'profiles'))) {
      const candidate = path.join(home, 'profiles', name);
      if (exists(path.join(candidate, 'cordis.patch.yml'))) return candidate;
    }
  } catch { /* no profiles dir */ }
  return desktop;
}

/** 动态解析情绪插件目录及相关文件路径。 */
export function resolveEmotionDirs({ dshHome: homeArg, env = process.env } = {}) {
  const home = homeArg ? path.resolve(String(homeArg)) : dshHome(env);
  const plugin = detectPlugin('emotion-state-portrait', { dshHome: home, env });
  if (!plugin.installed) return { installed: false, home, plugin };
  const dir = plugin.dir;
  const profileDir = resolveProfileDir(home, dir);
  const emotionDir = path.join(dir, 'emotion');
  return {
    installed: true,
    home,
    plugin,
    dir,
    profileDir,
    patchPath: path.join(profileDir, 'cordis.patch.yml'),
    credentialsPath: path.join(home, '.credentials.yaml'),
    entryPath: path.join(dir, 'qq-emotion.mjs'),
    configPath: path.join(emotionDir, 'config.json'),
    examplePath: path.join(emotionDir, 'config.example.json'),
    statePath: path.join(emotionDir, 'state.json'),
    inboxPath: path.join(emotionDir, 'inbox.jsonl'),
    moodMapPath: path.join(dir, 'mood-map.json'),
    moodFilePath: path.join(dir, 'mood.txt'),
  };
}

const cleanScalar = (raw) => String(raw || '').split(/\s+#/)[0].trim().replace(/^['"]|['"]$/g, '');

function splitBlocks(yamlText) {
  const blocks = {};
  let currentId = '';
  for (const line of String(yamlText || '').split(/\r?\n/)) {
    const m = /^- id:\s*(.+)$/.exec(line.trim());
    if (m) {
      currentId = cleanScalar(m[1]);
      blocks[currentId] = [];
    } else if (currentId) {
      blocks[currentId].push(line);
    }
  }
  return blocks;
}

function parseProvidersBlock(lines) {
  const providers = {};
  let inProviders = false;
  let provIndent = -1;
  let currentProv = '';
  let currentObj = null;
  let inModels = false;
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.search(/\S/);
    const trimmed = line.trim();
    if (!inProviders) {
      if (trimmed === 'providers:') {
        inProviders = true;
        provIndent = indent;
      }
      continue;
    }
    if (indent <= provIndent) break;
    if (trimmed.endsWith(':') && !trimmed.startsWith('-')) {
      const key = cleanScalar(trimmed.slice(0, -1));
      if (key === 'models') {
        inModels = true;
      } else if (!currentObj || indent <= currentObj.indent) {
        currentProv = key;
        currentObj = { indent, baseURL: '', apiKeyEnv: '', models: [] };
        providers[key] = currentObj;
        inModels = false;
      } else {
        inModels = false;
      }
      continue;
    }
    if (!currentObj) continue;
    if (inModels && /^-\s*id:\s*(.+)$/.test(trimmed)) {
      currentObj.models.push(cleanScalar(trimmed.replace(/^-\s*id:\s*/, '')));
      continue;
    }
    inModels = false;
    const kv = /^([A-Za-z0-9_]+):\s*(.+)$/.exec(trimmed);
    if (!kv) continue;
    const val = cleanScalar(kv[2]);
    if (kv[1] === 'baseURL') currentObj.baseURL = val.replace(/\/chat\/completions\/?$/i, '').replace(/\/+$/, '');
    else if (kv[1] === 'apiKeyEnv') currentObj.apiKeyEnv = val;
  }
  return providers;
}

function canResolveKey({ apiKeyEnv, keyFile, keyPattern }, env = process.env) {
  if (apiKeyEnv && String(env?.[apiKeyEnv] || '').trim()) return true;
  if (!keyFile || !keyPattern || !exists(keyFile)) return false;
  try {
    const m = new RegExp(keyPattern).exec(readText(keyFile));
    return Boolean(m?.[1] && cleanScalar(m[1]));
  } catch {
    return false;
  }
}

/** 从本机 cordis.patch.yml 与 .credentials.yaml 推导可用的 OpenAI 兼容 LLM 配置。 */
export function resolveLocalLlm(paths, env = process.env) {
  const blocks = splitBlocks(readText(paths.patchPath));
  let preferredProvider = '';
  let preferredModel = '';
  for (const line of blocks['agent-default-model'] || []) {
    const kv = /^\s*(provider|model):\s*(.+)$/.exec(line);
    if (kv?.[1] === 'provider') preferredProvider = cleanScalar(kv[2]);
    else if (kv?.[1] === 'model') preferredModel = cleanScalar(kv[2]);
  }
  const providers = parseProvidersBlock(blocks['llm-pi-ai'] || []);
  const order = [];
  if (preferredProvider && providers[preferredProvider]) order.push([preferredProvider, providers[preferredProvider]]);
  for (const [name, p] of Object.entries(providers)) if (name !== preferredProvider) order.push([name, p]);

  for (const [name, p] of order) {
    if (!p.baseURL) continue;
    const apiKeyEnv = p.apiKeyEnv || 'EMOTION_LLM_KEY';
    const keyPattern = `${apiKeyEnv}:\\s*(\\S+)`;
    if (canResolveKey({ apiKeyEnv, keyFile: paths.credentialsPath, keyPattern }, env)) {
      const model = (name === preferredProvider && preferredModel) || p.models[0] || '';
      if (model) {
        return { api: p.baseURL, model, apiKeyEnv, keyFile: portablePath(paths.credentialsPath), keyPattern };
      }
    }
  }
  if (canResolveKey({ apiKeyEnv: 'DEEPSEEK_API_KEY', keyFile: paths.credentialsPath, keyPattern: 'DEEPSEEK_API_KEY:\\s*(\\S+)' }, env)) {
    return {
      api: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      keyFile: portablePath(paths.credentialsPath),
      keyPattern: 'DEEPSEEK_API_KEY:\\s*(\\S+)',
    };
  }
  return null;
}

/** 检查 emotion-state-portrait 配置问题与实时情绪摘要。 */
export function inspectEmotionPlugin({ dshHome: homeArg, cfg, env = process.env } = {}) {
  const paths = resolveEmotionDirs({ dshHome: homeArg, env });
  if (!paths.installed) {
    return { installed: false, entry: false, ready: false, needsRepair: false, issues: [], live: null };
  }
  const entry = exists(paths.entryPath);
  const configExists = exists(paths.configPath);
  const exampleExists = exists(paths.examplePath);
  if (!configExists && !exampleExists) {
    return { installed: true, entry, ready: entry, configPath: '', needsRepair: false, issues: [], live: null };
  }
  const emotionCfg = readJson(paths.configPath) || readJson(paths.examplePath) || {};
  const issues = [];

  if (!configExists && exampleExists) issues.push('缺少 emotion/config.json（可从模板自动生成并对齐本机）');
  const keyFile = String(emotionCfg.llm?.keyFile || '');
  if (!keyFile || AUTHOR_MARKER.test(keyFile) || (exists(paths.credentialsPath) && !exists(keyFile))) {
    issues.push('llm.keyFile 仍指向无效或作者路径');
  }
  const pbFile = String(emotionCfg.integration?.personaBlock?.file || '');
  if (!pbFile || AUTHOR_MARKER.test(pbFile) || (exists(paths.patchPath) && !exists(pbFile))) {
    issues.push('personaBlock.file 仍指向无效或作者路径');
  }
  const resolvedKeyFile = exists(keyFile) ? keyFile : paths.credentialsPath;
  const keyOk = canResolveKey({
    apiKeyEnv: emotionCfg.llm?.apiKeyEnv,
    keyFile: resolvedKeyFile,
    keyPattern: emotionCfg.llm?.keyPattern,
  }, env);
  if (!keyOk) issues.push('当前配置读不到可用的 LLM Key');

  const peer = String(cfg?.channels?.qq?.peerId || '').trim();
  const ownerQq = String(emotionCfg.owner?.qq || '').trim();
  if (peer && (!ownerQq || ownerQq === AUTHOR_QQ)) {
    issues.push('owner.qq 尚未对齐你的 QQ 对象');
  }
  if (emotionCfg.integration?.source !== 'file' || !emotionCfg.integration?.fileInbox) {
    issues.push('消息源未设为 file（inbox.jsonl），QQ 桥聊天无法驱动情绪');
  }

  const st = readJson(paths.statePath);
  const inboxExists = exists(paths.inboxPath);
  let inboxBytes = 0;
  try { if (inboxExists) inboxBytes = fs.statSync(paths.inboxPath).size; } catch { inboxBytes = 0; }
  const live = st ? {
    spirit: Math.round(Number(st.spirit) || 0),
    statusWord: String(st.status?.word || ''),
    transition: String(st.transition?.name || ''),
    mood: Array.isArray(st.mood) ? st.mood.map((m) => `${m.name}Lv${Math.round(Number(m.level) || 1)}`) : [],
    portraitCount: Object.keys(st.portraits || {}).length,
    updatedAt: Number(st.updatedAt) || 0,
    inboxExists,
    inboxBytes,
  } : null;

  return {
    installed: true,
    entry,
    ready: entry,
    configPath: paths.configPath,
    needsRepair: issues.length > 0,
    issues,
    stateExists: Boolean(st),
    inboxExists,
    inboxBytes,
    live,
  };
}

/** 一键按当前机器的 DSH 环境修正 emotion/config.json（幂等，改前自动备份）。 */
export function repairEmotionConfig({ dshHome: homeArg, cfg, env = process.env, force = false } = {}) {
  const paths = resolveEmotionDirs({ dshHome: homeArg, env });
  if (!paths.installed) return { ok: false, reason: 'NOT_INSTALLED', changed: false, changes: [] };
  const sourceFile = exists(paths.configPath) ? paths.configPath : (exists(paths.examplePath) ? paths.examplePath : '');
  if (!sourceFile) return { ok: false, reason: 'NO_CONFIG', changed: false, changes: [] };

  const emotionCfg = readJson(sourceFile);
  if (!emotionCfg || typeof emotionCfg !== 'object') {
    return { ok: false, reason: 'INVALID_CONFIG', changed: false, changes: [] };
  }

  const changes = [];
  const seeded = !exists(paths.configPath);
  if (seeded) changes.push('从模板生成 emotion/config.json');

  emotionCfg.llm ||= {};
  emotionCfg.integration ||= {};
  emotionCfg.integration.personaBlock ||= {};
  emotionCfg.owner ||= {};

  const targetCreds = portablePath(paths.credentialsPath);
  const curKeyFile = String(emotionCfg.llm.keyFile || '');
  if ((exists(paths.credentialsPath) || AUTHOR_MARKER.test(curKeyFile)) && (!curKeyFile || AUTHOR_MARKER.test(curKeyFile) || !exists(curKeyFile) || force)) {
    if (curKeyFile !== targetCreds) {
      emotionCfg.llm.keyFile = targetCreds;
      changes.push('已将 llm.keyFile 设为本机 .credentials.yaml');
    }
  }

  const targetPatch = portablePath(paths.patchPath);
  const curPbFile = String(emotionCfg.integration.personaBlock.file || '');
  if ((exists(paths.patchPath) || AUTHOR_MARKER.test(curPbFile)) && (!curPbFile || AUTHOR_MARKER.test(curPbFile) || !exists(curPbFile) || force)) {
    if (curPbFile !== targetPatch) {
      emotionCfg.integration.personaBlock.file = targetPatch;
      changes.push('已将 personaBlock.file 设为本机 cordis.patch.yml');
    }
  }

  const keyAlreadyWorks = !AUTHOR_MARKER.test(curKeyFile) &&
    !String(emotionCfg.llm.keyPattern || '').includes(AUTHOR_KEY_PATTERN) &&
    canResolveKey(emotionCfg.llm, env);
  if (!keyAlreadyWorks) {
    const localLlm = resolveLocalLlm(paths, env);
    if (localLlm) {
      Object.assign(emotionCfg.llm, localLlm);
      changes.push(`已将打分模型对齐为本机 ${localLlm.model}（${localLlm.apiKeyEnv}）`);
    }
  }

  const peer = String(cfg?.channels?.qq?.peerId || '').trim();
  const curOwner = String(emotionCfg.owner.qq || '').trim();
  if (peer && (!curOwner || curOwner === AUTHOR_QQ || force) && curOwner !== peer) {
    emotionCfg.owner.qq = peer;
    changes.push(`已将 owner.qq 对齐为 ${peer}`);
  }

  if (emotionCfg.integration.source !== 'file' || !emotionCfg.integration.fileInbox) {
    emotionCfg.integration.source = 'file';
    emotionCfg.integration.fileInbox = emotionCfg.integration.fileInbox || 'emotion/inbox.jsonl';
    changes.push('已将消息源设为 file（emotion/inbox.jsonl）');
  }

  if (changes.length) {
    if (exists(paths.configPath) && !exists(`${paths.configPath}.bak-before-local`)) {
      fs.copyFileSync(paths.configPath, `${paths.configPath}.bak-before-local`);
    }
    writeAtomic(paths.configPath, `${JSON.stringify(emotionCfg, null, 2)}\n`);
  }

  return {
    ok: true,
    changed: changes.length > 0,
    changes,
    configPath: paths.configPath,
    inspection: inspectEmotionPlugin({ dshHome: paths.home, cfg, env }),
  };
}

/** 按 state.json.inboxOffset 归档并裁掉已消费的 inbox.jsonl，防止长跑无限膨胀。 */
export function compactEmotionInbox({ dshHome: homeArg, env = process.env, maxBytes = INBOX_COMPACT_BYTES } = {}) {
  const paths = resolveEmotionDirs({ dshHome: homeArg, env });
  if (!paths.installed || !exists(paths.inboxPath)) return { ok: false, compacted: false, reason: 'NO_INBOX' };
  let size = 0;
  try {
    size = fs.statSync(paths.inboxPath).size;
  } catch {
    return { ok: false, compacted: false, reason: 'STAT_FAILED' };
  }
  if (size <= maxBytes) return { ok: true, compacted: false, size };

  const st = readJson(paths.statePath);
  const rawOffset = Number(st?.inboxOffset);
  if (!st || !Number.isFinite(rawOffset) || rawOffset <= 0) {
    return { ok: true, compacted: false, reason: 'NO_CONSUMED_OFFSET', size };
  }

  const cut = Math.min(size, Math.floor(rawOffset));
  const buf = fs.readFileSync(paths.inboxPath);
  const consumed = buf.subarray(0, cut);
  const tail = buf.subarray(cut);
  const archivePath = path.join(path.dirname(paths.inboxPath), 'inbox.archive.jsonl');
  try {
    const tmpArch = `${archivePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpArch, consumed);
    fs.renameSync(tmpArch, archivePath);
  } catch { /* 归档失败不阻断裁切 */ }

  const tmpInbox = `${paths.inboxPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpInbox, tail);
  fs.renameSync(tmpInbox, paths.inboxPath);
  writeAtomic(paths.statePath, `${JSON.stringify({ ...st, inboxOffset: 0 }, null, 2)}\n`);
  return { ok: true, compacted: true, archivedBytes: consumed.length, keptBytes: tail.length };
}

/** 把 QQ 私聊用户/助手消息追加进 emotion/inbox.jsonl，驱动原生情绪与画像演化。 */
export function appendEmotionInbox({ dshHome: homeArg, env = process.env, user, role = 'user', text, t = Date.now(), name } = {}) {
  const clean = String(text || '').trim();
  const qq = String(user || '').trim();
  if (!qq || !clean) return false;
  const paths = resolveEmotionDirs({ dshHome: homeArg, env });
  if (!paths.installed || !exists(paths.entryPath)) return false;

  const ts = Number(t) || Date.now();
  const dedupKey = `${paths.inboxPath}|${role}|${qq}`;
  const prev = recentInbox.get(dedupKey);
  if (prev && prev.text === clean && Math.abs(ts - prev.t) < 5000) return false;
  recentInbox.set(dedupKey, { text: clean, t: ts });

  try {
    try { compactEmotionInbox({ dshHome: paths.home, env }); } catch { /* 轮转失败不影响写入 */ }
    fs.mkdirSync(path.dirname(paths.inboxPath), { recursive: true });
    const entry = { user: qq, role, text: clean.slice(0, 1000), t: ts, ...(name ? { name: String(name) } : {}) };
    fs.appendFileSync(paths.inboxPath, `${JSON.stringify(entry)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 把一轮自主探索结果整理成可读摘要，供情绪打分与 inbox 记录共用。 */
export function formatExplorationMoodText(state) {
  const mode = state?.lastRun?.mode === 'leisure' ? '休闲' : '研究';
  const entry = mode === '休闲' ? state?.leisure : state?.thread;
  const parts = [];
  if (entry?.topic) parts.push(`题目：${entry.topic}`);
  if (entry?.progress) parts.push(`进展：${entry.progress}`);
  if (entry?.discovery) parts.push(`新发现：${entry.discovery}`);
  if (state?.candidate?.line) parts.push(`想分享：${state.candidate.line}`);
  if (state?.mood?.text) parts.push(`感受：${state.mood.text}`);
  return parts.length ? `[自主探索·${mode}] ${parts.join('；')}` : '';
}

/** 把非跳过的自主探索成果追加进 emotion/inbox.jsonl，让探索过程也参与情绪与精神演化。 */
export function recordExplorationEmotion({ state, cfg, dshHome: homeArg, env = process.env } = {}) {
  if (cfg?.exploration?.portrait !== true && cfg?.exploration?.mood !== true) return '';
  const summary = formatExplorationMoodText(state);
  if (!summary) return '';
  const targetUser = String(cfg?.channels?.qq?.peerId || 'exploration').trim() || 'exploration';
  appendEmotionInbox({
    dshHome: homeArg,
    env,
    user: targetUser,
    role: 'ai',
    name: '自主探索',
    text: summary,
    t: Number(state?.lastAt) || Date.now(),
  });
  return summary;
}

/** 从 emotion-state-portrait 产出的 mood-map.json / mood.txt 读取完整状态行（去掉尾部重复硬规则）。 */
export function readPortraitMoodMap({ dshHome: homeArg, env = process.env, peer, now = Date.now() } = {}) {
  const paths = resolveEmotionDirs({ dshHome: homeArg, env });
  if (!paths.installed) return '';
  const st = readJson(paths.statePath);
  if (st?.updatedAt && now - Number(st.updatedAt) > VALID_MS) return '';
  const map = readJson(paths.moodMapPath);
  const raw = String((peer && map?.[String(peer)]) || map?.default || readText(paths.moodFilePath) || '').trim();
  if (!raw) return '';
  return raw.replace(/；硬规则：[\s\S]*$/u, '').trim();
}
