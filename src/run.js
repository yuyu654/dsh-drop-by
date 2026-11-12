// run.js —— 入口。
//
//   node src/run.js --once            跑一拍，打印判定
//   node src/run.js --loop            按 tickMinutes 常驻
//   node src/run.js --status          只读：看配置、信号、最近几条判定
//   node src/run.js --set idle.awaySec=900
//
//   时段（全局静默 + 功能执行时段，都支持多段、可跨零点）：
//   node src/run.js --windows                    时段表 + 冲突检查
//   node src/run.js --win-set qq=07:00-12:00,14:00-18:00
//   node src/run.js --win-set quiet=22:30-07:30  /  busy=08:00-12:00
//   node src/run.js --win-add douyin=21:00-23:00  追加，不覆盖
//   node src/run.js --win-clear qq|all            清空 = 全天
//   node src/run.js --sleep                     看睡眠由头的阈值 + 今天这封判在哪
//   node src/run.js --sleep-set short=6h30 deep=1h45 long=9h [late=01:00]
//   node src/run.js --stress                    看压力由头的开关/阈值/次数 + 今天已发几次
//   node src/run.js --stress-set off            关掉；也认 on max=2 high=65 from=10 to=23 gap=3h
//   node src/run.js --fire ["文本"]             立刻真发一条，不看判定（默认发 content.fixedText）
//   node src/run.js --live on|off               真发 / 演练 一键切换（send.enabled + dryRun）
//   node src/run.js --test-send "文本" [--yes]  验证 qq-bridge 通道
//
//   邮箱（IMAP 读鱼鱼状态的 FISH 邮件）：
//   node src/run.js --mail-set user=xx@qq.com auth=授权码 [interval=30]
//   node src/run.js --mail-on | --mail-off
//   node src/run.js --mail-now        立刻读一次（忽略开关与间隔）
//   node src/run.js --mail-merge merge|replace|append
//                                     同一天又来新邮件时：补充 / 替换 / 追加（默认 merge）
//   node src/run.js --mail            看状态 + 最近一封 + 最近两天的归档
//
//   记录保留（只留最近 keepDays 天，默认 2；每天 07:00 换日）：
//   node src/run.js --records         看留了哪几天、哪些待删
//   node src/run.js --prune           立刻清一次
//
// 默认 dryRun=true：不发送、不写真实计数，只演进影子计数。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadConfig, saveConfig, loadState, saveState, setPath, getPath, LOG_DIR } from './config.js';
import { probe, classifyActivity } from './probe.js';
import { perceive, appendPerception } from './perception.js';
import { readSignals, signalLine } from './signals.js';
import { readMemory, memoryLine } from './memorysource.js';
import { readChannels } from './channels/index.js';
import { decide, presenceOf, checkTierGap, tierGapMs, REASONS } from './decide.js';
import { append, tail } from './logger.js';
import {
  pruneOldRecords,
  recordDay,
  recordSummary,
  readFishArchive,
  cutoffDay,
  shiftDay,
  mailUpdateMode,
  MAIL_UPDATE_MODES,
} from './retention.js';
import { hhmm, agoSec, healthDay, hmToMin, parseDur, minToHm } from './time.js';
import {
  inQuiet,
  inBusy,
  normalizeWindows,
  fmtWindows,
  checkSchedule,
  describeSchedule,
  featureByKey,
  FEATURES,
} from './schedule.js';
import { sendQQPrivate, bridgeInfo } from './send.js';
import { buildContext, selfMtime } from './context.js';
import { detectTriggers } from './triggers.js';
import { pickTopic, explainNoTopic, classifySleep, bedTimeOf, fishStale, SLOTS, tierOfSlot } from './topics.js';
import { summarizeVideo, readCache, CACHE_DIR } from './videosum.js';
import { outboundFor, answeredAlready, recentOutbound, douyinLastInbound } from './outbound.js';
import { feedbackSummary, adaptiveExtraMin } from './feedback.js';
import { parseAgenda, agendaSource, nextCourse, currentWeek, courseEnabled } from './agenda.js';
import { parseExams, examsSource, reviewDue, soonDue } from './exams.js';
import { pickNoReply, noReplyDue } from './noreply.js';
import { compose, guard, composeDraft } from './compose.js';
import { buildSnapshot } from './snapshot.js';
import { judgeDecision } from './judge.js';
import { shadowLine, shadowRate } from './shadow.js';
import { checkHealth, healthLines } from './health.js';
import { writeDailyReport } from './report.js';
import { generate } from './llm.js';
import { tick } from './engine.js';
import { restFor, restLine, clockOf } from './bedtime.js';
import { chitchatGate, chitchatToday } from './chitchat.js';
import { applyChange, isKnownPath, saveSecret } from './settings.js';
import { detectSources } from './detect.js';
import { loadPersona, personaPlan, ensureLocalPersonaTemplate, dshHome } from './persona.js';
import {
  pollFishMail,
  readLatest,
  loadSecrets,
  saveSecrets,
  maskUser,
  maskAuth,
  hostFor,
  mailReady,
  LATEST_PATH,
  SECRETS_PATH,
} from './fishmail.js';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};


/** 分钟 → "7 小时 30 分钟" / "45 分钟"。 */
function fmtMin(m) {
  const n = Math.max(0, Math.round(Number(m) || 0));
  const h = Math.floor(n / 60);
  const mm = n % 60;
  if (!h) return `${mm} 分钟`;
  return mm ? `${h} 小时 ${mm} 分钟` : `${h} 小时`;
}

/** 睡眠阈值的键别名：中文照抄用户会说的话。 */
const SLEEP_KEY = {
  short: 'short',
  '睡少': 'short',
  '短': 'short',
  '少': 'short',
  deep: 'deep',
  '深睡': 'deep',
  '深': 'deep',
  long: 'long',
  '睡多': 'long',
  '长': 'long',
  '多': 'long',
  late: 'late',
  '熬夜': 'late',
  '熬夜线': 'late',
};

/** 压力配置的键别名，同样照抄用户会说的话。 */
const STRESS_KEY = {
  high: 'high',
  '阈值': 'high',
  '线': 'high',
  '压力线': 'high',
  max: 'max',
  '次数': 'max',
  'daily': 'max',
  '一天': 'max',
  from: 'from',
  '起': 'from',
  '开始': 'from',
  to: 'to',
  '止': 'to',
  '结束': 'to',
  gap: 'gap',
  '间隔': 'gap',
  '间隔分钟': 'gap',
};

/** "09:00" / "9" / "21.5" → 小时数（可带小数）；认不出 null。 */
function parseHour(v) {
  const s = String(v ?? '').trim();
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const m = hmToMin(s);
    return m == null ? null : Math.round((m / 60) * 100) / 100;
  }
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : null;
}

/** 小时数 → "07:00" / "22:30"。 */
function hhmmOf(h) {
  const n = Number(h);
  if (!Number.isFinite(n)) return '--:--';
  const hh = Math.floor(n);
  const mm = Math.round((n % 1) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** 中日韩字符按两格算，表格才对得齐。 */
function padEndCjk(s, width) {
  const str = String(s ?? '');
  let w = 0;
  for (const ch of str) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return str + ' '.repeat(Math.max(0, width - w));
}

const LEVEL_TAG = { error: '[冲突]', warn: '[注意]', info: '[ OK ]' };

function printFindings(findings, { onlyProblems = false } = {}) {
  const list = onlyProblems ? findings.filter((f) => f.level !== 'info') : findings;
  if (!list.length) {
    console.log('  时段配置没有冲突');
    return;
  }
  for (const f of list) console.log(`  ${LEVEL_TAG[f.level] || '      '} ${f.text}`);
}

/** 时段配置项的中文/英文别名 → 配置里的路径。 */
function winTargetPath(key) {
  const k = String(key || '').trim().toLowerCase();
  const map = {
    quiet: 'quietHours',
    silent: 'quietHours',
    静默: 'quietHours',
    busy: 'busyHours',
    忙碌: 'busyHours',
    qq: 'channels.qq.activeHours',
    main: 'channels.main.activeHours',
    douyin: 'channels.douyin.activeHours',
    dy: 'channels.douyin.activeHours',
    抖音: 'channels.douyin.activeHours',
    mail: 'mail.activeHours',
    email: 'mail.activeHours',
    邮箱: 'mail.activeHours',
  };
  if (map[k]) return map[k];
  // 也允许直接写路径：--win-set channels.qq.activeHours=07:00-12:00
  return String(key || '').includes('.') ? String(key) : null;
}

function printSchedule(cfg, now) {
  const tz = cfg.timezone;
  console.log(`=== 时段 ===（现在 ${hhmm(now, tz)}）`);
  for (const r of describeSchedule(cfg, now, tz)) {
    const state =
      r.kind === 'quiet' ? (r.active ? '静默中' : '未静默') : !r.enabled ? '关' : r.active ? '生效中' : '不生效';
    console.log(
      `  ${padEndCjk(r.label, 14)}${padEndCjk(r.windowsText ?? fmtWindows(r.windows), 32)}${padEndCjk(state, 8)}${r.note || ''}`
    );
  }
  // 忙碌时段单独一行：它不是「执行时段」，只在主动开口那道闸上起作用
  const bh = Array.isArray(cfg.busyHours) ? cfg.busyHours : [];
  console.log(
    `  ${padEndCjk('忙碌', 14)}${padEndCjk(bh.length ? fmtWindows(bh) : '没设', 32)}${padEndCjk(
      bh.length ? (inBusy(now, bh, tz) ? '忙' : '不忙') : '—',
      8
    )}忙碌里不主动开口（她先说话照常回）`
  );
}

/** 邮箱那一行的人话版本。 */
function mailLine(m) {
  if (!m) return '-';
  if (m.state === 'off') return '关';
  if (m.state === 'quiet') return '全局静默中，这拍不连';
  if (m.state === 'window') return `不在执行时段（${m.openInMin ?? '?'} 分钟后开）${m.note ? '　' + m.note : ''}`;
  if (m.state === 'wait') return `等下一轮（还有 ${m.waitSec}s）`;
  if (m.state === 'unconfigured') return `未配置（${m.reason === 'MAIL_NO_AUTH' ? '缺授权码' : '缺邮箱'}）`;
  if (m.state === 'error') return `出错 ${m.reason}：${m.note || ''}`;
  const l = m.latest;
  return (
    `${m.reason}：取 ${m.fetched} 封 / 命中 ${m.matched} 封 / 新 ${m.newCount}` +
    (l ? `　最新「${l.subject}」${l.chars} 字` : '')
  );
}

function printSummary({ record, ch, cfg, pruned }) {
  const r = record;
  console.log(`[${r.tsLocal}] ${r.decision.toUpperCase()}  ${r.track || '-'}  ${r.reason}（${r.reason_text}）`);
  console.log(
    `  空闲 ${r.idle_sec}s(${r.presence})  安静=${r.in_quiet}  前台「${r.fg_title}」` +
      `  她 ${r.last_user_ago_sec == null ? '无记录' : r.last_user_ago_sec + 's 前'}（${r.last_user_channel || '-'}）` +
      `  上次主动 ${r.last_send_ago_min == null ? '无' : r.last_send_ago_min + ' 分钟前'}`
  );
  console.log(
    `  通道 ` +
      ch.list
        .map((c) => {
          const st = typeof c.state === 'string' ? c.state : c.state?.state;
          return `${c.channel}:${st || (c.ok ? 'ok' : c.reason)}`;
        })
        .join('  ') +
      `  | 今日 real ${r.today_sent_real} / sim ${r.today_sent_sim}`
  );
  if (pruned?.removed?.length) {
    // 只在真删了东西时打一行，平时不吵
    console.log(`  记录 清掉 ${pruned.removed.length} 个过期文件（只留 ${pruned.keepDays ?? 2} 天，最早 ${pruned.cutoff}）`);
  }
  if (r.topic) {
    const c = r.content || {};
    const tag = c.ok ? `[${c.source}] ${c.chars} 字` : `没写成：${c.reason || '-'}`;
    console.log(`  由头 ${r.topic.slot}（${r.topic.label}）→ 内容 ${tag}`);
    if (c.ok && c.text) console.log(`  要说的话「${c.text}」`);
    if (!c.ok && c.note) console.log(`  ${c.note}`);
    if (r.chitchat?.reason === 'CHITCHAT_LOW_PRIORITY') console.log('  随口话 让位（这一拍有由头）');
  } else if (r.reason === 'NO_TOPIC') {
    console.log('  由头 没有（这一拍不硬凑）');
  } else if (r.reason === 'REPLY_ON_OTHER_CHANNEL') {
    const ch = r.channel || {};
    console.log(
      `  由头 没有：她那句是 ${ch.from || '别的通道'} 上说的（${ch.slot || 'reply'}），这边只有 QQ —— 不追过去答`
    );
  } else if (r.chitchat && r.chitchat.reason) {
    console.log(`  由头 没有；随口话也没产：${r.chitchat.reason}${r.chitchat.why ? `（${r.chitchat.why}）` : ''}`);
  } else if (r.content?.ok) {
    // fixed 模式：没有由头，直接是固定内容
    console.log(`  内容「${r.content.text}」（${r.content.source}）`);
  }
  if (r.delivery) {
    const dv = r.delivery;
    const line = dv.attempted
      ? dv.ok
        ? `已发出 to=${dv.to} messageId=${dv.messageId ?? '-'}`
        : `发送失败：${dv.error}`
      : `没发：${dv.reason}`;
    console.log(`  发送 ${line}${dv.preview ? `  预览「${dv.preview}」` : ''}`);
  }
  if (r.chitchat?.produced) {
    const sd = r.chitchat.seed;
    console.log(
      `  随口话 起点 ${sd ? `${sd.kind}（${sd.day || '日期不明'}）` : '没有（只靠最近聊到哪）'}${
        r.chitchat.seedWhy ? `（${r.chitchat.seedWhy}）` : ''
      }`
    );
    if (r.chitchat.rest) {
      const { startMin, endMin } = r.chitchat.rest;
      console.log(`  随口话 睡着时段 ${clockOf(startMin)}–${clockOf(endMin)}（${r.chitchat.rest.from === 'history' ? '鱼鱼数据推的' : '默认'}）`);
    }
  }
  if (r.douyin) console.log(`  抖音 ${JSON.stringify(r.douyin)}`);
  console.log(`  邮箱 ${mailLine(r.mail)}`);
  if (r.persona) console.log(`  人格 ${r.persona.kind}（${r.persona.chars} 字，${r.persona.sources.join('+') || '内置'}）`);
  if (r.activity) console.log(`  L2 ${JSON.stringify(r.activity)}`);
  if (r.signals) console.log(`  结构化 ${JSON.stringify(r.signals)}`);
  if (r.screen?.ok) console.log(`  L3 ${(r.screen.hints || []).join(' / ').slice(0, 120)}`);
  if (r.backfill) console.log(`  回填 ${JSON.stringify(r.backfill)}`);
}

async function main() {
  if (has('--set')) {
    // 走设置页同一套校验（coerce）：能少一次「打错一个字、下一拍才炸」。
    // 白名单外的路径仍然放行（调试用），但会明说是没校验过的。
    let cfg = loadConfig();
    const pairs = argv.filter((a) => a.includes('=') && !a.startsWith('--'));
    const done = [];
    const failed = [];
    const unchecked = [];
    for (const p of pairs) {
      const i = p.indexOf('=');
      const key = p.slice(0, i).trim();
      const raw = p.slice(i + 1);
      if (!isKnownPath(key)) {
        setPath(cfg, key, raw);
        unchecked.push(key);
        done.push(`${key}=${raw}`);
        continue;
      }
      const r = applyChange(cfg, key, raw);
      if (!r.ok) {
        failed.push(r.error || `${key}：拒绝写入`);
        continue;
      }
      cfg = r.cfg;
      if (r.secret) {
        saveSecret(key, raw);
        done.push(`${key}=（已存进 credentials.json）`);
        continue;
      }
      done.push(`${key}=${r.value}`);
      if (r.hostReset) console.log(`提示：换了邮箱，IMAP 服务器从 ${r.hostReset.from} 改成 ${r.hostReset.to}`);
    }
    if (done.length) saveConfig(cfg);
    if (done.length) console.log(`已写入 ${done.length} 项：${done.join('  ')}`);
    if (unchecked.length) console.log(`⚠ 这些不在设置页白名单里，原样写入、没有校验：${unchecked.join(', ')}`);
    if (failed.length) {
      for (const f of failed) console.error(`✖ ${f}`);
      process.exitCode = 1;
    }
    return;
  }

  if (has('--mail-set')) {
    const pairs = argv.filter((a) => a.includes('=') && !a.startsWith('--'));
    const kv = {};
    for (const p of pairs) {
      const i = p.indexOf('=');
      kv[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim();
    }
    let user = kv.user || kv.email || '';
    let auth = kv.auth || kv.authcode || kv.code || '';

    if (!user && process.stdin.isTTY) {
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        user = (await rl.question('邮箱地址（如 123456@qq.com）：')).trim();
        auth = (await rl.question('IMAP 授权码（QQ 邮箱→设置→账户→开启 IMAP 后生成）：')).trim();
      } finally {
        rl.close();
      }
    }

    if (!user.includes('@')) {
      console.log('用法：node src/run.js --mail-set user=123456@qq.com auth=授权码 [host=imap.qq.com] [interval=30]');
      console.log('     也可以直接编辑 ' + SECRETS_PATH + '：{"user":"…","authCode":"…"}');
      return;
    }

    saveSecrets(auth ? { user, authCode: auth } : { user });

    const cfg = loadConfig();
    cfg.mail.user = user;
    cfg.mail.host = kv.host || hostFor(user);
    if (kv.interval) cfg.mail.intervalMinutes = Math.max(1, Number(kv.interval) || 30);
    if (kv.mailbox) cfg.mail.mailbox = kv.mailbox;
    if (kv.enable === 'false') cfg.mail.enabled = false;
    else cfg.mail.enabled = true;
    saveConfig(cfg);

    console.log(`已保存：${maskUser(user)}  @ ${cfg.mail.host}`);
    console.log(`授权码 ${auth ? maskAuth(auth) : '（沿用已有的）'}  → ${SECRETS_PATH}`);
    console.log(`开关 ${cfg.mail.enabled ? '开' : '关'}  间隔 ${cfg.mail.intervalMinutes} 分钟  信箱 ${cfg.mail.mailbox}`);
    console.log('提醒：这个功能靠手机 App「鱼鱼状态」发信 —— 手机 ④ 里要填同一个发件邮箱，');
    console.log('      并点「发一封测试邮件」确认能收到，否则邮箱里永远不会有 FISH 邮件可读。');
    console.log('下一步：node src/run.js --mail-now   立刻读一次确认能连上');
    return;
  }

  if (has('--mail-on') || has('--mail-off')) {
    const on = has('--mail-on');
    const cfg = loadConfig();
    cfg.mail.enabled = on;
    saveConfig(cfg);
    const rd = mailReady(cfg);
    console.log(`邮箱读取已${on ? '打开' : '关闭'}（mail.enabled=${on}）`);
    if (on && !rd.ok) console.log(`提示：${rd.reason}，先跑 node src/run.js --mail-set`);
    return;
  }

  if (has('--mail-merge')) {
    const cfg = loadConfig();
    const now = Date.now();
    const cur = mailUpdateMode(cfg);
    const ALIAS = {
      merge: 'merge',
      '补充': 'merge',
      '合并': 'merge',
      '并在原内容上': 'merge',
      replace: 'replace',
      '替换': 'replace',
      '覆盖': 'replace',
      '直接替换': 'replace',
      append: 'append',
      '追加': 'append',
      '一封一条': 'append',
    };
    const LABEL = {
      merge: '补充（一天一条，新邮件并在原内容上：有的字段覆盖、缺的字段保留）',
      replace: '替换（一天一条，新邮件直接顶掉当天原内容）',
      append: '追加（一封一条，各自留档）',
    };
    const raw = String(valOf('--mail-merge') || '').trim().toLowerCase();
    const want = ALIAS[raw] || (MAIL_UPDATE_MODES.includes(raw) ? raw : null);

    console.log('=== 同一天又来新邮件怎么办 ===');
    console.log(`  当前 ${LABEL[cur]}`);
    const today = readFishArchive(cfg, now).filter((a) => a.day === recordDay(now, cfg.timezone, cfg));
    if (today.length) {
      const t = today[0];
      console.log(`  今天 ${t.uid} 那一封：合了 ${t.mailCount || 1} 封${t.uids?.length ? `（uid ${t.uids.join(' / ')}）` : ''}`);
    } else {
      console.log('  今天还没有归档');
    }

    if (!raw) {
      console.log('');
      console.log('改法：node src/run.js --mail-merge merge|replace|append   （也认 补充 / 替换 / 追加）');
      console.log(`  写在 config.json 的 logging.mailUpdateMode，当前值 ${JSON.stringify(cfg.logging?.mailUpdateMode ?? null)}`);
      return;
    }
    if (!want) {
      console.log(`\n认不出「${raw}」。只能是 merge / replace / append（或 补充 / 替换 / 追加），没写入。`);
      return;
    }
    cfg.logging ||= {};
    cfg.logging.mailUpdateMode = want;
    saveConfig(cfg);
    console.log(`\n已改为：${LABEL[want]}`);
    console.log(`下一封邮件到达就按这个口径合并（已经归档的那封不会被回头改写）。`);
    return;
  }

  if (has('--mail-now')) {
    const cfg = loadConfig();
    const st = loadState();
    if (cfg.mail.enabled !== true) console.log('提示：开关是关的，这次属于强制读一次，不会改动开关状态');
    const r = await pollFishMail({ cfg, state: st, now: Date.now(), force: true });
    saveState(st);
    console.log(JSON.stringify(r, null, 2));
    const latest = readLatest();
    if (latest?.summary) {
      console.log(`\n--- ${latest.subject}（${latest.date}）---`);
      console.log(latest.summary);
      console.log(`\n（完整内容已写入 ${LATEST_PATH}）`);
    }
    return;
  }

  if (has('--mail') || has('--mail-status')) {
    const cfg = loadConfig();
    const rd = mailReady(cfg);
    const st = loadState();
    const sec = loadSecrets();
    const now = Date.now();
    const m = cfg.mail || {};
    const ms = st.mail || {};
    console.log('=== 邮箱（IMAP 读鱼鱼状态）===');
    console.log('  来源 手机 App「鱼鱼状态」采集后发来的 FISH 邮件（App 没装/没配邮箱就不会有新邮件）');
    console.log(`  开关 ${m.enabled === true ? '开' : '关'}   间隔 ${m.intervalMinutes ?? 30} 分钟   信箱 ${m.mailbox || 'INBOX'}`);
    console.log(`  账号 ${rd.user ? maskUser(rd.user) : '（未填）'}   授权码 ${sec.authCode ? maskAuth(sec.authCode) : '（未填）'}`);
    console.log(`  服务器 ${hostFor(rd.user, m.host) || '-'}:${m.port || 993}  tls=${m.tls !== false}  取最近 ${m.fetchCount ?? 5} 封  主题 ${m.subjectPattern || '^\\s*FISH'}`);
    const how = mailUpdateMode(cfg);
    console.log(
      `  同日新邮件 ${how === 'merge' ? '补充（并在原内容上）' : how === 'replace' ? '替换（顶掉原内容）' : '追加（一封一条）'}   logging.mailUpdateMode`
    );
    console.log(`  就绪 ${rd.ok ? '是' : `否（${rd.reason}）`}`);
    if (ms.lastPollAt) console.log(`  上次检查 ${new Date(ms.lastPollAt).toLocaleString()}（${ms.polls || 0} 次）`);
    if (ms.lastOkAt) console.log(`  上次成功 ${new Date(ms.lastOkAt).toLocaleString()}`);
    if (ms.lastUid) console.log(`  已读到 uid ${ms.lastUid}「${ms.lastSubject || ''}」`);
    if (ms.lastError) console.log(`  上次错误 ${ms.lastError}`);
    const latest = readLatest();
    if (latest) {
      const age = Math.round((now - Number(latest.fetchedAt || 0)) / 60000);
      console.log(`  最新邮件「${latest.subject}」${latest.chars} 字，${age} 分钟前取回`);
      console.log(`  文件 ${LATEST_PATH}`);
    } else {
      console.log('  还没有取回过邮件');
    }
    // 归档：最近 keepDays 天收过几封、解析出什么
    const arch = readFishArchive(cfg, now);
    const days = [...new Set(arch.map((x) => x.day))].sort().reverse();
    if (arch.length) {
      console.log(`  归档 ${arch.length} 封（${days.join(' / ')}）  ${path.join(ROOT, 'data', 'fish')}`);
      for (const a of arch.slice(0, 3)) {
        const p = a.parsed || {};
        const bits = [];
        if (p.sleepMin != null) bits.push(`睡 ${p.sleepMin} 分`);
        if (p.deepMin != null) bits.push(`深睡 ${p.deepMin}`);
        if (p.stress != null) bits.push(`压力 ${p.stress}`);
        if (p.wakeHm) bits.push(`起 ${p.wakeHm}`);
        const cnt = Number(a.mailCount) || (Array.isArray(a.uids) ? a.uids.length : 1);
        console.log(
          `    ${a.day} uid ${a.uid}${cnt > 1 ? `（合了 ${cnt} 封）` : ''} ${String(a.subject).slice(0, 30)}  ${bits.join(' · ') || '没解析出数字'}`
        );
      }
    } else {
      console.log('  归档 空（读到新邮件后会自动记到 data/fish/<日期>.json）');
    }
    return;
  }

  if (has('--records') || has('--prune')) {
    const cfg = loadConfig();
    const now = Date.now();
    const doPrune = has('--prune');
    const s = recordSummary(cfg, now);

    console.log('=== 记录保留 ===');
    console.log(`  规则 只留最近 ${s.keepDays} 天（今天 + ${s.keepDays > 1 ? `前 ${s.keepDays - 1} 天` : '无'}），每天 ${String(cfg.logging?.dayStartHour ?? 7).padStart(2, '0')}:00 换日`);
    console.log(`  记录日 ${s.today}   最早保留 ${s.cutoff}`);
    console.log(`  下次自动清理 ${shiftDay(s.today, 1)} ${String(cfg.logging?.dayStartHour ?? 7).padStart(2, '0')}:00 之后（会删掉 ${s.cutoff} 及更早）`);

    const LABEL = { decision: '判定 decision', perception: '感知 perception', mail: '邮件 mail', fish: '邮件归档 fish' };
    for (const [key, label] of Object.entries(LABEL)) {
      const files = s.groups[key] || [];
      const live = files.filter((f) => !f.stale);
      const stale = files.filter((f) => f.stale);
      const kb = (live.reduce((a, b) => a + b.size, 0) / 1024).toFixed(1);
      console.log(
        `  ${padEndCjk(label, 17)}${live.length ? `保留 ${live.map((f) => f.day).join(' / ')}（${kb} KB）` : '—'}` +
          (stale.length ? `   待删 ${stale.map((f) => f.day).join(' / ')}` : '')
      );
    }

    if (doPrune) {
      const r = pruneOldRecords(cfg, now);
      if (r.removed.length) {
        console.log(`\n  已删除 ${r.removed.length} 个文件：`);
        for (const x of r.removed) console.log(`    ${path.basename(x.file)}`);
      } else {
        console.log(`\n  没有要删的（都在 ${r.cutoff} 之后）`);
      }
      if (r.errors.length) for (const e of r.errors) console.log(`    ✗ ${path.basename(e.file)}：${e.note}`);
    } else {
      console.log('\n  立刻清理：node src/run.js --prune');
      console.log('  改保留天数：node src/run.js --set logging.keepDays=3     改换日时刻：--set logging.dayStartHour=7');
    }
    return;
  }

  if (has('--sleep') || has('--sleep-set')) {
    const cfg = loadConfig();
    const T = (cfg.content.topics ||= {});
    const cur = {
      short: Number(T.sleepShortMin ?? 420),
      deep: Number(T.sleepDeepShortMin ?? 120),
      long: Number(T.sleepLongMin ?? 570),
      late: String(T.sleepLateBed ?? '00:30'),
    };

    if (has('--sleep-set')) {
      const flag = '--sleep-set';
      const jobs = [];
      for (const a of argv.slice(argv.indexOf(flag) + 1)) {
        if (a.startsWith('--')) continue;
        if (!a.includes('=')) continue;
        const i = a.indexOf('=');
        jobs.push({ key: a.slice(0, i), value: a.slice(i + 1) });
      }
      if (!jobs.length) {
        console.log('用法：node src/run.js --sleep-set short=6h30 deep=1h45 long=9h [late=01:00]');
        console.log('  时长写法：7h / 7h30 / 7:30 / 6.5h / 420（纯数字=分钟）');
        console.log('  键：short(睡少) / deep(深睡) / long(睡多) / late(熬夜线，HH:MM)');
        return;
      }
      const next = { ...cur };
      let bad = 0;
      for (const job of jobs) {
        const k = SLEEP_KEY[String(job.key).trim().toLowerCase()];
        if (!k) {
          console.log(`跳过「${job.key}」：只能是 short / deep / long / late（也认 睡少/深睡/睡多/熬夜）`);
          bad++;
          continue;
        }
        if (k === 'late') {
          if (!/^\d{1,2}:\d{2}$/.test(job.value) || hmToMin(job.value) == null) {
            console.log(`✗ late=${job.value} 不是 HH:MM`);
            bad++;
            continue;
          }
          next.late = job.value.padStart(5, '0');
          continue;
        }
        const m = parseDur(job.value);
        if (m == null || m <= 0 || m >= 1440) {
          console.log(`✗ ${job.key}=${job.value} 认不出时长（7h / 7h30 / 7:30 / 6.5h / 420）`);
          bad++;
          continue;
        }
        next[k] = m;
      }
      if (next.short >= next.long) {
        console.log(`✗ 睡少（${fmtMin(next.short)}）不能大于等于睡多（${fmtMin(next.long)}），先确认这两个值`);
        return;
      }
      if (next.deep >= next.short) {
        console.log(`提示：深睡线（${fmtMin(next.deep)}）≥ 睡少线（${fmtMin(next.short)}），读到深睡时这两个条件几乎没法同时成立——确认一下是不是想这样。`);
      }
      T.sleepShortMin = next.short;
      T.sleepDeepShortMin = next.deep;
      T.sleepLongMin = next.long;
      T.sleepLateBed = next.late;
      saveConfig(cfg);
      Object.assign(cur, next); // 下面这段表要显示改完的值，不是改之前的
      console.log(
        `已写入：睡少 <${fmtMin(next.short)}  深睡 <${fmtMin(next.deep)}  睡多 >${fmtMin(next.long)}  熬夜线 ${next.late}` +
          (bad ? `（${bad} 项跳过）` : ''),
      );
      console.log('下一拍就生效，不用重启。');
    }

    const now = Date.now();
    const tz = cfg.timezone;
    const fromH = Number(T.sleepFromHour ?? 7);
    const toH = Number(T.sleepToHour ?? 10.5);
    const row = (label, value, key) => console.log(`  ${padEndCjk(label, 10)}${padEndCjk(value, 30)}${key}`);
    console.log('=== 睡眠由头阈值（都能改） ===');
    row('睡少线', `< ${fmtMin(cur.short)}（${cur.short} 分）`, 'content.topics.sleepShortMin');
    row('深睡线', `< ${fmtMin(cur.deep)}（${cur.deep} 分）`, 'content.topics.sleepDeepShortMin');
    row('睡多线', `> ${fmtMin(cur.long)}（${cur.long} 分）`, 'content.topics.sleepLongMin');
    row('熬夜线', `入睡晚于 ${cur.late}`, 'content.topics.sleepLateBed');
    row('触发时段', `${hhmmOf(fromH)}–${hhmmOf(toH)}`, 'sleepFromHour / sleepToHour');
    row('一天一次', `健康日 ${hhmmOf(Number(T.sleepDayStartHour ?? 7))} 起算`, 'sleepDayStartHour');
    console.log('');
    console.log('  判定：睡眠 < 睡少线（深睡读到时还要 < 深睡线）→ 邮件里有「入睡时间」就直接用它，');
    console.log('        没有才用「起床 − 睡眠」反推入睡；晚于熬夜线算「熬夜」，否则算「没睡好」。');
    console.log('        睡眠 > 睡多线 → 问是不是累到了。');

    const st = loadState();
    const ctx = buildContext({ cfg, now, st, ch: { list: [] }, sys: {}, tz });
    if (!ctx.fish.ok) {
      console.log('\n今天这封：还没有鱼鱼数据（邮箱没开 / 没收到 FISH 邮件）');
    } else {
      const c = classifySleep(ctx.fish, cfg);
      const used = st?.content?.lastSleepFor;
      const day = healthDay(now, tz, Number(T.sleepDayStartHour ?? 7));
      const bt = bedTimeOf(ctx.fish);
      const where = c
        ? `${c.kind}${c.bedHm ? `（入睡 ${c.bedHm}${c.bedFrom === 'direct' ? '·邮件自带' : '·反推'}）` : ''}`
        : bt.bedHm
          ? `不构成由头（${bt.bedFrom === 'direct' ? '邮件自带入睡' : '反推入睡'} ${bt.bedHm}）`
          : '不构成由头';
      console.log(
        `\n今天这封：夜间睡眠 ${ctx.fish.nightMin == null ? '未读到' : fmtMin(ctx.fish.nightMin)}` +
          ` / 总睡眠 ${ctx.fish.totalMin == null ? '未读到' : fmtMin(ctx.fish.totalMin)}` +
          `（判定用${ctx.fish.sleepFrom === 'total' ? '总睡眠' : ctx.fish.sleepFrom === 'night' ? '夜间睡眠' : '—'}）` +
          ` / 深睡 ${ctx.fish.deepMin == null ? '未读到' : fmtMin(ctx.fish.deepMin)}` +
          ` / 起床 ${ctx.fish.wakeHm || '未读到'}` +
          ` / 入睡（邮件）${ctx.fish.bedHm || '未读到'}` +
          `（${ctx.fish.ageMin ?? '?'} 分钟前）→ ${where}`,
      );
      console.log(`          健康日 ${day}${used === day ? '（这个健康日已经说过睡眠了）' : '（还没说过）'}`);
    }
    console.log('\n改法：node src/run.js --sleep-set deep=1h45   （只改一项也行，数值按分钟换算）');
    return;
  }

  if (has('--stress') || has('--stress-set')) {
    const cfg = loadConfig();
    const T = (cfg.content.topics ||= {});
    const cur = {
      on: T.stress !== false,
      high: Number(T.stressHighMin ?? 59),
      max: Number(T.stressDailyMax ?? 1),
      from: Number(T.stressFromHour ?? 9),
      to: Number(T.stressToHour ?? 22),
      gap: Number(T.stressMinGapMin ?? 180),
      ageH: Number(T.stressMaxAgeH ?? 12),
    };

    if (has('--stress-set')) {
      const flag = '--stress-set';
      const jobs = [];
      for (const a of argv.slice(argv.indexOf(flag) + 1)) {
        if (a.startsWith('--')) continue;
        const s = a.trim().toLowerCase();
        if (['on', 'off', '开', '关', 'enable', 'disable'].includes(s)) {
          jobs.push({ key: 'switch', value: s });
          continue;
        }
        if (!a.includes('=')) continue;
        const i = a.indexOf('=');
        jobs.push({ key: a.slice(0, i), value: a.slice(i + 1) });
      }
      if (!jobs.length) {
        console.log('用法：node src/run.js --stress-set off');
        console.log('      node src/run.js --stress-set on max=2 high=65');
        console.log('  键：on/off 开关；max 一天次数(1–6)；high 压力阈值(1–100)；');
        console.log('      from/to 时段(HH:MM 或小时)；gap 两次最小间隔(分钟，也认 3h)');
        return;
      }

      const next = { ...cur };
      let bad = 0;
      for (const job of jobs) {
        const k0 = String(job.key).trim().toLowerCase();
        if (k0 === 'switch') {
          next.on = ['on', '开', 'enable'].includes(String(job.value).trim().toLowerCase());
          continue;
        }
        const k = STRESS_KEY[k0];
        if (!k) {
          console.log(`跳过「${job.key}」：只能是 on / off / max / high / from / to / gap（也认 次数/阈值/时段/间隔）`);
          bad++;
          continue;
        }
        if (k === 'from' || k === 'to') {
          const h = parseHour(job.value);
          if (h == null) {
            console.log(`✗ ${job.key}=${job.value} 认不出时刻（09:00 / 9 / 21.5）`);
            bad++;
            continue;
          }
          next[k] = h;
          continue;
        }
        if (k === 'gap') {
          const m = parseDur(job.value);
          if (m == null || m < 0 || m > 1440) {
            console.log(`✗ gap=${job.value} 认不出间隔（分钟数，或 3h / 2h30）`);
            bad++;
            continue;
          }
          next.gap = m;
          continue;
        }
        const n = Number(String(job.value).trim());
        if (!Number.isFinite(n)) {
          console.log(`✗ ${job.key}=${job.value} 不是数字`);
          bad++;
          continue;
        }
        if (k === 'high' && (n < 1 || n > 100)) {
          console.log(`✗ 压力阈值要在 1–100 之间（现在是 ${n}）`);
          bad++;
          continue;
        }
        if (k === 'max' && (n < 1 || n > 6)) {
          console.log(`✗ 一天次数要在 1–6 之间（现在是 ${n}；不想发就直接关掉）`);
          bad++;
          continue;
        }
        next[k] = n;
      }
      if (next.from >= next.to) {
        console.log(`✗ 起始（${hhmmOf(next.from)}）不能晚于结束（${hhmmOf(next.to)}），跨零点的时段请分开配`);
        return;
      }
      T.stress = next.on;
      T.stressHighMin = next.high;
      T.stressDailyMax = next.max;
      T.stressFromHour = next.from;
      T.stressToHour = next.to;
      T.stressMinGapMin = next.gap;
      saveConfig(cfg);
      Object.assign(cur, next);
      console.log(
        `已写入：${next.on ? '开' : '关'}  压力 >${next.high}  ${hhmmOf(next.from)}–${hhmmOf(next.to)}  一天最多 ${next.max} 次  间隔 ≥${next.gap} 分钟` +
          (bad ? `（${bad} 项跳过）` : ''),
      );
      console.log('下一拍就生效，不用重启。');
    }

    const now = Date.now();
    const tz = cfg.timezone;
    const row = (label, value, key) => console.log(`  ${padEndCjk(label, 12)}${padEndCjk(value, 36)}${key}`);
    console.log('=== 压力话题（可开关、可限次数） ===');
    row('开关', cur.on ? '开' : '关（不会因压力发消息）', 'content.topics.stress');
    row('阈值', `压力 > ${cur.high}`, 'content.topics.stressHighMin');
    row('一天次数', `最多 ${cur.max} 次（健康日 ${hhmmOf(Number(T.sleepDayStartHour ?? 7))} 起算）`, 'content.topics.stressDailyMax');
    row('两次间隔', `≥ ${cur.gap} 分钟`, 'content.topics.stressMinGapMin');
    row('触发时段', `${hhmmOf(cur.from)}–${hhmmOf(cur.to)}`, 'stressFromHour / stressToHour');
    row('数据新鲜度', `≤ ${cur.ageH} 小时内的邮件`, 'content.topics.stressMaxAgeH');

    const st = loadState();
    const ctx = buildContext({ cfg, now, st, ch: { list: [] }, sys: {}, tz });
    const day = healthDay(now, tz, Number(T.sleepDayStartHour ?? 7));
    const sent = st?.content?.stressDay === day ? Number(st?.content?.stressCount) || 0 : 0;
    console.log('');
    if (!ctx.fish.ok) {
      console.log('今天这封：还没有鱼鱼数据（邮箱没开 / 没收到 FISH 邮件）');
    } else if (ctx.fish.stress == null) {
      console.log('今天这封：摘要里没读到压力值（App 那行「· 压力 36」没解析出来）');
    } else {
      const v = Number(ctx.fish.stress);
      console.log(
        `今天这封：压力 ${v}（${ctx.fish.ageMin ?? '?'} 分钟前）→ ` +
          (v > cur.high ? `超过阈值 ${cur.high}` : `没超过阈值 ${cur.high}`),
      );
    }
    console.log(`          健康日 ${day}：今天已发 ${sent} 次，上限 ${cur.max} 次`);
    console.log('\n改法：node src/run.js --stress-set off           关掉这一类');
    console.log('      node src/run.js --stress-set max=2 gap=3h   一天最多两次、间隔 3 小时');
    return;
  }

  if (has('--windows') || has('--schedule')) {
    const cfg = loadConfig();
    const now = Date.now();
    printSchedule(cfg, now);
    console.log('=== 冲突检查 ===');
    printFindings(checkSchedule(cfg));
    console.log('\n用法：node src/run.js --win-set qq=07:00-12:00,14:00-18:00');
    console.log('      node src/run.js --win-set quiet=22:30-07:30  /  busy=08:00-12:00');
    console.log('      node src/run.js --win-set mail=        （留空=全天不限）');
    return;
  }

  if (has('--win-set') || has('--win-add') || has('--win-clear')) {
    const isClear = has('--win-clear');
    const isAdd = has('--win-add');
    const flag = isClear ? '--win-clear' : isAdd ? '--win-add' : '--win-set';

    const cfg = loadConfig();

    if (isClear) {
      const targets = argv
        .slice(argv.indexOf(flag) + 1)
        .filter((a) => !a.startsWith('--'))
        .map((a) => String(a).trim().toLowerCase());
      if (!targets.length) {
        console.log('用法：node src/run.js --win-clear qq|douyin|mail|quiet|all');
        return;
      }
      const all = targets.includes('all') || targets.includes('全部');
      let n = 0;
      for (const f of FEATURES) {
        if (!all && !targets.includes(f.key)) continue;
        setPath(cfg, f.path, []);
        n++;
      }
      if (all || targets.includes('quiet') || targets.includes('静默')) {
        cfg.quietHours = [];
        n++;
      }
      if (all || targets.includes('busy') || targets.includes('忙碌')) {
        cfg.busyHours = [];
        n++;
      }
      saveConfig(cfg);
      console.log(`已清空 ${n} 项（清空 = 全天不限 / 不静默）`);
      printSchedule(cfg, Date.now());
      printFindings(checkSchedule(cfg), { onlyProblems: true });
      return;
    }

    // 收集 key=值，值里带逗号没加引号时会被拆成多个 argv，往后拼回去
    const jobs = [];
    for (const a of argv.slice(argv.indexOf(flag) + 1)) {
      if (a.startsWith('--')) continue;
      if (a.includes('=')) {
        const i = a.indexOf('=');
        jobs.push({ key: a.slice(0, i), value: a.slice(i + 1) });
      } else if (jobs.length) {
        jobs[jobs.length - 1].value += ',' + a;
      }
    }
    if (!jobs.length) {
      console.log('用法：node src/run.js --win-set qq=07:00-12:00,14:00-18:00');
      console.log('      可设：qq / douyin / mail / quiet（静默）/ busy（忙碌），回车留空表示全天');
      return;
    }

    let bad = 0;
    const changed = [];
    for (const job of jobs) {
      const path = winTargetPath(job.key);
      if (!path) {
        console.log(`跳过「${job.key}」：不认识，只能是 qq / douyin / mail / quiet`);
        bad++;
        continue;
      }
      const norm = normalizeWindows(job.value);
      if (norm.errors.length) {
        for (const e of norm.errors) console.log(`✗ ${e}`);
        bad++;
        continue;
      }
      const prev = isAdd ? normalizeWindows(getPath(cfg, path, [])).windows : [];
      const merged = normalizeWindows([...prev, ...norm.windows]).windows;
      setPath(cfg, path, merged);
      changed.push(`${job.key}=${fmtWindows(merged)}`);
    }

    if (changed.length) {
      saveConfig(cfg);
      console.log(`已写入 ${changed.length} 项：${changed.join('  ')}`);
    }
    printSchedule(cfg, Date.now());
    const findings = checkSchedule(cfg);
    const problems = findings.filter((f) => f.level !== 'info');
    console.log('=== 冲突检查 ===');
    if (problems.length) printFindings(problems);
    else console.log('  没有冲突');
    if (bad) console.log('（有 ' + bad + ' 项没写进去，看上面的提示）');
    return;
  }

  if (has('--persona') || has('--persona-show')) {
    const cfg = loadConfig();
    const plan = personaPlan(cfg, cfg.persona?.projectCwd);
    const p = loadPersona({ cfg, force: true });
    console.log('=== 人格 ===');
    console.log(`  DSH_HOME ${plan.home}`);
    console.log(`  生效来源 ${p.kind}（${p.chars} 字）${p.ok ? '' : ' ← 用的内置兜底'}`);
    for (const r of plan.rows) {
      const mark = r.exists ? '有' : '无';
      console.log(`  ${r.exists ? '[有]' : '[无]'} ${padEndCjk(r.label, 26)}${r.path || '-'}`);
      if (r.exists && r.path) {
        try {
          console.log(`       ${fs.statSync(r.path).size} 字节`);
        } catch {
          /* 读不到就算了 */
        }
      }
    }
    if (plan.plugin) {
      console.log(
        `  插件开关 总开关=${plan.plugin.enabled ? '开' : '关'}  全局注入=${plan.plugin.includeGlobal ? '开' : '关'}  项目人格=${plan.plugin.projectPersonaEnabled ? '开' : '关'}`
      );
    } else {
      console.log('  插件开关 —— 没找到 dsh-agent-md，走本地 persona.md / 内置');
    }
    if (p.note) console.log(`  说明 ${p.note}`);
    console.log(`  实际注入 ${p.chars} 字，前 120 字：${p.text.replace(/\s+/g, ' ').slice(0, 120)}`);
    console.log('\n改人格：DSH 设置 → 人格；或直接编辑上面的文件。改完下一拍自动读到（按 mtime 判断）。');
    return;
  }

  if (has('--sources')) {
    const cfg = loadConfig();
    const d = detectSources(cfg);
    const sw = (k) => (cfg.sources?.[k]?.enabled !== false ? '开' : '关');
    console.log('=== 三条链路（开关 + 实测）===');
    for (const [k, label] of [['phone', '手机数据'], ['qq', 'QQ'], ['douyin', '抖音']]) {
      const x = d[k];
      const ver = x.version ? `（v${x.version}）` : '';
      console.log(`  ${label}：开关 ${sw(k)}｜检测 ${x.ready ? '通' : '不通'}｜${x.note}${ver}`);
    }
    console.log('  说明 手机数据 = 手机 App 发 FISH 邮件、本机 IMAP 取回；另两条要装插件');
    const mem = readMemory({ cfg, now: Date.now() });
    console.log(`  记忆插件：开关 ${sw('memory')}｜${memoryLine(mem)}`);
    console.log('  开关 设置页「接入」组，或 --set sources.qq.enabled=false');
    process.exit(0);
  }

  if (has('--video')) {
    // 手动看一条：node src/run.js --video <aweme_id> [--force]
    // 不给 id 就用「她最近转来的那条」。这是第 2 步的独立入口，方便一条条核对摘要准不准。
    const cfg = loadConfig();
    const now = Date.now();
    let id = String(valOf('--video') || '').trim();
    if (!id) {
      const st = loadState();
      const ch = readChannels(cfg, now, { quiet: inQuiet(now, cfg.quietHours, cfg.timezone) });
      const sys = await probe();
      const ctx = buildContext({ cfg, now, st, ch, sys, tz: cfg.timezone });
      id = String(ctx.her.forwardItem || '');
      if (!id) {
        console.log('没有 id：她最近没有转来带视频的消息，也没给 --video <aweme_id>。');
        process.exit(1);
      }
      console.log(`用她最近转的那条：${id}（${ctx.her.forwardText.slice(0, 60)}）`);
    }
    const cached = readCache(id, { cfg, now });
    if (cached && !has('--force')) {
      console.log('=== 缓存（同一条只看一次；要重看加 --force）===');
    }
    // 带上模型入口，CLI 里也能得到两三句摘要（不然只能退化成转写前几句）。
    const r = await summarizeVideo(id, {
      cfg,
      now,
      force: has('--force'),
      llm: (args) => generate(args),
    });
    console.log(JSON.stringify(r, null, 2));
    console.log(`缓存目录 ${CACHE_DIR}`);
    return;
  }

  if (has('--memory')) {
    // 手动看一眼「从记忆插件里读到了什么」：不发消息、不叫模型，只读。
    const cfg = loadConfig();
    const mem = readMemory({ cfg, now: Date.now() });
    console.log(`=== 记忆（${cfg.sources?.memory?.plugin || 'fish-memory'}）===`);
    console.log(`  ${memoryLine(mem)}`);
    if (mem.dir) console.log(`  目录 ${mem.dir}`);
    if (mem.mode) console.log(`  取法 ${mem.mode === 'all' ? '全部会话合并' : mem.mode === 'session' ? '指定会话' : '最近改过的那份'}`);
    for (const it of mem.items || []) {
      console.log(`  · ${it.day || '—'} [${it.category}${it.importance ? ` ${it.importance}` : ''}] ${it.text}`);
    }
    if (!mem.items?.length) console.log('  （没有能用的条目）');
    process.exit(0);
  }

  if (has('--why')) {
    const cfg = loadConfig();
    const now = Date.now();
    const tz = cfg.timezone;
    const st = loadState();
    const quiet = inQuiet(now, cfg.quietHours, tz);
    const ch = readChannels(cfg, now, { quiet });
    const sys = await probe();
    const ctx = buildContext({ cfg, now, st, ch, sys, tz });
    ctx.clock = hhmm(now, tz);
    // 结构化信号（窗口标题/标签页/文件）：几毫秒，顺手读一次，好让人看见模型到底拿到了什么。
    if (cfg.perception?.signals?.enabled !== false) {
      ctx.signals = await readSignals({ cfg, sys, now });
    }
    // 记忆插件里的长期记忆（只读；读不到就照常写，不挡这一拍）。
    ctx.memory = readMemory({ cfg, now });
    ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
    const busy = inBusy(now, cfg.busyHours, tz);
    // --why 不叫模型：只用上次判过的结果，别为了看一眼诊断就花一次调用
    const cand = pickNoReply({
      st, cfg, now,
      herTs: Math.max(Number(ch.lastUserTs) || 0, Number(ctx.her?.lastTs) || 0) || null,
      herOnDouyin: Number(douyinLastInbound({ cfg })?.ts) || 0,
    });
    ctx.noReply = cand
      ? { ...cand, verdict: st?.noReply && st.noReply.key === cand.key ? st.noReply.verdict || null : null }
      : null;
    const topic = pickTopic(ctx, cfg, now, st);
    console.log('=== 这一拍的数据 ===');
    console.log(
      `  她 ${ctx.her.lastAgoSec == null ? '没有记录' : (ctx.her.lastAgoSec / 3600).toFixed(1) + ' 小时前说过话'}` +
        `  我 ${ctx.me.lastAgoSec == null ? '没有记录' : (ctx.me.lastAgoSec / 3600).toFixed(1) + ' 小时前说过话'}`
    );
    console.log(`  对话条数 ${ctx.recent.length}   鱼鱼 ${ctx.fish.ok ? `有（${ctx.fish.ageMin} 分钟前取回）` : '没有'}`);
    if (cfg.rules?.replyGuard !== false) {
      const ob = outboundFor(ctx?.her?.lastChannel, { cfg });
      const hit = answeredAlready({ herTs: ctx.her.lastTs, out: ob });
      const when = ob.ts ? new Date(ob.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '';
      console.log(
        `  出站 ${when ? `${when}（${ob.channel}/${ob.src || '-'}）` : '没有记录'}` +
          `  → ${hit ? '她已经应过了，回复类由头这一拍会被拦下' : '还没回过她'}`
      );
    } else {
      console.log('  出站 防重复关着（rules.replyGuard=false）');
    }
    {
      const fb = feedbackSummary(st, cfg);
      console.log(`  反馈 ${fb.text}${fb.streak >= 2 ? `；连着 ${fb.streak} 条没回，间隔多等 ${fb.extraMin} 分钟` : ''}`);
    }
    {
      const bh = Array.isArray(cfg.busyHours) ? cfg.busyHours : [];
      console.log(
        `  忙碌 ${bh.length ? `${busy ? '现在就在忙碌时段 → 不主动开口' : '现在不在忙碌时段'}（${bh.map((w) => (Array.isArray(w) ? w.join('-') : String(w))).join('、')}）` : '没设（运行里「忙碌时段」）'}`
      );
    }
    {
      if (cfg.content?.topics?.noReply === false) console.log('  追问 关着（content.topics.noReply=false）');
      else if (!ctx.noReply) console.log('  追问 没有「我发过去、她一直没回」的那条');
      else {
        const c = ctx.noReply;
        const due = noReplyDue({ cand: c, cfg, now, herTs: ch.lastUserTs, tz });
        const vTxt = !c.verdict ? '还没让模型判' : c.verdict.away ? `判断在忙${c.verdict.untilHm ? `到 ${c.verdict.untilHm}` : ''}` : '判断不是忙';
        console.log(
          `  追问 ${c.channel === 'douyin' ? '抖音分享' : 'QQ'} ${c.silenceMin} 分钟没回（${hhmm(c.at, tz)} 那条）· ${vTxt} → ${due.ok ? '这一拍可以问' : due.why}`
        );
      }
    }
    {
      const a = agendaSource(cfg);
      const ag = cfg.content?.agenda || {};
      const termStart = String(ag.termStart || '');
      const opts = { termStart, periods: String(ag.periods || ''), off: Array.isArray(ag.off) ? ag.off : [] };
      const week = currentWeek(now, tz, termStart);
      const list = parseAgenda(a.text, opts);
      const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      const nc = list.length ? nextCourse(a.text, now, tz, opts) : null;
      const wkNote = week ? `；第 ${week} 周` : termStart ? '' : list.some((c) => c.weeks) ? '；没填开学日期，周次不生效' : '';
      const offNote = opts.off.length ? `；勾掉 ${opts.off.length} 节` : '';
      console.log(`  课表 ${list.length ? `${list.length} 节（${a.from === 'config' ? '设置页' : a.from}）${wkNote}${offNote}；下一节 ${nc ? `${nc.inDays === 0 ? '今天' : `${nc.inDays} 天后`} ${hm(nc.fromMin)}${nc.name ? ` ${nc.name}` : ''}${nc.room ? ` @${nc.room}` : ''}${nc.week ? `（第 ${nc.week} 周）` : ''}` : '接下来 7 天没有课（或者都被勾掉了）'}` : '还没填（设置页「课表与考试」）'}`);
      console.log(`  作息表 ${opts.periods.trim() ? '自己填的' : '内置（8:00 起，45 分钟一节）'}；勾选 ${list.length ? `${list.filter((c) => courseEnabled(c, opts.off)).length}/${list.length} 节开着` : '—'}`);
    }
    {
      const ex = examsSource(cfg);
      const list = parseExams(ex.text, { tz, now });
      const T0 = cfg.content?.topics || {};
      const rvDays = Number(T0.examReviewDays ?? 7);
      const snMin = Number(T0.examSoonMin ?? 60);
      console.log(`  考试 ${list.length ? `${list.length} 场（${ex.from === 'config' ? '设置页' : ex.from}）` : '还没填（设置页「课表与考试」）'}`);
      if (list.length) {
        const first = list[0];
        const rv = reviewDue(list, now, tz, rvDays);
        const sn = soonDue(list, now, snMin);
        console.log(
          `  最近一场 ${first.date} ${first.hm} ${first.subject || ''}${first.room ? ` @${first.room}` : ''}；复习 ${rv ? `这一拍会提（提前 ${rvDays} 天）` : `不在提前 ${rvDays} 天窗口`}；快考了 ${sn ? '这一拍会提' : `不在提前 ${snMin} 分钟窗口`}`
        );
      }
    }
    const sleepC = ctx.fish.ok ? classifySleep(ctx.fish, cfg) : null;
    const bt = ctx.fish.ok ? bedTimeOf(ctx.fish) : { bedHm: null, bedFrom: null };
    if (ctx.fish.ok) {
      const stale = fishStale(ctx.fish, cfg, now);
      if (stale.stale) {
        console.log(
          `  鱼鱼数据 ${Math.round(stale.ageHours)} 小时没更新（超过 ${stale.limitHours} 小时）——睡眠/压力/步数/屏幕四类由头停用`,
        );
      }
      console.log(
        `  睡眠 ${ctx.fish.sleepMin ?? '?'} 分${ctx.fish.sleepFrom ? `（${ctx.fish.sleepFrom === 'night' ? '夜间睡眠' : '总睡眠'}）` : ''}  深睡 ${ctx.fish.deepMin ?? '?'}  浅睡 ${ctx.fish.lightMin ?? '?'}  REM ${ctx.fish.remMin ?? '?'}  屏幕 ${ctx.fish.screenMin ?? '?'}`
      );
      const sleepDayStart = Number(cfg.content?.topics?.sleepDayStartHour ?? 7);
      const todayDay = healthDay(now, tz, sleepDayStart);
      // 数据属于哪一天，按邮件自己的 Date 算；抓回来的时间不算数（2026-11-10 踩过）
      const fishDay = ctx.fish.dateTs ? healthDay(Number(ctx.fish.dateTs), tz, sleepDayStart) : null;
      const fishDayTxt = fishDay && fishDay !== todayDay ? `，数据是 ${fishDay} 那天的（不算今天）` : '';
      console.log(
        `  起床 ${ctx.fish.wakeHm || '未读到'}  入睡 ${bt.bedHm || '未读到'}${bt.bedFrom ? `（${bt.bedFrom === 'direct' ? '邮件自带' : '起床－睡眠反推'}）` : ''}  → ${
          sleepC ? `${sleepC.kind}（${sleepC.lateBed ? '熬夜' : sleepC.bedUnknown ? '没睡好·缺入睡时间' : '没睡好'}）` : '不构成由头'
        }  健康日 ${todayDay}（${sleepDayStart}:00 起算）${fishDayTxt}`
      );
      const T0 = cfg.content?.topics || {};
      const sDay = healthDay(now, tz, Number(T0.sleepDayStartHour ?? 7));
      const sSent = st?.content?.stressDay === sDay ? Number(st?.content?.stressCount) || 0 : 0;
      console.log(
        `  压力 ${ctx.fish.stress ?? '未读到'}（阈值 ${Number(T0.stressHighMin ?? 59)}，${
          T0.stress === false ? '这一类已关' : `今天已发 ${sSent}/${Number(T0.stressDailyMax ?? 1)}`
        }）`
      );
      console.log(
        `  步数 ${ctx.fish.steps ?? '未读到'}（${Number(T0.stepsFromHour ?? 18)} 点后看：<${Number(T0.stepsLowMax ?? 2000)} 算没怎么动，>${Number(T0.stepsHighMin ?? 8000)} 算活动量好；${
          T0.steps === false ? '这一类已关' : st?.content?.lastStepsFor === sDay ? '今天说过了' : '今天还没说'
        }）`
      );
    }
    console.log(`  我的记忆 ${ctx.self ? `有（${ctx.self.section} / ${ctx.self.at}）` : '没有'}`);
    // 电脑侧那三类（深夜/坐太久/刚回来）不靠手机，--why 也要能看见它们为什么没用上
    if (st?.pc) {
      const pc = st.pc;
      const sit = pc.activeSince ? `连续坐了 ${Math.round((now - pc.activeSince) / 60_000)} 分钟` : '现在不在这段连续时间里';
      const away = pc.awaySince ? `，已离开 ${Math.round((now - pc.awaySince) / 60_000)} 分钟` : '';
      const back = pc.lastReturnAt
        ? `；上次离开 ${Math.round((Number(pc.lastAwayMs) || 0) / 60_000)} 分钟，${hhmm(pc.lastReturnAt, tz)} 回来`
        : '；今天还没记到离开又回来';
      console.log(`  电脑 ${sit}${away}${back}（与手机无关：深夜/坐太久/刚回来三类只看它）`);
    } else {
      console.log('  电脑 还没有记录（探针没读到，或今天第一拍）');
    }
    if (ctx.signals) {
      const sg = ctx.signals;
      if (sg.reason === 'ANTICHEAT') {
        console.log(`  信号 反作弊保护：${sg.proc || 'WeGame/腾讯游戏'} 在跑，这一拍不读窗口/标签/屏幕`);
      } else {
        console.log(`  信号 ${sg.ok ? signalLine(sg) : `没读到（${sg.reason}）`}`);
      }
    }
    if (ctx.memory) console.log(`  记忆 ${memoryLine(ctx.memory)}`);
    console.log('=== 由头 ===');
    if (topic) {
      console.log(`  有：${topic.slot}（${topic.label}）—— ${topic.why}`);
      console.log(`  素材：${topic.brief}`);
      if (topic.slot === 'forward') {
        const it = topic.evidence?.item;
        const c = it ? readCache(it, { cfg, now }) : null;
        console.log(
          `  视频 ${it || '没有 itemId（旧记忆里没存，只能靠标题）'}｜` +
            (c?.ok
              ? `已看过（${c.source}）：${String(c.summary).slice(0, 120)}`
              : c
                ? `上次没看成：${c.reason}`
                : '还没看过（node src/run.js --video 现在看）'),
        );
      }
    } else {
      console.log('  没有。原因：');
      for (const r of explainNoTopic(ctx, cfg, now, st)) console.log(`   - ${r}`);
    }
    // —— 随口话这一拍会怎样：拿 state 的副本跑一遍 gate（只读，不写回）。
    //    这样「没开口是因为什么」不用真发一拍就能看见。
    if (cfg.rules?.chitchat?.enabled === true) {
      if (topic) {
        console.log('  随口话 让位（这一拍有由头，最低优先级不参与）');
      } else {
        try {
          const scratch = structuredClone(st);
          const rest = restFor({ cfg, now, tz, st: scratch });
          const g = chitchatGate({ cfg, now, st: scratch, ctx, tz, rest });
          console.log(
            g.ok
              ? `  随口话 这一拍能说（今天第 ${chitchatToday(scratch, now, tz).count + 1} 条；睡着时段 ${clockOf(rest.startMin)}–${clockOf(rest.endMin)}）`
              : `  随口话 被拦 ${g.reason}（${g.why || ''}）`,
          );
        } catch (e) {
          console.log(`  随口话 没算成：${e?.message || e}`);
        }
      }
    }
    // 阶段 2：judge 是「软决策」，它上次怎么判的也属于「为什么」的一部分。
    {
      const j = st?.judge || null;
      if (cfg.rules?.judge?.enabled !== true) {
        console.log('  judge 关着（rules.judge.enabled=false）→ 上面就是这一拍的全部理由');
      } else if (!j) {
        console.log('  judge 开着，但这一拍还没判过（护栏放行之后才会问它）');
      } else if (j.fallback) {
        console.log(`  judge 上次判坏了（${j.reason || '原因未记'}）→ 退规则：${j.slot || '—'}`);
      } else if (j.say === false) {
        console.log(`  judge: 这一拍不说——${j.why || '没写理由'}`);
      } else {
        console.log(`  judge: 要说「${j.angle || '—'}」——${j.why || '没写理由'}`);
      }
    }
    // 阶段 4：judge 预演——被护栏拦下的拍子抽一部分问模型（只记不发）
    {
      const jd = cfg.rules?.judge || {};
      if (jd.shadow !== true) {
        console.log('  judge 预演关着（rules.judge.shadow=false）');
      } else {
        console.log(`  ${shadowLine(st, cfg)}｜采样 ${Math.round(shadowRate(cfg) * 100)}%`);
        const last = st?.judgeShadow?.last;
        if (last) {
          const when = `${Math.max(0, Math.round((now - (last.at || now)) / 60000))} 分钟前`;
          const what = last.fallback ? `判坏（${last.reason || '原因未记'}）` : last.say === true ? `会说「${last.angle || '—'}」` : '会说不出';
          console.log(`   上一次：${when}被「${last.blockedBy || '—'}」拦下，预演${what}`);
        }
      }
    }
    // 阶段 3：自然触发拍——关着时只说一句，开着时把记过的事件摊出来。
    {
      const nt = cfg.rules?.naturalTriggers || {};
      const tr = st?.triggers || null;
      if (nt.enabled !== true) {
        console.log('  自然触发关着（rules.naturalTriggers.enabled=false）→ 只看时钟');
      } else {
        const bits = [];
        if (tr?.lastKind) bits.push(`上次 L2 归类「${tr.lastKind}」`);
        if (tr?.courseDone?.keys?.length) {
          const segs = tr.courseDone.keys
            .map((k) => (k === 'am' ? '上午' : k === 'pm' ? '下午夜间' : ''))
            .filter(Boolean);
          if (segs.length) bits.push(`今天已算过的下课段：${segs.join('、')}`);
        }
        if (tr?.selfMtime) bits.push(`self.md 上次写入 ${Math.max(0, Math.round(agoSec(now, tr.selfMtime) / 60))} 分钟前`);
        console.log(
          `  自然触发开着：${nt.takeGap === true ? `事件可越过间隔，但要隔够 ${nt.floorMin ?? 20} 分钟` : '事件只把开口提前到那一秒，间隔照旧'}｜下课窗口 ${nt.courseWindowMin ?? 20} 分钟；分界 ${minToHm(nt.courseSplitMin ?? 720)}（之前的课算上午）`,
        );
        console.log(`   已记事件：${bits.length ? bits.join('｜') : '还没有'}`);
      }
    }
    // 阶段 1：间隔分档 + 「人不在」降级
    {
      const gt = cfg.rules?.gapByTier || {};
      const bucket = (cfg.dryRun !== false ? st?.sim : st?.real) || {};
      const lastByTier = bucket.lastSendByTier || {};
      if (gt.enabled !== true) {
        console.log(`  间隔分档关着（rules.gapByTier.enabled=false）→ 全用 ${cfg.rules.minGapMin} 分钟一刀切`);
      } else {
        const tier = topic ? tierOfSlot(topic.slot) : null;
        const mins = (t) => Math.round(tierGapMs(cfg, t) / 60000);
        const since = (t) => (Number(lastByTier[t]) ? `${Math.max(0, Math.round((now - Number(lastByTier[t])) / 60000))} 分钟前` : '还没发过');
        console.log(`  间隔分档开着：回复 ${mins('reply')} 分｜事件 ${mins('event')} 分｜闲聊 ${mins('chat')} 分（跨档至少隔 ${mins('reply')} 分）`);
        console.log(`   距上次同档：回复 ${since('reply')}｜事件 ${since('event')}｜闲聊 ${since('chat')}`);
        if (topic) {
          const g = checkTierGap({ cfg, now, tier: tierOfSlot(topic.slot), lastByTier, lastSendTs: bucket.lastSendAt, extraMin: adaptiveExtraMin(st, cfg) });
          console.log(`   这一拍由头「${topic.slot}」属 ${tierOfSlot(topic.slot)} 档：需 ${g.needMin} 分，距上次 ${g.sinceMin == null ? '还没发过' : `${g.sinceMin} 分`} → ${g.ok ? '够' : '不够'}`);
        }
      }
      const ps = cfg.rules?.presenceSignal || {};
      if (ps.enabled !== true) {
        console.log(`  人不在：硬拦（rules.presenceSignal.enabled=false）`);
      } else if (cfg.rules?.judge?.enabled !== true) {
        console.log(`  人不在：仍是硬拦——presenceSignal 开着，但 judge 关着（没有软决策层就不放开硬闸）`);
      } else {
        console.log(`  人不在 → 降级为信号（judge 可见），不再拦截主动由头｜静默/忙碌/每日上限照旧`);
      }
    }
    return;
  }

  if (has('--snapshot')) {
    const cfg = loadConfig();
    const now = Date.now();
    const tz = cfg.timezone;
    const st = loadState();
    const quiet = inQuiet(now, cfg.quietHours, tz);
    const ch = readChannels(cfg, now, { quiet });
    const sys = await probe();
    const ctx = buildContext({ cfg, now, st, ch, sys, tz });
    ctx.clock = hhmm(now, tz);
    if (cfg.perception?.signals?.enabled !== false) ctx.signals = await readSignals({ cfg, sys, now });
    ctx.memory = readMemory({ cfg, now });
    ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
    // 阶段 3：--snapshot 里也标出「这一拍是被哪种事件挑起的」（只在这里看，不落盘）
    try {
      const trig = detectTriggers({
        cfg,
        now,
        tz,
        st: { ...st },
        activity: cfg.perception?.l2?.enabled !== false ? classifyActivity(sys, cfg.perception?.l2 || {}) : null,
        selfMtimeMs: selfMtime(),
      });
      ctx.trigger = trig.fired[0] || null;
    } catch {
      ctx.trigger = null;
    }
    const topic = pickTopic(ctx, cfg, now, st);
    console.log('=== 模型会看到的处境（judge 开启时）===');
    console.log(buildSnapshot({ ctx, topic, cfg, st, now, tz }));
    console.log('\n（只读，没有叫模型、没有写 state）');
    return;
  }

  if (has('--judge')) {
    const cfg = loadConfig();
    const now = Date.now();
    const tz = cfg.timezone;
    const st = loadState();
    const quiet = inQuiet(now, cfg.quietHours, tz);
    const ch = readChannels(cfg, now, { quiet });
    const sys = await probe();
    const ctx = buildContext({ cfg, now, st, ch, sys, tz });
    ctx.clock = hhmm(now, tz);
    if (cfg.perception?.signals?.enabled !== false) ctx.signals = await readSignals({ cfg, sys, now });
    ctx.memory = readMemory({ cfg, now });
    ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
    const persona = loadPersona({ cfg });
    const topic = pickTopic(ctx, cfg, now, st);
    console.log(`judge ${cfg.rules?.judge?.enabled === true ? '开着' : '关着（--judge 只是手动试一次）'}  人格 ${persona.kind}`);
    console.log(`规则建议：${topic ? `${topic.slot}（${topic.label}）——${topic.brief}` : '这一拍规则没挑出由头（模型仍可以自己说）'}`);
    const t0 = Date.now();
    const v = await judgeDecision({
      snapshot: buildSnapshot({ ctx, topic, cfg, st, now, tz }),
      persona,
      cfg,
      generate,
      llmReady: true,
    });
    console.log(`判断 ${v.ok ? '成功' : '失败（engine 里会退回规则链）'}  ${Date.now() - t0}ms  第 ${v.attempts || 1} 次${v.reason ? '  reason=' + v.reason : ''}`);
    if (!v.ok) {
      if (v.raw) console.log(`模型原文：
${v.raw}`);
      console.log('（只演练：没有发送、没有写 state）');
      return;
    }
    console.log(`say=${v.say}  角度「${v.angle || '-'}」`);
    console.log(`why：${v.why || '-'}`);
    if (v.say !== true) {
      console.log('（模型说这一拍不说；只演练，没有发送、没有写 state）');
      return;
    }
    const c = composeDraft({ ctx, draft: v.draft, cfg, topic });
    console.log(`草稿「${v.draft || '-'}」`);
    if (c.ok) console.log(`护栏：过（可发，${c.text.length} 字）`);
    else console.log(`护栏：拦下 ${c.reason}${c.violations?.length ? '  ' + c.violations.map((x) => x.code).join('、') : ''}`);
    console.log('（只演练：没有发送、没有写 state）');
    return;
  }

  if (has('--compose')) {
    const cfg = loadConfig();
    if (has('--llm')) cfg.content.mode = 'llm';
    const now = Date.now();
    const tz = cfg.timezone;
    const st = loadState();
    const quiet = inQuiet(now, cfg.quietHours, tz);
    const ch = readChannels(cfg, now, { quiet });
    const sys = await probe();
    const ctx = buildContext({ cfg, now, st, ch, sys, tz });
    ctx.clock = hhmm(now, tz);
    // 结构化信号（窗口标题/标签页/文件）：几毫秒，顺手读一次，好让人看见模型到底拿到了什么。
    if (cfg.perception?.signals?.enabled !== false) {
      ctx.signals = await readSignals({ cfg, sys, now });
    }
    // 记忆插件里的长期记忆（只读；读不到就照常写，不挡这一拍）。
    ctx.memory = readMemory({ cfg, now });
    ctx.recentOutbound = recentOutbound({ limit: 5, cfg });
    const persona = loadPersona({ cfg });
    const topic = pickTopic(ctx, cfg, now, st);
    console.log(`模式 ${cfg.content.mode}  人格 ${persona.kind}（${persona.chars} 字）`);
    if (!topic) {
      console.log('这次没有由头，不会生成。用 --why 看具体卡在哪一条：');
      for (const r of explainNoTopic(ctx, cfg, now, st)) console.log(`  - ${r}`);
      return;
    }
    console.log(`由头 ${topic.slot}（${topic.label}）：${topic.brief}`);
    const r = await compose({ ctx, topic, persona, cfg, now, st });
    console.log(`结果 ${r.ok ? '可发' : '不可发'}  source=${r.source || '-'}${r.reason ? '  reason=' + r.reason : ''}`);
    if (r.text) console.log(`「${r.text}」（${r.text.length} 字）`);
    if (r.violations?.length) console.log(`违规：${r.violations.map((v) => `${v.code}(${v.why})`).join('、')}`);
    if (r.note) console.log(`说明：${r.note}`);
    console.log('（只演练，没有发送、没有写计数）');
    return;
  }

  if (has('--perception') || has('--l123')) {
    const cfg = loadConfig();
    const now = Date.now();
    const tz = cfg.timezone;
    const wantL3 = !has('--no-l3');
    console.log(`=== 感知（${hhmm(now, tz)}）===`);
    const p = await perceive(cfg, { l3: wantL3, force: true });

    const l1 = p.l1;
    if (l1.ok) {
      console.log(
        `  L1  空闲 ${(l1.idle_ms / 1000).toFixed(1)}s · 前台「${l1.fg_title || '-'}」(${l1.fg_name || '?'}:${l1.fg_pid})` +
          ` · 音频 ${l1.audio_peak < 0 ? 'n/a' : l1.audio_peak.toFixed(4)} · ${l1.procs} 进程`
      );
    } else {
      console.log(`  L1  失败 ${l1.reason}`);
    }

    const l2 = p.l2;
    if (l2.ok) {
      console.log(
        `  L2  ${l2.kind} · ${l2.speaking ? '有声音' : '没在放声音'} · ` +
          `IDE ${l2.opened.ide ? '开' : '关'} / 游戏 ${l2.opened.game ? '开' : '关'} / 影音 ${l2.opened.media ? '开' : '关'}`
      );
    } else {
      console.log(`  L2  跳过 ${l2.reason}`);
    }

    const l3 = p.l3;
    if (l3.ok) {
      console.log(`  L3  ok ${l3.chars} 字 / ${l3.ms}ms（截图 ${l3.shot_ms}ms，${l3.w}x${l3.h}）`);
      for (const h of (l3.hints || []).slice(0, 8)) console.log(`       ${h.slice(0, 90)}`);
    } else {
      console.log(`  L3  没读到 ${l3.reason}${l3.note ? '（' + l3.note + '）' : ''}`);
    }

    // 结构化信号（不截屏那一路）：窗口标题 + 浏览器当前标签页 + 编辑器里的文件
    const sig = await readSignals({
      cfg,
      sys: { ok: l1.ok, fg_name: l1.fg_name, fg_title: l1.fg_title },
      now,
    });
    if (sig.ok) {
      console.log(`  信号 ${signalLine(sig)}`);
      if (sig.tab?.url) console.log(`       页面 ${sig.tab.url.slice(0, 120)}`);
    } else {
      console.log(`  信号 没读到 ${sig.reason}`);
    }

    const file = path.join(LOG_DIR, `perception-${recordDay(now, tz, cfg)}.jsonl`);
    const wrote = appendPerception({ ts: now, tsLocal: hhmm(now, tz), ...p }, file);
    console.log(`\n  已记录 ${wrote ? file : '（写失败）'}`);
    // 手动跑也顺手清一次，免得只跑 --l123 的人永远等不到清理
    const pr = pruneOldRecords(cfg, now);
    if (pr.removed.length) console.log(`  顺手清掉 ${pr.removed.length} 个过期记录（只留 ${pr.keepDays} 天）`);
    return;
  }

  // 阶段 5.1：一屏红绿。有红项退出码非 0，外部可以直接盯这个数。
  if (has('--health')) {
    const cfg = loadConfig();
    const res = await checkHealth({ cfg });
    for (const line of healthLines(res)) console.log(line);
    {
      // 睡着时段是推出来的，不是设的——体检里露一眼，免得改作息后没人知道它跟着变。
      const rest = restFor({ cfg, now: Date.now(), tz: cfg.timezone });
      console.log(`  ${restLine(rest)}`);
    }
    if (res.bad) process.exitCode = 1;
    return;
  }

  // 阶段 5.2：日报。默认今天（已经去重过就不重写），--force 重算。
  if (has('--report')) {
    const cfg = loadConfig();
    const now = Date.now();
    const raw = String(valOf('--report') || '').trim();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : recordDay(now, cfg.timezone, cfg);
    const st = loadState();
    const r = writeDailyReport({ cfg, now, tz: cfg.timezone, day, st, force: has('--force') });
    console.log(r.written ? `已写 ${r.file}` : `已存在，没重写：${r.file}（加 --force 重算）`);
    console.log('');
    console.log(fs.readFileSync(r.file, 'utf8').trimEnd());
    return;
  }

  if (has('--status')) {
    const cfg = loadConfig();
    const now = Date.now();
    console.log('=== 开关 ===');
    console.log(`  总开关 ${cfg.enabled}  dryRun ${cfg.dryRun}  每 ${cfg.tickMinutes} 分钟`);
    console.log(`  QQ ${cfg.channels.qq.enabled ? '开' : '关'}（读 ${cfg.channels.qq.read} / 发 ${cfg.channels.qq.send}）`);
    console.log(`  主会话 ${cfg.channels.main.enabled ? '开' : '关'}  抖音 ${cfg.channels.douyin.enabled ? '开' : '关'}`);
    console.log(
      `  邮箱 ${cfg.mail?.enabled ? `开（每 ${cfg.mail.intervalMinutes ?? 30} 分钟，${maskUser(cfg.mail.user || loadSecrets().user) || '未填账号'}）` : '关'}`
    );
    console.log(`  L2 ${cfg.perception.l2.enabled ? '开' : '关'}  L3 ${cfg.perception.l3.enabled ? '开' : '关'}  真实发送 ${cfg.send.enabled ? '开' : '关'}`);
    {
      // 三条链路：总闸 + 实测。看这一行就知道「是关了」还是「装了但没通」。
      const ds = detectSources(cfg);
      const one = (k, label) => `${label} ${cfg.sources?.[k]?.enabled !== false ? '开' : '关'}(${ds[k].ready ? '通' : '不通'})`;
      console.log(`  接入 ${one('phone', '手机')} / ${one('qq', 'QQ')} / ${one('douyin', '抖音')}`);
    }
    console.log('=== 阈值 ===');
    console.log(`  在线 ≤ ${cfg.idle.onlineSec}s  离开 > ${cfg.idle.awaySec}s  回复等待 ${cfg.rules.replyCooldownMin} 分  间隔 ${cfg.rules.minGapMin} 分  每日 ${cfg.rules.dailyCap} 条`);
    printSchedule(cfg, now);
    const findings = checkSchedule(cfg);
    if (findings.some((f) => f.level !== 'info')) printFindings(findings, { onlyProblems: true });
    console.log('=== 桥 ===');
    const bi = bridgeInfo();
    console.log(`  qq-bridge ${bi.ok ? '可连' : '缺配置'}  api=${bi.api || '-'}  self=${bi.selfId || '-'}`);
    console.log('=== 最近判定 ===');
    const rows = tail(5, now, cfg.timezone, cfg);
    if (!rows.length) console.log('  （今天还没有日志）');
    for (const r of rows) console.log(`  ${r.tsLocal} ${r.decision} ${r.track || '-'} ${r.reason}`);
    return;
  }

  if (has('--live')) {
    const v = String(valOf('--live') || '').trim().toLowerCase();
    const cfg = loadConfig();
    if (v === 'on' || v === '1' || v === 'true') {
      cfg.send.enabled = true;
      cfg.dryRun = false;
      saveConfig(cfg);
      console.log('已切到真发：send.enabled=true  dryRun=false');
      console.log('之后 --loop 判到 send 就会真的发出去。随时用 --live off 收回。');
    } else if (v === 'off' || v === '0' || v === 'false') {
      cfg.dryRun = true;
      saveConfig(cfg);
      console.log('已回到演练：dryRun=true（send.enabled 保留原值，只关总闸的一半）');
    } else {
      console.log(`现在 send.enabled=${cfg.send.enabled}  dryRun=${cfg.dryRun}`);
      console.log('用法：node src/run.js --live on|off');
    }
    return;
  }

  if (has('--fire')) {
    const cfg = loadConfig();
    const to = Number(cfg.channels.qq.peerId) || 0;
    const arg = valOf('--fire');
    const text = arg && !String(arg).startsWith('--') ? String(arg) : String(cfg.content?.fixedText ?? '1');
    const live = cfg.send?.enabled === true && cfg.dryRun === false;
    console.log('=== 立刻发一条（不看判定、不看时段）===');
    console.log(`  收件人 ${to || '(没配 channels.qq.peerId)'}`);
    console.log(`  文本   「${text}」`);
    console.log(`  模式   ${live ? '真发' : '演练（send.enabled 或 dryRun 没开）'}`);
    const r = await sendQQPrivate({ to, text, dryRun: !live });
    console.log(JSON.stringify(r, null, 2));
    if (!live) console.log('\n要真发：node src/run.js --live on');
    return;
  }

  if (has('--test-send')) {
    const text = valOf('--test-send') || 'presence-gate 通道测试';
    const cfg = loadConfig();
    const to = cfg.channels.qq.peerId;
    const yes = has('--yes');
    const dryRun = !(yes && cfg.send.enabled && cfg.dryRun === false);
    console.log(`收件人 ${to}  文本「${text}」  ${dryRun ? '（演练，不会真发）' : '（会真发）'}`);
    const r = await sendQQPrivate({ to, text, dryRun });
    console.log(JSON.stringify(r, null, 2));
    if (dryRun) {
      console.log('提示：要真发需要同时满足 send.enabled=true、dryRun=false，并加 --yes');
    }
    return;
  }

  if (has('--loop')) {
    const cfg0 = loadConfig();
    const ms = Math.max(1, Number(cfg0.tickMinutes) || 10) * 60_000;
    console.log(`presence-gate 启动，每 ${ms / 60000} 分钟一拍，dryRun=${cfg0.dryRun}`);
    printSchedule(cfg0, Date.now());
    {
      const problems = checkSchedule(cfg0).filter((f) => f.level !== 'info');
      if (problems.length) {
        console.log('=== 时段冲突（先去 --windows 看看）===');
        printFindings(problems);
      }
    }
    const runOnce = async () => {
      try {
        const r = await tick();
        printSummary(r);
        pruneOldRecords(loadConfig(), Date.now());
      } catch (e) {
        console.error(`[${new Date().toISOString()}] 这一拍出错（已兜住）：${e?.message || e}`);
      }
    };
    await runOnce();
    setInterval(runOnce, ms);
    return;
  }

  // 默认 --once
  const r = await tick();
  printSummary(r);
}

main().catch((e) => {
  console.error('致命错误：', e);
  process.exit(1);
});
