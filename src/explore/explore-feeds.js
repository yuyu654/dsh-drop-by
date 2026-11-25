// explore-feeds.js —— 内置轻量结构化探索源（零浏览器、低 Token、公开 JSON / RSS 适配器）。
//
// 通过 extensions.js 的 registerExploreSource 注册：
//   - builtin-rss          用户配置的 RSS / Atom 订阅源
//   - builtin-bangumi      Bangumi 番剧每日放送日历（官方公开 JSON）
//   - builtin-github       GitHub 公开开源仓库检索/热门
//   - builtin-bilibili-hot B站公开全站热榜 JSON
//
// 所有网络请求均带硬超时与公开 URL 校验；默认需在设置页开启 exploration.builtinFeeds。

import { registerExploreSource } from '../settings/extensions.js';

const cleanText = (s, max = 240) =>
  String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

function isPublicHttpUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return false;
    if (!/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(u.hostname)) return false;
    if (/\.(?:localhost|local|internal|test|invalid)$/i.test(u.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

/** 轻量零依赖解析 RSS 2.0 (<item>) 与 Atom (<entry>) XML。 */
export function parseRssXml(xml, limit = 6) {
  const raw = String(xml || '');
  if (!raw.trim()) return [];
  const items = [];
  const blocks = [
    ...raw.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi),
    ...raw.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi),
  ];
  for (const m of blocks) {
    if (items.length >= limit) break;
    const body = m[1] || '';
    const title = cleanText(body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1], 120);
    const desc = cleanText(
      body.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i)?.[1] ||
      body.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i)?.[1] ||
      body.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i)?.[1],
      320,
    );
    const linkHref = body.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i)?.[1];
    const linkText = body.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1];
    const url = cleanText(linkHref || linkText, 400);
    if (!title && !desc) continue;
    items.push({
      title: title || '订阅条目',
      summary: desc || title,
      ...(isPublicHttpUrl(url) ? { url } : {}),
      evidence: 'RSS订阅摘要',
    });
  }
  return items;
}

function scoreMatch(item, keywords) {
  if (!keywords.length) return 0;
  const hay = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  let hits = 0;
  for (const kw of keywords) {
    if (kw.length >= 2 && hay.includes(kw)) hits += 1;
  }
  return hits;
}

function queryKeywords(query, interest) {
  const raw = `${query || ''} ${interest || ''}`.normalize('NFKC').toLowerCase();
  const toks = raw.match(/[\p{Script=Han}]{2,10}|[a-z0-9_-]{2,20}/gu) || [];
  return [...new Set(toks)].slice(0, 8);
}

export function parseRssUrlList(raw) {
  return String(raw || '')
    .split(/[\r\n,，;；]+/)
    .map((s) => s.trim())
    .filter(isPublicHttpUrl)
    .slice(0, 6);
}

async function fetchJson(url, { signal, fetchImpl = globalThis.fetch, headers = {} } = {}) {
  if (typeof fetchImpl !== 'function') return null;
  const res = await fetchImpl(url, {
    signal,
    redirect: 'follow',
    headers: {
      'User-Agent': 'dsh-drop-by/0.1 (structured-explore-feed)',
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
  });
  if (!res?.ok) return null;
  return res.json();
}

export function createBuiltinExploreSources({ getConfig, fetchImpl = globalThis.fetch } = {}) {
  const rss = {
    id: 'builtin-rss',
    label: 'RSS 订阅源',
    mode: 'both',
    description: '读取设置中填写的公开 RSS / Atom 订阅更新（零浏览器开销）',
    timeoutMs: 10_000,
    async browse({ query = '', interest = '', signal }) {
      const cfg = typeof getConfig === 'function' ? getConfig() : {};
      const urls = parseRssUrlList(cfg?.exploration?.rssUrls);
      if (!urls.length || typeof fetchImpl !== 'function') return { ok: false, items: [] };
      const all = [];
      for (const url of urls.slice(0, 3)) {
        try {
          const res = await fetchImpl(url, {
            signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'dsh-drop-by/0.1 (rss-reader)', Accept: 'application/rss+xml, application/atom+xml, text/xml, */*' },
          });
          if (!res?.ok) continue;
          const xml = await res.text();
          all.push(...parseRssXml(xml, 5));
        } catch { /* single feed failure does not abort others */ }
      }
      const kws = queryKeywords(query, interest);
      const ranked = all.sort((a, b) => scoreMatch(b, kws) - scoreMatch(a, kws));
      return { ok: ranked.length > 0, items: ranked.slice(0, 4) };
    },
  };

  const bangumi = {
    id: 'builtin-bangumi',
    label: 'Bangumi 番剧日历',
    mode: 'leisure',
    description: '获取 Bangumi 公开每日放送新番与简介（零浏览器开销）',
    timeoutMs: 10_000,
    async browse({ query = '', interest = '', now = Date.now(), signal }) {
      const data = await fetchJson('https://api.bgm.tv/calendar', { signal, fetchImpl });
      if (!Array.isArray(data) || !data.length) return { ok: false, items: [] };
      const allItems = [];
      const weekday = ((new Date(now).getDay() + 6) % 7) + 1; // 1=Mon..7=Sun
      for (const day of data) {
        const isToday = Number(day?.weekday?.id) === weekday;
        for (const item of Array.isArray(day?.items) ? day.items : []) {
          const title = cleanText(item?.name_cn || item?.name, 100);
          if (!title) continue;
          const rating = item?.rating?.score ? `评分 ${item.rating.score}` : '';
          const air = item?.air_date ? `首播 ${item.air_date}` : '';
          const summary = [
            isToday ? '今日放送' : (day?.weekday?.cn || ''),
            rating,
            air,
            cleanText(item?.summary, 160),
          ].filter(Boolean).join(' · ');
          allItems.push({
            title,
            summary: summary || title,
            url: item?.url || (item?.id ? `https://bgm.tv/subject/${item.id}` : ''),
            evidence: '公开接口摘要',
            _today: isToday ? 1 : 0,
            _score: Number(item?.rating?.score) || 0,
          });
        }
      }
      const kws = queryKeywords(query, interest);
      allItems.sort((a, b) => scoreMatch(b, kws) - scoreMatch(a, kws) || b._today - a._today || b._score - a._score);
      return {
        ok: allItems.length > 0,
        items: allItems.slice(0, 4).map(({ title, summary, url, evidence }) => ({ title, summary, url, evidence })),
      };
    },
  };

  const github = {
    id: 'builtin-github',
    label: 'GitHub 开源项目',
    mode: 'research',
    description: '检索 GitHub 公开高星仓库与项目简介（零浏览器开销）',
    timeoutMs: 10_000,
    async browse({ query = '', interest = '', signal }) {
      const q = cleanText(query || interest || 'stars:>5000', 80);
      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=5`;
      const data = await fetchJson(url, {
        signal,
        fetchImpl,
        headers: { Accept: 'application/vnd.github+json' },
      });
      const rows = Array.isArray(data?.items) ? data.items : [];
      const items = rows.slice(0, 4).map((repo) => ({
        title: cleanText(repo?.full_name || repo?.name, 100),
        summary: [
          repo?.language ? `[${repo.language}]` : '',
          Number.isFinite(Number(repo?.stargazers_count)) ? `★${repo.stargazers_count}` : '',
          cleanText(repo?.description, 200),
        ].filter(Boolean).join(' '),
        url: repo?.html_url || '',
        evidence: '公开接口摘要',
      })).filter((x) => x.title);
      return { ok: items.length > 0, items };
    },
  };

  const bilibiliHot = {
    id: 'builtin-bilibili-hot',
    label: 'B站公开热榜',
    mode: 'leisure',
    description: '浏览 B 站全站公开热门视频标题、UP 主与简介（零浏览器开销）',
    timeoutMs: 10_000,
    async browse({ query = '', interest = '', signal }) {
      const data = await fetchJson('https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', {
        signal,
        fetchImpl,
        headers: { Referer: 'https://www.bilibili.com/' },
      });
      const list = Array.isArray(data?.data?.list) ? data.data.list : [];
      if (!list.length) return { ok: false, items: [] };
      const kws = queryKeywords(query, interest);
      const mapped = list.slice(0, 30).map((v) => ({
        title: cleanText(v?.title, 100),
        summary: [
          v?.owner?.name ? `UP：${cleanText(v.owner.name, 24)}` : '',
          v?.tname ? `分区：${cleanText(v.tname, 16)}` : '',
          cleanText(v?.desc, 160),
        ].filter(Boolean).join(' · '),
        url: v?.bvid ? `https://www.bilibili.com/video/${v.bvid}` : '',
        evidence: '公开接口摘要',
      })).filter((x) => x.title);
      mapped.sort((a, b) => scoreMatch(b, kws) - scoreMatch(a, kws));
      return { ok: mapped.length > 0, items: mapped.slice(0, 4) };
    },
  };

  return [rss, bangumi, github, bilibiliHot];
}

let activeDisposers = [];

/** 按当前配置动态注册或卸载内置轻量探索源（开关切换无需重启）。 */
export function syncBuiltinExploreFeeds(getConfig, { fetchImpl = globalThis.fetch } = {}) {
  for (const dispose of activeDisposers) {
    try { dispose(); } catch { /* ignore */ }
  }
  activeDisposers = [];
  const cfg = typeof getConfig === 'function' ? getConfig() : (getConfig || {});
  if (cfg?.exploration?.builtinFeeds !== true) return 0;
  const sources = createBuiltinExploreSources({
    getConfig: typeof getConfig === 'function' ? getConfig : () => cfg,
    fetchImpl,
  });
  const hasRss = parseRssUrlList(cfg?.exploration?.rssUrls).length > 0;
  for (const src of sources) {
    if (src.id === 'builtin-rss' && !hasRss) continue;
    activeDisposers.push(registerExploreSource(src));
  }
  return activeDisposers.length;
}
