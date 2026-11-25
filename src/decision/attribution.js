export const ATTRIBUTION_RULE = '【来源归属铁律】探索记录和标为「我这边」的参数、公式、方案和下一步都是角色自己的后台笔记。只有近期用户原话明确提过同一个细节，才可以说「你说的」「照你的建议」。否则用「我想到」「我打算」或省略归属。';

const ATTRIBUTION = /(?:(?:按|照(?:着)?|按照|依照|根据|沿用|采纳)\s*你(?:的(?:建议|提议|方案|说法|思路)|(?:之前|刚才|上次)?(?:说|提到|提及|提|建议)(?:过|的|了)*))|你(?:之前|刚才|上次|先前|前面|原先|当时|也|曾经|曾)?(?:亲口)?(?:说|提到|提及|提|给|建议|推荐)(?:过的?|的|了)/gu;
const normalize = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^\S\n]+/gu, '');
const breakClause = /[，,。！？!?；;\n]/u;
const generic = /^(?:对|是|没错|有道理|也对|我懂了)?[的了啊呀吧嘛呢哈]*$/u;
const details = /[+-]?\d+(?:\.\d+)?(?:%|[a-z]+)?|[a-z][a-z0-9_-]*|[α-ω]/gu;

export function falseAttribution(text, ctx) {
  const raw = normalize(text);
  const history = [ctx?.her?.lastText,
    ...(ctx?.recent || []).filter((m) => m.from === 'her').map((m) => m.text),
    ...(ctx?.dialogueTurns || []).filter((m) => m.who === 'her').map((m) => m.text),
  ].map(normalize).filter(Boolean);
  for (const match of raw.matchAll(ATTRIBUTION)) {
    const before = raw.slice(0, match.index).split(breakClause).at(-1);
    const after = raw.slice(match.index + match[0].length);
    const adjacent = after.replace(/^[，,:：]+/u, '').split(breakClause)[0];
    const payload = adjacent.replace(/^(?:先|那个|这个|的|就是)+/u, '').replace(/^[:：「“"'《]+/u, '');
    if (generic.test(adjacent) && !/(?:按|照|根据|采纳)/u.test(match[0]) && (!before || adjacent === '对' || adjacent === '有道理' || adjacent === '没错')) continue;
    const facts = [...(before + ' ' + payload).matchAll(details)].map(([fact]) => fact);
    // 数字、比例和术语都要在用户原话里出现，不能因为另一个参数相同就放行。
    if (!facts.every((fact) => history.some((line) => [...line.matchAll(details)].some(([word]) => word === fact)))) return true;
    const quoted = /^([^」”"'》]+)[」”"'》]/u.exec(payload)?.[1];
    const key = quoted || payload || before;
    if (key && history.some((line) => {
      if (line.includes(key)) return true;
      if (quoted) return false;
      const head = key.slice(0, 6);
      return head.length >= 2 && line.includes(head);
    })) continue;
    return true;
  }
  return false;
}
