/* =====================================================================
   Market data service — real data from Yahoo Finance (no API key).
   ===================================================================== */
'use strict';
const yahooFinance = require('yahoo-finance2').default;
const finnhub = require('./finnhub');

// Quiet the library's informational notices
try { yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical']); } catch (_) {}

// tiny in-memory cache so rapid re-requests don't hammer Yahoo
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  const now = Date.now();
  if (hit && now - hit.t < ttlMs) return hit.v;
  const v = await fn();
  cache.set(key, { t: now, v });
  return v;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

// diagnostic logger → writes to <project>/debug.log so issues can be inspected
const _fs = require('fs'), _path = require('path');
function dbg(msg) { try { _fs.appendFileSync(_path.join(__dirname, '..', 'debug.log'), new Date().toISOString() + '  ' + msg + '\n'); } catch (e) {} }

// When Yahoo returns 429, stop calling it for a couple of minutes so its
// rate-limit can reset (aggressive retries keep the block alive).
let yahooCooldownUntil = 0;
const is429 = (e) => /Too Many Requests|429/i.test((e && e.message) || '');

/* ── Twelve Data (free API key) — reliable primary source when Yahoo/Stooq
   are blocked. Get a free key at https://twelvedata.com and put it in .env
   as TWELVEDATA_API_KEY. Free tier: 8 req/min, 800 req/day.               */
const TD_KEY = (process.env.TWELVEDATA_API_KEY || '').trim();
const TD = 'https://api.twelvedata.com';
dbg('market build=finnhub-primary-quotes  TD_KEY=' + (TD_KEY ? 'SET' : 'MISSING'));
const TD_COUNTRY = '&country=' + encodeURIComponent('United States'); // pin to US listing (avoids wrong foreign resolutions)
async function tdQuote(symbol) {
  const r = await fetch(`${TD}/quote?symbol=${encodeURIComponent(symbol)}${TD_COUNTRY}&apikey=${TD_KEY}`);
  const j = await r.json();
  if (j.status === 'error' || j.code >= 400) throw new Error('TwelveData: ' + (j.message || 'error'));
  if (j.close == null) throw new Error('TwelveData: no quote for ' + symbol);
  return {
    name: j.name || symbol, exch: j.exchange || '',
    price: +j.close, prevClose: +j.previous_close,
    dayHigh: num(+j.high), dayLow: num(+j.low),
    high52: j.fifty_two_week ? num(+j.fifty_two_week.high) : null,
    low52: j.fifty_two_week ? num(+j.fifty_two_week.low) : null,
    volume: num(+j.volume), avgVolume: num(+j.average_volume),
    marketCap: null, pe: null, forwardPE: null, eps: null,
    bid: null, ask: null, currency: j.currency || 'USD',
  };
}
const TD_INTERVAL = {
  '1D': { interval: '5min', outputsize: 78 }, '1W': { interval: '30min', outputsize: 90 },
  '1M': { interval: '1day', outputsize: 23 }, '3M': { interval: '1day', outputsize: 66 },
  '1Y': { interval: '1day', outputsize: 260 }, '3Y': { interval: '1day', outputsize: 780 },
  'MAX': { interval: '1week', outputsize: 800 },
};
async function tdCandles(symbol, range) {
  const c = TD_INTERVAL[range] || TD_INTERVAL['1Y'];
  const r = await fetch(`${TD}/time_series?symbol=${encodeURIComponent(symbol)}&interval=${c.interval}&outputsize=${c.outputsize}${TD_COUNTRY}&apikey=${TD_KEY}`);
  const j = await r.json();
  if (j.status === 'error' || !Array.isArray(j.values)) throw new Error('TwelveData: ' + (j.message || 'no series'));
  return j.values.slice().reverse().map((v) => {
    const iso = v.datetime.includes(' ') ? v.datetime.replace(' ', 'T') + 'Z' : v.datetime + 'T00:00:00Z';
    return { t: new Date(iso).toISOString(), o: +v.open, h: +v.high, l: +v.low, c: +v.close, v: +v.volume || 0 };
  });
}

/* ── Stooq fallback (free, no key, no crumb, not rate-limited like Yahoo) ──
   Used only when Yahoo is throttling. US tickers use the ".us" suffix.       */
async function stooqDaily(symbol) {
  const s = symbol.toLowerCase() + '.us';
  const url = `https://stooq.com/q/d/l/?s=${s}&i=d`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': 'text/csv,text/plain,*/*' } });
  const txt = await r.text();
  if (!r.ok) { dbg('stooq HTTP ' + r.status + ' body=' + txt.slice(0, 160).replace(/\s+/g, ' ')); throw new Error('Stooq HTTP ' + r.status); }
  const lines = txt.trim().split(/\r?\n/);
  const header = (lines[0] || '').toLowerCase();
  if (!header.startsWith('date')) { // not CSV — likely a block/limit page
    dbg('stooq non-CSV for ' + symbol + ': ' + txt.slice(0, 160).replace(/\s+/g, ' '));
    throw new Error('Stooq: unexpected response');
  }
  const bars = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(',');
    if (p.length < 5) continue;
    const d = p[0], c = p[4];
    const dt = new Date(d + 'T00:00:00Z');
    if (isNaN(dt.getTime()) || !c || isNaN(+c)) continue; // skip bad rows instead of crashing
    bars.push({ t: dt.toISOString(), o: +p[1], h: +p[2], l: +p[3], c: +c, v: +p[5] || 0 });
  }
  if (!bars.length) { dbg('stooq no valid bars for ' + symbol + ': ' + txt.slice(0, 160).replace(/\s+/g, ' ')); throw new Error('Stooq: no valid data'); }
  return bars;
}
async function stooqQuoteBase(symbol) {
  const bars = await stooqDaily(symbol);
  const last = bars[bars.length - 1], prev = bars[bars.length - 2] || last;
  const window = bars.slice(-252);
  return {
    name: symbol, exch: 'Stooq',
    price: last.c, prevClose: prev.c,
    dayHigh: last.h, dayLow: last.l,
    high52: Math.max(...window.map((b) => b.h)),
    low52: Math.min(...window.map((b) => b.l)),
    volume: last.v, avgVolume: Math.round(window.reduce((a, b) => a + b.v, 0) / window.length) || null,
    marketCap: null, pe: null, forwardPE: null, eps: null,
    bid: null, ask: null, currency: 'USD',
  };
}

/* ── Quote: price, change, ranges, volume, cap, P/E, EPS, beta, bid/ask ── */
async function getQuote(symbol) {
  symbol = symbol.toUpperCase();
  return cached('q:' + symbol, 20000, async () => { // 20s cache — frugal with free-tier API credits
    // Base price data. Prefer quote() (richest), but Yahoo frequently rate-limits
    // that endpoint (HTTP 429) — so fall back to chart(), which is NOT crumb-gated
    // and keeps working when quote() is throttled.
    let base = null, src = 'stooq';
    // Finnhub FIRST — accurate real-time US quotes at 60/min. Twelve Data's free
    // tier mis-resolves some tickers (e.g. returns a foreign listing) and only
    // gives a frozen last-close, so it's demoted to a fallback.
    if (finnhub.hasKey()) {
      try {
        const fq = await finnhub.quote(symbol);
        if (fq && fq.price) {
          base = {
            name: symbol, exch: '', price: num(fq.price), prevClose: num(fq.prevClose),
            dayHigh: num(fq.dayHigh), dayLow: num(fq.dayLow), high52: null, low52: null,
            volume: null, avgVolume: null, marketCap: null, pe: null, forwardPE: null, eps: null,
            bid: null, ask: null, currency: 'USD',
          };
          src = 'finnhub';
        }
      } catch (e) { dbg('finnhub quote err ' + symbol + ': ' + (e && e.message)); }
    }
    if (!base && TD_KEY) { try { base = await tdQuote(symbol); src = 'twelvedata'; } catch (e) { dbg('td quote err ' + symbol + ': ' + (e && e.message)); } }
    const yahooOK = !base && Date.now() > yahooCooldownUntil;
    if (yahooOK) try {
      const q = await yahooFinance.quote(symbol);
      if (q && q.regularMarketPrice != null) {
        base = {
          name: q.longName || q.shortName || symbol,
          exch: q.fullExchangeName || q.exchange || '',
          price: num(q.regularMarketPrice), prevClose: num(q.regularMarketPreviousClose),
          dayHigh: num(q.regularMarketDayHigh), dayLow: num(q.regularMarketDayLow),
          high52: num(q.fiftyTwoWeekHigh), low52: num(q.fiftyTwoWeekLow),
          volume: num(q.regularMarketVolume),
          avgVolume: num(q.averageDailyVolume3Month) || num(q.averageDailyVolume10Day),
          marketCap: num(q.marketCap), pe: num(q.trailingPE), forwardPE: num(q.forwardPE),
          eps: num(q.epsTrailingTwelveMonths), bid: num(q.bid), ask: num(q.ask),
          currency: q.currency || 'USD',
        };
      }
    } catch (e) { if (is429(e)) yahooCooldownUntil = Date.now() + 120000; dbg('quote() err ' + symbol + ': ' + (e && e.message)); }

    if (!base && yahooOK) {
      try {
        const c = await yahooFinance.chart(symbol, { period1: new Date(Date.now() - 7 * 86400000), interval: '1d' });
        const m = c && c.meta;
        if (m && m.regularMarketPrice != null) base = {
          name: m.longName || m.shortName || symbol,
          exch: m.fullExchangeName || m.exchangeName || '',
          price: num(m.regularMarketPrice),
          prevClose: num(m.chartPreviousClose) ?? num(m.previousClose),
          dayHigh: num(m.regularMarketDayHigh), dayLow: num(m.regularMarketDayLow),
          high52: num(m.fiftyTwoWeekHigh), low52: num(m.fiftyTwoWeekLow),
          volume: num(m.regularMarketVolume), avgVolume: null,
          marketCap: null, pe: null, forwardPE: null, eps: null,
          bid: null, ask: null, currency: m.currency || 'USD',
        };
      } catch (e) { if (is429(e)) yahooCooldownUntil = Date.now() + 120000; dbg('chart() err ' + symbol + ': ' + (e && e.message)); }
    }
    if (base && src === 'stooq') src = 'yahoo'; // base came from Yahoo, not TwelveData
    if (!base) {
      try { base = await stooqQuoteBase(symbol); }
      catch (e) { dbg('ALL SOURCES FAILED ' + symbol + ': ' + (TD_KEY ? '' : '(no TwelveData key) ') + 'stooq ' + (e && e.message)); throw e; }
    }
    dbg('QUOTE ' + symbol + ' via ' + src + ' price=' + (base && base.price));

    // Enrich fundamentals: Finnhub (60/min, reliable) fills market cap / P/E /
    // EPS / beta / sector; Yahoo only for the analyst target it uniquely gives.
    let beta = null, sector = '—', divYield = 0, targetMean = null, recKey = null, recMean = null;
    try {
      const fh = await finnhub.metrics(symbol);
      if (fh) {
        if (fh.beta != null) beta = fh.beta;
        if (fh.sector) sector = fh.sector;
        if (fh.divYield != null) divYield = fh.divYield;
        if (base.marketCap == null) base.marketCap = fh.marketCap;
        if (base.pe == null) base.pe = fh.pe;
        if (base.eps == null) base.eps = fh.eps;
        if (base.high52 == null) base.high52 = fh.high52;
        if (base.low52 == null) base.low52 = fh.low52;
        if (base.avgVolume == null) base.avgVolume = fh.avgVolume;
        if (base.volume == null) base.volume = fh.avgVolume; // Finnhub quote has no volume — show avg as an approximation
        if (!base.name || base.name === symbol) base.name = fh.name || base.name;
      }
    } catch (e) { dbg('finnhub metrics err ' + symbol + ': ' + (e && e.message)); }
    if (Date.now() > yahooCooldownUntil) try { // Yahoo just for analyst target / rating
      const s = await yahooFinance.quoteSummary(symbol, { modules: ['financialData', 'defaultKeyStatistics'] });
      targetMean = num(s.financialData?.targetMeanPrice);
      recKey = s.financialData?.recommendationKey || null;
      recMean = num(s.financialData?.recommendationMean);
      if (beta == null) beta = num(s.defaultKeyStatistics?.beta);
    } catch (e) { if (is429(e)) yahooCooldownUntil = Date.now() + 120000; }

    const change = (base.price != null && base.prevClose != null) ? base.price - base.prevClose : null;
    // ── Sanity cross-check (no extra API calls): catch grossly wrong quotes
    //    (e.g. a mis-resolved foreign listing) by testing the live price against
    //    the previous close and the 52-week range. ──
    let suspect = false, suspectReason = null;
    const px = base.price, pc = base.prevClose, hi = base.high52, lo = base.low52;
    if (px != null) {
      if (pc != null && pc > 0 && Math.abs(px - pc) / pc > 0.35) { suspect = true; suspectReason = `${((px - pc) / pc * 100).toFixed(0)}% vs prev close`; }
      if (hi != null && lo != null && hi > lo && (px > hi * 1.6 || px < lo * 0.5)) { suspect = true; suspectReason = 'outside 52-week range'; }
    }
    if (suspect) dbg('SUSPECT quote ' + symbol + ' via ' + src + ' px=' + px + ' (' + suspectReason + ')');
    return {
      symbol, sector, ...base,
      change, changePct: (change != null && base.prevClose) ? (change / base.prevClose) * 100 : null,
      beta, divYield, targetMean, recommendationKey: recKey, recommendationMean: recMean,
      source: src, suspect, suspectReason,
    };
  });
}

/* ── Candles / OHLCV for a range ── */
const RANGE = {
  '1D': { days: 1, interval: '5m', ttl: 120000 },
  '1W': { days: 7, interval: '30m', ttl: 180000 },
  '1M': { days: 32, interval: '1d', ttl: 600000 },
  '3M': { days: 95, interval: '1d', ttl: 300000 },
  '1Y': { days: 370, interval: '1d', ttl: 600000 },
  '3Y': { days: 1100, interval: '1d', ttl: 600000 },
  'MAX': { days: 3700, interval: '1wk', ttl: 600000 },
};

async function getCandles(symbol, range) {
  symbol = symbol.toUpperCase();
  const cfg = RANGE[range] || RANGE['1Y'];
  return cached(`c:${symbol}:${range}`, cfg.ttl, async () => {
    // Twelve Data first when a key is set (reliable); then Yahoo; then Stooq.
    if (TD_KEY) { try { const td = await tdCandles(symbol, range); if (td.length) return td; } catch (e) { dbg('td candles err ' + symbol + ': ' + (e && e.message)); } }
    if (Date.now() > yahooCooldownUntil) try {
      const period1 = new Date(Date.now() - cfg.days * 86400000);
      const res = await yahooFinance.chart(symbol, { period1, interval: cfg.interval });
      const quotes = (res && res.quotes) || [];
      const out = quotes.filter((x) => x.close != null && x.open != null).map((x) => ({
        t: x.date instanceof Date ? x.date.toISOString() : x.date,
        o: +x.open, h: +x.high, l: +x.low, c: +x.close, v: x.volume || 0,
      }));
      if (out.length) return out;
    } catch (e) { if (is429(e)) yahooCooldownUntil = Date.now() + 120000; }
    // Stooq gives daily bars only — slice to the requested window.
    const daily = await stooqDaily(symbol);
    const approxDays = cfg.days;
    const cut = Date.now() - approxDays * 86400000;
    const win = daily.filter((b) => new Date(b.t).getTime() >= cut);
    return (win.length ? win : daily.slice(-Math.min(daily.length, range === '1D' ? 5 : 60)));
  });
}

/* ── Fundamentals: income statement, balance sheet, cash flow, ratios ── */
async function getFundamentals(symbol) {
  symbol = symbol.toUpperCase();
  return cached('f:' + symbol, 3600000, async () => {
    const M = 1e6;
    let inc = [], bal = [], cf = [], est = [], yr = {};
    // Yahoo statements (best-effort — skipped when rate-limited)
    if (Date.now() > yahooCooldownUntil) {
      try {
        const s = await yahooFinance.quoteSummary(symbol, {
          modules: ['incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory',
            'defaultKeyStatistics', 'financialData', 'summaryDetail', 'earningsTrend'],
        });
        inc = (s.incomeStatementHistory?.incomeStatementHistory || []).slice(0, 3).map((r) => ({
          year: fy(r.endDate), revenue: div(r.totalRevenue, M), grossProfit: div(r.grossProfit, M),
          operatingIncome: div(r.operatingIncome, M), netIncome: div(r.netIncome, M) }));
        bal = (s.balanceSheetHistory?.balanceSheetStatements || []).slice(0, 3).map((r) => ({
          year: fy(r.endDate), cash: div(r.cash, M), totalAssets: div(r.totalAssets, M),
          totalDebt: div(r.shortLongTermDebt != null || r.longTermDebt != null ? (r.shortLongTermDebt || 0) + (r.longTermDebt || 0) : r.totalLiab, M),
          equity: div(r.totalStockholderEquity, M) }));
        cf = (s.cashflowStatementHistory?.cashflowStatements || []).slice(0, 3).map((r) => ({
          year: fy(r.endDate), operatingCF: div(r.totalCashFromOperatingActivities, M), capex: div(r.capitalExpenditures, M),
          fcf: r.totalCashFromOperatingActivities != null ? div((r.totalCashFromOperatingActivities || 0) + (r.capitalExpenditures || 0), M) : null }));
        est = (s.earningsTrend?.trend || []).filter((t) => ['0y', '+1y', '+2y'].includes(t.period))
          .map((t) => ({ period: t.period, eps: num2(t.earningsEstimate?.avg) }));
        yr = {
          pe: num2(s.summaryDetail?.trailingPE), forwardPE: num2(s.summaryDetail?.forwardPE),
          eps: num2(s.defaultKeyStatistics?.trailingEps), pegRatio: num2(s.defaultKeyStatistics?.pegRatio),
          beta: num2(s.defaultKeyStatistics?.beta) ?? num2(s.summaryDetail?.beta),
          priceToBook: num2(s.defaultKeyStatistics?.priceToBook), profitMargin: pct(s.defaultKeyStatistics?.profitMargins),
          grossMargin: pct(s.financialData?.grossMargins), operatingMargin: pct(s.financialData?.operatingMargins),
          returnOnEquity: pct(s.financialData?.returnOnEquity), dividendYield: pct(s.summaryDetail?.dividendYield),
          targetMean: num2(s.financialData?.targetMeanPrice), targetHigh: num2(s.financialData?.targetHighPrice),
          targetLow: num2(s.financialData?.targetLowPrice), recommendationKey: s.financialData?.recommendationKey || null,
          numberOfAnalysts: num2(s.financialData?.numberOfAnalystOpinions),
        };
      } catch (e) { if (is429(e)) yahooCooldownUntil = Date.now() + 120000; dbg('fundamentals yahoo err ' + symbol + ': ' + (e && e.message)); }
    }
    // Finnhub ratios (reliable) fill anything Yahoo didn't provide
    let fh = {}; try { fh = await finnhub.metrics(symbol); } catch (e) {}
    const pick = (a, b) => (a != null ? a : (b != null ? b : null));
    const ratios = {
      pe: pick(yr.pe, fh.pe), forwardPE: yr.forwardPE ?? null, eps: pick(yr.eps, fh.eps),
      pegRatio: yr.pegRatio ?? null, beta: pick(yr.beta, fh.beta), priceToBook: pick(yr.priceToBook, fh.priceToBook),
      profitMargin: pick(yr.profitMargin, fh.netMargin), grossMargin: pick(yr.grossMargin, fh.grossMargin),
      operatingMargin: pick(yr.operatingMargin, fh.operatingMargin), returnOnEquity: pick(yr.returnOnEquity, fh.roe),
      dividendYield: pick(yr.dividendYield, fh.divYield), targetMean: yr.targetMean ?? null,
      targetHigh: yr.targetHigh ?? null, targetLow: yr.targetLow ?? null,
      recommendationKey: yr.recommendationKey ?? null, numberOfAnalysts: yr.numberOfAnalysts ?? null,
      // Finnhub-sourced extras so the AI ranking's Fundamentals & Cashflow
      // factors have real data even when Yahoo statements are rate-limited.
      revenueGrowth: fh.revenueGrowth ?? null, epsGrowth: fh.epsGrowth ?? null,
      fcfPerShare: fh.fcfPerShare ?? null, pfcf: fh.pfcf ?? null, fcfYield: fh.fcfYield ?? null,
      currentRatio: fh.currentRatio ?? null, roa: fh.roa ?? null,
    };
    return { symbol, years: inc.map((x) => x.year), income: inc, balance: bal, cashflow: cf, epsEstimates: est, ratios, hasStatements: inc.length > 0 };
  });
}

// helpers
function fy(d) { if (!d) return '—'; const y = (d instanceof Date ? d : new Date(d)).getFullYear(); return 'FY' + String(y).slice(2); }
function div(v, by) { return (typeof v === 'number' && isFinite(v)) ? v / by : null; }
function num2(v) { return (typeof v === 'number' && isFinite(v)) ? v : null; }
function pct(v) { return (typeof v === 'number' && isFinite(v)) ? v * 100 : null; }

module.exports = { getQuote, getCandles, getFundamentals };
