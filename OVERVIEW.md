# TradingBot V2.0 — Overview

A **predict-only** market scanner and dashboard. It scans stocks + crypto, makes long/short predictions, checks later whether they were right, and tunes itself from the results. **It never places trades** (`tradingEnabled` is hard-locked to `false`).

## Stack
- Node 18+ / Express (ES modules), `node-cron` for schedules
- Vanilla JS frontend (no build step) served from `public/`
- JSON-file storage in `data/` (ephemeral on Render free tier)
- Alpaca market data (optional) — mock data is used when no keys are set

## How it works
1. **Scan** (`services/scanner.js`) – every `SCAN_INTERVAL_MINUTES` (default 30) pulls bars for a stock + crypto universe.
2. **Predict** (`services/predictor.js`, `indicators.js`) – computes momentum, RSI, MACD, volume, trend, volatility → weighted score → direction (long/short/neutral), confidence, expected move. Top picks form the daily watchlist and are logged as predictions with a horizon (default 24h).
3. **Evaluate** (`services/evaluator.js`) – every 15 min, resolves predictions past their horizon as hit/miss vs. current price.
4. **Train** (`services/trainer.js`) – nudges the feature weights based on hits/misses (simple, inspectable online learning).

## Layout
```
server/
  index.js          Express app, cron jobs, boot scan
  config.js         Env config
  routes/api.js     REST API
  services/         alpaca, scanner, predictor, indicators, evaluator, trainer
  db/store.js       JSON file store (watchlist, predictions, model, logs, settings)
  cli/              `npm run scan`, `npm run evaluate`
public/
  index.html, css/dashboard.css
  js/app.js         Dashboard UI
  js/charts.js      Candle chart (EMA/VWAP/volume) + TradingView embeds
  js/api.js         API client
render.yaml         Render.com blueprint
```

## Key API endpoints
`GET /api/health` · `/api/dashboard` · `/api/watchlist` · `/api/predictions` · `/api/accuracy` · `/api/model` · `/api/logs` · `/api/market/{quote,bars,quotes}` · `POST /api/scan` · `/api/evaluate` · `/api/train` · `PATCH /api/settings` · `POST /api/worker/{start,stop,kill}`

## Run it
```bash
cp .env.example .env
npm install
npm start        # http://localhost:3000
```
Env vars: `PORT`, `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `USE_MOCK_DATA`, `SCAN_INTERVAL_MINUTES`, `WATCHLIST_SIZE`, `PREDICTION_HORIZON_HOURS`.
