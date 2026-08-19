/* =====================================================================
   Equity Analytics Terminal — Express API + static dashboard
   Real market data via yahoo-finance2 (no API key required).
   ===================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');

// ── minimal .env loader (avoids a dotenv dependency) ──────────────────
(function loadEnv() {
  for (const name of ['.env', 'settings.txt']) { // settings.txt is an alias for .env
    const p = path.join(__dirname, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const market = require('./services/market');
const news = require('./services/news');
const alerts = require('./services/alerts');
const finnhub = require('./services/finnhub');

// Indices mapped to US-listed ETF proxies (all covered by Finnhub's free tier).
const INDEX_LIST = [
  { sym: '^GSPC', name: 'S&P 500', region: 'US', proxy: 'SPY' },
  { sym: '^IXIC', name: 'Nasdaq 100', region: 'US', proxy: 'QQQ' },
  { sym: '^DJI', name: 'Dow Jones', region: 'US', proxy: 'DIA' },
  { sym: 'VOO', name: 'Vanguard S&P 500', region: 'US', proxy: 'VOO' },
  { sym: 'VTI', name: 'Vanguard Total US', region: 'US', proxy: 'VTI' },
  { sym: 'IWM', name: 'Russell 2000', region: 'US', proxy: 'IWM' },
  { sym: '^STI', name: 'Straits Times (SG)', region: 'Asia', proxy: 'EWS' },
  { sym: '^N225', name: 'Nikkei / Japan', region: 'Asia', proxy: 'EWJ' },
  { sym: '^HSI', name: 'Hang Seng / HK', region: 'Asia', proxy: 'EWH' },
  { sym: '^KS11', name: 'KOSPI / Korea', region: 'Asia', proxy: 'EWY' },
  { sym: '^FTSE', name: 'FTSE 100 / UK', region: 'Europe', proxy: 'EWU' },
  { sym: '^GDAXI', name: 'DAX / Germany', region: 'Europe', proxy: 'EWG' },
  { sym: '^FCHI', name: 'CAC 40 / France', region: 'Europe', proxy: 'EWQ' },
  { sym: '^STOXX50E', name: 'Euro Stoxx 50', region: 'Europe', proxy: 'FEZ' },
  { sym: 'VT', name: 'Vanguard Total World', region: 'Global', proxy: 'VT' },
  { sym: 'EEM', name: 'iShares Emerging Mkts', region: 'Global', proxy: 'EEM' },
  { sym: 'ACWI', name: 'iShares MSCI ACWI', region: 'Global', proxy: 'ACWI' },
  { sym: 'VXUS', name: 'Vanguard ex-US', region: 'Global', proxy: 'VXUS' },
];

const app = express();
app.use(express.json());

// Optional password protection for public deployments. Set DASH_PASSWORD
// (and optionally DASH_USER) as an env var to require HTTP Basic auth.
const DASH_USER = process.env.DASH_USER || 'admin';
const DASH_PASSWORD = process.env.DASH_PASSWORD || '';
if (DASH_PASSWORD) {
  app.use((req, res, next) => {
    if (req.path === '/api/health') return next(); // health check + keep-alive pings stay open
    const [, b64] = (req.headers.authorization || '').split(' ');
    const [u, p] = Buffer.from(b64 || '', 'base64').toString().split(':');
    if (u === DASH_USER && p === DASH_PASSWORD) return next();
    res.set('WWW-Authenticate', 'Basic realm="Equity Analytics"').status(401).send('Authentication required');
  });
  console.log('  ▸ Dashboard password protection: ON');
}

app.use(express.static(path.join(__dirname, 'public')));

// tiny async wrapper so route errors become clean JSON 500s
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[api] ${req.method} ${req.path} →`, err.message);
  res.status(502).json({ error: err.message || 'upstream error' });
});

// ── Market data ───────────────────────────────────────────────────────
app.get('/api/quote/:symbol', wrap(async (req, res) => {
  res.json(await market.getQuote(req.params.symbol));
}));

app.get('/api/candles/:symbol', wrap(async (req, res) => {
  const range = (req.query.range || '1Y').toUpperCase();
  res.json(await market.getCandles(req.params.symbol, range));
}));

app.get('/api/fundamentals/:symbol', wrap(async (req, res) => {
  res.json(await market.getFundamentals(req.params.symbol));
}));

// Indexes (via Finnhub ETF proxies). Falls back to nulls if no key.
app.get('/api/indexes', wrap(async (req, res) => {
  res.json(await finnhub.indexQuotes(INDEX_LIST));
}));

// Batch quotes for the watchlist (Finnhub, 60/min) — keeps every ticker fresh.
app.get('/api/watchquotes', wrap(async (req, res) => {
  const syms = String(req.query.symbols || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);
  const out = {};
  await Promise.all(syms.map(async (s) => { try { const q = await finnhub.quote(s); out[s] = { price: q.price, prevClose: q.prevClose, changePct: q.changePct }; } catch (e) { out[s] = null; } }));
  res.json(out);
}));

// Earnings countdown, analyst recommendation trend, insider transactions.
app.get('/api/earnings/:symbol', wrap(async (req, res) => res.json(await finnhub.earnings(req.params.symbol))));
app.get('/api/earnings-report/:symbol', wrap(async (req, res) => res.json(await finnhub.earningsReport(req.params.symbol))));
app.get('/api/recommendations/:symbol', wrap(async (req, res) => res.json(await finnhub.recommendations(req.params.symbol))));
app.get('/api/insiders/:symbol', wrap(async (req, res) => res.json(await finnhub.insiders(req.params.symbol))));
// Fast Finnhub-only key metrics (margins, ROE, FCF, growth) for the AI ranking —
// avoids the Yahoo-gated /api/fundamentals path that rate-limits on some IPs.
app.get('/api/metrics/:symbol', wrap(async (req, res) => res.json(await finnhub.metrics(req.params.symbol))));
app.get('/api/sentiment/:symbol', wrap(async (req, res) => res.json(await news.getSentiment(req.params.symbol))));
app.get('/api/peers/:symbol', wrap(async (req, res) => res.json(await finnhub.peers(req.params.symbol))));

// Peer group key metrics for relative (percentile) scoring. The stock itself is
// included as the first entry. Metrics are Finnhub-cached, so this is cheap.
const _peerMetCache = new Map();
app.get('/api/peer-metrics/:symbol', wrap(async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const hit = _peerMetCache.get(sym);
  if (hit && Date.now() - hit.t < 3600000) return res.json(hit.v);
  let peers = [];
  try { peers = await finnhub.peers(sym); } catch (e) {}
  const syms = [sym, ...peers.filter((p) => p && p.toUpperCase() !== sym)].slice(0, 12);
  const group = (await Promise.all(syms.map(async (s) => {
    try { const m = await finnhub.metrics(s); return { sym: s, pe: m.pe, priceToBook: m.priceToBook, peg: m.peg, fcfYield: m.fcfYield, netMargin: m.netMargin, roe: m.roe, grossMargin: m.grossMargin, operatingMargin: m.operatingMargin, revenueGrowth: m.revenueGrowth }; }
    catch (e) { return null; }
  }))).filter(Boolean);
  const v = { symbol: sym, group };
  _peerMetCache.set(sym, { t: Date.now(), v });
  res.json(v);
}));
app.get('/api/economic', wrap(async (req, res) => res.json(await finnhub.economicCalendar())));

// Sector performance via the 11 SPDR sector ETFs (Finnhub quotes, 60/min).
const SECTORS = [
  { name: 'Technology', etf: 'XLK' }, { name: 'Financials', etf: 'XLF' }, { name: 'Health Care', etf: 'XLV' },
  { name: 'Energy', etf: 'XLE' }, { name: 'Industrials', etf: 'XLI' }, { name: 'Consumer Discretionary', etf: 'XLY' },
  { name: 'Consumer Staples', etf: 'XLP' }, { name: 'Utilities', etf: 'XLU' }, { name: 'Materials', etf: 'XLB' },
  { name: 'Real Estate', etf: 'XLRE' }, { name: 'Communication Svcs', etf: 'XLC' },
];
let _sectorCache = { t: 0, v: null };
app.get('/api/sectors', wrap(async (req, res) => {
  const now = Date.now();
  if (_sectorCache.v && now - _sectorCache.t < 30000) return res.json(_sectorCache.v);
  const out = await Promise.all(SECTORS.map(async (s) => {
    try { const q = await finnhub.quote(s.etf); return { ...s, price: q.price, changePct: q.changePct, prevClose: q.prevClose }; }
    catch (e) { return { ...s, price: null, changePct: null }; }
  }));
  _sectorCache = { t: now, v: out };
  res.json(out);
}));

// Top constituents per sector for a finviz-style heatmap. Ranked biggest→smallest
// so the frontend can size tiles by weight. Quotes via Finnhub (cached 90s).
const SECTOR_MEMBERS = {
  Technology: ['AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM'],
  Financials: ['BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC'],
  'Health Care': ['LLY', 'UNH', 'JNJ', 'ABBV', 'MRK'],
  Energy: ['XOM', 'CVX', 'COP', 'SLB', 'EOG'],
  Industrials: ['GE', 'CAT', 'RTX', 'HON', 'UNP'],
  'Consumer Discretionary': ['AMZN', 'TSLA', 'HD', 'MCD', 'NKE'],
  'Consumer Staples': ['PG', 'COST', 'KO', 'PEP', 'WMT'],
  Utilities: ['NEE', 'DUK', 'SO', 'CEG'],
  Materials: ['LIN', 'SHW', 'FCX', 'APD'],
  'Real Estate': ['PLD', 'AMT', 'EQIX', 'WELL'],
  'Communication Svcs': ['META', 'GOOGL', 'NFLX', 'DIS', 'TMUS'],
};
let _heatCache = { t: 0, v: null };
app.get('/api/sector-heatmap', wrap(async (req, res) => {
  const now = Date.now();
  if (_heatCache.v && now - _heatCache.t < 90000) return res.json(_heatCache.v);
  const jobs = [];
  for (const s of SECTORS) for (const sym of (SECTOR_MEMBERS[s.name] || [])) jobs.push({ sector: s.name, etf: s.etf, sym });
  const quotes = {};
  const queue = [...jobs];
  async function worker() {
    while (queue.length) {
      const j = queue.shift();
      try { const q = await finnhub.quote(j.sym); quotes[j.sym] = { price: q.price, changePct: q.changePct }; }
      catch (e) { quotes[j.sym] = null; }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker(), worker()]);
  const out = SECTORS.map((s) => ({
    name: s.name, etf: s.etf,
    companies: (SECTOR_MEMBERS[s.name] || []).map((sym) => ({ sym, changePct: quotes[sym] ? quotes[sym].changePct : null, price: quotes[sym] ? quotes[sym].price : null })),
  }));
  _heatCache = { t: now, v: out };
  res.json(out);
}));

// ── Screener universe ──────────────────────────────────────────────────
// A curated large/mid-cap universe. We assemble quote + key metrics for each
// (both Finnhub-cached — metrics 1h, quotes 15s) so filtering happens client
// side. The whole list is cached 60s; a cold load may return partial rows if
// the 60/min Finnhub budget is hit, and fills in on the next open.
const UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'AVGO', 'ORCL', 'AMD', 'CRM', 'ADBE', 'NFLX', 'INTC', 'QCOM', 'JPM', 'BAC', 'V', 'MA', 'WMT', 'COST', 'KO', 'PEP', 'XOM', 'CVX', 'JNJ', 'UNH', 'DIS', 'HD', 'CAT', 'BA', 'PFE'];
let _univCache = { t: 0, v: null };
app.get('/api/universe', wrap(async (req, res) => {
  const now = Date.now();
  if (_univCache.v && now - _univCache.t < 60000) return res.json(_univCache.v);
  const out = [];
  const queue = [...UNIVERSE];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      try {
        const [q, m] = await Promise.all([finnhub.quote(s).catch(() => null), finnhub.metrics(s).catch(() => ({}))]);
        if (q && q.price) out.push({ symbol: s, name: (m && m.name) || s, sector: (m && m.sector) || '—', price: q.price, changePct: q.changePct, marketCap: (m && m.marketCap) || null, pe: (m && m.pe) || null, eps: (m && m.eps) || null, divYield: (m && m.divYield) || null, beta: (m && m.beta) || null, high52: (m && m.high52) || null, low52: (m && m.low52) || null });
      } catch (e) {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  out.sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0));
  _univCache = { t: now, v: out };
  res.json(out);
}));

// Persisted UI state (watchlist + portfolio) so they survive restarts.
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const slog = (m) => { try { fs.appendFileSync(path.join(__dirname, 'debug.log'), new Date().toISOString() + '  [state] ' + m + '\n'); } catch (e) {} };
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; } }
// Returns true on success, false (and logs the real error) on failure — so a
// silent write failure (e.g. Windows Controlled Folder Access blocking a new
// file) is visible in debug.log and reported to the browser instead of a fake OK.
function writeState(s) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
    fs.renameSync(tmp, STATE_FILE); // atomic-ish; avoids half-written files
    return true;
  } catch (e) {
    slog('WRITE FAILED at ' + STATE_FILE + ' → ' + (e && (e.code || e.message)));
    // last resort: try a direct write (some sync tools block rename but allow create)
    try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); slog('direct write succeeded'); return true; }
    catch (e2) { slog('direct write ALSO FAILED → ' + (e2 && (e2.code || e2.message))); return false; }
  }
}
// Create the file once at startup so later saves only ever *overwrite* it
// (overwriting an existing file is permitted even where creating a new one is not).
(function ensureStateFile() {
  if (!fs.existsSync(STATE_FILE)) { const ok = writeState(readState()); slog(ok ? 'startup: created state.json' : 'startup: could NOT create state.json — check folder permissions / OneDrive / antivirus'); }
  else slog('startup: state.json present');
})();
app.get('/api/state', (req, res) => res.json(readState()));
app.post('/api/state', (req, res) => {
  const { watchlist, portfolio, prefs, groups, activeGroup } = req.body || {}; const cur = readState();
  if (Array.isArray(watchlist)) cur.watchlist = watchlist; // kept in sync = active group (the digest reads this)
  if (Array.isArray(portfolio)) cur.portfolio = portfolio;
  if (prefs && typeof prefs === 'object') cur.prefs = prefs;
  if (groups && typeof groups === 'object') cur.groups = groups;
  if (typeof activeGroup === 'string') cur.activeGroup = activeGroup;
  const ok = writeState(cur); res.json({ ok });
});

// ── News + SEC filings ─────────────────────────────────────────────────
app.get('/api/news/:symbol', wrap(async (req, res) => {
  res.json(await news.getNews(req.params.symbol));
}));

app.get('/api/filings/:symbol', wrap(async (req, res) => {
  res.json(await news.getFilings(req.params.symbol));
}));

// ── Alerts ─────────────────────────────────────────────────────────────
app.get('/api/alerts', (req, res) => res.json(alerts.list()));

app.post('/api/alerts', (req, res) => {
  const { symbol, cond, value } = req.body || {};
  const NO_VALUE = ['high52_break', 'low52_break'];
  if (!symbol || !cond) return res.status(400).json({ error: 'symbol and cond required' });
  if (value == null && !NO_VALUE.includes(cond)) return res.status(400).json({ error: 'value required for this condition' });
  res.json(alerts.add({ symbol: String(symbol).toUpperCase(), cond, value: value == null ? null : Number(value) }));
});

app.patch('/api/alerts/:id', (req, res) => {
  const a = alerts.update(req.params.id, req.body || {});
  if (!a) return res.status(404).json({ error: 'alert not found' });
  res.json(a);
});

app.delete('/api/alerts/:id', (req, res) => { alerts.remove(req.params.id); res.json({ ok: true }); });

app.get('/api/telegram', (req, res) => res.json(alerts.getTelegram()));
app.post('/api/telegram', (req, res) => {
  const { chatId, botToken } = req.body || {};
  res.json(alerts.setTelegram({ chatId, botToken }));
});
app.post('/api/telegram/detect', wrap(async (req, res) => { res.json(await alerts.detectTelegram()); }));

// health
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  ▸ Equity Analytics Terminal running`);
  console.log(`  ▸ Open  http://localhost:${PORT}\n`);
  try { fs.appendFileSync(path.join(__dirname, 'debug.log'), `${new Date().toISOString()}  SERVER STARTED build=stooq-fallback+diag\n`); } catch (e) {}
  alerts.startChecker(market); // background price/volume alert loop → Telegram
});
