# TradingBot V2.0

AI market scanner & prediction dashboard. Same look and feel as the classic tradingbot UI — **new backend that never places trades**.

## What it does

- **The AI is required.** There is no fallback: without an OpenRouter key, with the monthly budget used up, or when the model errors / rate-limits / returns unusable output (after at most ONE repair retry), the run ends in a clear `blocked` / `error` state with a machine-readable code. Previous picks stay as they were and nothing is traded or guessed.
- **Scanner bot** screens ~120 equities + crypto (hourly + daily context, relative strength, market regime) via OpenRouter
- **Trader bot only PROPOSES.** It writes **trade proposals** (entry, stop, target, size, reason, risk-check snapshot) to an approval queue. You approve or reject each one; approval re-runs the risk engine with a **fresh quote** and then opens the **simulated** position: ATR stops, slippage + fees, gap-aware fills, break-even / trailing stops, time exit, portfolio risk limits, daily-loss halt. Auto-approval exists behind a switch that is **off** by default
- **Budget governor**: a hard monthly cap (default **$20**, all bots) with real cost tracking per call
- **Shadow scoring**: every proposal (approved or not) and every scanner pick is scored at its horizon as if it had been traded, so the dashboard can show what your approvals/rejections were worth (avoided loss, missed gain) and whether the AI beats SPY buy-and-hold and seeded random picks
- **Scores every pick** after its horizon and reports confidence calibration (`/api/performance`)
- **Fun stuff** (see *Fun features* below): streaks & badges, trade of the week with a share image, bot personalities, a "Why did the AI pick this?" panel with an on-demand bull-vs-bear debate, a what-if replay, a confidence reliability diagram, an earnings & event calendar and a live market-mood bar
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
4. `render.yaml` already sets `NODE_VERSION=22`, `TRUST_PROXY=true` and generates `APP_SECRET` for you and declares the secrets (`SIGNUP_CODE`, `ADMIN_TOKEN`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `OPENROUTER_API_KEY`, `FINNHUB_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) as `sync: false`, so Render asks you for them. **Set `SIGNUP_CODE`** (see *Account login* below) so only you can create the owner account; once an account exists the whole API requires login. Run `supabase/migrations/003_users.sql`, `004_revoked_sessions.sql` and `005_proposals_spend.sql` and `006_research_notes.sql` (in that order, after 001 and 002; or just paste `supabase/setup_all.sql`) if you use Supabase so the account, the proposals and the AI budget survive redeploys.
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

1. Set `SIGNUP_CODE` (a long random secret; falls back to `ADMIN_TOKEN`) and `APP_SECRET` (a long random string; `render.yaml` generates it) on the server. **On a deployment `SIGNUP_CODE` is required**: without an account the API is closed (see fail-closed setup below), so there is nothing to sign up with until it is set.
2. Open the site. It shows the create-account screen: enter email, a password (10+ characters, not a common one) and the sign-up code. You are signed in with an `HttpOnly` `tb_session` cookie (14 days; signed payload `{uid, sv, sid, exp}`; always `Secure` in production / on Render).
3. Under **Settings → Account** add your OpenRouter key, Alpaca key/secret and (optional, free) Finnhub key (and optionally model names). They are stored **encrypted** (AES-256-GCM, key derived from `APP_SECRET`) and are **never returned** by any endpoint (only `set` / `source` / last 4 characters). They take effect immediately and **override** the `OPENROUTER_API_KEY` / `FINNHUB_API_KEY` / `ALPACA_API_*` env vars, which stay as the fallback. Attaching Alpaca keys also switches data to live even if `USE_MOCK_DATA=true`.
4. Once an account exists, **every `/api` route except `GET /api/health` and `/api/auth/*` requires the session cookie** (or `Authorization: Bearer <ADMIN_TOKEN>` for scripts). Static files stay public so the SPA can show the login screen.

Rules worth knowing:

- **Nobody can claim a fresh deployment.** Sign-up needs `SIGNUP_CODE` (or `ADMIN_TOKEN`). If neither is set, sign-up is only accepted from `localhost` (not through a proxy); remote clients get `403 signup_disabled`.
- After the owner exists, sign-up is closed unless `ALLOW_SIGNUP=true` (still needs the code). Extra accounts **share the same data and the same workspace API keys**; this is not multi-tenant.
- **`APP_SECRET`**: sessions are signed with it and stored keys are encrypted with it. If it is unset, a random per-boot secret is used (everyone is signed out on restart) and keys **cannot be saved** (`409 encryption_not_configured`). **If you lose or change `APP_SECRET`, stored keys become unreadable and you must re-enter them** (sessions also reset).
- **Login throttling** (in memory; a restart clears all counters and locks, and every lock expires on its own, so nobody is locked out permanently): failures are throttled per **(email, client IP) pair** (10 / 10 min, then a doubling lock capped at 15 min, `429` + `Retry-After`). It is never keyed by email alone, so knowing the owner's email does not let anyone lock the owner out from another address. A separate, much higher **per-IP spray limit** (60 failures / 10 min, lock capped at 10 min) covers one address trying many emails. Many failures for one email from *any* address only add an escalating **delay** (250 ms doubling, max 5 s) to that email's attempts, never a rejection, so the correct password still works from a fresh IP during an attack. IPv6 clients are keyed on their /64 and IPv4-mapped addresses are normalised. `POST /api/auth/password` from a live session ignores these login limiters (wrong guesses are counted per user+session only). Wrong sign-up codes are also capped globally (30 / hour, then a 5-30 min lock). Errors are generic and unknown emails take the same time as wrong passwords. Changing the password or `POST /api/auth/logout-all` invalidates every other session.
- **Logout is server-side**: each session carries a random `sid`; `POST /api/auth/logout` adds that `sid` to a revoked set (kept until the token's own expiry, persisted to `data/revoked-sessions.json` and mirrored to Supabase `revoked_sessions`, migration `004`) so a stolen/replayed cookie stops working, while your other sessions stay valid. Cookies issued before this change carry no `sid` and are refused (sign in again).
- **Password rules**: 10-200 characters, not on an embedded blocklist of ~500 very common passwords/stems (leetspeak and digit/symbol decorations folded, so `Password1!` and `P@ssw0rd2024` fail), no repeated blocks, no sequences / keyboard walks (`12345678901`, `qwertyuiop1`), and it must not contain the email's local part. The browser applies the same module (`public/js/password-rules.js`), so the strength meter agrees with the server.
- **Fail-closed first run**: with `NODE_ENV=production`, `RENDER` set, or `REQUIRE_SETUP=true`, and no account and no `ADMIN_TOKEN`, every `/api` route except `GET /api/health` and `/api/auth/*` answers `503 {error, code:'setup_required'}` until the owner account is created (an ephemeral-disk reset therefore cannot open your dashboard). The message says which env var to set (`SIGNUP_CODE` when none is configured). `GET /api/auth/status` then reports `mode:'setup', required:true, setupRequired:true` and the UI shows only the create-account screen. When Supabase is configured the account restore at boot is retried with backoff; if it still fails (or is pending) sign-up is refused (`503 accounts_unavailable`) rather than creating a second owner next to an unreachable one.
- First-run sign-up without a code (loopback only) additionally requires the `Host` header to be `localhost`, `127.0.0.1` or `[::1]` (DNS-rebinding defence).
- `TRUST_PROXY=true` is **required behind Render / any reverse proxy** (otherwise every visitor shares one rate-limit bucket; the server warns at boot when `RENDER`/production is set without it). Supabase is **strongly recommended** on Render: the free disk is ephemeral, so accounts, encrypted keys and logged-out sessions only survive restarts through Supabase.
- Every `/api/*` response is `Cache-Control: no-store` with no ETag; HSTS (`max-age=31536000; includeSubDomains`) is sent in production and over https.
- The legacy admin token (if you use `ADMIN_TOKEN` from the browser) is kept in `sessionStorage` (per tab, gone when the tab closes), not `localStorage`; a copy left by an older version is deleted.
- State-changing requests must be `application/json` (or carry `X-Requested-With`) and any `Origin` header must match the host (or `CORS_ORIGIN`), otherwise `403 csrf`. Bearer-token requests skip the content-type rule.
- Passwords, keys, cookies and auth request bodies are never logged (`api_logs`/`ai_logs`/app logs).
- Scheduled and event-triggered runs (`settings.schedule`, see *Run schedules*) use the active OpenRouter key and are skipped, with a logged reason, when there is no key or the remaining budget is below the projected cost of a run.
- Without an account, and without `ADMIN_TOKEN`, **and outside production** (no `RENDER`, `NODE_ENV` not `production`, `REQUIRE_SETUP` not `true`), the app is open (local use) and `GET /api/auth/status` reports `setupRequired: true`. `ADMIN_TOKEN` alone (no account yet) also gates the API for scripts.

Every response carries `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options` and a Content-Security-Policy (same-origin + `*.tradingview.com` scripts/frames + Google Fonts). Market endpoints (`/api/market/*`) only serve symbols in the scanner universe or with an open position (otherwise 400).

Live data failures are never papered over with mock prices: with real Alpaca keys a failed fetch throws (HTTP 502 on the market routes), the symbol is skipped by the monitor / trader / pick scoring, and it is listed under `fallbacks` in `/api/health` and `/api/status`.

Worker status: `POST /api/run` returns **409** (`code: worker_not_running`) while the worker is stopped or killed, and the trader never opens positions in that state. The 5-minute monitor keeps managing exits (stops, targets, time exit) regardless of worker status.

CORS is same-origin unless `CORS_ORIGIN` is set; `POST /api/run` is rate limited; settings are whitelisted and range-checked.

## API

Everything below except `/api/health` and `/api/auth/*` needs a session cookie or `Authorization: Bearer <ADMIN_TOKEN>` (401 `{error:'unauthorized', code:'login_required'}`).

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/status` | Public: `{required, setupRequired, signupOpen, signupNeedsCode, mode ('session'\|'token'\|'none'\|'setup'), user, guidance?}` |
| POST | `/api/auth/signup` \| `/login` \| `/logout` \| `/logout-all` \| `/password` | Account session management (`signup` body `{email,password,code}`, `password` body `{current,next}`) |
| GET | `/api/research`, `/api/research/latest` | News bot notes (`?runId=&symbol=&limit=`) / latest note per symbol; see *News & earnings bot* |
| GET | `/api/account` | Email, key summary (`set`/`source`/last 4 only), models, `encryptionReady` |
| PUT | `/api/account/keys` | `{openrouterKey?, alpacaKey?, alpacaSecret?, finnhubKey?, clear?:['openrouter'\|'alpaca'\|'finnhub']}` |
| PUT | `/api/account/models` | `{scannerModel?, traderModel?, newsModel?}` (empty string = default; `newsModel` is the news bot's model). Ids are validated (`[A-Za-z0-9_.-:/]`, max 100) and, when the catalog is loaded, against it: unknown ids are saved but returned in `warnings`; free models add `notes`. Response = account summary + `warnings` + `notes` |
| POST | `/api/account/test` | `{service:'openrouter'\|'alpaca'\|'finnhub'}` → `{ok, message}` (real minimal call with the active key) |
| POST | `/api/run` | Start scanner → trader run (→ proposals). 409 `worker_not_running` while stopped |
| GET | `/api/run/status` | Progress of the current run |
| GET | `/api/runs?limit=20` | Persisted run history (`status`, `code`, `error`, `proposalCount`, `costUsd`) |
| GET | `/api/proposals?status=&limit=` | Approval queue: `{proposals, counts}`; `status` = pending\|approved\|rejected\|expired\|superseded\|all |
| POST | `/api/proposals/:id/approve` | Re-checks risk with a fresh quote, then opens the simulated position. 409 `{code, error, details}` with code `expired`\|`price_moved`\|`risk_blocked`\|`stale_quote`\|`worker_not_running`\|`no_slots`\|`already_decided` |
| POST | `/api/proposals/:id/reject` | Body `{reason?}` |
| POST | `/api/proposals/approve-all` | `{approved:[{id,symbol,positionId}], failed:[{id,symbol,code,error}]}`: only proposals that pass their re-checks open |
| GET | `/api/budget` | Monthly AI spend: cap, spent, remaining, `pct`, `resetsAt`, `byBot`, `byModel`, `last7d`, `avgCostPerRun`, `projectedMonthEndUsd`, `level` (ok\|warn ≥70%\|blocked) |
| GET | `/api/models?free=1&q=&maxPrice=&limit=` | OpenRouter model catalog with live prices (USD per 1M tokens), cheapest first |
| GET | `/api/models/estimate?bot=scanner\|trader\|news&model=` | Estimated cost of one call and how many fit in the monthly budget |
| GET | `/api/ai/summary` \| `/api/ai/picks` | Latest run summary / picks |
| GET | `/api/positions` | Account, open (with live P&L, `stale`) and closed positions |
| POST | `/api/positions/:id/close` \| `/api/positions/close-all` | Manual close `?force=1` (or body `{force:true}`) closes on a stale quote. Errors: 404 unknown, 409 `stale_quote`, 502 `no_quote`; close-all returns `{closed, failed:[{id,symbol,status,code,error}]}` |
| GET | `/api/performance` | Equity curve, win rate, avg R, drawdown, calibration, per-bot stats, plus `proposals`, `approval`, `avoidedLoss`, `missedGain`, `baselines`, `netEdge` (see *Proposals, shadow scoring and netEdge*) |
| GET | `/api/status` | Worker, settings, `marketOpen`, `staleSymbols`, data mode, `ai:{required, ready, blockedReason?, demo}`, compact `budget`, `proposalsPending` |
| GET | `/api/schedule` | `{enabled, plan, tz:'America/New_York', custom, cryptoRuns, slotsToday:[{id,timeEt,timeUtc,scope,status:'upcoming'\|'fired'\|'skipped'\|'missed',reason?}], nextRunAt, lastRuns:[{at,trigger,status,code?,costUsd,proposals}], eventTriggers:{...,active,firedToday}}` |
| POST | `/api/schedule/test-fire` | Body `{slotId?}`. Runs through the same gate as a scheduled run, marked `trigger.type:'test'`; 202 `{started, trigger, run}`. 409 `code`: `worker_not_running` \| `run_in_progress` \| `no_api_key` \| `budget_exhausted` \| `insufficient_budget`; 400 `unknown_slot` |
| GET | `/api/schedule/forecast?plan=A\|B\|C\|D\|custom` | Monthly cost forecast per plan (all plans + `current` when `plan` is omitted; 400 `invalid_plan`) |
| GET | `/api/schedule/experiments` | Per plan and trigger type: runs, avg cost, proposals/run, approval rate, net edge, edge per dollar (null until enough samples) |
| PATCH | `/api/settings` | `botPersona` (see *Fun features*), slippage/fees/risk limits/horizon, `autoApprove`, `autoApproveMaxAllocPct`, `proposalTtlHours`, `monthlyAiBudgetUsd`, `netEdgeDrawdownWeight`, `netEdgeAvoidedWeight`, `schedule` (partial object, deep-merged; see *Run schedules*) |
| GET | `/api/gamify` | `{streaks:{win:{current,best,closed}, calls:{current,best,judged}}, stats, badges:[{id,emoji,name,desc,group,earned,progress:{value,target}}], earnedCount, total, recentCalls}`. Derived from stored trades and proposals; nothing is persisted |
| GET | `/api/trade-of-the-week` | `{trade, window, candidates}`: best profitable closed trade of the last 7 days with a templated `caption` (`trade` is `null` when there is none) |
| POST | `/api/proposals/:id/debate` | One AI call returning the case FOR and AGAINST that proposal plus a lean; saved on the proposal, so repeats are free (`?force=1` re-runs and re-spends). Budget-governed (billed under bot `other`), no fallback. Errors: 404, 409 `no_api_key`, 402 `budget_exhausted`, 429 `rate_limited`, 502 `invalid_output`\|`model_unavailable`\|`upstream_error`, 504 `timeout` |
| POST | `/api/whatif` | Body (all optional) `{stopMult, targetMult (0.25-4), sizeMult (0.1-3), horizonHours (1-168), breakEven, trailR (0-10), scope: all\|approved\|declined}` → baseline vs scenario P&L, win rate, drawdown, both cumulative curves, biggest movers and honest `skipped` counts |
| GET | `/api/calendar?days=21` | Earnings (Finnhub; what you hold, what is proposed, the scanner's top picks), FOMC decisions, the jobs report and NYSE closures, grouped by ET day (max 28 days). `earningsAvailable:false` when there is no Finnhub key |
| GET | `/api/mood` | Homemade 0-100 fear/greed-style index with its components, plus SPY/QQQ/IWM/BTC quotes |
| GET | `/api/health` | Public |

`/api/dashboard` remains as a slim summary (accuracy, worker, logs). The legacy `/watchlist`, `/predictions`, `/accuracy`, `/model`, `/scan`, `/train`, `/evaluate` endpoints were removed.

## Dashboard layout

Proposals stay open at the top. Every other block is a one-line section with a summary (for example "net edge +$1,528"). **Positions** is the only section open by default. Use the arrow on a section, or **Collapse all / Expand all**, to change this. The choice is saved in your browser. In the calendar, each day also folds. News shows 4 notes first, the dashboard performance block shows headline numbers and the equity chart (full tables live on the Performance page), and each proposal card folds its risk numbers behind one line. Copy rules are in [`docs/COPY-STYLE.md`](docs/COPY-STYLE.md).

## Fun features

All of these are read-only helpers: none of them can open a position or loosen a risk rule.

- **Streaks & badges** (`/api/gamify`, dashboard *Achievements*). A *win streak* is consecutive profitable closed trades. A *good call* is approving a trade that made money or rejecting one that would have lost; only decisions you made count (not expiries, news-guard blocks or auto-approvals), and an approved trade is judged on its real closed position when there is one. 13 badges are derived from that data, so there is no new storage. A toast announces a newly earned badge (never on your first visit, which only records what you already have).
- **Trade of the week**. Best profitable closed trade of the last 7 days. *Share image* draws a 1200x630 card on a canvas in your browser (native share sheet where available, otherwise a download); nothing is uploaded.
- **Bot personalities** (Settings → *Bot personality*, `botPersona`: `default`, `professor`, `hype`, `veteran`, `zen`, `pirate`). Changes only the wording of the trader's one-sentence reasons and run summary (and of debates). The persona id is a closed whitelist, the instruction states that numbers, levels and risk rules are unaffected, and every level is still validated and clamped server-side. The persona is saved on each proposal.
- **Why did the AI pick this?** On every proposal card (pending and history). Shows the scanner's and trader's reasoning, the market backdrop and the technical setup read *relative to the trade's side* (falling prices support a short), news sentiment, and a "watch out for" list (earnings soon, risk flags, upcoming macro days, low reward-to-risk). New proposals store a compact numeric snapshot (`setup`, `regime`, `scannerReason`, `persona`); older ones show what they have.
- **Bull vs bear debate**. On demand from that panel. One AI call (not two) returns both cases and a lean. It only receives structured numbers and flags, never raw news text. Cached on the proposal, billed against the monthly budget, and with no key or budget it says so instead of inventing anything.
- **What-if replay** (Performance page). Re-simulates decided proposals through the same exit simulator the app already uses (stop, target, break-even, trailing stop, time exit, slippage, fees) with different rules, next to the real rules. Both lines are re-simulated, so they are comparable. Proposals still inside their horizon, or whose hourly price history is no longer available, are skipped and counted. Hourly bars hide intra-hour moves.
- **Confidence reliability diagram** (Performance, dashboard). Stated confidence vs actual hit rate with 95% Wilson ranges, a Brier score against the base-rate guess, and a verdict that stays "anecdotal" below 30 scored picks.
- **Earnings & event calendar**. Earnings come from the same Finnhub client and cache as the news stage. **The macro list is built in** (FOMC decision days for 2026 in `server/services/calendar.js`, the jobs report as "usually the first Friday", NYSE closures from the existing holiday table): verify dates before relying on them and extend the list each year. CPI is not included.
- **Market mood bar**. A slim bar under the top nav on every page: a homemade index (SPY trend and momentum, breadth, new highs vs lows, volatility regime, Bitcoin momentum) computed from market data the app already fetches, plus index quotes. It is not CNN's Fear & Greed and says so.

## Tests & maintenance

```bash
npm test            # node:test unit tests (CI runs these + syntax checks)
npm run prune       # delete Supabase log rows older than 14 days (-- --days N)
```

Run `supabase/migrations/001_init.sql`, `002_runs.sql` (runs, equity snapshots, pick scores, `prune_logs()`) then `003_users.sql` (`app_users`: the owner account and its encrypted keys; without Supabase they live in `data/users.json`) `004_revoked_sessions.sql` (logged-out sessions, so a stolen cookie stays dead after a redeploy) and `005_proposals_spend.sql` (`proposals` approval queue + `ai_spend` ledger) and `006_research_notes.sql` (`research_notes`: the news bot's notes; each is optional and the server tolerates them missing, but the budget is only exact across redeploys with them).

## Stack

- Node.js + Express
- File-backed JSON store in `data/`
- Vanilla SPA frontend matching the classic dark tradingbot chrome
- `node-cron` for periodic scan + evaluate cycles

## AI run (OpenRouter)

Press **RUN** on the dashboard:

1. **Scanner bot** (`SCANNER_MODEL`, default `deepseek/deepseek-v3.1-terminus`) screens ~120 stocks/ETFs/crypto and returns the top 100 as JSON `{symbol, direction, confidence, reason}` → shown in *AI TOP 100 PICKS*.
2. **Trader bot** (`TRADER_MODEL`, default `deepseek/deepseek-chat-v3.1`) reviews those picks and **proposes** up to 10 trades, each with an allocation, stop-loss and take-profit. The server validates/clamps them, runs the risk engine (caps, halt, slippage/fees, stale-quote refusal, no crypto shorts) and stores them as **pending proposals**.
3. You **approve** (or reject) each proposal in the queue. Approval re-runs the risk engine with a fresh quote and refuses with `price_moved` if the price drifted more than `max(1 × ATR%, 1.5%)` from the proposal, then opens the simulated position. Pending proposals expire after `proposalTtlHours` (default 6h); a newer run supersedes older pending proposals for the same symbol. Stops/targets of open positions are checked every 5 minutes.

**No fallback.** If the AI cannot run, the run ends with `stage: 'blocked'` or `'error'`, `code` and a human `error` (also stored in the run history), previous picks stay, and nothing is proposed or opened. Codes:

| code | stage | meaning |
|---|---|---|
| `no_api_key` | blocked | no OpenRouter key (or OpenRouter rejected it) |
| `budget_exhausted` | blocked | month-to-date + estimate would exceed the cap (or OpenRouter credits are empty) |
| `rate_limited` | error | HTTP 429 after one bounded wait (`Retry-After` honoured, at most 15s). Free `:free` models do this often |
| `model_unavailable` | error | unknown / withdrawn model or no provider |
| `invalid_output` | error | unusable JSON or shape after the single repair retry |
| `upstream_error` | error | OpenRouter 5xx / network / malformed reply |
| `timeout` | error | no answer in time |

Each call sends `usage: {include: true}` and reads the provider-reported `usage.cost`; when that is missing the cost is estimated from tokens × the catalog price. JSON mode (`response_format`) is requested when the model supports it and dropped automatically if the provider rejects it. Invalid JSON gets exactly **one** repair retry (billed and counted like any call).

### Run schedules, event triggers and cost forecast

The old `autoRun` cron is gone (the setting is still accepted but does nothing). Runs are driven by `settings.schedule` (off by default), evaluated every minute on **America/New_York** wall-clock time (DST-safe, NYSE holidays and 13:00 half-days from the built-in table):

| Plan | Slots (weekdays, ET) |
|---|---|
| A | 09:00, 12:30 |
| B | 09:00 |
| C | B + event triggers on |
| D | 09:00, 13:00, 16:15 |
| custom | `schedule.custom`: `[{time:'HH:MM', days:'weekdays'\|'daily', scope:'stocks'\|'crypto'\|'all'}]` |

`schedule.cryptoRuns` (default `[]`, opt-in — each crypto run costs the same as a stock run; e.g. `['09:00','21:00']` ET) adds daily crypto-scope slots; a crypto slot at the same time as another slot merges into it (scope `all`). Stock-scope slots are skipped on holidays/weekends; on a half-day an after-close slot moves 3 h earlier. Settings shape: `schedule: {enabled, plan, custom, cryptoRuns, eventTriggers:{enabled, spyMovePct:1.0, btcMovePct:2.5, shortlistMovePct:3.0, minMinutesBetweenEventRuns:120, maxEventRunsPerDay:2, newsCatalyst}}` (`newsCatalyst` is reserved and does nothing yet). `PATCH /api/settings {schedule:{...}}` validates and deep-merges (bad times, unknown plans/fields → 400).

Every scheduled, event or test run: needs the AI (no fallback), is skipped with a logged reason when remaining budget is below the projected cost of a run (measured average of full runs, else an estimate), never starts while another run is in progress, and is recorded as `trigger:{type:'schedule'|'event'|'manual'|'test', plan, slot, reason}` on the run and in `GET /api/runs`. When the budget level is `warn`, event runs are dropped before scheduled ones. Fired/skipped/missed slots are persisted (`data/schedule-state.json`, plus `trigger.slot` on the run history), so a restart never double-fires; a slot missed by up to 20 minutes (e.g. during a restart) fires once, older ones are skipped and logged.

Event triggers (plan C, or `eventTriggers.enabled`) poll every 5 minutes with no LLM calls: SPY, BTC/USD and the current shortlist versus their previous daily close; stocks only while the market is open. A run starts when a move crosses its threshold, honouring `minMinutesBetweenEventRuns` and `maxEventRunsPerDay` (ET day).

`GET /api/schedule/forecast` projects the next 30 days per plan: real trading days (holidays excluded) plus crypto runs, `eventRunsAssumed` (C: 4 per month as a rough guess; D: 0 because its fixed slots cover the day), cost per run (`basis` `measured` from the ledger's full runs, `estimated` from model prices x default token sizes, or `unknown`), `projectedMonthlyUsd`, `pctOfBudget`, `fitsBudget`. `/api/status` → `budget.forecast` carries the active plan's forecast. `GET /api/schedule/experiments` compares plans and trigger types (`edgePerDollar` stays null until 10 runs and 10 shadow-scored proposals).

### Budget (hard cap, default $20/month)

`MONTHLY_AI_BUDGET_USD` sets the default; the `monthlyAiBudgetUsd` setting overrides it. The month is the **UTC** calendar month. Every model call is written to a ledger (`data/ai-spend.json`, mirrored to Supabase `ai_spend`) with `{ts, bot, model, promptTokens, completionTokens, costUsd, costSource: 'reported'|'estimated', ok, runId}`. Before each call the governor estimates its cost (actual prompt size, measured or default output size, catalog price) and refuses with `budget_exhausted` if month-to-date + estimate > cap; free models (estimate $0) still run at the cap. Scheduled runs skip with a logged reason. On boot the month-to-date spend is merged back from `ai_spend` (or, if migration 005 was not applied, rebuilt from `ai_logs.usage`, where the cost is also stored), so a redeploy cannot reset the budget to zero (`npm run prune` never touches `ai_spend`; it does trim `ai_logs`, so the fallback only sees what `ai_logs` still holds). `GET /api/budget` reports it.

### Choosing a model (free or cheaper)

`GET /api/models` returns the public OpenRouter catalog (fetched server-side, cached 1h, served stale on errors, never sends your key): `[{id, name, promptPerM, completionPerM (USD per 1M tokens), contextLength, isFree, supportsJson?, created?}]` cheapest first; filter with `?free=1&q=claude&maxPrice=1`. `GET /api/models/estimate?bot=scanner&model=<id>` returns the estimated cost per call and how many fit in the monthly budget (`basis: 'measured'` once your own runs have recorded token counts, else `'default'`: scanner ≈ 6k in / 4k out, trader ≈ 3k / 1k). A full RUN is one scanner call plus one trader call. Free models are rate limited and their providers may log prompts (only market data is sent), so a run can fail with `rate_limited`; retry later or switch models. Save the choice with `PUT /api/account/models` (`scannerModel`, `traderModel`, `newsModel`).

### Proposals, shadow scoring and netEdge

Every proposal is scored when its horizon passes (`horizonHours`), whether you approved it, rejected it, let it expire, or a newer run superseded it, using the same exit simulation as real positions (stop, target, break-even/trail, time exit, slippage and fees). The result is stored on the proposal as `shadow: {scoredAt, hypotheticalPnl, hypotheticalPct, exitReason, ...}`. Scanner picks are scored the same way with default levels (2 ATR stop, 3.5 ATR target) and a default size (min of 20% of equity, 2% risk at the stop, and an equal share of the gross cap across the position slots).

`GET /api/performance` adds:

- `proposals: {total, pending, approved, rejected, expired, superseded}`
- `approval: {approvedNet, rejectedNet, ...}`: hypothetical net P&L of what you approved vs what you rejected or let expire (`passedOnNet` = picks the AI itself skipped)
- `avoidedLoss`: sum of |loss| of rejected/expired proposals that would have lost; `missedGain`: sum of gains you passed on
- `baselines: {window, ai, spyHold, randomPicks, beats}`, each `{pnl, pct, n}` over the same scored proposals: SPY buy-and-hold with the same allocations, and a **deterministic seeded random** sample from the same scanner lists with the same sizing rules
- **`netEdge = realizedPnl − 0.5 × maxDrawdownUsd + 1 × avoidedLoss`** (`netEdgeParts` shows the terms). Realized P&L is after slippage and fees; the weights are the settings `netEdgeDrawdownWeight` (0.5) and `netEdgeAvoidedWeight` (1)

### Auto-approval (off by default)

`autoApprove` (setting, default `false`) lets the run open proposals itself, only when the value is exactly `true`. Guard rails: each proposal still goes through the full approval path (fresh quote, `price_moved`, caps, slots, halt), its allocation must be ≤ `autoApproveMaxAllocPct` (default 5) % of equity, demo proposals are never auto-approved, and every auto-approval or refusal is logged (`AUTO-APPROVED …`).

### Dev/test only: `MOCK_LLM`

`MOCK_LLM=true` swaps OpenRouter for a deterministic canned reply (scanner: the first ~20 symbols alternating long/short; trader: the top 3 candidates) so screenshots and tests run with no key. It is a test fixture, never a fallback: it is **refused** (ignored, with a loud warning) when `NODE_ENV=production` or `RENDER` is set, it is never used automatically, costs nothing, and everything it produces is labelled `source: 'demo'` / `model: 'mock-llm'` (`/api/status` → `ai.demo`, `/api/health` → `mockLlm`) so the UI can show **DEMO DATA**.

### News & earnings bot (optional context stage)

A third bot, `news`, runs between the scanner and the trader: **fetch → scanner → news (shortlist only) → trader**. It never trades and is **optional context**: if it cannot run the run continues without notes and the run record says why. There is **no rule-based trading fallback**; the AI trader is still required.

- **Shortlist**: the top `news.maxSymbols` (default 30) scanner picks by confidence (minus open positions and crypto shorts). For each: up to 8 headlines from the last 48 h (Alpaca News, `GET https://data.alpaca.markets/v1beta1/news`, the same Alpaca credentials as market data; de-duplicated, each truncated to 300 chars) and the next earnings date (Finnhub `GET https://finnhub.io/api/v1/calendar/earnings`; crypto has none).
- **Finnhub key** (free plan is enough): Settings → Account (`PUT /api/account/keys {finnhubKey}`, encrypted like the other keys, never returned: only `{set, source:'account'|'env'|'none', last4}`) or env `FINNHUB_API_KEY`. It is sent **only** in the `X-Finnhub-Token` header, never in a URL or log. `POST /api/account/test {service:'finnhub'}` makes one minimal real call. `PUT /api/account/keys {clear:['finnhub']}` removes it. Without a key the news stage still runs on headlines alone and the run's `news.status` is `partial` ("earnings dates unknown").
- **Model and cost**: `settings`/account `newsModel` (env `NEWS_MODEL`, default `deepseek/deepseek-chat-v3.1`). Its calls are ledgered under bot `news` and obey the same $20/month governor (`GET /api/budget` → `byBot.news`); the news call is skipped, not the trader, when the remaining budget cannot cover both. The schedule forecast (`/api/schedule/forecast`, `estCostPerRunUsd`) includes one news call per run while `news.enabled` is true.
- **Output** (strictly validated; anything outside the schema is dropped): `{notes:[{symbol, sentiment:-1..1, catalyst(<=200), earningsInDays:number|null, riskFlags:[earnings_imminent|guidance_risk|legal|regulatory|halt|offering|macro|rumor|low_confidence], summary(<=300), sources:[{title,url,publishedAt}]}]}`. Every source must be one of the headlines that were supplied (hallucinated ones are dropped; a note citing none is dropped unless its earnings date is known). `earningsInDays` is the **calendar's** value, never the model's.
- **Untrusted text**: headlines are scraped third-party text. They are stripped of HTML/markdown/URLs/control characters and instruction-like phrases, size-capped, and only ever sent inside a JSON data block that the system prompt declares to be data, not instructions. The trader receives **only** `sentiment`, `earningsInDays` and `riskFlags` (never free text). Notes are stored as plain text (the UI must still escape them; `sources[].url` is http(s) only).
- **Server-side guard**: a proposal whose symbol has `earningsInDays <= news.earningsBlackoutDays` (default 2) is created already **rejected** with `rejectReason: 'earnings blackout'` (`decidedBy: 'system'`; it consumes no slot or cash and is shadow-scored like any rejection) unless `news.allowEarningsTrades` is true. Notes whose `riskFlags` intersect `news.blockingFlags` (default `['halt','legal']`) are rejected with `news risk flag: <flag>`. Proposals carry `notes`, `riskFlags`, `earningsInDays`.
- **Settings**: `news: {enabled:true, maxSymbols:30 (1-60), earningsBlackoutDays:2 (0-10), allowEarningsTrades:false, blockingFlags:['halt','legal'] (subset of the flag enum)}` via `PATCH /api/settings {news:{...}}` (partial, validated, unknown fields → 400).
- **Run record** `news: {status:'ok'|'partial'|'skipped'|'error', reason, symbols, headlines, earningsKnown, costUsd, notes, model?}` on `/api/status` → `run.news`, `/api/runs`, `/api/ai/summary`; proposals rejected by the guard are listed in the run's `newsBlocked`. While it runs `run.stage` is `news`. Reasons include: turned off, no Alpaca credentials, no Finnhub key, no headlines, budget kept for the trader, AI error code.
- **Research endpoints**: `GET /api/research?runId=&symbol=&limit=` (newest first) and `GET /api/research/latest` (latest note per symbol); notes persist in `data/research-notes.json` and Supabase `research_notes` (migration 006).
- Upstream calls use fixed host allow-lists (`data.alpaca.markets`, `finnhub.io`), 10 s timeouts, at most 3 attempts with backoff on 429/5xx and small caches (news 10 min, earnings 6 h).

### Dev/test only: `MOCK_NEWS`

`MOCK_NEWS=true` stubs the Alpaca-news and Finnhub clients with deterministic headlines and earnings dates (and `MOCK_LLM` answers the news bot with canned notes, including an `earnings_imminent` case), so the whole pipeline runs with no keys. Like `MOCK_LLM` it is **refused** (ignored, loud warning, logged) when `NODE_ENV=production` or `RENDER` is set (`/api/health` → `mockNews`).

### Environment variables added

| Variable | Default | Purpose |
|---|---|---|
| `MONTHLY_AI_BUDGET_USD` | `20` | Hard monthly cap on AI spend (also editable in Settings) |
| `PROPOSAL_TTL_HOURS` | `6` | Default proposal lifetime (setting `proposalTtlHours`) |
| `NEWS_MODEL` | `deepseek/deepseek-chat-v3.1` | Model of the news & earnings bot (overridable under Settings) |
| `FINNHUB_API_KEY` | unset | Free Finnhub key for earnings dates (fallback; the account key overrides it) |
| `MOCK_NEWS` | unset | Dev/test canned headlines/earnings; refused in production/Render |
| `MOCK_LLM` | unset | Dev/test canned LLM; refused in production/Render |

## Operational notes

- **Trading day**: daily P&L / loss halt use the US/Eastern calendar day. Market hours model NYSE holidays and half-days for 2025-2027 (static list in `server/services/market.js`; extend yearly).
- **Time exit**: a position past its horizon is flagged `expired`/`expiredAt` and closes at the first fresh bar (stocks wait for the next session).
- **Rate limits / proxies**: set `TRUST_PROXY=true` behind Render/nginx, otherwise every client shares one bucket (a startup warning is logged on Render / `NODE_ENV=production`). Dashboard GET polling has its own 1200/min bucket; other API calls 300/min; `POST /api/run` 10 per 10 min (no charge for "already running" replies).
- **Storage**: JSON files are cached in memory (write-through). Closed positions beyond 1000 move to `data/positions-archive.json`.
