# TradingBot V2.0

AI market scanner & prediction dashboard. Same look and feel as the classic tradingbot UI — **new backend that never places trades**.

## What it does

- **Super-scans** equities + crypto (Alpaca when configured, mock data otherwise)
- Builds a **daily watchlist** with direction, confidence, and expected move
- Logs **predictions** with a horizon (default 24h) — long / short only, no orders
- **Evaluates** predictions after they resolve (hit / miss)
- **Trains** a lightweight scoring model from outcomes so the scanner improves over time
- Embeds **TradingView** charts + a custom candle chart with EMA / VWAP / volume

## Quick start

```bash
cp .env.example .env
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000).

### Alpaca (optional but recommended)

Add paper keys to `.env`:

```
ALPACA_API_KEY=...
ALPACA_API_SECRET=...
USE_MOCK_DATA=false
```

The app only uses Alpaca for **market data**. Order endpoints are never called.

## Dashboard map (old UI → new meaning)

| Old widget | V2.0 |
|---|---|
| Allocation | Open prediction mix (long / short / watch) |
| Portfolio | Prediction accuracy over time |
| Buying power | Scanner coverage (scanned / universe) |
| Positions | Open predictions |
| Recent trades | Settled hit / miss results |
| Bot performance | AI accuracy + model version |
| Bot log | AI / scanner log |
| Strategies | Signal engines (trading router stays OFF) |

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/dashboard` | Full dashboard payload |
| POST | `/api/scan` | Run a full market scan |
| GET | `/api/watchlist` | Today's AI watchlist |
| GET | `/api/predictions` | Prediction history |
| POST | `/api/evaluate` | Resolve due predictions |
| POST | `/api/train` | Retrain model weights |
| GET | `/api/accuracy` | Hit rate stats |
| POST | `/api/worker/stop` \| `/kill` \| `/start` | Worker controls |

## Stack

- Node.js + Express
- File-backed JSON store in `data/`
- Vanilla SPA frontend matching the classic dark tradingbot chrome
- `node-cron` for periodic scan + evaluate cycles
