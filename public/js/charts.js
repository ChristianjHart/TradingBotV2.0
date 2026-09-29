/** Mini candlestick + indicator canvas chart */

function ema(values, period) {
  if (values.length < period) return values.map(() => null);
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

export function drawCandleChart(canvas, bars, indicators = {}) {
  if (!canvas || !bars?.length) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const w = rect.width;
  const h = rect.height;
  const padL = 8;
  const padR = 56;
  const padT = 10;
  const padB = indicators.vol ? 48 : 16;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#15171d';
  ctx.fillRect(0, 0, w, h);

  const slice = bars.slice(-80);
  const highs = slice.map((b) => b.h);
  const lows = slice.map((b) => b.l);
  let min = Math.min(...lows);
  let max = Math.max(...highs);
  const pad = (max - min) * 0.08 || 1;
  min -= pad;
  max += pad;

  const closes = slice.map((b) => b.c);
  const ema9 = indicators.ema9 ? ema(closes, 9) : null;
  const ema21 = indicators.ema21 ? ema(closes, 21) : null;
  const vwap = indicators.vwap ? sma(closes, Math.min(20, closes.length)) : null;

  const xAt = (i) => padL + (i + 0.5) * (plotW / slice.length);
  const yAt = (v) => padT + ((max - v) / (max - min)) * plotH;
  const candleW = Math.max(2, (plotW / slice.length) * 0.65);

  // grid
  ctx.strokeStyle = '#1e2128';
  ctx.lineWidth = 1;
  for (let i = 0; i < 4; i++) {
    const y = padT + (plotH / 3) * i;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
  }

  // candles
  slice.forEach((b, i) => {
    const x = xAt(i);
    const up = b.c >= b.o;
    ctx.strokeStyle = up ? '#22c55e' : '#ef4444';
    ctx.fillStyle = up ? '#22c55e' : '#ef4444';
    ctx.beginPath();
    ctx.moveTo(x, yAt(b.h));
    ctx.lineTo(x, yAt(b.l));
    ctx.stroke();
    const top = yAt(Math.max(b.o, b.c));
    const bot = yAt(Math.min(b.o, b.c));
    ctx.fillRect(x - candleW / 2, top, candleW, Math.max(1, bot - top));
  });

  function drawLine(series, color) {
    if (!series) return;
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    let started = false;
    series.forEach((v, i) => {
      if (v == null) return;
      const x = xAt(i);
      const y = yAt(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  drawLine(ema9, '#eab308');
  drawLine(ema21, '#3b82f6');
  drawLine(vwap, '#a855f7');

  // volume
  if (indicators.vol) {
    const maxV = Math.max(...slice.map((b) => b.v));
    const volH = 36;
    const volTop = h - padB + 6;
    slice.forEach((b, i) => {
      const x = xAt(i);
      const vh = (b.v / maxV) * volH;
      ctx.fillStyle = b.c >= b.o ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)';
      ctx.fillRect(x - candleW / 2, volTop + volH - vh, candleW, vh);
    });
  }

  // price label
  const last = slice[slice.length - 1];
  const py = yAt(last.c);
  ctx.fillStyle = last.c >= last.o ? '#22c55e' : '#ef4444';
  ctx.beginPath();
  const label = last.c.toFixed(2);
  ctx.font = '11px IBM Plex Sans, sans-serif';
  const tw = ctx.measureText(label).width + 10;
  ctx.roundRect?.(w - padR + 4, py - 9, tw, 18, 4);
  if (ctx.roundRect) ctx.fill();
  else ctx.fillRect(w - padR + 4, py - 9, tw, 18);
  ctx.fillStyle = '#0b0c0e';
  ctx.fillText(label, w - padR + 9, py + 4);

  // legend
  const legend = [];
  if (indicators.ema9) legend.push(['EMA 9', '#eab308']);
  if (indicators.ema21) legend.push(['EMA 21', '#3b82f6']);
  if (indicators.vwap) legend.push(['VWAP', '#a855f7']);
  let lx = padL;
  const ly = h - 6;
  ctx.font = '10px IBM Plex Sans, sans-serif';
  legend.forEach(([name, color]) => {
    ctx.fillStyle = color;
    ctx.fillRect(lx, ly - 8, 8, 8);
    ctx.fillStyle = '#8b919c';
    ctx.fillText(name, lx + 12, ly);
    lx += ctx.measureText(name).width + 28;
  });
}
