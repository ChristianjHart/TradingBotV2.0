"""Kronos forecast service on Modal (serverless GPU). See docs/KRONOS.md.

    pip install modal && modal setup
    modal secret create kronos-token KRONOS_TOKEN=<a long random string>
    modal deploy scripts/kronos_modal.py        # prints the https URL

Then set KRONOS_URL=<that URL> and KRONOS_TOKEN=<the same string> for the bot.
It scales to zero, so you pay only while a forecast runs. Written from the Modal and Kronos docs, NOT yet run against the real weights.
"""
import hmac, os

import modal

MODEL_ID, TOKENIZER_ID = "NeoQuasar/Kronos-base", "NeoQuasar/Kronos-Tokenizer-base"
MAX_SAMPLES, MAX_HORIZON = 100, 48

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .run_commands("git clone --depth 1 https://github.com/shiyu-coder/Kronos /root/Kronos")
    .run_commands("pip install -r /root/Kronos/requirements.txt")
    .pip_install("torch", "fastapi[standard]", "huggingface_hub")
    .env({"HF_HOME": "/cache/hf"})
)
cache = modal.Volume.from_name("kronos-cache", create_if_missing=True)  # model weights are downloaded once, then reused
app = modal.App("kronos-forecast", image=image)


@app.cls(gpu="T4", volumes={"/cache": cache}, secrets=[modal.Secret.from_name("kronos-token")], scaledown_window=120, timeout=900)
class Forecaster:
    @modal.enter()
    def load(self):
        import sys

        sys.path.insert(0, "/root/Kronos")
        from model import Kronos, KronosPredictor, KronosTokenizer

        self.predictor = KronosPredictor(Kronos.from_pretrained(MODEL_ID), KronosTokenizer.from_pretrained(TOKENIZER_ID), device="cuda:0", max_context=512)

    def run(self, req: dict) -> dict:
        import pandas as pd

        bars = req["bars"]
        horizon = max(1, min(MAX_HORIZON, int(req["horizon"])))
        samples = max(1, min(MAX_SAMPLES, int(req["samples"])))
        df = pd.DataFrame(bars)
        ts = pd.to_datetime(df["t"], utc=True).dt.tz_localize(None)
        x = pd.DataFrame({"open": df["o"], "high": df["h"], "low": df["l"], "close": df["c"], "volume": df["v"].fillna(0)})
        x["amount"] = x["volume"] * x[["open", "high", "low", "close"]].mean(axis=1)
        x_ts = pd.Series(ts.values)
        y_ts = pd.Series(pd.date_range(ts.iloc[-1] + pd.Timedelta(hours=1), periods=horizon, freq="h"))
        paths = []
        for _ in range(samples):  # one draw per call: the library averages inside a call when sample_count > 1
            out = self.predictor.predict(df=x, x_timestamp=x_ts, y_timestamp=y_ts, pred_len=horizon, T=1.0, top_p=0.9, sample_count=1, verbose=False)
            paths.append([{"o": float(r.open), "h": float(r.high), "l": float(r.low), "c": float(r.close)} for r in out.itertuples()])
        return {"model": MODEL_ID, "paths": paths}

    @modal.asgi_app()
    def web(self):
        from fastapi import FastAPI, Header, HTTPException, Request

        api = FastAPI()
        token = os.environ.get("KRONOS_TOKEN", "")

        @api.post("/forecast")
        async def forecast(request: Request, authorization: str = Header(default="")):
            if not token or not hmac.compare_digest(authorization, f"Bearer {token}"):
                raise HTTPException(status_code=401, detail="bad token")
            body = await request.body()
            if len(body) > 2_000_000:
                raise HTTPException(status_code=413, detail="too large")
            import json

            return self.run(json.loads(body))

        return api
