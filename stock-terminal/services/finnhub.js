/* =====================================================================
   Finnhub service — free tier allows 60 calls/min (far more generous than
   Twelve Data's 8/min), so we use it for fundamentals + the indexes tab.
   Get a free key at https://finnhub.io  → put it in settings.txt as
   FINNHUB_API_KEY=...
   ===================================================================== */
'use strict';
const FH_KEY = (process.env.FINNHUB_API_KEY || '').trim();
const FH = 'https://finnhub.io/api/v1';
const hasKey = () => !!FH_KEY;
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

const _cache = new Map();
async function cached(key, ttl, fn) {
  const h = _cache.get(key), now = Date.now();
  if (h && now - h.t < ttl) return h.v;
  const v = await fn(); _cache.set(key, { t: now, v }); return v;
}
async function fhGet(p) {
  const url = `${FH}${p}${p.includes('?') ? '&' : '?'}token=${FH_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Finnhub HTTP ' + r.status);
  return r.json();
}

/* Real-time quote (US stocks & ETFs on the free tier). */
async function quote(symbol) {
  if (!FH_KEY) throw new Error('no finnhub key');
  return cached('q:' + symbol, 15000, async () => {
    const q = await fhGet(`/quote?symbol=${encodeURIComponent(symbol)}`);
    if (q.c == null || q.c === 0) throw new Error('Finnhub: no quote for ' + symbol);
    return { price: q.c, prevClose: q.pc, open: q.o, dayHigh: q.h, dayLow: q.l, change: q.d, changePct: q.dp };
  });
}

/* Company profile + key metrics → market cap, P/E, EPS, beta, sector, 52wk.
   Cached 1h since fundamentals don't change intraday. */
async function metrics(symbol) {
  if (!FH_KEY) return {};
  return cached('m:' + symbol, 3600000, async () => {
    const [p, m] = await Promise.all([
      fhGet(`/stock/profile2?symbol=${encodeURIComponent(symbol)}`).catch(() => ({})),
      fhGet(`/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all`).catch(() => ({})),
    ]);
    const M = m.metric || {};
    const pfcf = n(M.pfcfShareTTM) ?? n(M.pfcfShareAnnual);
    return {
      name: p.name || null, exch: p.exchange || null, sector: p.finnhubIndustry || null,
      marketCap: n(p.marketCapitalization) != null ? p.marketCapitalization * 1e6 : null, // Finnhub gives $M
      pe: n(M.peTTM) ?? n(M.peBasicExclExtraTTM) ?? n(M.peInclExtraTTM),
      eps: n(M.epsTTM) ?? n(M.epsBasicExclExtraItemsTTM) ?? n(M.epsInclExtraItemsTTM),
      beta: n(M.beta),
      high52: n(M['52WeekHigh']), low52: n(M['52WeekLow']),
      divYield: n(M.dividendYieldIndicatedAnnual) ?? n(M.currentDividendYieldTTM),
      grossMargin: n(M.grossMarginTTM), netMargin: n(M.netProfitMarginTTM), roe: n(M.roeTTM),
      priceToBook: n(M.pbQuarterly) ?? n(M.pbAnnual),
      // ── extra ratios for the AI ranking (Finnhub-sourced so they work when
      //    Yahoo's statement data is rate-limited) ──
      operatingMargin: n(M.operatingMarginTTM) ?? n(M.operatingMarginAnnual),
      peg: n(M.pegTTM) ?? n(M.pegRatioTTM),
      revenueGrowth: n(M.revenueGrowthTTMYoy) ?? n(M.revenueGrowthQuarterlyYoy) ?? n(M.revenueGrowth3Y),
      epsGrowth: n(M.epsGrowthTTMYoy) ?? n(M.epsGrowth3Y),
      fcfPerShare: n(M.freeCashFlowPerShareTTM) ?? n(M.freeCashFlowPerShareAnnual) ?? n(M.cashFlowPerShareTTM) ?? n(M.cashFlowPerShareAnnual),
      pfcf,
      fcfYield: (pfcf != null && pfcf !== 0) ? 100 / pfcf : null, // FCF yield % = FCF per share / price
      currentRatio: n(M.currentRatioQuarterly) ?? n(M.currentRatioAnnual),
      roa: n(M.roaTTM),
      // avg daily volume (Finnhub gives these in millions of shares)
      avgVolume: (() => { const v = n(M['10DayAverageTradingVolume']) ?? n(M['3MonthAverageTradingVolume']); return v != null ? Math.round(v * 1e6) : null; })(),
    };
  });
}

/* Index quotes via US-listed ETF proxies (all covered by the free tier).
   `list` items: {sym, name, region, proxy}. Cached 2min. */
async function indexQuotes(list) {
  if (!FH_KEY) return list.map((ix) => ({ ...ix, val: null, chg: null, live: false }));
  return cached('idx', 120000, async () => Promise.all(list.map(async (ix) => {
    try { const q = await quote(ix.proxy); return { ...ix, val: q.price, chg: q.changePct, live: true }; }
    catch (e) { return { ...ix, val: null, chg: null, live: false }; }
  })));
}

/* Company news (real articles with URLs) from the last ~2 weeks. Cached 10min. */
async function news(symbol) {
  if (!FH_KEY) return [];
  return cached('news:' + symbol, 600000, async () => {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const to = new Date(), from = new Date(Date.now() - 14 * 86400000);
    const arr = await fhGet(`/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}`);
    if (!Array.isArray(arr)) return [];
    return arr.filter((a) => a.headline && a.url).slice(0, 12).map((a) => ({
      title: a.headline, publisher: a.source || '', link: a.url,
      time: a.datetime ? new Date(a.datetime * 1000).toISOString() : null,
      summary: a.summary || '',
    }));
  });
}

/* Next earnings date + estimate, with days-until. Cached 1h. */
async function earnings(symbol) {
  if (!FH_KEY) return null;
  return cached('earn:' + symbol, 3600000, async () => {
    const fmt = (d) => d.toISOString().slice(0, 10);
    const j = await fhGet(`/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${fmt(new Date(Date.now() - 3 * 864e5))}&to=${fmt(new Date(Date.now() + 130 * 864e5))}`);
    const list = (j && j.earningsCalendar) || [];
    const now = Date.now();
    const upcoming = list.filter((e) => new Date(e.date).getTime() >= now - 864e5).sort((a, b) => new Date(a.date) - new Date(b.date));
    const nx = upcoming[0]; if (!nx) return null;
    return { date: nx.date, daysUntil: Math.round((new Date(nx.date).getTime() - now) / 864e5), epsEstimate: n(nx.epsEstimate), hour: nx.hour || null };
  });
}

/* Analyst recommendation trend (real buy/hold/sell over recent periods). Cached 1h. */
async function recommendations(symbol) {
  if (!FH_KEY) return [];
  return cached('rec:' + symbol, 3600000, async () => {
    const arr = await fhGet(`/stock/recommendation-trends?symbol=${encodeURIComponent(symbol)}`);
    if (!Array.isArray(arr)) return [];
    return arr.slice(0, 6).map((r) => ({ period: r.period, strongBuy: r.strongBuy || 0, buy: r.buy || 0, hold: r.hold || 0, sell: r.sell || 0, strongSell: r.strongSell || 0 }));
  });
}

/* Recent insider transactions. Cached 1h. */
async function insiders(symbol) {
  if (!FH_KEY) return [];
  return cached('ins:' + symbol, 3600000, async () => {
    const j = await fhGet(`/stock/insider-transactions?symbol=${encodeURIComponent(symbol)}`);
    const data = (j && j.data) || [];
    return data.slice(0, 15).map((t) => ({ name: t.name, shares: t.share, change: t.change, date: t.transactionDate, price: n(t.transactionPrice), code: t.transactionCode }));
  });
}

/* Official news-sentiment score (may require a paid plan; returns null if not). */
async function newsSentiment(symbol) {
  if (!FH_KEY) return null;
  return cached('sent:' + symbol, 3600000, async () => {
    try {
      const j = await fhGet(`/news-sentiment?symbol=${encodeURIComponent(symbol)}`);
      const s = j && j.sentiment;
      if (!s || s.bullishPercent == null) return null;
      return { bullishPercent: s.bullishPercent * 100, companyNewsScore: n(j.companyNewsScore), buzz: n(j.buzz && j.buzz.articlesInLastWeek), source: 'finnhub' };
    } catch (e) { return null; }
  });
}

/* Similar companies (auto-fills Compare). */
async function peers(symbol) {
  if (!FH_KEY) return [];
  return cached('peers:' + symbol, 3600000, async () => {
    try { const a = await fhGet(`/stock/peers?symbol=${encodeURIComponent(symbol)}`); return Array.isArray(a) ? a.slice(0, 8) : []; }
    catch (e) { return []; }
  });
}

/* Upcoming economic events (CPI, Fed, jobs…). May be paid on some plans. */
async function economicCalendar() {
  if (!FH_KEY) return [];
  return cached('econ', 3600000, async () => {
    try {
      const j = await fhGet('/calendar/economic');
      const list = (j && j.economicCalendar) || [];
      const now = Date.now();
      return list
        .filter((e) => e.time && new Date(e.time).getTime() >= now - 6 * 3600000)
        .filter((e) => !e.country || ['US', 'EU', 'GB', 'CN', 'JP'].includes(e.country))
        .sort((a, b) => new Date(a.time) - new Date(b.time))
        .slice(0, 25)
        .map((e) => ({ event: e.event, country: e.country, time: e.time, impact: e.impact, actual: e.actual, estimate: e.estimate, prev: e.prev }));
    } catch (e) { return []; }
  });
}

module.exports = { hasKey, quote, metrics, indexQuotes, news, earnings, recommendations, insiders, newsSentiment, peers, economicCalendar, FH_KEY };
