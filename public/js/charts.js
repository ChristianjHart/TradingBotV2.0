/** Canvas charts: candlesticks (crosshair/tooltip/markers/live line) and a simple line chart. */

const C = {
  bg: '#15171d',
  grid: '#232730',
  text: '#a6acb7',
  up: '#22c55e',
  down: '#ef4444',
  ink: '#0b0c0e',
  live: '#22d3ee',
};

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

/** Aggregate hourly bars to 4H / 1D buckets (client-side; the API returns hourly bars). */
export function aggregateBars(bars, tf) {
  if (tf === '1H' || !bars.length) return bars;
  const out = [];
  if (tf === '4H') {
    for (let i = bars.length % 4; i < bars.length; i += 4) out.push(merge(bars.slice(i, i + 4)));
    return out;
  }
  let cur = [];
  let day = null;
  for (const b of bars) {
    const d = String(b.t).slice(0, 10);
    if (day !== null && d !== day) {
      out.push(merge(cur));
      cur = [];
    }
    day = d;
    cur.push(b);
  }
  if (cur.length) out.push(merge(cur));
  return out;
}
function merge(g) {
  return {
    t: g[0].t,
    o: g[0].o,
    h: Math.max(...g.map((b) => b.h)),
    l: Math.min(...g.map((b) => b.l)),
    c: g[g.length - 1].c,
    v: g.reduce((a, b) => a + (b.v || 0), 0),
  };
}

function fit(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(50, rect.width);
  const h = Math.max(50, rect.height);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

function fmtP(v) {
  const a = Math.abs(v);
  return v.toFixed(a >= 1000 ? 1 : a >= 1 ? 2 : 4);
}
function fmtT(t) {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? String(t) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function tooltipBox(ctx, w, x, y, lines, padTop = 4) {
  ctx.font = '11px IBM Plex Mono, monospace';
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
  const th = lines.length * 14 + 8;
  let bx = x + 12;
  if (bx + tw > w - 4) bx = x - 12 - tw;
  if (bx < 4) bx = 4;
  const by = Math.max(padTop, y - th / 2);
  ctx.fillStyle = 'rgba(11,12,14,0.94)';
  ctx.strokeStyle = '#3a3f4b';
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(bx, by, tw, th, 4);
  else ctx.rect(bx, by, tw, th);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#e8eaed';
  ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + 7, by + 5 + i * 14));
  ctx.textBaseline = 'alphabetic';
}

export class CandleChart {
  constructor(canvas, { summaryEl } = {}) {
    this.canvas = canvas;
    this.summaryEl = summaryEl;
    this.bars = [];
    this.ind = {};
    this.levels = [];
    this.markers = [];
    this.live = null;
    this.hover = null;
    this.title = '';
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    this._draw = () => this.draw();
    this.ro = new ResizeObserver(() => requestAnimationFrame(this._draw));
    this.ro.observe(canvas.parentElement || canvas);
    canvas.addEventListener('mousemove', (e) => this._move(e.clientX));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    canvas.addEventListener('touchmove', (e) => e.touches[0] && this._move(e.touches[0].clientX), { passive: true });
    canvas.addEventListener('keydown', (e) => {
      if (!this.vis?.length) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const cur = this.hover ?? this.vis.length - 1;
        this.hover = Math.min(this.vis.length - 1, Math.max(0, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
        this.draw();
      } else if (e.key === 'Escape') {
        this.hover = null;
        this.draw();
      }
    });
    canvas.addEventListener('blur', () => {
      this.hover = null;
      this.draw();
    });
  }

  destroy() {
    this.ro.disconnect();
  }

  set({ bars, indicators, levels, markers, live, title }) {
    if (bars) this.bars = bars;
    if (indicators) this.ind = indicators;
    if (levels) this.levels = levels;
    if (markers) this.markers = markers;
    if (live !== undefined) this.live = live;
    if (title !== undefined) this.title = title;
    this.draw();
  }

  _move(clientX) {
    if (!this.geom || !this.vis?.length) return;
    const rect = this.canvas.getBoundingClientRect();
    const i = Math.floor((clientX - rect.left - this.geom.padL) / (this.geom.plotW / this.vis.length));
    const c = Math.min(this.vis.length - 1, Math.max(0, i));
    if (c !== this.hover) {
      this.hover = c;
      this.draw();
    }
  }

  draw() {
    const canvas = this.canvas;
    if (!canvas.isConnected) return;
    const { ctx, w, h } = fit(canvas);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);
    const slice = this.bars.slice(-80);
    this.vis = slice;
    if (!slice.length) {
      ctx.fillStyle = C.text;
      ctx.font = '12px IBM Plex Sans, sans-serif';
      ctx.fillText('No price data', 12, 24);
      this._summary('No price data available.');
      return;
    }
    const ind = this.ind;
    const padL = 8;
    const padR = 58;
    const padT = 10;
    const padB = ind.vol ? 48 : 20;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    this.geom = { padL, plotW };

    const extra = [...this.levels.map((l) => l.price), ...(this.live != null ? [this.live] : [])].filter(Number.isFinite);
    let min = Math.min(...slice.map((b) => b.l), ...extra);
    let max = Math.max(...slice.map((b) => b.h), ...extra);
    const pad = (max - min) * 0.08 || 1;
    min -= pad;
    max += pad;
    const closes = slice.map((b) => b.c);
    const xAt = (i) => padL + (i + 0.5) * (plotW / slice.length);
    const yAt = (v) => padT + ((max - v) / (max - min)) * plotH;
    const cw = Math.max(2, (plotW / slice.length) * 0.65);

    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.fillStyle = C.text;
    ctx.font = '10px IBM Plex Mono, monospace';
    for (let i = 0; i < 4; i++) {
      const y = padT + (plotH / 3) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.fillText(fmtP(max - ((max - min) / 3) * i), w - padR + 5, y + 3);
    }

    slice.forEach((b, i) => {
      const x = xAt(i);
      const up = b.c >= b.o;
      ctx.strokeStyle = ctx.fillStyle = up ? C.up : C.down;
      ctx.beginPath();
      ctx.moveTo(x, yAt(b.h));
      ctx.lineTo(x, yAt(b.l));
      ctx.stroke();
      const top = yAt(Math.max(b.o, b.c));
      ctx.fillRect(x - cw / 2, top, cw, Math.max(1, yAt(Math.min(b.o, b.c)) - top));
    });

    const line = (series, color) => {
      if (!series) return;
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.4;
      let s = false;
      series.forEach((v, i) => {
        if (v == null) return;
        if (!s) {
          ctx.moveTo(xAt(i), yAt(v));
          s = true;
        } else ctx.lineTo(xAt(i), yAt(v));
      });
      ctx.stroke();
    };
    if (ind.ema9) line(ema(closes, 9), '#eab308');
    if (ind.ema21) line(ema(closes, 21), '#3b82f6');
    if (ind.vwap) line(sma(closes, Math.min(20, closes.length)), '#a855f7');

    if (ind.vol) {
      const maxV = Math.max(...slice.map((b) => b.v || 0)) || 1;
      const volTop = h - padB + 6;
      slice.forEach((b, i) => {
        const vh = ((b.v || 0) / maxV) * 32;
        ctx.fillStyle = b.c >= b.o ? 'rgba(34,197,94,0.35)' : 'rgba(239,68,68,0.35)';
        ctx.fillRect(xAt(i) - cw / 2, volTop + 32 - vh, cw, vh);
      });
    }

    // level lines (target / entry / stop)
    ctx.font = '10px IBM Plex Sans, sans-serif';
    this.levels.forEach((l) => {
      if (!Number.isFinite(l.price)) return;
      const y = yAt(l.price);
      ctx.save();
      ctx.setLineDash(l.dash ? [6, 4] : []);
      ctx.strokeStyle = l.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      ctx.restore();
      const text = `${l.label} ${fmtP(l.price)}`;
      const tw = ctx.measureText(text).width + 8;
      ctx.fillStyle = l.color;
      ctx.fillRect(padL + 4, y - 14, tw, 13);
      ctx.fillStyle = C.ink;
      ctx.fillText(text, padL + 8, y - 4);
    });

    // markers (entry / exit)
    const t0 = new Date(slice[0].t).getTime();
    this.markers.forEach((m) => {
      const tm = new Date(m.t).getTime();
      if (!Number.isFinite(tm) || tm < t0 || !Number.isFinite(m.price)) return;
      let idx = slice.length - 1;
      for (let i = 0; i < slice.length; i++) {
        if (new Date(slice[i].t).getTime() > tm) {
          idx = Math.max(0, i - 1);
          break;
        }
      }
      const x = xAt(idx);
      const y = yAt(m.price);
      const dir = m.up ? -1 : 1;
      ctx.fillStyle = m.color;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x - 6, y - dir * 11);
      ctx.lineTo(x + 6, y - dir * 11);
      ctx.closePath();
      ctx.fill();
      ctx.font = '700 10px IBM Plex Sans, sans-serif';
      const lw = ctx.measureText(m.label).width;
      ctx.fillText(m.label, x + 8 + lw > w - padR ? x - 8 - lw : x + 8, y - dir * 8);
    });

    // live price line + axis label
    const last = slice[slice.length - 1];
    const lp = this.live != null ? this.live : last.c;
    const py = yAt(lp);
    if (this.live != null) {
      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = C.live;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(w - padR, py);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = this.live != null ? C.live : lp >= last.o ? C.up : C.down;
    const label = fmtP(lp);
    ctx.font = '11px IBM Plex Sans, sans-serif';
    ctx.fillRect(w - padR + 2, py - 9, ctx.measureText(label).width + 10, 18);
    ctx.fillStyle = C.ink;
    ctx.fillText(label, w - padR + 7, py + 4);

    // legend
    const legend = [];
    if (ind.ema9) legend.push(['EMA 9', '#eab308']);
    if (ind.ema21) legend.push(['EMA 21', '#3b82f6']);
    if (ind.vwap) legend.push(['VWAP', '#a855f7']);
    let lx = padL;
    ctx.font = '10px IBM Plex Sans, sans-serif';
    legend.forEach(([name, color]) => {
      ctx.fillStyle = color;
      ctx.fillRect(lx, h - 12, 8, 8);
      ctx.fillStyle = C.text;
      ctx.fillText(name, lx + 12, h - 4);
      lx += ctx.measureText(name).width + 28;
    });

    // crosshair + OHLC tooltip
    if (this.hover != null && slice[this.hover]) {
      const b = slice[this.hover];
      const x = xAt(this.hover);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#6b7280';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.moveTo(padL, yAt(b.c));
      ctx.lineTo(w - padR, yAt(b.c));
      ctx.stroke();
      ctx.restore();
      tooltipBox(ctx, w, x, yAt(b.c), [fmtT(b.t), `O ${fmtP(b.o)}  H ${fmtP(b.h)}`, `L ${fmtP(b.l)}  C ${fmtP(b.c)}`, `Vol ${Math.round(b.v || 0).toLocaleString()}`]);
    }

    const first = slice[0];
    const hi = Math.max(...slice.map((b) => b.h));
    const lo = Math.min(...slice.map((b) => b.l));
    const lv = this.levels.map((l) => `${l.label} ${fmtP(l.price)}`).join(', ');
    this._summary(`${this.title ? `${this.title} candlestick chart. ` : 'Candlestick chart. '}${slice.length} bars from ${fmtT(first.t)} to ${fmtT(last.t)}. Range ${fmtP(lo)} to ${fmtP(hi)}, last price ${fmtP(lp)}${lv ? `. Levels: ${lv}` : ''}. Use left and right arrow keys to inspect bars.`);
  }

  _summary(text) {
    this.canvas.setAttribute('aria-label', text);
    if (this.summaryEl) this.summaryEl.textContent = text;
  }
}

export class LineChart {
  constructor(canvas, { summaryEl, format = (v) => v.toFixed(2), color = '#22c55e', title = 'Line chart' } = {}) {
    this.canvas = canvas;
    this.summaryEl = summaryEl;
    this.format = format;
    this.color = color;
    this.title = title;
    this.points = [];
    this.hover = null;
    canvas.setAttribute('role', 'img');
    canvas.tabIndex = 0;
    this.ro = new ResizeObserver(() => requestAnimationFrame(() => this.draw()));
    this.ro.observe(canvas.parentElement || canvas);
    canvas.addEventListener('mousemove', (e) => this._move(e.clientX));
    canvas.addEventListener('mouseleave', () => {
      this.hover = null;
      this.draw();
    });
    canvas.addEventListener('touchmove', (e) => e.touches[0] && this._move(e.touches[0].clientX), { passive: true });
    canvas.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const cur = this.hover ?? this.points.length - 1;
      this.hover = Math.min(this.points.length - 1, Math.max(0, cur + (e.key === 'ArrowLeft' ? -1 : 1)));
      this.draw();
    });
    canvas.addEventListener('blur', () => {
      this.hover = null;
      this.draw();
    });
  }
  destroy() {
    this.ro.disconnect();
  }
  set(points) {
    this.points = points || [];
    this.draw();
  }
  _move(cx) {
    if (this.points.length < 2) return;
    const r = this.canvas.getBoundingClientRect();
    const i = Math.round(((cx - r.left - 8) / (r.width - 16)) * (this.points.length - 1));
    const c = Math.min(this.points.length - 1, Math.max(0, i));
    if (c !== this.hover) {
      this.hover = c;
      this.draw();
    }
  }
  draw() {
    if (!this.canvas.isConnected) return;
    const { ctx, w, h } = fit(this.canvas);
    ctx.clearRect(0, 0, w, h);
    const pts = this.points;
    if (pts.length < 2) {
      ctx.fillStyle = C.text;
      ctx.font = '12px IBM Plex Sans, sans-serif';
      ctx.fillText('Not enough data yet', 8, 22);
      this._summary(`${this.title}: not enough data yet.`);
      return;
    }
    const padL = 8;
    const padR = 54;
    const padT = 8;
    const padB = 8;
    const vals = pts.map((p) => p.v);
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const pd = (max - min) * 0.1 || 1;
    min -= pd;
    max += pd;
    const x = (i) => padL + (i / (pts.length - 1)) * (w - padL - padR);
    const y = (v) => padT + ((max - v) / (max - min)) * (h - padT - padB);
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.font = '10px IBM Plex Mono, monospace';
    for (let i = 0; i < 3; i++) {
      const gy = padT + ((h - padT - padB) / 2) * i;
      ctx.beginPath();
      ctx.moveTo(padL, gy);
      ctx.lineTo(w - padR, gy);
      ctx.stroke();
      ctx.fillText(this.format(max - ((max - min) / 2) * i), w - padR + 4, gy + 3);
    }
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, `${this.color}55`);
    g.addColorStop(1, `${this.color}00`);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.v)) : ctx.moveTo(x(i), y(p.v))));
    ctx.lineTo(x(pts.length - 1), h);
    ctx.lineTo(x(0), h);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.v)) : ctx.moveTo(x(i), y(p.v))));
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (this.hover != null && pts[this.hover]) {
      const p = pts[this.hover];
      ctx.beginPath();
      ctx.arc(x(this.hover), y(p.v), 4, 0, Math.PI * 2);
      ctx.fillStyle = this.color;
      ctx.fill();
      tooltipBox(ctx, w, x(this.hover), y(p.v), [p.t ? fmtT(p.t) : `#${this.hover + 1}`, this.format(p.v)]);
    }
    const first = pts[0];
    const last = pts[pts.length - 1];
    this._summary(`${this.title}: ${pts.length} points, from ${this.format(first.v)} to ${this.format(last.v)}, low ${this.format(Math.min(...vals))}, high ${this.format(Math.max(...vals))}.`);
  }
  _summary(text) {
    this.canvas.setAttribute('aria-label', text);
    if (this.summaryEl) this.summaryEl.textContent = text;
  }
}
