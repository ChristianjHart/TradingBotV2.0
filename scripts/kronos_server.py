#!/usr/bin/env python3
"""Small HTTP service that runs the Kronos candlestick model for the trading bot.  See docs/KRONOS.md.

Setup (once):  git clone https://github.com/shiyu-coder/Kronos  &&  pip install -r Kronos/requirements.txt  &&  pip install torch
Run:           KRONOS_REPO=./Kronos python3 scripts/kronos_server.py          (listens on 127.0.0.1:8765)
Then set KRONOS_URL=http://127.0.0.1:8765 for the bot.

UNTESTED against the real weights when this file was written: the Kronos API calls below follow its README. If a call fails, the bot shows
"forecast_failed" and the traceback is printed here.
POST /forecast  {"symbol", "bars":[{t,o,h,l,c,v}...], "horizon": hours, "samples": n}  ->  {"model", "paths": [[{o,h,l,c}...horizon] ...]}
"""
import json, os, sys, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.environ.get("KRONOS_REPO", "./Kronos"))
import pandas as pd  # noqa: E402
import torch  # noqa: E402
from model import Kronos, KronosPredictor, KronosTokenizer  # noqa: E402

MODEL_ID = os.environ.get("KRONOS_MODEL", "NeoQuasar/Kronos-base")
TOKENIZER_ID = os.environ.get("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base")
DEVICE = os.environ.get("KRONOS_DEVICE", "cuda:0" if torch.cuda.is_available() else "cpu")
HOST, PORT = os.environ.get("KRONOS_HOST", "127.0.0.1"), int(os.environ.get("KRONOS_PORT", "8765"))
MAX_BYTES, MAX_SAMPLES, MAX_HORIZON = 2_000_000, 100, 48

print(f"loading {MODEL_ID} on {DEVICE} ...", flush=True)
predictor = KronosPredictor(Kronos.from_pretrained(MODEL_ID), KronosTokenizer.from_pretrained(TOKENIZER_ID), device=DEVICE, max_context=512)
print("ready", flush=True)


def draw_paths(predictor, x, x_ts, y_ts, horizon, samples, chunk=16):
    """`samples` different future paths. Uses the library's batch call (one GPU pass per chunk); falls back to one call per path."""
    outs = []
    done = 0
    while done < samples:
        n = min(chunk, samples - done)
        try:
            outs += predictor.predict_batch([x] * n, [x_ts] * n, [y_ts] * n, horizon, T=1.0, top_p=0.9, sample_count=1, verbose=False)
        except (AttributeError, TypeError):  # older Kronos without predict_batch: slower, same result
            outs += [predictor.predict(df=x, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=horizon, T=1.0, top_p=0.9, sample_count=1, verbose=False) for _ in range(n)]
        done += n
    return [[{"o": float(r.open), "h": float(r.high), "l": float(r.low), "c": float(r.close)} for r in out.itertuples()] for out in outs]


def forecast(req):
    bars = req["bars"]
    horizon = max(1, min(MAX_HORIZON, int(req["horizon"])))
    samples = max(1, min(MAX_SAMPLES, int(req["samples"])))
    df = pd.DataFrame(bars)
    ts = pd.to_datetime(df["t"], utc=True).dt.tz_localize(None)
    x = pd.DataFrame({"open": df["o"], "high": df["h"], "low": df["l"], "close": df["c"], "volume": df["v"].fillna(0)})
    x["amount"] = x["volume"] * x[["open", "high", "low", "close"]].mean(axis=1)
    x_ts = pd.Series(ts.values)
    y_ts = pd.Series(pd.date_range(ts.iloc[-1] + pd.Timedelta(hours=1), periods=horizon, freq="h"))
    paths = draw_paths(predictor, x, x_ts, y_ts, horizon, samples)
    return {"model": MODEL_ID, "paths": paths}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/forecast":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("content-length", "0"))
            if n <= 0 or n > MAX_BYTES:
                return self._send(413, {"error": "bad size"})
            self._send(200, forecast(json.loads(self.rfile.read(n))))
        except Exception:
            traceback.print_exc()
            self._send(500, {"error": "forecast failed"})

    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
