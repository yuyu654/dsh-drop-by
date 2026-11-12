// fishparse.js —— 从 App 那封 FISH 邮件里抠数字。
//
// 单独一个文件（不放 context.js）：fishmail.js 归档时要解析一次，context.js 读上下文时
// 也要解析一次，两边都从这里拿，就不会绕成「context → fishmail → context」的循环依赖。
//
// 原则：抠不到就 null，不猜、不补默认值。调用方看 null 自己决定怎么办。

/** "7 小时 39 分钟" / "38分钟" → 分钟数；读不到 null。 */
export function minsOf(s) {
  const t = String(s || '');
  const h = /(\d{1,2})\s*小时\s*(?:(\d{1,2})\s*分)?/.exec(t);
  if (h) return Number(h[1]) * 60 + (h[2] ? Number(h[2]) : 0);
  const m = /(\d{1,3})\s*分/.exec(t);
  if (m) return Number(m[1]);
  return null;
}

/**
 * 从 App 邮件摘要里抠数字。摘要长这样：
 *   起床 07:57 · 睡眠 7.6h · 步数 6045 · 压力 36 · 心率 72 · 血氧 97%
 *   睡眠详情
 *   夜间睡眠：7 小时 39 分钟
 *   深睡：2 小时 25 分钟 · 浅睡：3 小时 59 分钟 · 快速眼动：1 小时 15 分钟
 *   屏幕时间：5小时12分（微信 48分、浏览器 32分）
 * 抠不到就是 null，不做猜测。
 *
 * 两种「睡眠」不是一个数：`睡眠 7.6h` 是**总睡眠**（24 小时里睡了多少，含白天小睡），
 * `睡眠详情：睡眠时间 7 小时 39 分钟` 是**夜间睡眠**（昨夜那一觉）。判定优先用夜间睡眠，
 * 没有才退回总睡眠；两个都记下来（nightMin / totalMin / sleepFrom），方便排查。
 */
export function parseFishSummary(summary) {
  const s = String(summary || '');
  const pick = (re) => {
    const m = re.exec(s);
    return m ? minsOf(m[1]) : null;
  };
  // 首页那行的「睡眠 7.6h」只在没抓到详情时兜底（详情更准，能到分钟）
  const hDecimal = (() => {
    const m = /(?:^|[·\s])睡眠\s*(\d{1,2}(?:\.\d)?)\s*h/.exec(s);
    return m ? Math.round(Number(m[1]) * 60) : null;
  })();
  // 两个不同的数，别混：
  //   「睡眠 8.8h」= **总睡眠**（一天 24 小时里睡了多少，含白天小睡），只有首页行才给小数
  //   「睡眠详情：睡眠时间 8小时8分钟」= **夜间睡眠**（昨夜那一觉，能到分钟）
  // 一天只采早上一次时两者通常一致；有详情就用夜间睡眠（更准），没有才退回总睡眠。
  const nightMin =
    pick(/(?:睡眠时间|夜间睡眠)\s*[：:]?\s*([0-9]+\s*小时[^·\n]*|[0-9]+\s*分)/) ??
    pick(/(?:睡眠时间|夜间睡眠)\s*[：:\s]\s*([^\n·]*)/);
  const totalMin = hDecimal;
  const sleepFrom = nightMin != null ? 'night' : totalMin != null ? 'total' : null;
  return {
    // 判定用这个（夜间优先，缺了才用总睡眠）
    sleepMin: nightMin ?? totalMin,
    nightMin,
    totalMin,
    sleepFrom,
    deepMin: pick(/深睡\s*[：:]?\s*([0-9]+\s*小时[^·\n]*|[0-9]+\s*分)/),
    lightMin: pick(/浅睡\s*[：:]?\s*([0-9]+\s*小时[^·\n]*|[0-9]+\s*分)/),
    remMin: pick(/(?:快速眼动|REM)\s*[：:]?\s*([0-9]+\s*小时[^·\n]*|[0-9]+\s*分)/),
    screenMin: pick(/屏幕时间\s*[：:]\s*([0-9]+\s*小时[^·\n]*|[0-9]+\s*分)/),
    // 入睡时间：App 那边可能会带「入睡时间 23:41」/「入睡 23:41」。
    // 这一项**大概率读不到**（没绑设备、没同步、字段空着都常见），读不到就是 null，
    // 调用方拿不到时仍用「起床 − 夜间睡眠」反推，不猜。
    bedHm: (() => {
      const m = /(?:入睡时间|入睡时刻|入睡|睡着时间)\s*[：:]?\s*([0-2]?\d\s*[:：]\s*[0-5]\d)/.exec(s);
      if (!m) return null;
      const [h, mi] = m[1].split(/[:：]/);
      const hh = Number(h);
      const mm = Number(mi);
      if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh > 24 || mm > 59) return null;
      return `${String(hh % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    })(),
    // 起床时间：优先「起床 07:57」，其次「23:41-07:57」这种区间取后半段
    wakeHm: (() => {
      const a = /起床[^0-9]{0,8}(\d{1,2}:\d{2})/.exec(s);
      if (a) return a[1];
      const b = /(\d{1,2}:\d{2})\s*[-~—至]\s*(\d{1,2}:\d{2})/.exec(s);
      return b ? b[2] : null;
    })(),
    // 步数：首页行「· 步数 6045」。只认 0~200000 的整数，
    // 「步数 未读到」这类文字自然抓不到（返回 null），不猜。
    steps: (() => {
      const m = /步数\s*[：:]?\s*(\d{1,6})/.exec(s);
      if (!m) return null;
      const v = Number(m[1]);
      return Number.isFinite(v) && v >= 0 && v <= 200000 ? v : null;
    })(),
    // 压力：首页行「· 压力 36」，也认「压力 36 / 36 压力」。
    // 只认 0~100 的整数——超出范围的多半是抠错了（比如把年份、步数当压力）。
    stress: (() => {
      const cands = [
        /(?:^|[·\s，,])压力\s*[：:]?\s*(\d{1,3})/,
        /压力[^0-9\n]{0,10}(\d{1,3})/,
        /(\d{1,3})\s*压力/,
      ];
      for (const re of cands) {
        const m = re.exec(s);
        if (!m) continue;
        const v = Number(m[1]);
        if (Number.isFinite(v) && v >= 0 && v <= 100) return v;
      }
      return null;
    })(),
  };
}
