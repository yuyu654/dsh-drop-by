// local.js —— 本机私有规则：禁用词、只属于这台机器（这个人）的事实。
//
// 插件本身不带任何具体人设：这些东西以前写死在 compose.js 里（「别多想」禁用、
// 「滚」太凶、胃病/冰饮是「我」的事），换一个人装就全错。现在从两处读，缺了就当没有：
//   1) local-style.json（默认在插件根目录；不进 npm 包、不进 git）
//   2) cfg.content.local（测试，或者设置页直接塞进来）
//
// 文件格式（全部可选）：
//   {
//     "taboos":  [{ "code": "CATCHPHRASE", "pattern": "别多想", "flags": "", "why": "用滥了" }],
//     "notes":   ["胃病、不能喝冰的、胃药都是我自己的事，不是她的"],
//     "samples": ["跑完了。第三行那个报错是路径写错，改了。"]
//   }
//
// taboo.pattern 是正则源码字符串；写错了就跳过这一条，不让一个坏正则把整个发送链路带死。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

const EMPTY = { taboos: [], notes: [], samples: [] };

export function localStylePath(cfg) {
  const f = String(cfg?.local?.file || process.env.PG_LOCAL_STYLE || 'local-style.json');
  return path.isAbsolute(f) ? f : path.join(ROOT, f);
}

function normalize(o) {
  const taboos = (Array.isArray(o?.taboos) ? o.taboos : [])
    .map((t) => {
      if (!t || !t.pattern) return null;
      try {
        return {
          code: String(t.code || 'LOCAL_TABOO'),
          why: String(t.why || '本机禁用的说法'),
          re: new RegExp(String(t.pattern), String(t.flags || '')),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const clean = (arr) => (Array.isArray(arr) ? arr : []).map((s) => String(s || '').trim()).filter(Boolean);
  return { taboos, notes: clean(o?.notes), samples: clean(o?.samples) };
}

// 按 mtime+size 缓存：这一跳每 10 分钟一次，没必要每次读盘。
const cache = new Map();

function readFileStyle(file) {
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.value;
    const value = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
    cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, value });
    return value;
  } catch {
    return EMPTY;
  }
}

/** 合并「文件里的」和「配置里直接给的」；两个都没有就是空对象（= 插件原样通用）。 */
export function localStyle(cfg) {
  const fromFile = readFileStyle(localStylePath(cfg));
  const inline = normalize(cfg?.content?.local || {});
  return {
    taboos: [...fromFile.taboos, ...inline.taboos],
    notes: [...fromFile.notes, ...inline.notes],
    samples: [...fromFile.samples, ...inline.samples],
  };
}