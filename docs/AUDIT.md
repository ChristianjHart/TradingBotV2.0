# TradingBot V2.0 — Audit (Round 0)

Scored against the rubric below (100 pts). Target: **> 89**. Evidence = code read + screenshots of the running app (mock mode).

## Rubric
| # | Category | Max |
|---|---|---|
| 1 | Visual design & consistency | 10 |
| 2 | Information hierarchy / dashboard clarity | 12 |
| 3 | Interaction & feedback (loading, progress, toasts) | 12 |
| 4 | Accessibility | 10 |
| 5 | Responsive / mobile | 8 |
| 6 | Perceived performance & live updates | 8 |
| 7 | Error handling & empty states | 8 |
| 8 | Trust & data transparency (mock/stale/failed data, accuracy honesty) | 10 |
| 9 | Prediction/trade logic quality & risk controls | 12 |
| 10 | Security, robustness, tests | 10 |

## Round 0 score: **54 / 100**
| Category | Score | Why |
|---|---|---|
| Visual design | 7/10 | Cohesive dark theme; old pages (Market/AI Desk/Decisions/Strategies) inconsistent with new dashboard |
| Hierarchy | 8/12 | New dashboard is clear; dead nav items (Chat, Strategies, Activity) and legacy pages confuse |
| Interaction & feedback | 5/12 | `alert()`/`confirm()`, no stepper/elapsed time, no cancel, silent failures |
| Accessibility | 2/10 | Almost no aria, rows are click-only divs, canvases have no text alternative, no focus styles audit |
| Responsive | 4/8 | One breakpoint; tables overflow; canvas doesn't resize on window resize |
| Perceived perf | 4/8 | Whole page re-rendered every 20s (flicker, scroll/selection loss); 119 sequential-ish Alpaca calls per run |
| Errors/empty | 4/8 | Some empty states; API failures shown as raw text; run errors only in a popup |
| Trust/transparency | 5/10 | Mock/fallback banners good; but "Model accuracy" only counts closed sim trades, no calibration, stale/closed-market prices not flagged |
| Trade logic | 5/12 | ATR stops OK; but no time exit, no slippage/fees, crypto shorts allowed, no exposure/sector caps, stop fills ignore gaps, one-shot LLM with hourly bars only |
| Security/robustness/tests | 3/10 | **No auth on any API** (anyone can RUN → spend OpenRouter credits, close/kill), fake "Sign out", open CORS, no rate limit, no tests, non-atomic JSON writes |

## Top 20 improvements
Security / robustness
1. **API auth**: optional `ADMIN_TOKEN` (Bearer). Mutating + costly endpoints (`/run`, `/positions/*/close`, `/worker/*`, `/settings`, `/scan`, `/train`) require it when set; restrict CORS to same-origin; frontend prompts for token, stores in localStorage, replaces the fake Sign-out.
2. **Input validation + rate limiting**: whitelist `PATCH /settings` fields, body size limit, simple in-memory rate limit on `/run`.
3. **Atomic JSON writes** (temp + rename) and debounced log writes; log retention for Supabase (`npm run` prune script or SQL).
4. **Tests + CI**: `node:test` unit tests (indicators, trader validation/clamping, positions monitor, supabase normalize) + GitHub Actions workflow running `npm test` and syntax checks.

Accuracy / trading logic
5. **Time-based exit**: positions expire at horizon (default 24h) and close at market price with reason `time-exit`; `expiresAt` on each position.
6. **Realistic fills**: configurable slippage + fee bps applied to entry/exit; gap-aware stop/target fills (if a bar opens beyond the level, fill at open).
7. **Market-hours awareness**: mark stock quotes stale when US market closed; don't monitor/close stock stops on stale data; no shorting crypto (Alpaca can't) — enforce in trader validation and prompt.
8. **Portfolio risk engine**: max gross exposure, max per-asset-class exposure, max positions per sector/group, daily loss halt (no new trades if realized+open P&L < −X% today).
9. **Trailing stop / break-even**: after +1R move stop to entry; optional trailing by ATR; recorded on the position.
10. **Richer scanner input**: add daily-timeframe context (5d/20d returns, distance from 20d high/low), relative strength vs SPY/BTC, and market regime line; enforce long/short balance guidance and de-duplication.
11. **Pick accuracy + calibration**: score every scanner pick after its horizon (direction hit/miss vs price then), store it, expose confidence-bucket hit rates (`/api/performance`), use for the Model Accuracy widget.
12. **Retire the legacy prediction pipeline** (old cron scan/evaluator/trainer/Decisions/AI Desk data) or rewire pages to the new bots — one source of truth; remove dead nav items.
13. **Data quality + efficiency**: retry/backoff and 429 handling for Alpaca, bar validation (gaps, zero volume), per-run bar cache, use multi-symbol bars endpoint.
14. **Persist runs**: save every run summary (+ trades, rejected) to Supabase `runs` table (add migration `002_runs.sql`) and restore latest on boot; equity snapshots for the curve.

Frontend / UX
15. **Live updates without full re-render**: patch changed widgets, keep scroll/selection/chart; pause polling while tab hidden.
16. **Run UX**: stepper (Fetch → Scanner bot → Trader bot) with elapsed timer, toasts instead of `alert()`, accessible modal instead of `confirm()`, disable/label states.
17. **Performance page/widget**: equity curve chart, win rate, avg R, max drawdown, confidence calibration, AI-vs-rules comparison.
18. **Positions table upgrades**: sortable columns, distance-to-stop/target progress bar, total open risk, close-all, time-left countdown, expired/closed history tab.
19. **Chart upgrades**: resize handling, crosshair tooltip with OHLC, entry/stop/target/exit markers, live price line, timeframe toggle.
20. **Accessibility + responsive pass**: aria labels/roles, keyboard-operable rows/tabs, focus rings, contrast ≥ 4.5:1, `prefers-reduced-motion`, canvas text summary, tables→cards on mobile, skeleton loaders, remove dead nav.

## Contracts between backend and frontend (so they can work in parallel)
- Auth: header `Authorization: Bearer <ADMIN_TOKEN>`; protected endpoints return `401 {error:'unauthorized'}`. `GET /api/health` and `GET /api/auth/status` → `{required:boolean}` are public. `GET`s of dashboard data stay public.
- Position object gains: `expiresAt` (ISO), `initialStop`, `trailing` (bool), `fees`, `slippage`, `exitReason` ∈ `stop-loss|take-profit|time-exit|manual|trailing-stop`.
- `GET /api/performance` → `{ equityCurve:[{t,equity}], winRate, closed, wins, avgR, maxDrawdownPct, realizedPnl, calibration:[{bucket:'50-60%',n,hitRate}], pickAccuracy:{hits,total}, byBot:{ai:{closed,winRate,pnl},rules:{closed,winRate,pnl}} }`
- `GET /api/ai/summary` unchanged plus `runId`. `GET /api/runs?limit=20` → `{runs:[summary…]}`.
- `POST /api/positions/close-all` → `{closed:n}`.
- `GET /api/status` gains `marketOpen:boolean`, `staleSymbols:[…]`.
