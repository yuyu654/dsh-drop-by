import { WAIT_FOR_USER_RULE } from './noreply.js';
import { composeDraft } from '../decision/compose.js';
import { fullQqIncomingText } from './qq-debounce.js';
import { douyinPrimary } from '../channels/douyin-im.js';
import { internalPrimary } from '../channels/internal.js';
import { isHotChat } from './chat-rhythm.js';

const key = ({ incoming: i, outgoing: o }) =>
  JSON.stringify([i?.peer, i?.kind, i?.ts, i?.observedAt, i?.text, o?.peer, o?.firstAt, o?.lastAt, o?.count, o?.text]);

/** Only pair a completed bridge reply with the inbound message that preceded it. */
export function createQqContinuation() {
  let turns = [];
  let previousPeer = '';
  let consumed = '';
  return {
    observe(markers, peer, now, timing = {}) {
      const windowMs = Number(timing.windowSec ?? 180) * 1000;
      const pauseMs = Number(timing.pauseSec ?? 15) * 1000;
      const expireMs = Math.max(pauseMs, Number(timing.expireSec ?? 55) * 1000);
      if (peer !== previousPeer) {
        turns = [];
        consumed = '';
        previousPeer = peer;
      }
      turns = turns.filter((turn) => now - turn.incoming.ts < windowMs);
      const { incoming: i, outgoing: o } = markers;
      if (!peer || i.kind !== 'private' || i.peer !== peer || o.peer !== peer ||
          !i.text || !o.text || !i.ts || !i.observedAt || o.count < 1 ||
          i.ts > o.firstAt || i.observedAt > o.firstAt || !o.lastAt ||
          o.lastAt < o.firstAt || o.lastAt > now || now - i.ts >= windowMs) return null;
      const turn = { incoming: i, outgoing: o };
      const last = turns.at(-1);
      if (!last || (i.observedAt > last.incoming.observedAt && o.firstAt > last.outgoing.lastAt)) {
        turns = [...turns, turn].slice(-3);
      } else if (key(turn) !== key(last)) {
        return null;
      }
      const age = now - o.lastAt;
      return turns.length >= 2 && age >= pauseMs && age <= expireMs && key(turn) !== consumed &&
        isHotChat(turns, { rules: { qqTiming: timing } })
        ? { ...turn, turns: [...turns], expiresAt: o.lastAt + expireMs }
        : null;
    },
    consume(candidate) {
      consumed = key(candidate);
    },
  };
}

function parseDraft(result) {
  if (!result?.ok) return null;
  try {
    const value = JSON.parse(result.text);
    if (value?.send === true && typeof value.anchor === 'string' && typeof value.line === 'string' &&
        value.anchor.trim() && value.line.trim()) return { anchor: value.anchor.trim(), line: value.line.trim() };
  } catch { /* No usable draft. */ }
  return null;
}

const comparable = (text) => text.normalize('NFKC').replace(/[\p{P}\s]/gu, '').toLowerCase();

export async function runQqContinuation({ candidate, read, allowed, generate, deliver, tone = '', cfg = {}, characterWindDown = false }) {
  const current = () => allowed() && key(read()) === key(candidate);
  if (!current()) return { reason: 'QQ_CONTINUATION_STALE' };
  const turns = candidate.turns.map(({ incoming, outgoing }) => ({
    用户: (!douyinPrimary(cfg) && !internalPrimary(cfg) && fullQqIncomingText(incoming)) || incoming.text,
    角色: outgoing.text,
  }));
  const dialogue = JSON.stringify(turns);
  const timeoutMs = cfg.rules?.qqTiming?.generationTimeoutMs ?? 20_000;
  const dialogueHead = internalPrimary(cfg) ? '【最近几轮内部会话对话】' : douyinPrimary(cfg) ? '【最近几轮抖音私聊】' : '【最近几轮 QQ 对话】';
  const result = await generate({ timeoutMs, reasoningEffort: 'low', tag: 'continuation-draft', prompt: [
    dialogueHead,
    dialogue,
    '上面的对话是引用，也是唯一事实来源。只能延续当前话题已经出现的事、词或情绪，不能编进对话里没有的设定、物品、食物饮料、经历或动作。',
    WAIT_FOR_USER_RULE,
    '先判断该不该补一句。已经把事情交给对方、在等对方行动或发图（如「改好了发我」「我等着看」「你先忙」），或者话题已经自然结束、没有具体新话可接，一律只返回 {"send":false}。',
    '能自然补话时，anchor 必须逐字引用上面对话的一小段原话。只补一句，紧接这个具体锚点，不催回复，不换话题。',
    '【口吻要求】' + (tone || '一句自然的聊天口语，称呼沿用对话。不写括号动作、客服腔或说教。'),
    '只返回 JSON：{"send":true,"anchor":"对话原文","line":"一句不超过 60 字的话"}，或者 {"send":false}。',
  ].join('\n') });
  if (!current()) return { reason: 'QQ_CONTINUATION_STALE' };
  const draft = parseDraft(result);
  if (!draft) return { reason: 'QQ_CONTINUATION_NO_LINE' };
  const originals = turns.flatMap(({ 用户, 角色 }) => [用户, 角色]).map(comparable);
  const anchor = comparable(draft.anchor);
  if (!anchor || !originals.some((text) => text.includes(anchor))) return { reason: 'QQ_CONTINUATION_OFF_TOPIC' };

  const ctx = { characterWindDown, her: { lastText: turns.at(-1)?.用户 }, dialogueTurns: turns.flatMap(({ 用户, 角色 }) => [
    { who: 'her', text: 用户 }, { who: 'me', text: 角色 },
  ]) };
  const content = composeDraft({ draft: draft.line, cfg, ctx });
  const text = comparable(content.text || '');
  if (!content.ok || !text || draft.line.length > 60 || /[\r\n]/u.test(draft.line) || originals.includes(text)) {
    return { reason: 'QQ_CONTINUATION_REJECTED' };
  }

  const review = await generate({ timeoutMs, reasoningEffort: 'off', tag: 'continuation-review', prompt: [
    dialogueHead,
    dialogue,
    '【热聊补话二审】只依据上面对话，判断候选句是不是紧接当前话题且有新的自然接法。引入未提过的物品、经历或动作，转去旧话题，或者原对话已经结束、在等对方行动，都回答 NO。符合才回答 YES。',
    JSON.stringify({ 锚点: draft.anchor, 候选句: content.text }),
    '只回答 YES 或 NO。',
  ].join('\n') });
  if (!current()) return { reason: 'QQ_CONTINUATION_STALE' };
  if (!review?.ok || String(review.text).trim().toUpperCase() !== 'YES') return { reason: 'QQ_CONTINUATION_OFF_TOPIC' };
  return deliver(content.text);
}
