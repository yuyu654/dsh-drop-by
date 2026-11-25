// schedule.js —— 时间段。全局静默 + 每个功能各自的执行时段，都支持多段、可跨零点。
//
// 三条语义约定，别猜：
//   1) 空数组 []   = 全天不限（不是「全天关闭」）
//   2) 一段可以跨零点，如 ["22:30","07:30"]，会被拆成 [22:30,24:00) 和 [00:00,07:30)
//   3) 全局静默优先级最高：落在静默里，所有功能都不读、不发，连邮箱都不联网
//
// 这里全是纯函数，不读文件不联网，方便单测。

export const DAY = 24 * 60;

/** "07:00" → 420；"24:00" → 1440（只允许作为结束时间）；非法 → -1 */
export function parseHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return -1;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (mi > 59) return -1;
  if (h === 24 && mi === 0) return DAY;
  if (h > 23) return -1;
  return h * 60 + mi;
}

/** 420 → "07:00"；1440 → "24:00" */
export function fmtHm(mins) {
  const n = Math.max(0, Math.min(DAY, Math.round(Number(mins) || 0)));
  const h = Math.floor(n / 60);
  const m = n % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

const ALL_WORDS = /^(all|any|always|\*|全天|全部|不限|关)$/i;

/**
 * 把配置里的各种写法统一成 [["07:00","12:00"], ...]。
 * 接受：[[ "07:00","12:00" ]] / ["07:00-12:00", ...] / "07:00-12:00,14:00-18:00" / "" / "全天"
 * 返回 { windows, errors }，errors 是给人看的中文，不抛异常（配置写错了不该让插件起不来）。
 */
export function normalizeWindows(input) {
  const errors = [];
  let list = [];

  if (input == null) list = [];
  else if (typeof input === 'string') {
    // 中文输入法打出来的全角标点也算分隔符/冒号：使用者不会为了填个时段切半角。
    const t = input
      .replace(/[，、]/g, ',')
      .replace(/：/g, ':')
      .replace(/[；]/g, ';')
      .trim();
    list = !t || ALL_WORDS.test(t) ? [] : t.split(/[,;\s]+/).filter(Boolean);
  } else if (Array.isArray(input)) {
    list = input;
  } else {
    return { windows: [], errors: ['时间段应该是一个数组，比如 [["07:00","12:00"]]'] };
  }

  const windows = [];
  for (const item of list) {
    let a = -1;
    let b = -1;
    let text = '';

    if (Array.isArray(item) && item.length >= 2) {
      text = `${item[0]}-${item[1]}`;
      a = parseHm(item[0]);
      b = parseHm(item[1]);
    } else if (typeof item === 'string') {
      text = item.trim();
      if (!text) continue;
      if (ALL_WORDS.test(text)) continue;
      const m = /^(\d{1,2}:\d{2})\s*(?:-|~|至|到|—)\s*(\d{1,2}:\d{2})$/.exec(text);
      if (!m) {
        errors.push(`「${text}」看不懂，要写成 07:00-12:00`);
        continue;
      }
      a = parseHm(m[1]);
      b = parseHm(m[2]);
    } else {
      errors.push(`「${JSON.stringify(item)}」不是合法的时间段`);
      continue;
    }

    if (a < 0 || b < 0) {
      errors.push(`「${text}」时间不合法（小时 0-24，分钟 0-59）`);
      continue;
    }
    if (a === b) {
      errors.push(`「${text}」首尾相同，等于没写，已忽略`);
      continue;
    }
    windows.push([fmtHm(a), fmtHm(b)]);
  }

  return { windows, errors };
}

export function fmtWindows(windows) {
  const list = Array.isArray(windows) ? windows : [];
  if (!list.length) return '全天不限';
  return list.map((w) => `${w[0]}-${w[1]}`).join('、');
}

/** 时间段 → 当天的分钟区间（跨零点拆两段并合并相邻）。也接受 "07:00-12:00" 这种字符串。 */
export function toSegs(windows) {
  const list = normalizeWindows(windows).windows;
  const segs = [];
  for (const w of list) {
    const a = parseHm(w[0]);
    const b = parseHm(w[1]);
    if (a < 0 || b < 0 || a === b) continue;
    if (a < b) segs.push([a, b]);
    else {
      segs.push([a, DAY]);
      segs.push([0, b]);
    }
  }
  return mergeSegs(segs);
}

function mergeSegs(segs) {
  const out = [];
  for (const [a, b] of [...segs].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function inSegs(cur, segs) {
  for (const [a, b] of segs) if (cur >= a && cur < b) return true;
  return false;
}

function minutesOfDay(now, timezone) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone || 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const [h, m] = f.format(new Date(now)).split(':').map(Number);
  return h * 60 + m;
}

/** 当前是否在执行时段内。空数组 = 全天，恒 true。 */
export function inWindows(now, windows, timezone) {
  const segs = toSegs(windows || []);
  if (!segs.length) return true;
  return inSegs(minutesOfDay(now, timezone), segs);
}

/** 当前是否在全局静默内。空数组 = 不静默，恒 false。 */
export function inQuiet(now, quietWindows, timezone) {
  const segs = toSegs(quietWindows || []);
  if (!segs.length) return false;
  return inSegs(minutesOfDay(now, timezone), segs);
}

/**
 * 当前是否在「忙碌时段」内。语义和静默不同，说清楚：
 *   · 误配成空数组 [] 时，忙碌 = 不忙（不能因为没填就全天不发）
 *   · 多段、可跨零点，和 quietHours 用同一套解析
 */
export function inBusy(now, busyWindows, timezone) {
  const segs = toSegs(busyWindows || []);
  if (!segs.length) return false;
  return inSegs(minutesOfDay(now, timezone), segs);
}

/**
 * 最近一次忙碌时段的结束时间戳（今天之内）；今天还没经历过就返回 0。
 * 跨零点的段已经在 toSegs 里拆过，所以 [00:00,07:30) 这种也能算对。
 */
export function lastWindowEnd(now, windows, timezone) {
  const segs = toSegs(windows || []);
  if (!segs.length) return 0;
  const cur = minutesOfDay(now, timezone);
  let best = -1;
  for (const [, b] of segs) if (b <= cur && b > best) best = b;
  if (best < 0) return 0;
  return now - (cur - best) * 60000;
}

/** 距离下一次执行时段开始还有多少分钟；已经在时段内返回 0，全天返回 0。 */
export function nextOpenIn(now, windows, timezone) {
  const segs = toSegs(windows || []);
  if (!segs.length) return 0;
  const cur = minutesOfDay(now, timezone);
  if (inSegs(cur, segs)) return 0;
  let best = null;
  for (const [a] of segs) {
    const d = (a - cur + DAY) % DAY;
    if (d > 0 && (best === null || d < best)) best = d;
  }
  return best === null ? 0 : best;
}

/** 两组时间段的重叠区（分钟区间）与总重叠分钟数。 */
export function overlapOf(aWindows, bWindows) {
  const A = toSegs(aWindows);
  const B = toSegs(bWindows);
  const ranges = [];
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i][0], B[j][0]);
    const e = Math.min(A[i][1], B[j][1]);
    if (s < e) ranges.push([s, e]);
    if (A[i][1] < B[j][1]) i++;
    else j++;
  }
  return { ranges: mergeSegs(ranges), mins: ranges.reduce((n, [s, e]) => n + (e - s), 0) };
}

export function totalMins(windows) {
  return toSegs(windows).reduce((n, [a, b]) => n + (b - a), 0);
}

function fmtRanges(ranges) {
  return ranges.map(([a, b]) => `${fmtHm(a)}-${fmtHm(b)}`).join('、');
}

// ---------------------------------------------------------------- 功能清单

/** 三个功能 + 主会话，统一从这里取，避免各处硬编码 key。 */
export const FEATURES = [
  { key: 'qq', label: '读 QQ 消息', path: 'channels.qq.activeHours' },
  { key: 'douyin', label: '读抖音私信', path: 'channels.douyin.activeHours' },
  { key: 'mail', label: '读邮箱 FISH', path: 'mail.activeHours' },
  { key: 'main', label: '读主会话', path: 'channels.main.activeHours' },
];

export function featureByKey(key) {
  const k = String(key || '').toLowerCase();
  return (
    FEATURES.find((f) => f.key === k) ||
    ({ qq消息: FEATURES[0], 抖音: FEATURES[1], 邮箱: FEATURES[2], email: FEATURES[2], main: FEATURES[3] }[k] ||
      null)
  );
}

function getIn(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function isEnabled(cfg, feature) {
  if (feature.key === 'mail') return cfg?.mail?.enabled === true;
  const c = getIn(cfg, feature.path.replace('.activeHours', ''));
  return c?.enabled === true;
}

/**
 * 冲突检查。静默时段和功能时段撞上就是白设，必须提前说出来。
 * 返回 [{ level: 'error'|'warn'|'info', feature, text }]
 */
export function checkSchedule(cfg) {
  const quietInput = cfg?.quietHours;
  const quiet = normalizeWindows(quietInput).windows;
  const findings = [];

  const quietMins = totalMins(quiet);
  if (quietMins >= DAY) {
    findings.push({
      level: 'error',
      feature: 'quiet',
      text: '静默时段已经覆盖全天，所有功能都不会执行一秒',
    });
  }

  for (const f of FEATURES) {
    const raw = getIn(cfg, f.path);
    const norm = normalizeWindows(raw);
    for (const e of norm.errors) {
      findings.push({ level: 'error', feature: f.key, text: `${f.label}：${e}` });
    }
    const wins = norm.windows;
    if (!wins.length) continue; // 全天不限，不会有冲突

    const enabled = isEnabled(cfg, f);
    const suffix = enabled ? '' : '（该功能现在是关的）';
    const ov = overlapOf(wins, quiet);
    const span = fmtWindows(wins);

    if (ov.mins > 0 && ov.mins >= totalMins(wins)) {
      findings.push({
        level: 'error',
        feature: f.key,
        text: `${f.label} 的执行时段 ${span} 整段落在静默里，等于不执行${suffix}`,
      });
    } else if (ov.mins > 0) {
      findings.push({
        level: 'warn',
        feature: f.key,
        text: `${f.label} ${span} 与静默重叠 ${ov.mins} 分钟（${fmtRanges(ov.ranges)}），这段时间不会读${suffix}`,
      });
    } else {
      findings.push({ level: 'info', feature: f.key, text: `${f.label} ${span} 与静默不冲突` });
    }

    // 同一功能自己几段互相重叠：不算错，但多半是写重了
    if (wins.length > 1) {
      let selfOverlap = 0;
      for (let i = 0; i < wins.length; i++) {
        for (let j = i + 1; j < wins.length; j++) {
          selfOverlap += overlapOf([wins[i]], [wins[j]]).mins;
        }
      }
      if (selfOverlap > 0) {
        findings.push({
          level: 'info',
          feature: f.key,
          text: `${f.label} 自己有两段重叠，已按并集处理（不影响运行）`,
        });
      }
    }
  }

  return findings;
}

export function hasBlockingIssue(findings) {
  return findings.some((f) => f.level === 'error');
}

/** 给 --windows / --status 打印用的表格行。 */
export function describeSchedule(cfg, now, timezone) {
  const tz = timezone || 'Asia/Shanghai';
  const quiet = normalizeWindows(cfg?.quietHours).windows;
  const quietNow = inQuiet(now, quiet, tz);
  const rows = [
    {
      label: '全局静默',
      kind: 'quiet',
      windows: quiet,
      windowsText: quiet.length ? fmtWindows(quiet) : '不静默',
      enabled: true,
      active: quietNow, // 这一行的 active 指「静默正在生效」
      note: quietNow ? '所有功能暂停' : '',
    },
  ];

  for (const f of FEATURES) {
    const norm = normalizeWindows(getIn(cfg, f.path));
    const enabled = isEnabled(cfg, f);
    const inWin = inWindows(now, norm.windows, tz);
    rows.push({
      label: f.label,
      kind: 'feature',
      windows: norm.windows,
      windowsText: fmtWindows(norm.windows),
      enabled,
      active: enabled && inWin && !quietNow,
      note: !enabled ? '开关关着' : quietNow ? '被静默压住' : inWin ? '' : `未到时段（${nextOpenIn(now, norm.windows, tz)} 分钟后开）`,
    });
  }
  return rows;
}
