# Deploy 24/7 (so alerts & the daily digest run without your PC)

This runs the backend on a small cloud server. Then your Telegram alerts and the
daily digest fire around the clock, and you can open the dashboard from any device.

Recommended host: **Render** (simple UI, free tier available).

---

## The honest tradeoff first

- **Render Free** is $0 but **spins the service down after ~15 min of inactivity**.
  A sleeping server can't check alerts — so for reliable 24/7 alerts you either:
  - add a free **keep-alive pinger** (Step 5 below), **or**
  - upgrade to **Render Starter ($7/mo)**, which never sleeps (recommended if you
    rely on the alerts).
- The free tier's disk is **ephemeral**: your alerts/watchlist reset on each
  redeploy. Setting `TELEGRAM_CHAT_ID` as an env var (below) means Telegram keeps
  working regardless. For durable alerts/watchlist across redeploys, use a paid
  plan with a persistent disk.

---

## Step 1 — Put the project on GitHub

1. Create a free account at https://github.com and click **New repository**
   (name it e.g. `stock-terminal`, keep it **Private**, don't add a README).
2. Upload the project: on the new repo page click **uploading an existing file**,
   then drag in the **contents** of your `stock-terminal` folder
   (server.js, package.json, render.yaml, the `services/` and `public/` folders,
   etc.). **Do NOT upload** `settings.txt`, `.env`, `node_modules/`, or `data/` —
   those hold secrets or are regenerated. Commit.

> Prefer the command line? From the `stock-terminal` folder:
> `git init && git add . && git commit -m "init" && git branch -M main`
> then add your GitHub remote and `git push -u origin main`.
> (A `.gitignore` is already included that excludes secrets and node_modules.)

## Step 2 — Create the service on Render

1. Sign up at https://render.com (log in with GitHub).
2. Click **New → Blueprint**, pick your repo. Render reads `render.yaml`
   and sets up the service automatically.
   - (No Blueprint? Use **New → Web Service** instead: Build `npm install`,
     Start `node server.js`, Health check path `/api/health`.)

## Step 3 — Fill in your keys (Environment)

When prompted (or under the service's **Environment** tab), set:

| Key | Value |
|---|---|
| `TWELVEDATA_API_KEY` | your Twelve Data key |
| `FINNHUB_API_KEY` | your Finnhub key |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `TELEGRAM_CHAT_ID` | `843423295` (your chat id — avoids re-detection) |
| `DIGEST_HOUR` | `8` (or blank to disable) |
| `TZ` | `Asia/Singapore` (so 8 = 8am your time) |
| `DASH_PASSWORD` | *(optional)* a password to protect the public URL |
| `SEC_USER_AGENT` | `Equity Analytics Terminal your-email@example.com` |

## Step 4 — Deploy

Click **Create / Deploy**. After a couple minutes you'll get a URL like
`https://equity-analytics-terminal.onrender.com`. Open it — that's your live
dashboard. (If you set `DASH_PASSWORD`, your browser asks for user `admin` +
that password.)

## Step 5 — Keep it awake (free tier only)

So the alert checker never sleeps:

1. Sign up free at https://uptimerobot.com.
2. **Add New Monitor** → type **HTTP(s)** → URL
   `https://YOUR-APP.onrender.com/api/health` → interval **5 minutes** → Save.

That steady ping keeps the service running so alerts and the 8am digest fire.
(On Render Starter/paid you can skip this — it never sleeps.)

---

## After deploying

- **Alerts & digest** now run in the cloud 24/7. You can close your PC.
- Open the dashboard from your **phone or any browser** at the Render URL.
- To update the app later: push changes to GitHub — Render redeploys automatically.
- You can keep running it locally too (`runme.bat`); both can coexist.

## Other hosts (if you prefer)

- **Fly.io** — free allowance, doesn't sleep, but needs the `flyctl` CLI + a
  Dockerfile. More setup, no keep-alive needed.
- **Railway** — very easy UI, but the free monthly credit is limited.

Ask if you'd like a Fly.io setup instead and I'll add the Dockerfile + fly.toml.
