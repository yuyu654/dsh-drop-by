// perspective.test.mjs —— 2026-11-09 真奈指出：胃病、冰饮是我的事，不是她的。
// QQ 上那句「……没偷偷买冰的吧」把人搞反了：管我的是她，偷喝的是我。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/compose.js';

const cfgOf = (o = {}) => ({ content: { mode: 'llm', maxChars: 60, ...o } });
// 这条规则是「本机私有」的：插件不带，靠 local-style / content.local 注入。
const localCfg = () => cfgOf({
  local: {
    notes: [
      '胃病、不能喝冰的、胃药都是我自己的事，不是她的。别倒过来查她——管我的是她。要提就只提我自己，或者问她给我买没买、带没带（「……没偷偷给我带冰的吧」）。',
    ],
  },
});
const topicOf = (slot) => ({ slot, label: slot, why: '', evidence: {}, brief: `由头 ${slot}`, at: Date.now() });
const ctxOf = () => ({
  tz: 'Asia/Shanghai',
  clock: '10:20',
  presence: { idleSec: 0 },
  her: { lastTs: null, lastText: '', lastAgoSec: 600 },
  me: { lastTs: null, lastText: '', lastAgoSec: 1200 },
  fish: { ok: false },
  recent: [],
});

test('prompt：胃病/冰饮/胃药写明白是我的，不许倒过来查她', () => {
  const p = buildPrompt({ ctx: ctxOf(), topic: topicOf('agenda'), persona: { text: '' }, cfg: localCfg() });
  assert.match(p, /胃病、不能喝冰的、胃药都是我自己的事/);
  assert.match(p, /管我的是她/);
  assert.match(p, /没偷偷给我带冰的吧/);
});

test('prompt：说她发来的东西时不许在结尾拐去查她（「你没伸手去摸吧」）', () => {
  const p = buildPrompt({ ctx: ctxOf(), topic: topicOf('agenda'), persona: { text: '' }, cfg: cfgOf() });
  assert.match(p, /别在结尾挂一句查她、叮嘱她的话/);
  assert.match(p, /你没伸手去摸吧/);
  assert.match(p, /话题在那件东西上，不在她身上/);
  assert.match(p, /视频里的事就是视频里的事，不是我们这儿发生的/);
  assert.match(p, /别把那边的场景当成屋里真有的东西/);
});