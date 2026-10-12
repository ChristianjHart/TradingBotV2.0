# Kronos forecast (optional)

[Kronos](https://huggingface.co/NeoQuasar/Kronos-base) is a model for candlestick (price) data. It is not a chat model, so it cannot run through OpenRouter. It needs a small Python service that you host.

## What the bot does with it
1. Sends the last ~400 hourly bars of the symbol to the service.
2. The service draws many possible future price paths (default 30) for the trade's horizon.
3. The bot replays each path against the trade's stop and target. A path that touches both in one hour counts as a stop.
4. The card shows: share of paths that end in profit, share that hit target, share that hit stop.
5. The result is saved on the proposal. Loss review scores it like the AI checker (`/api/review` -> `kronos`).

It is advice only. It never approves or rejects. It uses no AI budget.

## Run it
```
git clone https://github.com/shiyu-coder/Kronos
pip install -r Kronos/requirements.txt
KRONOS_REPO=./Kronos python3 scripts/kronos_server.py     # 127.0.0.1:8765
KRONOS_URL=http://127.0.0.1:8765 npm start
```
Kronos-base has about 100M parameters. It runs on a CPU, slowly (expect tens of seconds for 30 paths). A GPU is much faster.

## Where to host it
- **Your own computer:** the bot and the service must be able to reach each other, so run the bot on the same computer (or tunnel the port).
- **A small cloud VM** with 4+ GB RAM (CPU is enough). Keep the port private (firewall or private network). The service has no login.
- **A GPU host (Modal, RunPod, a GPU VM):** fastest, costs more.
- Render free plans are too small for it.

`KRONOS_URL` is read from the environment only, never from the browser.

## Status
`scripts/kronos_server.py` follows the Kronos README but was **not run against the real weights** when written. The bot side is tested with a stand-in service. Check the first forecasts by hand. Expect the scorecard to need 20+ forecast trades before it says anything.
