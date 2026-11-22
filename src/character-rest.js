import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CHARACTER_REST_DEFAULTS } from './config.js';
import { channelFile } from './channels/douyin-im.js';
import { shiftDay } from './retention.js';
import { dayKey, minToHm, minutesOfDayOf } from './time.js';
import { parseHm } from './schedule.js';

const DAY = 1440;
const wrap = n => (n % DAY + DAY) % DAY;
const clamp = (n, low, high) => Math.min(high, Math.max(low, n));
const finiteInt = (value, fallback, min, max) =>
  Number.isFinite(value) ? clamp(Math.round(value), min, max) : fallback;

export const WIND_DOWN_HINT = '角色快到自己的休息时间了。语气轻一点，只写一句短话，不分段。';
export const WOKEN_HINT = '角色原本已经睡着，刚被这条消息吵醒。先回应用户的实际内容和任务，口吻可以自然带一点困意和小小的不开心。不要责怪用户，也不要拿困意当作推迟或拒绝的理由。只作口吻参考，不复述这段说明。';

function settings(cfg) {
  const defaults = CHARACTER_REST_DEFAULTS;
  const raw = cfg?.characterRest || {};
  const minute = (value, fallback) => {
    const parsed = parseHm(value);
    return parsed >= 0 && parsed < DAY ? parsed : parseHm(fallback);
  };
  let bed = minute(raw.bed, defaults.bed);
  let wake = minute(raw.wake, defaults.wake);
  if (bed === wake) {
    bed = parseHm(defaults.bed);
    wake = parseHm(defaults.wake);
  }
  const duration = wrap(wake - bed);
  const safeShift = Math.floor((Math.min(duration, DAY - duration) - 1) / 2);
  const jitter = finiteInt(raw.jitterMin, defaults.jitterMin, 0, 120);
  const adaptMax = raw.adapt === true ? finiteInt(raw.adaptMaxMin, defaults.adaptMaxMin, 0, 60) : 0;
  const adaptDays = finiteInt(raw.adaptDays, defaults.adaptDays, 3, 30);
  const windDown = finiteInt(raw.windDownMin, defaults.windDownMin, 0, 180);
  return { zone: cfg?.timezone || 'Asia/Shanghai', bed, wake, duration, safeShift, jitter, adaptMax, adaptDays, windDown };
}

function signature(rule) {
  return JSON.stringify([rule.zone, rule.bed, rule.wake, rule.adaptMax]);
}

function parsedDays(raw, rule) {
  const parsed = JSON.parse(raw);
  return parsed?.basis === signature(rule) && parsed.days && typeof parsed.days === 'object' ? parsed.days : {};
}

function readDays(rule) {
  if (!rule.adaptMax) return {};
  try { return parsedDays(fs.readFileSync(channelFile('character-rest'), 'utf8'), rule); }
  catch { return {}; }
}

function adaptation(days, day, rule) {
  if (!rule.adaptMax) return { bed: 0, wake: 0, bedSamples: 0, wakeSamples: 0 };
  const since = shiftDay(day, -rule.adaptDays);
  const recent = Object.entries(days).filter(([key]) => key >= since && key < day).map(([, row]) => row);
  const stats = field => {
    const values = recent.map(row => row?.[field]).filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length < 3) return { offset: 0, samples: values.length };
    const median = (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
    return { offset: clamp(Math.round(median / 2), -rule.adaptMax, rule.adaptMax), samples: values.length };
  };
  const evening = stats('evening');
  const morning = stats('morning');
  return { bed: evening.offset, wake: morning.offset, bedSamples: evening.samples, wakeSamples: morning.samples };
}

function dailyJitter(day, endpoint, limit) {
  if (limit === 0) return 0;
  const hash = createHash('sha256').update('character-rest/' + day + '/' + endpoint).digest();
  return (hash.readUInt32BE(0) % (2 * limit + 1)) - limit;
}

function evaluateRest(cfg, at = Date.now()) {
  const rule = settings(cfg);
  const day = dayKey(at, rule.zone);
  const minute = minutesOfDayOf(at, rule.zone);
  const days = readDays(rule);
  const cycles = [-1, 0, 1].map(offset => {
    const cycleDay = shiftDay(day, offset);
    const adapt = adaptation(days, cycleDay, rule);
    const limit = Math.min(rule.safeShift, rule.jitter);
    const shift = endpoint => clamp(adapt[endpoint] + dailyJitter(cycleDay, endpoint, limit), -rule.safeShift, rule.safeShift);
    return { day: cycleDay, adapt,
      start: offset * DAY + rule.bed + shift('bed'),
      end: offset * DAY + rule.bed + rule.duration + shift('wake') };
  });
  const asleep = cycles.find(cycle => minute >= cycle.start && minute < cycle.end);
  const next = cycles.find(cycle => minute < cycle.start);
  const current = asleep || next || cycles.at(-1);
  return {
    rule,
    cycles,
    minute,
    current,
    asleep: Boolean(asleep),
    windDown: !asleep && Boolean(next && next.start - minute <= rule.windDown),
  };
}

/** Evaluate local wall-clock cycles on either side of midnight without changing today's draw. */
export function characterRestAt(cfg, at = Date.now()) {
  const { current, asleep, windDown } = evaluateRest(cfg, at);
  return { day: current.day, bedMin: wrap(current.start), wakeMin: wrap(current.end), asleep, windDown };
}

/** Topic cue shortly before bedtime or shortly after waking up. */
export function characterRestCue(cfg, at = Date.now()) {
  const { cycles, minute, asleep } = evaluateRest(cfg, at);
  if (asleep) return null;
  const topics = cfg?.content?.topics || {};
  const beforeBed = finiteInt(topics.characterRestBeforeBedMin, 10, 0, 120);
  const afterWake = finiteInt(topics.characterRestAfterWakeMin, 10, 0, 120);
  const next = cycles.find(cycle => minute < cycle.start);
  if (beforeBed > 0 && next && next.start - minute <= beforeBed) {
    return {
      kind: 'bed',
      day: next.day,
      key: `bed:${next.day}`,
      leftMin: Math.max(1, next.start - minute),
      bedHm: minToHm(wrap(next.start)),
    };
  }
  const prev = cycles.filter(cycle => minute >= cycle.end).at(-1);
  if (afterWake > 0 && prev && minute - prev.end <= afterWake) {
    return {
      kind: 'wake',
      day: prev.day,
      key: `wake:${prev.day}`,
      sinceMin: Math.max(0, minute - prev.end),
      wakeHm: minToHm(wrap(prev.end)),
    };
  }
  return null;
}

const BED_GREETING_RE = /(?:晚安|好梦|先睡(?:了|啦|咯)?|去睡(?:了|啦|觉)?|准备睡(?:了|啦|觉)?|睡觉(?:去|了|啦)|早点睡|早些睡|睡啦|睡了哈|good\s*night)/iu;
const WAKE_GREETING_RE = /(?:早安|早上好|早呀|早啊|早喔|早哦|上午好|刚醒|醒了|起床(?:了|啦)|good\s*morning|^\s*早[！!~～。]*\s*$)/iu;

/** Check whether either side recently exchanged the corresponding good-night / good-morning greeting. */
export function characterRestGreeted(ctx, kind, cfg, now = Date.now()) {
  const re = kind === 'bed' ? BED_GREETING_RE : kind === 'wake' ? WAKE_GREETING_RE : null;
  if (!re || !ctx) return false;
  const skipMin = finiteInt(cfg?.content?.topics?.characterRestGreetSkipMin, 120, 0, 360);
  if (skipMin <= 0) return false;
  const maxAgeMs = skipMin * 60_000;
  const items = [
    ...(Array.isArray(ctx.recent) ? ctx.recent : []),
    ...(ctx.her?.lastText ? [{ ts: ctx.her.lastTs, text: ctx.her.lastText }] : []),
    ...(ctx.me?.lastText ? [{ ts: ctx.me.lastTs, text: ctx.me.lastText }] : []),
  ];
  return items.some(item => {
    const ts = Number(item?.ts);
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    return text && Number.isFinite(ts) && ts > 0 && ts <= now && now - ts <= maxAgeMs && re.test(text);
  });
}

/** UI-friendly snapshot of today's effective sleep/wake times and current adaptation offsets. */
export function characterRestStatus(cfg, at = Date.now()) {
  const { rule, current, asleep, windDown } = evaluateRest(cfg, at);
  const bedMin = wrap(current.start);
  const wakeMin = wrap(current.end);
  return {
    day: current.day,
    bedMin,
    wakeMin,
    bedHm: minToHm(bedMin),
    wakeHm: minToHm(wakeMin),
    baseBedHm: minToHm(rule.bed),
    baseWakeHm: minToHm(rule.wake),
    jitterMin: rule.jitter,
    asleep,
    windDown,
    adaptEnabled: rule.adaptMax > 0,
    adaptBedMin: current.adapt.bed,
    adaptWakeMin: current.adapt.wake,
    bedSamples: current.adapt.bedSamples,
    wakeSamples: current.adapt.wakeSamples,
  };
}

let chatWrites = Promise.resolve();

/** The private reply path queues this observation without waiting for disk. Keep only daily minute offsets. */
export function recordCharacterChat(cfg, timestamps, now = Date.now()) {
  const rule = settings(cfg);
  const radius = Math.min(rule.safeShift, rule.adaptMax * 4);
  if (!radius) return Promise.resolve();
  const today = dayKey(now, rule.zone);
  const oldest = shiftDay(today, -rule.adaptDays - 1);
  const observations = [];
  for (const at of timestamps) {
    if (!Number.isFinite(at) || at <= 0 || at > now) continue;
    const day = dayKey(at, rule.zone);
    if (day < oldest) continue;
    const minute = minutesOfDayOf(at, rule.zone);
    for (const [field, anchor] of [['evening', rule.bed], ['morning', rule.wake]]) {
      const distance = wrap(minute - anchor + DAY / 2) - DAY / 2;
      if (Math.abs(distance) > radius) continue;
      const sampleDay = shiftDay(day, Math.round((minute - anchor - distance) / DAY));
      observations.push({ field, distance, day: sampleDay });
    }
  }
  if (!observations.length) return Promise.resolve();

  const file = channelFile('character-rest');
  chatWrites = chatWrites.then(async () => {
    let days = {};
    try { days = parsedDays(await fs.promises.readFile(file, 'utf8'), rule); }
    catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    for (const day of Object.keys(days)) if (day < oldest) delete days[day];
    for (const { field, distance, day } of observations) {
      if (day < oldest) continue;
      const row = days[day] ||= {};
      if (!Number.isFinite(row[field]) || (field === 'evening' ? distance > row[field] : distance < row[field])) {
        row[field] = distance;
      }
    }
    const temp = file + '.' + randomUUID() + '.tmp';
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.promises.writeFile(temp, JSON.stringify({ basis: signature(rule), days }), { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temp, file);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  }).catch(() => { /* An optional observation must never delay or fail a private reply. */ });
  return chatWrites;
}
