# Kronos forecast (optional)

[Kronos](https://huggingface.co/NeoQuasar/Kronos-base) is a model for candlestick (price) data. It is not a chat model, so it cannot run through OpenRouter. It needs a small Python service that you host.

## What the bot does with it
1. Sends the last ~400 hourly bars of the symbol to the service.
2. The service draws many possible future price paths (default 30) for the trade's horizon.
3. The bot replays each path against the trade's stop and target. A path that touches both in one hour counts as a stop.
4. The card shows: share of paths that end in profit, share that hit target, share that hit stop.
5. The result is saved on the proposal. Loss review scores it like the AI checker (`/api/review` -> `kronos`).

It is advice only. It never approves or rejects. It uses no AI budget.

## Saved forecasts and the comparison chart
Each forecast is saved on the proposal: the middle 80% band (p10, median, p90 close for every hour), the start time and start price. After the forecast's hours are over, the real closes are saved next to it. Loss review > "Kronos forecasts vs real prices" draws both, with the entry, stop and target lines, and scores them: how many hours the real price stayed inside the band (about 80% if it is a good forecast), and whether the median path pointed the right way. The forecast is refused when the latest bar price differs from the proposal entry by more than 15% (bad data).

## Auto-forecast
Settings > Kronos forecast > "Forecast every new proposal automatically" (off by default). After each run, the new proposals are forecast one after another in the background. It needs `KRONOS_URL`; it uses GPU time on your host, not AI budget.

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

## Modal (serverless GPU)
```
pip install modal && modal setup                       # log in
modal secret create kronos-token KRONOS_TOKEN=<long random string>
modal deploy scripts/kronos_modal.py                   # prints https://...modal.run
```
Then give the bot `KRONOS_URL=<that URL>` and `KRONOS_TOKEN=<same string>`. The service refuses calls without the token. It uses a T4 GPU, scales to zero when idle, and bills only while it runs. The first call after idle loads the model (about a minute).

## Status
`scripts/kronos_server.py` follows the Kronos README but was **not run against the real weights** when written. The bot side is tested with a stand-in service. Check the first forecasts by hand. Expect the scorecard to need 20+ forecast trades before it says anything.
