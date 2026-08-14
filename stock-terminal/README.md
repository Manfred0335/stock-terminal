# Equity Analytics Terminal

A real-time stock analysis dashboard with **live market data**, technical indicators,
candlestick charts with drawing tools, financial statements, an AI-style price-target
model, a portfolio tracker, **Telegram price alerts**, and **SEC EDGAR filings** — served
by a small Node.js backend.

Market data (quotes, historical candles, fundamentals, news) comes from Yahoo Finance via
[`yahoo-finance2`](https://github.com/gadicc/node-yahoo-finance2) and requires **no API key**.

---

## Quick start

You need **Node.js 18 or newer** (for built-in `fetch`). Check with `node -v`.

```bash
# 1. install dependencies
npm install

# 2. (optional) set up config — only needed for Telegram alerts / SEC contact
cp .env.example .env      # then edit .env

# 3. run
npm start
```

Then open **http://localhost:3000** in your browser. That's it — you'll see live prices.

> Always open the **served URL** (`http://localhost:3000`), not the `index.html` file
> directly. Opening the file on its own has no backend to talk to, so it falls back to
> *simulated* data (the header badge will read **● SIM** instead of **● LIVE**).

---

## What's live vs. what to know

| Feature | Source |
|---|---|
| Quotes: price, change, day/52-wk range, volume, market cap, P/E, EPS, beta, bid/ask | Yahoo Finance (real) |
| Candles: 1D intraday + 1W/1M/3M/1Y/ALL + custom range | Yahoo Finance (real) |
| Fundamentals: income statement, balance sheet, cash flow, ratios, EPS estimates, analyst target | Yahoo Finance (real) |
| Indexes tab (S&P 500, Nasdaq, STI, Nikkei, DAX, FTSE, VOO, QQQ, …) | Yahoo Finance (real) |
| News headlines | Yahoo Finance (real, links out) |
| SEC filings (10-K, 10-Q, 8-K, Form 4, …) | SEC EDGAR (real, links out) |
| Price / volume alerts → Telegram | Real, server-monitored (see below) |
| Technical indicators (RSI, MACD, MAs, Bollinger, volume profile, support/resistance) | Computed locally from real candles |
| Price-target model (bull/base/bear) | My own model, built on the real fundamentals |
| Portfolio tracker | Local (positions you enter); priced with live quotes |

The **price-target model** is a heuristic (forward EPS × a fair P/E, blended with the
analyst mean) — it is clearly labeled and is **not investment advice**.

---

## Telegram price alerts

Alerts are checked **on the server**, so they keep working while your browser is closed
(as long as `npm start` is running).

1. In Telegram, message **@BotFather** → `/newbot` → copy the **bot token**.
2. Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy your **chat id**
   (the number under `"chat":{"id": … }`).
3. Put the token in `.env` as `TELEGRAM_BOT_TOKEN=…` and restart the server.
   (The **chat id** can go in `.env` too, or you can set it from the dashboard's
   **Alerts** tab.)
4. Create alerts in the **Alerts** tab. When price crosses your level (or volume spikes),
   you'll get a Telegram message.

Alert checks run every `ALERT_INTERVAL_SECONDS` (default 45s). Alerts persist to
`data/alerts.json`, so they survive restarts.

---

## SEC filings

SEC EDGAR asks that requests identify you with a real contact email in the `User-Agent`.
Set `SEC_USER_AGENT` in `.env`, e.g.:

```
SEC_USER_AGENT=Equity Analytics Terminal jane@example.com
```

Requests without a proper UA may be throttled or blocked by the SEC.

---

## Project layout

```
stock-terminal/
├─ server.js              Express app: REST API + serves the dashboard
├─ services/
│  ├─ market.js           Yahoo Finance: quotes, candles, fundamentals
│  ├─ news.js             Yahoo news + SEC EDGAR filings
│  ├─ alerts.js           Alert store + background checker
│  └─ telegram.js         Telegram delivery (native fetch)
├─ public/
│  └─ index.html          The dashboard (single-file frontend)
├─ data/                  Runtime state (alerts.json, config.json) — auto-created
├─ .env.example           Copy to .env
└─ package.json
```

## API endpoints

```
GET  /api/quote/:symbol
GET  /api/candles/:symbol?range=1D|1W|1M|3M|1Y|3Y|MAX
GET  /api/fundamentals/:symbol
GET  /api/news/:symbol
GET  /api/filings/:symbol
GET  /api/alerts        POST /api/alerts        DELETE /api/alerts/:id
GET  /api/telegram      POST /api/telegram
GET  /api/health
```

---

## Troubleshooting

- **Badge says ● SIM / no live prices** — you opened `index.html` directly, or the server
  isn't running. Run `npm start` and open `http://localhost:3000`.
- **A ticker shows no data** — Yahoo may not cover that exact symbol; try the canonical
  ticker (e.g. `BRK-B`, `GOOGL`). Non-US tickers often need a suffix (e.g. `D05.SI`).
- **Filings empty** — set a real `SEC_USER_AGENT` email in `.env`.
- **Telegram not sending** — confirm the bot token and that you messaged the bot first;
  check the server console for `[alert]` lines.
- **Rate limiting** — Yahoo is an unofficial data source; the server caches responses, but
  heavy use can still get throttled. This tool is for **personal, non-commercial** use.

## Disclaimer

For educational and personal use only. Data is provided by third parties (Yahoo Finance,
SEC EDGAR) and may be delayed or inaccurate. Nothing here is investment advice.
