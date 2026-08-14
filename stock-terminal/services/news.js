/* =====================================================================
   News (Yahoo) + SEC EDGAR filings. Native fetch (Node 18+), no keys.
   ===================================================================== */
'use strict';
const yahooFinance = require('yahoo-finance2').default;
const finnhub = require('./finnhub');

const SEC_UA = process.env.SEC_USER_AGENT || 'Equity Analytics Terminal contact@example.com';

/* ── Latest news headlines — Finnhub first (real URLs, not rate-limited),
   Yahoo as a fallback. ── */
async function getNews(symbol) {
  symbol = symbol.toUpperCase();
  try {
    const fn = await finnhub.news(symbol);
    if (fn && fn.length) return fn;
  } catch (e) {}
  try {
    const r = await yahooFinance.search(symbol, { newsCount: 10, quotesCount: 0 });
    return (r.news || []).map((n) => ({
      title: n.title, publisher: n.publisher || '', link: n.link,
      time: n.providerPublishTime instanceof Date ? n.providerPublishTime.toISOString() : n.providerPublishTime,
    }));
  } catch (e) {
    return [];
  }
}

/* ── News sentiment ── official Finnhub score if available, else a lexicon
   score computed from recent headlines (always real, always free). ── */
const POS = ['beat', 'beats', 'surge', 'surges', 'soar', 'record', 'upgrade', 'upgraded', 'bullish', 'growth', 'rally', 'gain', 'gains', 'jump', 'jumps', 'strong', 'outperform', 'raise', 'raised', 'profit', 'wins', 'win', 'partnership', 'expand', 'expands', 'approve', 'approved', 'breakthrough', 'tops', 'top', 'buyback', 'dividend', 'high', 'higher', 'boost', 'positive'];
const NEG = ['miss', 'misses', 'plunge', 'plunges', 'fall', 'falls', 'drop', 'drops', 'downgrade', 'downgraded', 'bearish', 'loss', 'losses', 'lawsuit', 'probe', 'decline', 'declines', 'cut', 'cuts', 'weak', 'warn', 'warns', 'warning', 'recall', 'fraud', 'slump', 'crash', 'sink', 'sinks', 'fears', 'concern', 'concerns', 'slash', 'layoff', 'layoffs', 'halt', 'lower', 'negative', 'selloff', 'tumble'];
async function getSentiment(symbol) {
  symbol = symbol.toUpperCase();
  const fin = await finnhub.newsSentiment(symbol).catch(() => null);
  if (fin && fin.bullishPercent != null) return { bullishPercent: Math.round(fin.bullishPercent), articles: fin.buzz || null, source: 'finnhub' };
  // fallback: score recent headlines
  const items = await getNews(symbol).catch(() => []);
  let pos = 0, neg = 0;
  for (const it of items) { const t = (it.title || '').toLowerCase(); for (const w of POS) if (t.includes(w)) pos++; for (const w of NEG) if (t.includes(w)) neg++; }
  const tot = pos + neg;
  const bullishPercent = tot ? Math.round((pos / tot) * 100) : 50;
  return { bullishPercent, articles: items.length, pos, neg, source: items.length ? 'headlines' : 'none' };
}

/* ── SEC EDGAR filings ── */
let tickerMap = null;
let tickerMapAt = 0;
async function loadTickerMap() {
  if (tickerMap && Date.now() - tickerMapAt < 86400000) return tickerMap;
  const r = await fetch('https://www.sec.gov/files/company_tickers.json', {
    headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' },
  });
  if (!r.ok) throw new Error('SEC ticker map HTTP ' + r.status);
  const j = await r.json();
  const map = {};
  for (const o of Object.values(j)) map[String(o.ticker).toUpperCase()] = String(o.cik_str).padStart(10, '0');
  tickerMap = map; tickerMapAt = Date.now();
  return map;
}

async function getFilings(symbol) {
  symbol = symbol.toUpperCase();
  try {
    const map = await loadTickerMap();
    const cik = map[symbol];
    if (!cik) return [];
    const r = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
      headers: { 'User-Agent': SEC_UA, 'Accept': 'application/json' },
    });
    if (!r.ok) throw new Error('SEC submissions HTTP ' + r.status);
    const j = await r.json();
    const f = j.filings?.recent;
    if (!f) return [];
    const out = [];
    for (let i = 0; i < f.form.length && out.length < 15; i++) {
      const acc = (f.accessionNumber[i] || '').replace(/-/g, '');
      out.push({
        form: f.form[i],
        date: f.filingDate[i],
        desc: f.primaryDocDescription?.[i] || f.items?.[i] || formName(f.form[i]),
        link: acc
          ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc}/${f.primaryDocument[i] || ''}`
          : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${f.form[i]}`,
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

function formName(f) {
  const m = { '10-K': 'Annual report', '10-Q': 'Quarterly report', '8-K': 'Current report',
    '4': 'Insider transaction', 'DEF 14A': 'Proxy statement', 'S-1': 'Registration',
    'SC 13G': 'Beneficial ownership', '13F-HR': 'Institutional holdings' };
  return m[f] || 'SEC filing';
}

module.exports = { getNews, getFilings, getSentiment };
