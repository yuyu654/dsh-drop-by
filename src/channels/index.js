// channels/index.js —— 汇总各通道信号。
//
// 三个硬规则：
//   1) enabled=false 的通道**根本不调用读取函数**（连文件都不碰）；
//   2) 落在全局静默里 → 所有通道都跳过，一个文件都不读；
//   3) 只有落在自己的 activeHours 里才读（空数组 = 全天）。
// 单通道失败只记 reason，不参与 max，不影响其他通道与整轮判定。
import { readQq } from './qq.js';
import { readMain } from './main.js';
import { readDouyin } from './douyin.js';
import { readDouyinState, douyinPeer, douyinInstallation } from './douyin-im.js';
import { readyDouyinBinding } from './chat-switch.js';
import { detectQq } from '../detect.js';
import { inQuiet, inWindows, normalizeWindows } from '../schedule.js';

/** 跳过时的统一形状：state 只表示「本拍没读」，不是失败。 */
function skipEntry(channel, g) {
  if (g.skip === 'off') return { channel, state: 'off', ...(g.reason ? { reason: g.reason } : {}), ...(g.note ? { note: g.note } : {}) };
  return {
    channel,
    ok: false,
    state: g.skip,
    reason: g.skip === 'quiet' ? 'GLOBAL_QUIET' : 'OUTSIDE_WINDOW',
    note: g.note,
  };
}

/**
 * 通道当前该不该读：返回 { skip: 'off'|'quiet'|'window', reason?, note } 或 null。
 * srcOn = sources.<链路>.enabled：总闸关着就整条链路过掉，理由单独给 SOURCE_OFF，
 * 别和「通道开关关着」混成一个理由——排障时这俩指向完全不同的地方。
 */
function gate(chanCfg, now, tz, quiet, srcOn = true) {
  if (!srcOn) return { skip: 'off', reason: 'SOURCE_OFF', note: '这条链路的总闸关着' };
  if (!chanCfg?.enabled) return { skip: 'off' };
  if (quiet) return { skip: 'quiet', note: '全局静默中，不读' };

  const wins = normalizeWindows(chanCfg.activeHours).windows;
  if (!inWindows(now, wins, tz)) {
    return { skip: 'window', note: `不在执行时段（${wins.map((w) => w.join('-')).join('、')}）` };
  }
  return null;
}

export function readChannels(cfg, now, opts = {}) {
  const tz = cfg.timezone;
  const ch = cfg.channels || {};
  const quiet = opts.quiet !== undefined ? opts.quiet : inQuiet(now, cfg.quietHours, tz);
  const src = cfg.sources || {};
  const srcOn = (k) => src[k]?.enabled !== false;
  // 检测结果由外面传进来（测试不扫真机）；没传就当场问一次（只读文件，10 分钟缓存）。
  const primary = ch.primary;
  const det = opts.detect || {};
  const list = [];

  // QQ
  {
    const g = primary === 'douyin' ? { skip: 'off' } : gate(ch.qq, now, tz, quiet, srcOn('qq'));
    if (!g) {
      if (ch.qq?.read) {
        const qq = det.qq || detectQq();
        if (!qq.installed) {
          // 插件没装：qq-history.json 里的东西一定是旧的，不能当「她刚说话」用。
          list.push({ channel: 'qq', ok: false, reason: 'QQ_PLUGIN_MISSING', note: qq.note, plugin: qq });
        } else if (!qq.paired) {
          list.push({ channel: 'qq', ok: false, reason: 'QQ_PLUGIN_UNPAIRED', note: qq.note, plugin: qq });
        } else {
          try {
            list.push({ ...readQq(ch.qq, now, tz), plugin: qq });
          } catch (e) {
            list.push({ channel: 'qq', ok: false, reason: 'QQ_READ_ERROR', note: String(e.message).slice(0, 120) });
          }
        }
      } else {
        list.push({ channel: 'qq', ok: false, reason: 'CHANNEL_READ_OFF' });
      }
    } else {
      list.push(skipEntry('qq', g));
    }
  }

  // 主会话
  {
    const g = gate(ch.main, now, tz, quiet);
    if (!g) {
      list.push(ch.main?.read ? readMain() : { channel: 'main', ok: false, reason: 'CHANNEL_READ_OFF' });
    } else {
      list.push(skipEntry('main', g));
    }
  }

  // 抖音：没开就完全不执行这一项
  {
    const g = primary === 'qq' ? { skip: 'off' } : primary === 'douyin'
      ? gate({ ...ch.douyin, enabled: true }, now, tz, quiet)
      : gate(ch.douyin, now, tz, quiet, srcOn('douyin'));
    if (!g) {
      if (ch.douyin?.read) {
        try {
          if (primary === 'douyin') {
            const state = readDouyinState(douyinPeer(cfg));
            const ok = !!readyDouyinBinding() && douyinInstallation().ready && !!state.polledAt && !state.pollError;
            list.push({ channel: 'douyin', ok, note: state.pollError || (ok ? '陪伴正在读取抖音私信' : '等待首次私信轮询'),
              lastUserTs: ok ? state.incoming?.ts || null : null, lastSendTs: ok ? state.outgoing?.lastAt || null : null });
          } else {
            list.push(readDouyin(now, cfg.rules?.douyinStaleMin || 10, cfg.sources?.douyin?.detectCacheMin));
          }
        } catch (e) {
          list.push({ channel: 'douyin', ok: false, reason: 'DOUYIN_READ_ERROR', note: String(e.message).slice(0, 120) });
        }
      } else {
        list.push({ channel: 'douyin', ok: false, reason: 'CHANNEL_READ_OFF' });
      }
    } else {
      list.push(skipEntry('douyin', g));
    }
  }

  let lastUserTs = null;
  let lastUserChannel = null;
  let lastSendTs = null;
  for (const c of list) {
    if (c.ok && c.lastUserTs && (!lastUserTs || c.lastUserTs > lastUserTs)) {
      lastUserTs = c.lastUserTs;
      lastUserChannel = c.channel;
    }
    if (c.ok && c.lastSendTs && (!lastSendTs || c.lastSendTs > lastSendTs)) {
      lastSendTs = c.lastSendTs;
    }
  }

  const available = list.filter((c) => c.ok);
  const skipped = list.filter((c) => c.state); // off / quiet / window：本拍没读，不算失败

  return {
    list,
    lastUserTs,
    lastUserChannel,
    lastSendTs,
    quiet,
    available: available.map((c) => c.channel),
    off: list.filter((c) => c.state === 'off').map((c) => c.channel),
    windowOff: list.filter((c) => c.state === 'window').map((c) => c.channel),
    allDown: available.length === 0 && skipped.length === 0,
  };
}
