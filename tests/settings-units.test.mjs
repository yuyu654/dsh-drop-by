// settings-units.test.mjs —— 设置页里的默认值要带单位。
//
// 真奈 2026-11-07：注释里「默认 30」看不出是 30 分钟还是 30 天；
// 凡是带 unit 的项，hint 里提到「默认 N」时就得把单位写在旁边。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA, courseItems, coerce, listForUi } from '../src/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('带单位的项，默认值旁边写着单位', () => {
  const bad = [];
  for (const s of SCHEMA) {
    const hint = String(s.hint || '');
    const m = /默认\s*(\d+(?:\.\d+)?)/.exec(hint);
    if (!m || !s.unit) continue;
    const unit = String(s.unit).split('（')[0];
    if (!hint.includes(unit)) bad.push(`${s.path}（${m[0]}，单位 ${s.unit}）`);
  }
  assert.deepEqual(bad, [], `这些项的 hint 没写单位：${bad.join('、')}`);
});

test('随口话找话头的天数、下课窗口的分钟数都写清楚了', () => {
  const byPath = new Map(SCHEMA.map((s) => [s.path, s]));
  assert.match(byPath.get('rules.chitchat.seedDays').hint, /默认 30 天/);
  const cw = byPath.get('rules.naturalTriggers.courseWindowMin');
  assert.equal(cw.unit, '分钟');
  assert.match(cw.hint, /默认 20 分钟/);
  assert.match(cw.hint, /课上完了/);
  assert.match(cw.hint, /一天只算一次/);
  const split = byPath.get('rules.naturalTriggers.courseSplitMin');
  assert.equal(split.unit, '分钟（从 0 点算）');
  assert.match(split.hint, /默认 720 分钟/);
  assert.match(split.hint, /12:00/);
});

test('课程勾选列表有「全不选」，勾上就是整份 off', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/client.js'), 'utf8');
  assert.match(src, /全不选：一节都不提醒/);
  assert.match(src, /pg-course-all/);
  // 勾上 = 把每一节的 key 都写进 off
  assert.match(src, /list\.map\(function \(i\) \{\s*return i\.key;/);
  // 取消勾选 = 清空 off（全勾回来）
  assert.match(src, /: \[\]\s*\);\s*\},/);
  const hint = SCHEMA.find((s) => s.path === 'content.agenda.off').hint;
  assert.match(hint, /全不选/);
});

test('courseItems 的 checked 语义没变（off 里没有的才勾上）', () => {
  const cfg = {
    content: {
      agenda: {
        text: ['周一 08:00-09:40 电机学', '周二 10:00-11:40 电路'].join('\n'),
        off: [],
      },
    },
  };
  const list = courseItems(cfg);
  assert.equal(list.length, 2);
  assert.ok(list.every((i) => i.checked));
  cfg.content.agenda.off = list.map((i) => i.key);
  assert.ok(courseItems(cfg).every((i) => !i.checked));
});
test('分段发送的间隔在设置页按秒填，存回去还是毫秒', () => {
  const cfg = { send: { split: { enabled: true, minFirstMs: 6000, minGapMs: 1200, maxRoundMs: 90000 } } };
  const items = new Map(listForUi(cfg).flatMap((g) => g.items).map((i) => [i.path, i]));
  assert.equal(items.get('send.split.minFirstMs').value, 6);
  assert.equal(items.get('send.split.minGapMs').value, 1);
  assert.equal(items.get('send.split.maxRoundMs').value, 90);
  assert.equal(items.get('send.split.minFirstMs').unit, '秒');
  assert.equal(coerce('send.split.minFirstMs', 6).value, 6000);
  assert.equal(coerce('send.split.minGapMs', 1).value, 1000);
  assert.equal(coerce('send.split.minGapMs', 9).ok, false);
  assert.equal(coerce('send.split.maxParts', 5).ok, false);
});
