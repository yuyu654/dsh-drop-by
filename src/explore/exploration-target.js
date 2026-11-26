import { planInitialWebSearch, publicExplorationUrl } from './explore-media.js';

const MANGA_HOST = 'manga.bilibili.com';
const METADATA_HOSTS = ['bgm.tv', 'bangumi.tv'];
export const TRUSTED_WORK_CATALOGS = Object.freeze([MANGA_HOST, ...METADATA_HOSTS]);

const BOOK_TITLE = /《([^》]+)》|〈([^〉]+)〉/gu;
const WORK_MARKER = /(?:作品|书名|篇名|漫画|小说|番剧)\s*[:：]/u;
const CHAPTER = /第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*[章节话回集卷]/u;
const READ = /^(?:(?:请|想|先|要|继续|接着|帮我|给我)\s*)*(?:看一看|看看|读一读|阅读|追更|追|读|看)\s*/u;
const RESEARCH_REQUEST = /^(?:(?:我|请|想|最近|今天|先|继续|帮我|关于|只看|只找)\s*)*(?:研究|探讨|学习|分析|了解|比较|调查|科普|只查|找资料|找教程|查资料|查询|怎么|怎样|如何|为什么)/u;
const RESEARCH_SUBJECT = /(?:教程|原理|方法|设计|方案|代码|插件|架构|文档|分布式事务|对比|分析|调研|研究|话题|的题|研究题|望远镜[^，。]*观测|插排[^，。]*负载|兴趣|评测|评价|叙事手法|怎么|怎样|如何|为什么|是什么)(?:[？?。！!]|\s|$)|^(?:漫画|小说|视频|动画|番剧|独立游戏|乐器|气象|编程)(?:[，,。！!；;、\s]|$)/u;
const MANGA_PLATFORM = /^(?:哔哩哔哩漫画|bilibili漫画|B\s*站漫画|B\s*漫)$/iu;
const READING_PLATFORM = /^(?:哔哩哔哩漫画|bilibili漫画|B\s*站漫画|B\s*漫|起点中文网|起点读书|起点|晋江文学城|晋江|番茄免费小说|番茄小说|番茄|腾讯动漫|腾讯漫画|快看漫画|快看)$/iu;
const SOURCE_REFERENCE = /(?:\bsite|来源)\s*[:：]\s*([^\s(),，。；;、《》〈〉（）]+)|[a-z][a-z0-9+.-]*:\/\/[^\s(),，。；;、《》〈〉（）]+|(?<![\w@./:-])(?:[a-z0-9-]+\.)+(?:com|net|org|cn|edu|gov|io|co|dev|info|me|tv|app|wiki|xyz|uk|de|jp)\b(?:\/[^\s(),，。；;、《》〈〉（）]*)?(?![@./:-])/giu;
const NAMED_SOURCE = /哔哩哔哩漫画|bilibili漫画|B\s*站漫画|B\s*漫|起点中文网|起点读书|起点|晋江文学城|晋江|番茄免费小说|番茄小说|番茄|腾讯动漫|腾讯漫画|快看漫画|快看|知乎|\b(?:CSDN|GitHub|GitLab)\b|掘金|博客园/giu;

function cleanTitle(value) {
  return String(value || '').normalize('NFKC')
    .replace(/[《》〈〉“”„‟"]/gu, '')
    .replace(/\s+/gu, ' ').trim();
}

const titleKey = (value) => cleanTitle(value).toLowerCase();
const metadataHost = (host) => METADATA_HOSTS.includes(host.replace(/^www\./u, ''));

function workSource(value) {
  const text = String(value || '').trim();
  if (!text || /[\r\n]/u.test(text)) return null;
  if (MANGA_PLATFORM.test(text)) return { hosts: [MANGA_HOST] };
  const url = publicExplorationUrl(text.includes('://') ? text : 'https://' + text);
  if (url) {
    if (metadataHost(url.hostname)) return null;
    return { hosts: [url.hostname], ...(url.pathname !== '/' || url.search ? { url: url.href } : {}) };
  }
  if (text.includes('://')) return null;
  const plan = planInitialWebSearch({ pinnedTopic: text });
  return !plan.fallbackQuery && plan.preferredSites.length ? { hosts: plan.preferredSites } : null;
}

function mapping(line) {
  const match = /^([^|｜]+?)\s*[|｜]\s*(.+)$/u.exec(line) || /^([^:：]+?)\s*[:：]\s*(.+)$/u.exec(line);
  return match ? [titleKey(match[1]), match[2]] : [];
}

function configuredWorkSource(raw, title) {
  const key = titleKey(title);
  for (const line of String(raw || '').split(/\r?\n/u)) {
    const [storedTitle, value] = mapping(line);
    if (key && storedTitle === key) return workSource(value);
  }
  return null;
}

export function setExplorationWorkSource(rawConfig, title, url) {
  const raw = String(rawConfig || '');
  const key = titleKey(title);
  if (!key || /[|｜]/u.test(key) || !workSource(url)) return raw;
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw ? raw.split(/\r?\n/u) : [];
  const assignment = cleanTitle(title) + ' | ' + String(url).trim();
  let found = false;
  const updated = lines.flatMap((line) => {
    if (mapping(line)[0] !== key) return [line];
    if (found) return [];
    found = true;
    return [assignment];
  });
  if (!found) updated.splice(updated.at(-1) === '' ? updated.length - 1 : updated.length, 0, assignment);
  return updated.join(newline);
}

function extractSource(text) {
  const references = [];
  const names = [];
  const rest = text.replace(SOURCE_REFERENCE, (reference, site) => {
    references.push(workSource(site || reference));
    return ' ';
  }).replace(NAMED_SOURCE, (name) => {
    names.push({ name, source: workSource(name) });
    return ' ';
  });
  const sources = references.length ? references : names.map(({ source }) => source);
  const hosts = [...new Set(sources.flatMap((source) => source?.hosts || []))];
  const urls = [...new Set(sources.map((source) => source?.url).filter(Boolean))];
  return {
    rest, namedPlatform: names.some(({ name }) => READING_PLATFORM.test(name)),
    specified: sources.length > 0,
    hosts, ...(urls.length === 1 && hosts.length === 1 ? { url: urls[0] } : {}),
    ...(urls.length > 1 ? { candidates: urls.map((url) => ({ label: url, url })) } : {}),
  };
}

export function classifyExplorationTarget(raw, workSources = '') {
  const input = String(raw || '').trim();
  const explicitTopic = /^主题\s*[:：]\s*/u.exec(input);
  if (!input || explicitTopic) {
    return { input, title: input.slice(explicitTopic?.[0].length || 0), kind: 'topic', hosts: [] };
  }

  const bracketTitles = [...input.matchAll(BOOK_TITLE)].map((match) => cleanTitle(match[1] || match[2]));
  const source = extractSource(input.replace(BOOK_TITLE, ' '));
  const rest = source.rest.replace(/(?:来源|官网|平台)\s*[:：]?\s*$/u, '').trim();
  const explicitWork = WORK_MARKER.test(input);
  const chapter = CHAPTER.test(rest);
  const subject = rest.split(CHAPTER)[0].replace(WORK_MARKER, ' ')
    .replace(/^(?:[：:\s，,]+|(?:在|从|上)\s+)/u, '')
    .replace(/[：:\s，,。（）()]+$/u, '');
  const title = bracketTitles.join(' / ') || cleanTitle(chapter || source.namedPlatform ? subject.replace(READ, '') : subject);
  const saved = configuredWorkSource(workSources, title);
  const exactSavedTitle = !source.specified && saved && titleKey(input) === titleKey(title);
  const topic = !explicitWork && !exactSavedTitle && (RESEARCH_REQUEST.test(input) || RESEARCH_REQUEST.test(rest)
    || (!chapter && RESEARCH_SUBJECT.test(bracketTitles.length ? rest : input)));
  if (topic) return { input, title: input, kind: 'topic', hosts: [] };

  const target = { input, title, hosts: [] };
  if (bracketTitles.length > 1 || source.candidates) {
    return { ...target, kind: 'ambiguous', reason: 'TOPIC_AMBIGUOUS', candidates: source.candidates || [] };
  }
  const savedMatchesHost = Boolean(
    saved?.url && (!source.hosts.length || saved.hosts?.some((h) => source.hosts.includes(h)))
  );
  const approved = source.specified
    ? { hosts: source.hosts, ...(source.url ? { url: source.url } : (savedMatchesHost ? { url: saved.url } : {})) }
    : saved;
  if (approved?.hosts.length) return { ...target, ...approved, kind: 'work' };
  if (explicitWork || bracketTitles.length || chapter || source.namedPlatform) {
    return { ...target, kind: 'work', reason: 'WORK_SOURCE_REQUIRED' };
  }
  return { ...target, kind: 'ambiguous', reason: 'TOPIC_AMBIGUOUS' };
}

function catalogMatch(row, key) {
  const url = publicExplorationUrl(row?.url);
  if (!url || !TRUSTED_WORK_CATALOGS.includes(url.hostname)) return null;
  const label = String(row?.title || '').trim();
  const workTitle = label.replace(/\s*(?:[|_｜·—-]\s*)?(?:哔哩哔哩漫画|Bangumi\s*番组计划|Bangumi)\s*$/iu, '');
  if (titleKey(workTitle) !== key) return null;
  if (metadataHost(url.hostname)) return /^\/subject\/\d+\/?$/u.test(url.pathname) ? { metadata: true } : null;
  const manga = /^\/(?:m\/)?detail\/(mc\d+)\/?$/u.exec(url.pathname);
  return manga ? { label, url: 'https://' + MANGA_HOST + '/detail/' + manga[1] } : null;
}

export async function resolveExplorationTarget(raw, { workSources = '', lookup, signal } = {}) {
  const target = classifyExplorationTarget(raw, workSources);
  if (target.kind === 'topic' || target.hosts.length || target.candidates || !target.title || typeof lookup !== 'function') {
    return target;
  }
  signal?.throwIfAborted();
  let rows;
  try {
    rows = await lookup(target.title, { signal });
  } catch {
    signal?.throwIfAborted();
    return target;
  }
  signal?.throwIfAborted();
  if (!Array.isArray(rows)) return target;

  const matches = rows.map((row) => catalogMatch(row, titleKey(target.title))).filter(Boolean);
  const candidates = [...new Map(matches.filter(({ url }) => url).map((match) => [match.url, match])).values()];
  if (candidates.length === 1) {
    return { input: target.input, title: target.title, kind: 'work', hosts: [MANGA_HOST], url: candidates[0].url };
  }
  if (candidates.length > 1) return { ...target, kind: 'ambiguous', reason: 'TOPIC_AMBIGUOUS', candidates };
  if (matches.some(({ metadata }) => metadata)) return { ...target, kind: 'work', reason: 'WORK_SOURCE_REQUIRED' };
  return target;
}
