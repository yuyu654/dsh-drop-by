// fishmail.js —— 通过 IMAP 读「鱼鱼状态」发过来的邮件。
//
// ⚠ 前提：这个功能**依赖手机上的「鱼鱼状态」App**。App 每次采集完会用 SMTP 发一封
//   主题 `FISH MM-dd HH:mm` 的邮件到你自己填的邮箱，这里才有东西可读。
//   手机没装/没配邮箱、或者 App 没在跑，邮箱里就不会有新邮件 —— 这不是本插件的问题。
//   反过来，本插件只读不发，不会替 App 发信，也不会动你的邮箱（不改已读、不删邮件）。
//
// 这是一个**独立开关**的功能，不参与「要不要主动找她」的判定：
// 它只是把邮箱里最新的 FISH 邮件取回来、剥掉排查用的原文段落、
// 落到 data/fish-latest.json，供后续（内容生成/复盘）直接读。
//
// 五道自己的闸：
//   1) mail.enabled          总开关，false = 连配置都不读、绝不联网
//   2) 全局静默 quietHours    静默里一律不连，--mail-now 才会硬闯
//   3) mail.activeHours      只在设定时段里读（空数组=全天，多段、可跨零点）
//   4) mail.intervalMinutes  到点才连服务器（状态记在 state.json，重启不清零）
//   5) 邮箱口令不从 config.json 走，单独存 credentials.json（建议 600 权限、别提交）
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, LOG_DIR } from './config.js';
import { ImapClient } from './imap.js';
import { parseMessage } from './mime.js';
import { parseFishSummary } from './fishparse.js';
import { archiveFishMail, mailUpdateMode, recordDay } from './retention.js';
import { inQuiet, inWindows, normalizeWindows, nextOpenIn } from './schedule.js';

export const DATA_DIR = path.join(ROOT, 'data');
// 测试可以顶掉（PG_SECRETS_PATH），否则就是插件目录下的 credentials.json
export const SECRETS_PATH = process.env.PG_SECRETS_PATH || path.join(ROOT, 'credentials.json');
export const LATEST_PATH = process.env.PG_FISH_LATEST_PATH || path.join(DATA_DIR, 'fish-latest.json');

/** 常见邮箱的 IMAP 地址；不在表里就按域名猜 imap.<domain>。 */
const HOSTS = {
  'qq.com': 'imap.qq.com',
  'foxmail.com': 'imap.qq.com',
  'vip.qq.com': 'imap.qq.com',
  '163.com': 'imap.163.com',
  '126.com': 'imap.126.com',
  'yeah.net': 'imap.yeah.net',
  'sina.com': 'imap.sina.com',
  'sohu.com': 'imap.sohu.com',
  'aliyun.com': 'imap.aliyun.com',
  'gmail.com': 'imap.gmail.com',
  'outlook.com': 'outlook.office365.com',
  'hotmail.com': 'outlook.office365.com',
};

export function hostFor(user, override) {
  const o = String(override || '').trim();
  if (o) return o;
  const at = String(user || '').indexOf('@');
  const domain = at >= 0 ? String(user).slice(at + 1).toLowerCase() : '';
  if (!domain) return '';
  return HOSTS[domain] || `imap.${domain}`;
}

// ---------------------------------------------------------------- 凭据

/** 只存邮箱和授权码，别的一概不落这里。 */
export function loadSecrets() {
  try {
    const j = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    return {
      user: String(j.user || j.mail?.user || ''),
      authCode: String(j.authCode || j.mail?.authCode || ''),
    };
  } catch {
    return { user: '', authCode: '' };
  }
}

export function saveSecrets({ user, authCode }) {
  const prev = loadSecrets();
  const next = {
    ...prev,
    ...(user !== undefined ? { user: String(user).trim() } : {}),
    ...(authCode !== undefined ? { authCode: String(authCode).trim() } : {}),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(SECRETS_PATH, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(SECRETS_PATH, 0o600); // Windows 上无效，忽略即可
  } catch {
    /* ignore */
  }
  return next;
}

export function maskUser(user) {
  const s = String(user || '');
  const at = s.indexOf('@');
  if (at <= 0) return s ? '***' : '';
  const name = s.slice(0, at);
  const shown = name.length <= 3 ? name[0] + '**' : name.slice(0, 2) + '***' + name.slice(-1);
  return `${shown}${s.slice(at)}`;
}

export function maskAuth(code) {
  const s = String(code || '');
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`;
}

// ---------------------------------------------------------------- 正文

const DIAG_MARKERS = [
  // 老版本 App 会在正文末尾附上这两段原始页面文字；新版本（0.1.1 构建号 7 起）不再发，
  // 但邮箱里已有的旧邮件还在，所以这里继续裁掉。
  /^-{2,}\s*本次的原始页面文字/m,
  /^-{2,}\s*睡眠详情页原始文字/m,
];

/** 剥掉「原文诊断」段落，只留人读的摘要。 */
export function summaryOf(text) {
  let s = String(text || '');
  for (const re of DIAG_MARKERS) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// 日志按「健康日」切（07:00 起算），跟 data/fish 归档用同一个日期，
// 这样清理时一次就能对齐两处，不会出现「日志算今天、档案算昨天」的错位。
function appendMailLog(record, now, timezone, cfg) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const file = path.join(LOG_DIR, `mail-${recordDay(now, timezone, cfg)}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(record) + '\n', 'utf8');
}

export function readLatest() {
  try {
    return JSON.parse(fs.readFileSync(LATEST_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/** 配置 + 凭据合起来看「能不能读」。给 --status / --mail-status 用。 */
export function mailReady(cfg) {
  const m = cfg?.mail || {};
  const sec = loadSecrets();
  const user = String(m.user || sec.user || '').trim();
  const auth = String(sec.authCode || m.authCode || process.env.PRESENCE_MAIL_AUTH || '').trim();
  if (m.enabled !== true) return { ok: false, reason: 'MAIL_DISABLED', user, auth };
  if (!user.includes('@')) return { ok: false, reason: 'MAIL_NO_USER', user, auth };
  if (!auth) return { ok: false, reason: 'MAIL_NO_AUTH', user, auth };
  return { ok: true, reason: null, user, auth };
}

/**
 * 一轮拉取。
 *   cfg/state  正常传即可
 *   force      true = 忽略开关和间隔，立刻连一次（--mail-now 用）
 *   clientFactory  测试注入用，默认 ImapClient.connect
 * 返回一个可以直接塞进日志的紧凑对象，绝不含授权码。
 */
export async function pollFishMail({
  cfg,
  state = {},
  now = Date.now(),
  force = false,
  clientFactory,
  secrets = null,
  writeLatest = true,
  archive = true,
  archiveDir = null,
  latestPath = LATEST_PATH,
  log = true,
} = {}) {
  const m = cfg?.mail || {};
  const tz = cfg?.timezone || 'Asia/Shanghai';

  if (m.enabled !== true && !force) return { state: 'off', reason: 'MAIL_DISABLED' };

  // 静默优先，且要在联网之前判：静默里不该有任何出站流量
  if (!force && inQuiet(now, cfg?.quietHours, tz)) {
    return { state: 'quiet', reason: 'GLOBAL_QUIET' };
  }

  const winWins = normalizeWindows(m.activeHours).windows;
  if (!force && !inWindows(now, winWins, tz)) {
    return {
      state: 'window',
      reason: 'MAIL_OUTSIDE_WINDOW',
      note: `执行时段 ${winWins.map((w) => w.join('-')).join('、')}`,
      openInMin: nextOpenIn(now, winWins, tz),
    };
  }

  const sec = secrets || loadSecrets();
  const user = String(m.user || sec.user || '').trim();
  const auth = String(sec.authCode || m.authCode || process.env.PRESENCE_MAIL_AUTH || '').trim();

  if (!user.includes('@') || !auth) {
    return {
      state: 'unconfigured',
      reason: !user.includes('@') ? 'MAIL_NO_USER' : 'MAIL_NO_AUTH',
      note: `去 设置 → 陪伴 → 邮箱 填账号和授权码（或写 ${SECRETS_PATH} / 跑 node src/run.js --mail-set）`,
    };
  }

  const intervalMin = Math.max(1, Number(m.intervalMinutes) || 30);
  state.mail ||= {};
  const ms = state.mail;
  const lastPollAt = Number(ms.lastPollAt) || 0;

  if (!force && lastPollAt && now - lastPollAt < intervalMin * 60_000) {
    return {
      state: 'wait',
      reason: 'MAIL_INTERVAL',
      waitSec: Math.round((intervalMin * 60_000 - (now - lastPollAt)) / 1000),
      lastOkAt: ms.lastOkAt || null,
      lastUid: ms.lastUid ?? null,
    };
  }

  // 先记时间再连：失败也按间隔重试，避免每一拍都去敲服务器
  ms.lastPollAt = now;
  ms.polls = (Number(ms.polls) || 0) + 1;

  const host = hostFor(user, m.host);
  const port = Number(m.port) || 993;
  const secure = m.tls !== false;
  const timeoutMs = Math.max(3000, Number(m.timeoutMs) || 20000);
  const count = Math.min(20, Math.max(1, Number(m.fetchCount) || 5));
  const mailbox = String(m.mailbox || 'INBOX');
  const pattern = new RegExp(String(m.subjectPattern || '^\\s*FISH'), 'i');

  const factory = clientFactory || ((o) => ImapClient.connect(o));
  const base = { host, port, user: maskUser(user), forced: Boolean(force) && m.enabled !== true };

  let client = null;
  let fetched = [];
  try {
    client = await factory({ host, port, secure, timeoutMs });
    await client.login(user, auth);
    const { exists } = await client.select(mailbox);
    fetched = await client.fetchRecent(count, exists);
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 240);
    ms.lastError = msg;
    ms.failedAt = now;
    const out = {
      ...base,
      state: 'error',
      reason: e?.name === 'ImapError' ? 'MAIL_IMAP_ERROR' : 'MAIL_ERROR',
      note: msg,
      nextPollInSec: intervalMin * 60,
    };
    if (log) appendMailLog({ ts: now, tsLocal: new Date(now).toISOString(), ...out }, now, tz, cfg);
    return out;
  } finally {
    if (client) {
      try {
        await client.logout();
      } catch {
        try {
          client.destroy();
        } catch {
          /* ignore */
        }
      }
    }
  }

  // 只认主题像 FISH 的，按 uid 从旧到新
  const parsed = [];
  for (const item of fetched) {
    if (!item?.raw) continue;
    let mail;
    try {
      mail = parseMessage(item.raw);
    } catch {
      continue;
    }
    if (!pattern.test(mail.subject)) continue;
    parsed.push({ uid: Number(item.uid) || 0, mail });
  }
  parsed.sort((a, b) => a.uid - b.uid);

  const newest = parsed.length ? parsed[parsed.length - 1] : null;
  const lastUid = Number(ms.lastUid) || 0;
  const fresh = parsed.filter((p) => p.uid > lastUid);

  let latestOut = null;
  const archived = [];
  if (newest) {
    const summary = summaryOf(newest.mail.text);

    // 先归档（按 logging.mailUpdateMode 决定补充/替换/追加），再写 latest：
    // 合并模式下 latest 要反映「这一整天合起来的内容」，而不是只有最新那一封。
    let dayEntry = null;
    if (archive) {
      const targets = fresh.length ? fresh : [{ uid: newest.uid, mail: newest.mail }];
      for (const f of targets) {
        const sum = summaryOf(f.mail.text);
        try {
          const r = archiveFishMail(
            {
              uid: f.uid,
              subject: f.mail.subject,
              date: f.mail.date,
              dateTs: f.mail.dateTs,
              fetchedAt: now,
              summary: sum,
              text: f.mail.text,
              chars: sum.length,
            },
            { cfg, now, parsed: parseFishSummary(sum), ...(archiveDir ? { dir: archiveDir } : {}) }
          );
          dayEntry = { day: r.day, entry: r.entry };
          archived.push({ uid: r.uid, day: r.day, file: r.file, mode: r.mode, mails: r.mailsToday });
        } catch (e) {
          archived.push({ uid: f.uid, error: String(e?.message || e).slice(0, 120) });
        }
      }
    }

    const how = mailUpdateMode(cfg);
    const merged = how !== 'append' && dayEntry?.entry ? dayEntry.entry : null;
    const latestSummary = merged?.summary || summary;
    const payload = {
      fetchedAt: now,
      host,
      user: maskUser(user),
      mailbox,
      uid: merged?.uid ?? newest.uid,
      subject: merged?.subject || newest.mail.subject,
      from: newest.mail.from,
      date: merged?.date || newest.mail.date,
      dateTs: newest.mail.dateTs,
      summary: latestSummary,
      text: newest.mail.text.slice(0, 40_000),
      chars: latestSummary.length,
      parsed: merged?.parsed || parseFishSummary(summary),
      // 这一天合了几封（只读归档，不参与判定，纯粹让人知道数是怎么来的）
      day: dayEntry?.day || null,
      dayMails: merged ? merged.mailCount || 1 : 1,
    };
    if (writeLatest) writeAtomic(latestPath, JSON.stringify(payload, null, 2) + '\n');

    ms.lastUid = newest.uid;
    ms.lastSubject = newest.mail.subject;
    ms.lastOkAt = now;
    ms.lastError = null;
    latestOut = {
      uid: payload.uid,
      subject: payload.subject,
      date: payload.date,
      chars: payload.chars,
      mode: how,
      dayMails: payload.dayMails,
      preview: latestSummary.slice(0, 160).replace(/\n/g, ' / '),
      path: latestPath,
    };
    if (fresh.length && log) {
      for (const f of fresh) {
        appendMailLog(
          {
            ts: now,
            tsLocal: new Date(now).toISOString(),
            state: 'new',
            uid: f.uid,
            subject: f.mail.subject,
            date: f.mail.date,
            chars: summaryOf(f.mail.text).length,
            summary: summaryOf(f.mail.text).slice(0, 2000),
          },
          now,
          tz,
          cfg
        );
      }
    }
  }

  const out = {
    ...base,
    state: 'ok',
    reason: !parsed.length ? 'MAIL_NO_MATCH' : fresh.length ? 'MAIL_NEW' : 'MAIL_SAME',
    fetched: fetched.length,
    matched: parsed.length,
    newCount: fresh.length,
    latest: latestOut,
    archived,
    nextPollInSec: intervalMin * 60,
  };
  if (log) appendMailLog({ ts: now, tsLocal: new Date(now).toISOString(), ...out, latest: latestOut }, now, tz, cfg);
  return out;
}
