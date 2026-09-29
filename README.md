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
4. `render.yaml` already sets `NODE_VERSION=22`, `TRUST_PROXY=true` and generates `APP_SECRET` for you and declares the secrets (`SIGNUP_CODE`, `ADMIN_TOKEN`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) as `sync: false`, so Render asks you for them. **Set `SIGNUP_CODE`** (see *Account login* below) so only you can create the owner account; once an account exists the whole API requires login. Run `supabase/migrations/003_users.sql` if you use Supabase so the account survives redeploys.
5. Env vars (optional for a first mock-data test — defaults work):
   - `USE_MOCK_DATA=true` for a smoke test with no keys
   - Or set `ALPACA_API_KEY`, `ALPACA_API_SECRET`, and `USE_MOCK_DATA=false` for live scans

Render sets `PORT` automatically. Set `TRUST_PROXY=true` on any reverse-proxied host (already in `render.yaml`). Note: free instances sleep when idle, and the local `data/` store is **ephemeral** (resets on redeploy / disk wipe) unless you add a persistent disk.

### Alpaca (optional but recommended)

Add paper keys to `.env` (or Render env):

```
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
USE_MOCK_DATA=false
```

The app only uses Alpaca for **market data**. Order endpoints are never called.

## Security

### Account login and API keys

The app is **single-tenant**: one shared dataset and one **owner** account. Flow:

1. Set `SIGNUP_CODE` (any secret string; falls back to `ADMIN_TOKEN`) and `APP_SECRET` (a long random string; `render.yaml` generates it) on the server.
2. Open the site. It shows the create-account screen: enter email, a password (10+ characters, not a common one) and the sign-up code. You are signed in with an `HttpOnly` `tb_session` cookie (14 days).
3. Under **Settings → Account** add your OpenRouter key and Alpaca key/secret (and optionally model names). They are stored **encrypted** (AES-256-GCM, key derived from `APP_SECRET`) and are **never returned** by any endpoint (only `set` / `source` / last 4 characters). They take effect immediately and **override** the `OPENROUTER_API_KEY` / `ALPACA_API_*` env vars, which stay as the fallback. Attaching Alpaca keys also switches data to live even if `USE_MOCK_DATA=true`.
4. Once an account exists, **every `/api` route except `GET /api/health` and `/api/auth/*` requires the session cookie** (or `Authorization: Bearer <ADMIN_TOKEN>` for scripts). Static files stay public so the SPA can show the login screen.

Rules worth knowing:

- **Nobody can claim a fresh deployment.** Sign-up needs `SIGNUP_CODE` (or `ADMIN_TOKEN`). If neither is set, sign-up is only accepted from `localhost` (not through a proxy); remote clients get `403 signup_disabled`.
- After the owner exists, sign-up is closed unless `ALLOW_SIGNUP=true` (still needs the code). Extra accounts **share the same data and the same workspace API keys**; this is not multi-tenant.
- **`APP_SECRET`**: sessions are signed with it and stored keys are encrypted with it. If it is unset, a random per-boot secret is used (everyone is signed out on restart) and keys **cannot be saved** (`409 encryption_not_configured`). **If you lose or change `APP_SECRET`, stored keys become unreadable and you must re-enter them** (sessions also reset).
- Login is rate limited per IP and per email (10 failures / 10 min, then a growing lockout, `429` + `Retry-After`); errors are generic and unknown emails take the same time as wrong passwords. Changing the password or `POST /api/auth/logout-all` invalidates every other session.
- State-changing requests must be `application/json` (or carry `X-Requested-With`) and any `Origin` header must match the host (or `CORS_ORIGIN`), otherwise `403 csrf`. Bearer-token requests skip the content-type rule.
- Passwords, keys, cookies and auth request bodies are never logged (`api_logs`/`ai_logs`/app logs).
- Scheduled runs use the active keys and skip (with a log line) if no OpenRouter or Alpaca credentials are configured.
- Without an account, and without `ADMIN_TOKEN`, the app is open (local use) and `GET /api/auth/status` reports `setupRequired: true`. `ADMIN_TOKEN` alone (no account yet) also gates the API for scripts.

Every response carries `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and a Content-Security-Policy (same-origin + `*.tradingview.com` scripts/frames + Google Fonts). Market endpoints (`/api/market/*`) only serve symbols in the scanner universe or with an open position (otherwise 400).

Live data failures are never papered over with mock prices: with real Alpaca keys a failed fetch throws (HTTP 502 on the market routes), the symbol is skipped by the monitor / trader / pick scoring, and it is listed under `fallbacks` in `/api/health` and `/api/status`.

Worker status: `POST /api/run` returns **409** (`code: worker_not_running`) while the worker is stopped or killed, and the trader never opens positions in that state. The 5-minute monitor keeps managing exits (stops, targets, time exit) regardless of worker status.

CORS is same-origin unless `CORS_ORIGIN` is set; `POST /api/run` is rate limited; settings are whitelisted and range-checked.

## API

Everything below except `/api/health` and `/api/auth/*` needs a session cookie or `Authorization: Bearer <ADMIN_TOKEN>` (401 `{error:'unauthorized', code:'login_required'}`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/status` | Public: `{required, setupRequired, signupOpen, signupNeedsCode, mode, user}` |
| POST | `/api/auth/signup` \| `/login` \| `/logout` \| `/logout-all` \| `/password` | Account session management (`signup` body `{email,password,code}`, `password` body `{current,next}`) |
| GET | `/api/account` | Email, key summary (`set`/`source`/last 4 only), models, `encryptionReady` |
| PUT | `/api/account/keys` | `{openrouterKey?, alpacaKey?, alpacaSecret?, clear?:['openrouter'\|'alpaca']}` |
| PUT | `/api/account/models` | `{scannerModel, traderModel}` (empty string = default) |
| POST | `/api/account/test` | `{service:'openrouter'\|'alpaca'}` → `{ok, message}` (real minimal call with the active key) |
| POST | `/api/run` | Start scanner → trader run |
| GET | `/api/run/status` | Progress of the current run |
| GET | `/api/runs?limit=20` | Persisted run history |
| GET | `/api/ai/summary` \| `/api/ai/picks` | Latest run summary / picks |
| GET | `/api/positions` | Account, open (with live P&L, `stale`) and closed positions |
| POST | `/api/positions/:id/close` \| `/api/positions/close-all` | Manual close `?force=1` (or body `{force:true}`) closes on a stale quote. Errors: 404 unknown, 409 `stale_quote`, 502 `no_quote`; close-all returns `{closed, failed:[{id,symbol,status,code,error}]}` |
| GET | `/api/performance` | Equity curve, win rate, avg R, drawdown, calibration, per-bot stats |
| GET | `/api/status` | Worker, settings, `marketOpen`, `staleSymbols`, data mode |
| PATCH | `/api/settings` | Slippage/fees/risk limits/horizon  |
| GET | `/api/health` | Public |

`/api/dashboard` remains as a slim summary (accuracy, worker, logs). The legacy `/watchlist`, `/predictions`, `/accuracy`, `/model`, `/scan`, `/train`, `/evaluate` endpoints were removed.

## Tests & maintenance

```bash
npm test            # node:test unit tests (CI runs these + syntax checks)
npm run prune       # delete Supabase log rows older than 14 days (-- --days N)
```

Run `supabase/migrations/001_init.sql`, `002_runs.sql` (runs, equity snapshots, pick scores, `prune_logs()`) then `003_users.sql` (`app_users`: the owner account and its encrypted keys; without Supabase they live in `data/users.json`).

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

## Operational notes

- **Trading day**: daily P&L / loss halt use the US/Eastern calendar day. Market hours model NYSE holidays and half-days for 2025-2027 (static list in `server/services/market.js`; extend yearly).
- **Time exit**: a position past its horizon is flagged `expired`/`expiredAt` and closes at the first fresh bar (stocks wait for the next session).
- **Rate limits / proxies**: set `TRUST_PROXY=true` behind Render/nginx, otherwise every client shares one bucket (a startup warning is logged on Render / `NODE_ENV=production`). Dashboard GET polling has its own 1200/min bucket; other API calls 300/min; `POST /api/run` 10 per 10 min (no charge for "already running" replies).
- **Storage**: JSON files are cached in memory (write-through). Closed positions beyond 1000 move to `data/positions-archive.json`.
