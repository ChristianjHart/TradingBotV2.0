# TradingBot V2.0

AI market scanner & prediction dashboard. Same look and feel as the classic tradingbot UI — **new backend that never places trades**.

## What it does

- **Scanner bot** screens ~120 equities + crypto (hourly + daily context, relative strength, market regime) via OpenRouter, with a rule-based fallback
- **Trader bot** turns picks into **simulated** positions: ATR stops, slippage + fees, gap-aware fills, break-even / trailing stops, time exit, portfolio risk limits, daily-loss halt
- **Scores every pick** after its horizon and reports confidence calibration (`/api/performance`)
- Persists runs, positions, equity snapshots and picks to Supabase (optional) and restores them on boot
- Never places real orders. Alpaca is used for market data only

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

### Deploy on Render

1. Push this repo to GitHub.
2. In [Render](https://render.com) → **New** → **Blueprint** (uses `render.yaml`), or **Web Service** and point at the repo.
3. Settings if creating manually:
   - **Runtime:** Node
   - **Build:** `npm install`
   - **Start:** `npm start`
   - **Health check:** `/api/health`
4. Env vars (optional for a first mock-data test — defaults work):
   - `USE_MOCK_DATA=true` for a smoke test with no keys
   - Or set `ALPACA_API_KEY`, `ALPACA_API_SECRET`, and `USE_MOCK_DATA=false` for live scans

Render sets `PORT` automatically. Note: free instances sleep when idle, and the local `data/` store is **ephemeral** (resets on redeploy / disk wipe) unless you add a persistent disk.

### Alpaca (optional but recommended)

Add paper keys to `.env` (or Render env):

```
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
USE_MOCK_DATA=false
```

The app only uses Alpaca for **market data**. Order endpoints are never called.

## Security

Set `ADMIN_TOKEN` to require `Authorization: Bearer <token>` on mutating/costly endpoints (`POST /api/run`, `/scan`, `/evaluate`, `/train`, `/positions/*/close`, `/positions/close-all`, `/worker/*`, `PATCH /settings`). Unset = open (local use). `GET /api/auth/status` reports `{required}`. CORS is same-origin unless `CORS_ORIGIN` is set; `POST /api/run` is rate limited; settings are whitelisted and range-checked.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/run` | Start scanner → trader run (auth) |
| GET | `/api/run/status` | Progress of the current run |
| GET | `/api/runs?limit=20` | Persisted run history |
| GET | `/api/ai/summary` \| `/api/ai/picks` | Latest run summary / picks |
| GET | `/api/positions` | Account, open (with live P&L, `stale`) and closed positions |
| POST | `/api/positions/:id/close` \| `/api/positions/close-all` | Manual close (auth) |
| GET | `/api/performance` | Equity curve, win rate, avg R, drawdown, calibration, per-bot stats |
| GET | `/api/status` | Worker, settings, `marketOpen`, `staleSymbols`, data mode |
| PATCH | `/api/settings` | Slippage/fees/risk limits/horizon (auth) |
| GET | `/api/health` \| `/api/auth/status` | Public |

Legacy endpoints (`/dashboard`, `/watchlist`, `/predictions`, `/accuracy`, `/model`) still respond, now derived from scanner picks; `/scan` starts a run and `/train` is a no-op.

## Tests & maintenance

```bash
npm test            # node:test unit tests (CI runs these + syntax checks)
npm run prune       # delete Supabase log rows older than 14 days (-- --days N)
```

Run `supabase/migrations/001_init.sql` then `002_runs.sql` (runs, equity snapshots, pick scores, `prune_logs()`).

## Stack

- Node.js + Express
- File-backed JSON store in `data/`
- Vanilla SPA frontend matching the classic dark tradingbot chrome
- `node-cron` for periodic scan + evaluate cycles

## AI run (OpenRouter)

Press **RUN** on the dashboard:

1. **Scanner bot** (`SCANNER_MODEL`, default `deepseek/deepseek-v3.1-terminus`) screens ~120 stocks/ETFs/crypto and returns the top 100 as JSON `{symbol, direction, confidence, reason}` → shown in *AI TOP 100 PICKS*.
2. **Trader bot** (`TRADER_MODEL`, default `deepseek/deepseek-chat-v3.1`) reviews those picks and opens up to 10 **simulated** positions, each with an allocation, stop-loss and take-profit (risk-capped server-side). They appear under *OPEN POSITIONS* with entry/stop/target lines on the chart. Stops/targets are checked every 5 minutes.

Set `OPENROUTER_API_KEY` to enable the models; without it the same flow runs on the built-in rule-based scorer. No real orders are ever placed.
