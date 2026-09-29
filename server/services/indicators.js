/** Lightweight technical indicators for the prediction model */

export function sma(values, period) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(closes, period = 14) {
  if (closes.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function macd(closes) {
  if (closes.length < 35) return null;
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (ema12 == null || ema26 == null) return null;
  const line = ema12 - ema26;
  // Approximate signal with short SMA of recent MACD proxies
  const recent = [];
  for (let i = Math.max(26, closes.length - 9); i <= closes.length; i++) {
    const e12 = ema(closes.slice(0, i), 12);
    const e26 = ema(closes.slice(0, i), 26);
    if (e12 != null && e26 != null) recent.push(e12 - e26);
  }
  const signal = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : line;
  return { line, signal, hist: line - signal };
}

export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - prev),
      Math.abs(bars[i].l - prev),
    );
    trs.push(tr);
  }
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

export function extractFeatures(bars) {
  const closes = bars.map((b) => b.c);
  const volumes = bars.map((b) => b.v);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] || last;

  const momentum5 = closes.length > 5 ? (last - closes[closes.length - 6]) / closes[closes.length - 6] : 0;
  const momentum20 = closes.length > 20 ? (last - closes[closes.length - 21]) / closes[closes.length - 21] : momentum5;
  const rsiVal = rsi(closes) ?? 50;
  const macdVal = macd(closes);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const sma50 = sma(closes, 50);
  const volSma = sma(volumes, 20) || volumes[volumes.length - 1];
  const volRatio = volSma ? volumes[volumes.length - 1] / volSma : 1;
  const atrVal = atr(bars) || last * 0.01;
  const volatility = last ? atrVal / last : 0.01;

  return {
    price: last,
    change1: prev ? (last - prev) / prev : 0,
    momentum5,
    momentum20,
    rsi: rsiVal,
    macdHist: macdVal?.hist ?? 0,
    macdLine: macdVal?.line ?? 0,
    trend: ema9 != null && ema21 != null ? (ema9 - ema21) / last : 0,
    aboveSma50: sma50 != null ? (last - sma50) / sma50 : 0,
    volumeRatio: volRatio,
    volatility,
    ema9,
    ema21,
    sma50,
    vwapApprox: sma(closes.slice(-20), Math.min(20, closes.length)),
  };
}
