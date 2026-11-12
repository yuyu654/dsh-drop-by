// persona.js —— 人格装载。
//
// 人格不是写在插件里的，是**借用宿主已有的人格配置**，按这个顺序找：
//   1) dsh-agent-md 插件的全局人格  <DSH_HOME>/AGENT.md
//      —— 就是设置页「人格 → 全局人格」里编辑的那份，改了下一个回合就生效
//   2) 项目人格（可选）            <DSH_HOME>/agents/projects/<slug>.md 或 <cwd>/AGENT.md
//      —— 插件默认「全局作底座、项目覆盖」，这里也按同样规则拼
//   3) 本插件自己的 persona.md     presence-gate/persona.md
//      —— 没装插件、或插件关掉时用这份，内容随你填
//   4) 内置最小口吻
//      —— 什么都没写也要能发话，但会明确告诉你是兜底
//
// 插件的三个开关（enabled / includeGlobal / projectPersonaEnabled）会被尊重：
// 用户在 DSH 里关掉人格，这里也不会偷偷读。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ROOT } from './config.js';

/** <DSH_HOME>：环境变量优先，其次 ~/.dsh。 */
export function dshHome(cfg) {
  const fromCfg = String(cfg?.persona?.dshHome || '').trim();
  if (fromCfg) return fromCfg;
  const fromEnv = String(process.env.DSH_HOME || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

export const pluginStatePath = (home) => path.join(home, 'agent-md.json');
export const globalPersonaPath = (home) => path.join(home, 'AGENT.md');
export const projectsIndexPath = (home) => path.join(home, 'agents', 'projects.json');
export const localPersonaPath = (cfg) => {
  const f = String(cfg?.persona?.localFile || 'persona.md');
  return path.isAbsolute(f) ? f : path.join(ROOT, f);
};

/** 内置兜底：不假设任何具体角色，只保证「像人、不像客服」。 */
export const BUILTIN_PERSONA = `# 说话方式（内置兜底）

- 短：一到三句，能一句说完就一句。不写小作文。
- 像发消息，不像客服：不用「您好」「请问」「希望能帮到您」这类客套。
- 先给判断，再给一句理由。
- 不写括号动作说明（不要「（笑了笑）」这种）；语气写在字面上。
- 不列 1/2/3 清单，不写标题。
- 不承认自己是 AI、助手、程序；被问就带过。
- 不替对方做决定，不劝、不说教。`;

function readText(file) {
  try {
    const s = fs.readFileSync(file, 'utf8');
    return s.trim() ? s : null;
  } catch {
    return null;
  }
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 插件的开关。没装插件时返回 null（= 视作没有插件，走本地人格）。 */
export function readPluginConfig(home) {
  const statePath = pluginStatePath(home);
  const hasPluginFile = fs.existsSync(globalPersonaPath(home)) || fs.existsSync(path.join(home, 'agents'));
  const raw = readJson(statePath, null);
  if (!raw && !hasPluginFile) return null;
  const c = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: c.enabled !== false,
    includeGlobal: c.includeGlobal !== false,
    projectPersonaEnabled: c.projectPersonaEnabled !== false,
    localNames: Array.isArray(c.localNames) && c.localNames.length ? c.localNames : ['AGENT.md'],
    statePath,
    found: Boolean(raw),
  };
}

/** 项目人格：项目内 AGENT.md 优先，其次 agents/projects.json 里登记的那份。 */
export function findProjectPersona(home, cwd, plugin) {
  const dir = String(cwd || '').trim();
  if (!dir) return null;

  for (const name of plugin?.localNames || ['AGENT.md']) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }

  const idx = readJson(projectsIndexPath(home), null);
  const list = Array.isArray(idx?.projects) ? idx.projects : [];
  const norm = (s) => String(s || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  const hit = list.find((p) => norm(p?.cwd) === norm(dir) || norm(p?.key) === norm(dir));
  if (hit?.path && fs.existsSync(hit.path)) return hit.path;
  return null;
}

function fingerprint(files) {
  return files
    .map((f) => {
      try {
        const st = fs.statSync(f);
        return `${f}:${st.size}:${Math.round(st.mtimeMs)}`;
      } catch {
        return `${f}:0`;
      }
    })
    .join('|');
}

let cache = null;

/**
 * 装一份人格。返回：
 *   { ok, kind, text, chars, sources:[{kind,path,chars}], plugin, note, fp }
 * kind: 'plugin' | 'local' | 'builtin' | 'off'
 * 每次都按 mtime 判断要不要重读（人格文件随时可能被改）。
 */
export function loadPersona({ cfg, cwd, force = false } = {}) {
  const home = dshHome(cfg);
  const pcfg = cfg?.persona || {};
  const plugin = readPluginConfig(home);

  const globalPath = globalPersonaPath(home);
  const projectPath =
    pcfg.includeProject === true || (pcfg.includeProject !== false && plugin?.projectPersonaEnabled)
      ? findProjectPersona(home, cwd || pcfg.projectCwd, plugin)
      : null;
  const localPath = localPersonaPath(cfg);

  const watch = [globalPath, projectPath, localPath, pluginStatePath(home)].filter(Boolean);
  const fp = fingerprint(watch);
  if (!force && cache && cache.fp === fp) return cache.value;

  const sources = [];
  const notes = [];

  // 插件人格：enabled 与 includeGlobal 都要放行
  if (pcfg.enabled !== false && plugin) {
    if (!plugin.enabled) {
      notes.push('dsh-agent-md 的总开关是关的（agent-md.json enabled=false），不读它的 AGENT.md');
    } else {
      if (plugin.includeGlobal) {
        const t = readText(globalPath);
        if (t) sources.push({ kind: 'plugin-global', path: globalPath, chars: t.length, text: t });
      }
      if (projectPath) {
        const t = readText(projectPath);
        if (t) sources.push({ kind: 'plugin-project', path: projectPath, chars: t.length, text: t });
      }
    }
  } else if (!plugin && pcfg.enabled !== false) {
    notes.push('没找到 dsh-agent-md 插件（没有 AGENT.md，也没有 agents 目录），走本插件自己的 persona.md');
  }

  // 自填人格：插件那份没用上时补位（有插件人格时不叠加，避免两套口吻打架）
  if (!sources.length && pcfg.enabled !== false) {
    const t = readText(localPath);
    if (t) sources.push({ kind: 'local', path: localPath, chars: t.length, text: t });
  }

  let kind = 'builtin';
  let text = '';
  if (sources.length) {
    kind = sources.some((s) => s.kind.startsWith('plugin')) ? 'plugin' : 'local';
    text = sources
      .map((s) => {
        const label =
          s.kind === 'plugin-global'
            ? `## 人格（全局 · ${path.basename(s.path)}）`
            : s.kind === 'plugin-project'
              ? `## 这个通道的细则（${path.basename(s.path)}）`
              : '## 人格（自己填的）';
        return `${label}\n${s.text}`;
      })
      .join('\n\n');
  } else if (pcfg.enabled === false) {
    kind = 'off';
    text = '';
    notes.push('persona.enabled=false：不注入人格，只用内置的最小口吻规则');
    text = BUILTIN_PERSONA;
    kind = 'builtin';
  } else {
    text = BUILTIN_PERSONA;
    notes.push(`没有可用的人格文件，用内置兜底。想自己写就编辑 ${localPath}`);
  }

  const value = {
    ok: sources.length > 0,
    kind,
    text,
    chars: text.length,
    sources: sources.map(({ text: _t, ...rest }) => rest),
    plugin,
    note: notes.join('；'),
    fp,
  };
  cache = { fp, value };
  return value;
}

/** 给 --persona 用：不加载全文，只看会读哪几份。 */
export function personaPlan(cfg, cwd) {
  const home = dshHome(cfg);
  const pcfg = cfg?.persona || {};
  const plugin = readPluginConfig(home);
  const projectPath =
    pcfg.includeProject === true || (pcfg.includeProject !== false && plugin?.projectPersonaEnabled)
      ? findProjectPersona(home, cwd || pcfg.projectCwd, plugin)
      : null;

  const rows = [
    { label: 'dsh-agent-md 插件', path: plugin ? plugin.statePath : '', exists: Boolean(plugin) },
    { label: '全局人格 AGENT.md', path: globalPersonaPath(home), exists: fs.existsSync(globalPersonaPath(home)) },
    { label: '项目人格', path: projectPath || '', exists: Boolean(projectPath) },
    { label: '本插件 persona.md（自填）', path: localPersonaPath(cfg), exists: fs.existsSync(localPersonaPath(cfg)) },
  ];
  return { home, plugin, rows };
}

/** 生成一份可编辑的 persona.md 模板（只在用户没有时写）。 */
export function ensureLocalPersonaTemplate(cfg) {
  const p = localPersonaPath(cfg);
  if (fs.existsSync(p)) return { written: false, path: p };
  const tpl = `<!-- presence-gate 自填人格：装了 dsh-agent-md 且全局人格有内容时，这份不会被用到。
     想让它生效：删掉/改名 ~/.dsh/AGENT.md，或在 config.json 里设 persona.enabled=true 且 persona.dshHome 指向一个没有 AGENT.md 的目录。 -->

# 说话方式

- 短：一到三句，能一句说完就一句。
- 先给判断，再给一句理由。
- 不写括号动作，不列清单。

# 不喜欢

- 客服腔：您好、请问、感谢反馈、希望能帮到您。
- 说教、劝、替我做决定。

# 边界

- 不承认自己是 AI / 助手 / 程序。
- 不谈我的隐私：住址、账号、家里的事。
`;
  fs.writeFileSync(p, tpl, 'utf8');
  return { written: true, path: p };
}
