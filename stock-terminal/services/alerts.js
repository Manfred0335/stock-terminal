/* =====================================================================
   Alert engine — persisted store + background checker → Telegram.
   Conditions: price above / price below / volume spike above.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const telegram = require('./telegram');
const finnhub = require('./finnhub');

// indicator helpers (computed from a close-price array)
function sma(arr, p) { if (arr.length < p) return null; let s = 0; for (let i = arr.length - p; i < arr.length; i++) s += arr[i]; return s / p; }
function rsi(arr, p = 14) { if (arr.length < p + 1) return null; let g = 0, l = 0; for (let i = arr.length - p; i < arr.length; i++) { const ch = arr[i] - arr[i - 1]; if (ch >= 0) g += ch; else l -= ch; } g /= p; l /= p; return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
const INDICATOR_CONDS = ['rsi_below', 'rsi_above', 'ma_above', 'ma_below'];
function alertLabel(a) {
  switch (a.cond) {
    case 'above': return `rose above $${a.value}`;
    case 'below': return `fell below $${a.value}`;
    case 'volspike': return `volume spiked above ${Number(a.value).toLocaleString()}`;
    case 'rsi_below': return `RSI(14) fell below ${a.value}`;
    case 'rsi_above': return `RSI(14) rose above ${a.value}`;
    case 'ma_above': return `price crossed above MA${a.value || 50}`;
    case 'ma_below': return `price crossed below MA${a.value || 50}`;
    case 'high52_break': return `broke to a new 52-week high`;
    case 'low52_break': return `broke to a new 52-week low`;
    case 'gap_up': return `gapped up ${a.value}%+ at the open`;
    case 'gap_down': return `gapped down ${a.value}%+ at the open`;
    case 'earnings_in': return `reports earnings within ${a.value} day(s)`;
    default: return 'condition met';
  }
}

const DATA_DIR = path.join(__dirname, '..', 'data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const dbg = (m) => { try { fs.appendFileSync(path.join(__dirname, '..', 'debug.log'), new Date().toISOString() + '  [telegram] ' + m + '\n'); } catch (e) {} };

function ensure() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; } }
function writeJSON(file, val) { ensure(); fs.writeFileSync(file, JSON.stringify(val, null, 2)); }

let alerts = readJSON(ALERTS_FILE, []);
let config = readJSON(CONFIG_FILE, {
  chatId: process.env.TELEGRAM_CHAT_ID || '',
  botToken: process.env.TELEGRAM_BOT_TOKEN || '',
});

function persist() { writeJSON(ALERTS_FILE, alerts); }
function persistConfig() { writeJSON(CONFIG_FILE, config); }

function list() { return alerts; }

function add({ symbol, cond, value }) {
  const a = { id: 'a' + Date.now() + Math.floor(Math.random() * 1000), symbol, cond, value: value == null ? null : Number(value), fired: false, createdAt: Date.now() };
  alerts.push(a); persist(); return a;
}
function remove(id) { alerts = alerts.filter((a) => a.id !== id); persist(); }

/* Edit / snooze / re-arm an existing alert. patch may include:
   value (new threshold), cond, rearm (clear fired+snooze), snoozeMinutes. */
function update(id, patch) {
  const a = alerts.find((x) => x.id === id);
  if (!a) return null;
  patch = patch || {};
  if (patch.value != null && patch.value !== '') a.value = Number(patch.value);
  if (patch.cond) a.cond = patch.cond;
  if (patch.rearm) { a.fired = false; delete a.firedAt; delete a.firedPrice; delete a.snoozedUntil; }
  if (patch.snoozeMinutes) { a.snoozedUntil = Date.now() + Number(patch.snoozeMinutes) * 60000; a.fired = false; }
  persist(); return a;
}

function getTelegram() { return { chatId: config.chatId || '', configured: !!(config.botToken && config.chatId) }; }
function setTelegram({ chatId, botToken }) {
  if (chatId != null) config.chatId = String(chatId).trim();
  if (botToken) config.botToken = String(botToken).trim(); // token via env is preferred; UI can override
  persistConfig();
  return getTelegram();
}

/* On-demand Telegram chat-id detection (called from the dashboard). */
async function detectTelegram() {
  if (!config.botToken) return { ok: false, reason: 'No bot token set in settings.txt' };
  if (!config.chatId) {
    const id = await telegram.detectChatId(config.botToken);
    if (!id) return { ok: false, reason: 'No message found — send your bot any message first, then try again.' };
    config.chatId = id; persistConfig(); dbg('auto-detected chat id ' + id);
  }
  // send a test/confirmation and surface any error
  try {
    await telegram.sendMessage(config.botToken, config.chatId, '✅ Equity Analytics Terminal connected. Price/volume alerts will arrive here.');
    dbg('confirmation sent OK to ' + config.chatId);
    return { ok: true, chatId: config.chatId };
  } catch (e) {
    dbg('confirmation send FAILED to ' + config.chatId + ': ' + (e && e.message));
    return { ok: false, chatId: config.chatId, reason: 'Telegram send failed: ' + (e && e.message) };
  }
}

/* Background loop: re-check armed alerts against live quotes. */
function startChecker(market) {
  const secs = Math.max(15, parseInt(process.env.ALERT_INTERVAL_SECONDS || '45', 10));
  // On startup: log Telegram config state, and if the token+chat are set, send
  // a "connected" ping so you know it works (logs the result either way).
  dbg('startup: botToken=' + (config.botToken ? 'SET' : 'MISSING') + ' chatId=' + (config.chatId || 'NONE'));
  if (config.botToken && config.chatId) {
    telegram.sendMessage(config.botToken, config.chatId, '✅ Equity Analytics Terminal started — Telegram alerts are active.')
      .then(() => dbg('startup ping sent OK to ' + config.chatId))
      .catch((e) => dbg('startup ping FAILED to ' + config.chatId + ': ' + (e && e.message)));
  }
  const run = async () => {
    // Keep trying to auto-detect the Telegram chat id (so messaging the bot
    // connects it within one cycle — no restart needed).
    if (config.botToken && !config.chatId) {
      const id = await telegram.detectChatId(config.botToken);
      if (id) {
        config.chatId = id; persistConfig(); dbg('auto-detected chat id ' + id);
        telegram.sendMessage(config.botToken, id, '✅ Equity Analytics Terminal connected. Price/volume alerts will arrive here.')
          .then(() => dbg('confirmation sent OK to ' + id))
          .catch((e) => dbg('confirmation send FAILED to ' + id + ': ' + (e && e.message)));
      }
    }
    await maybeDigest(market);
    const now0 = Date.now();
    const armed = alerts.filter((a) => !a.fired && !(a.snoozedUntil && now0 < a.snoozedUntil));
    const symbols = [...new Set(armed.map((a) => a.symbol))];
    const FH_CONDS = ['gap_up', 'gap_down', 'high52_break', 'low52_break'];
    for (const sym of symbols) {
      let q;
      try { q = await market.getQuote(sym); } catch (_) { continue; }
      const symAlerts = armed.filter((x) => x.symbol === sym);
      let closes = null; // computed lazily if an indicator alert needs it
      if (symAlerts.some((a) => INDICATOR_CONDS.includes(a.cond))) {
        try { const c = await market.getCandles(sym, '1Y'); closes = c.map((b) => b.c); } catch (_) {}
      }
      // Finnhub-sourced extras (open/prevClose for gaps, 52wk levels, earnings date)
      let fq = null, met = null, earn = null;
      if (finnhub.hasKey()) {
        if (symAlerts.some((a) => FH_CONDS.includes(a.cond))) {
          try { fq = await finnhub.quote(sym); } catch (_) {}
          if (symAlerts.some((a) => a.cond === 'high52_break' || a.cond === 'low52_break')) { try { met = await finnhub.metrics(sym); } catch (_) {} }
        }
        if (symAlerts.some((a) => a.cond === 'earnings_in')) { try { earn = await finnhub.earnings(sym); } catch (_) {} }
      }
      const gapPct = (fq && fq.open && fq.prevClose) ? (fq.open - fq.prevClose) / fq.prevClose * 100 : null;
      for (const a of symAlerts) {
        let hit = false;
        if (a.cond === 'above') hit = q.price >= a.value;
        else if (a.cond === 'below') hit = q.price <= a.value;
        else if (a.cond === 'volspike') hit = q.volume >= a.value;
        else if (a.cond === 'gap_up') hit = gapPct != null && gapPct >= Math.abs(a.value || 0);
        else if (a.cond === 'gap_down') hit = gapPct != null && gapPct <= -Math.abs(a.value || 0);
        else if (a.cond === 'high52_break') { const h = met && met.high52; hit = h != null && q.price >= h; }
        else if (a.cond === 'low52_break') { const l = met && met.low52; hit = l != null && q.price <= l; }
        else if (a.cond === 'earnings_in') { hit = earn && earn.daysUntil != null && earn.daysUntil >= 0 && earn.daysUntil <= (a.value || 0); }
        else if (closes) {
          if (a.cond === 'rsi_below') { const r = rsi(closes); hit = r != null && r < a.value; }
          else if (a.cond === 'rsi_above') { const r = rsi(closes); hit = r != null && r > a.value; }
          else if (a.cond === 'ma_above') { const m = sma(closes, a.value || 50); hit = m != null && q.price >= m; }
          else if (a.cond === 'ma_below') { const m = sma(closes, a.value || 50); hit = m != null && q.price <= m; }
        }
        if (!hit) continue;
        a.fired = true; a.firedAt = Date.now(); a.firedPrice = q.price; persist();
        const label = alertLabel(a);
        const msg = `🔔 <b>${sym}</b> alert\n${q.name}\n${label}\nNow: <b>$${q.price}</b> (${q.changePct >= 0 ? '+' : ''}${(q.changePct || 0).toFixed(2)}%)`;
        if (config.botToken && config.chatId) {
          telegram.sendMessage(config.botToken, config.chatId, msg)
            .then(() => dbg(`alert sent for ${sym}`))
            .catch((e) => dbg(`alert send FAILED for ${sym}: ${e && e.message}`));
        } else {
          dbg(`${sym} ${label} @ $${q.price} (Telegram not configured)`);
        }
      }
    }
  };
  setInterval(run, secs * 1000);
  console.log(`  ▸ Alert checker running every ${secs}s` + (config.botToken && config.chatId ? ' (Telegram armed)' : ' (Telegram not configured yet)'));
}

/* Daily watchlist digest to Telegram. Enabled by setting DIGEST_HOUR (0-23,
   local time) in settings.txt; sends once per day at that hour. */
let digestBusy = false;
async function maybeDigest(market) {
  if (!config.botToken || !config.chatId) return;
  const hour = parseInt(process.env.DIGEST_HOUR ?? '', 10);
  if (isNaN(hour)) return; // disabled unless DIGEST_HOUR is set
  const now = new Date();
  const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  if (now.getHours() !== hour || config.lastDigest === today || digestBusy) return;
  digestBusy = true; config.lastDigest = today; persistConfig();
  try {
    let wl = [];
    try { wl = (JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'state.json'), 'utf8')).watchlist) || []; } catch (e) {}
    if (!wl.length) wl = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'TSLA', 'AMZN'];
    const lines = [];
    for (const s of wl.slice(0, 12)) {
      try {
        let px, p;
        if (finnhub.hasKey()) { const fq = await finnhub.quote(s); px = fq.price; p = fq.changePct; }
        else { const q = await market.getQuote(s); px = q.price; p = q.changePct; }
        lines.push(`${(p || 0) >= 0 ? '🟢' : '🔴'} <b>${s}</b>  $${px}  ${(p || 0) >= 0 ? '+' : ''}${(p || 0).toFixed(2)}%`);
      } catch (e) {}
    }
    await telegram.sendMessage(config.botToken, config.chatId, `📊 <b>Daily Watchlist Digest</b> · ${today}\n\n${lines.join('\n') || 'No data'}`);
    dbg('digest sent for ' + today);
  } catch (e) { dbg('digest failed: ' + (e && e.message)); }
  finally { digestBusy = false; }
}

module.exports = { list, add, update, remove, getTelegram, setTelegram, detectTelegram, startChecker };
