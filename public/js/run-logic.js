/* Pure, DOM-free helpers (importable from node:test). Keep browser globals out of this file. */

export const STEPS = [
  { id: 'fetching', label: 'Fetch market data', hint: 'downloading bars' },
  { id: 'scanning', label: 'Scanner bot', hint: 'AI can take 1–3 min' },
  { id: 'trading', label: 'Trader bot', hint: 'sizing & simulating trades' },
];

/**
 * Derive the run stepper from /run/status. `now` is epoch ms (injected so it is testable).
 * `lastRunningStage` is the last stage seen while running; used to place the error marker.
 * @returns {{visible:boolean, steps:{id:string,label:string,hint:string,state:'done'|'error'|'active'|'pending'}[], kind:string, elapsedMs:number|null}}
 */
export function stepperState(run, now, lastRunningStage = null) {
  if (!run || !run.startedAt || run.stage === 'idle') return { visible: false, steps: [], kind: 'idle', elapsedMs: null };
  const idx = STEPS.findIndex((s) => s.id === run.stage);
  const errIdx = Math.max(0, STEPS.findIndex((s) => s.id === lastRunningStage));
  const steps = STEPS.map((s, i) => {
    let st = 'pending';
    if (run.stage === 'done') st = 'done';
    else if (run.stage === 'blocked') st = 'pending'; // blocked before anything ran
    else if (run.stage === 'error') st = i < errIdx ? 'done' : i === errIdx ? 'error' : 'pending';
    else if (idx >= 0) st = i < idx ? 'done' : i === idx ? 'active' : 'pending';
    return { ...s, state: st };
  });
  const kind = run.stage === 'error' ? 'error' : run.stage === 'blocked' ? 'blocked' : run.stage === 'done' ? 'done' : 'running';
  const start = new Date(run.startedAt).getTime();
  const end = run.running ? now : new Date(run.finishedAt || now).getTime();
  const elapsedMs = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
  return { visible: true, steps, kind, elapsedMs };
}

/** Where the stop/target progress marker sits, clamped to 0..1. */
export function progressOf(p) {
  const price = p.price ?? p.entry;
  const span = p.takeProfit - p.stopLoss;
  if (!span) return 0.5;
  return Math.min(1, Math.max(0, (price - p.stopLoss) / span));
}

export function riskOf(p) {
  return Math.abs(p.entry - p.stopLoss) * (p.qty ?? p.allocation / p.entry);
}

/** Null-last comparator-based sort of positions by an accessor; returns a new array. */
export function sortRows(rows, get, dir = 'desc') {
  const d = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = get(a);
    const y = get(b);
    if (x === y) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
  });
}

/** CSS conic-gradient string for donut charts. */
export function donutGradient(parts) {
  const total = parts.reduce((s, p) => s + p.value, 0) || 1;
  let acc = 0;
  return `conic-gradient(${parts
    .map((p) => {
      const start = (acc / total) * 360;
      acc += p.value;
      return `${p.color} ${start}deg ${(acc / total) * 360}deg`;
    })
    .join(', ')})`;
}

/** Tolerate fraction or percent input. */
export const pctOf = (v) => (v == null ? null : Math.abs(v) <= 1 ? v * 100 : v);

/** Calibration bucket like "60-70%" -> {mid, hitRate(0..100 clamped for width), n}. */
export function calibrationBar(c) {
  const m = String(c.bucket).match(/(\d+)\D+(\d+)/);
  const mid = m ? (Number(m[1]) + Number(m[2])) / 2 : null;
  const hr = pctOf(c.hitRate) ?? 0;
  return { mid, hitRate: hr, width: Math.min(100, Math.max(0, hr)), overconfident: mid != null && hr < mid };
}

/** Bar aggregation: '1H' passthrough, '4H' groups of four (aligned to the end), else per UTC day. */
export function aggregateBars(bars, tf) {
  if (tf === '1H' || !bars.length) return bars;
  const merge = (g) => ({
    t: g[0].t,
    o: g[0].o,
    h: Math.max(...g.map((b) => b.h)),
    l: Math.min(...g.map((b) => b.l)),
    c: g[g.length - 1].c,
    v: g.reduce((a, b) => a + (b.v || 0), 0),
  });
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

/** Map an app symbol to a TradingView symbol. */
export function toTvSymbol(symbol) {
  if (symbol.includes('/')) {
    const [base, quote] = symbol.split('/');
    return `BINANCE:${base}${quote === 'USD' ? 'USDT' : quote}`;
  }
  return symbol;
}

/** Classify an API error for friendly UI: 'untracked' (400 symbol outside universe), 'worker-stopped' (409), else 'other'. */
export function classifyApiError(err) {
  const status = err?.status;
  const msg = String(err?.message || '').toLowerCase();
  if (status === 409) return 'worker-stopped';
  if (status === 400 && /(universe|tracked|not.*allowed|unknown symbol|open position)/.test(msg)) return 'untracked';
  return 'other';
}
