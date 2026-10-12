// Kronos forecast (optional). Kronos (NeoQuasar/Kronos-base) is a model for candlestick price paths, NOT a chat model, so it cannot run
// through OpenRouter. It runs in a small separate Python service (scripts/kronos_server.py) that KRONOS_URL points at.
//
//  - We send recent hourly bars. The service returns several possible future paths (hourly candles) for the trade's horizon.
//  - Each path is replayed against the proposal's stop and target. The share of paths that end in profit is the forecast chance of profit.
//  - A path that touches stop and target in the same hour counts as a stop (the cautious choice).
//  - Advice only. It never approves or rejects. Its record is scored like the AI checker's (judgeScorecard with key 'kronos').
import { config } from '../config.js';
import { store } from '../db/store.js';
import { patchProposal } from './proposals.js';
import { fetchBars } from './whatif.js';

const r3 = (n) => Math.round(n * 1000) / 1000;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const COST = 0.002; // round-trip slippage and fees as a share of price, same order as the app's 5+5 bps each way

export const KRONOS = Object.freeze({ SAMPLES: 30, MAX_SAMPLES: 100, CONTEXT_BARS: 400, MIN_BARS: 60, TIMEOUT_MS: 180_000, MAX_HORIZON: 48, MAX_PRICE_GAP: 0.15 });
export const kronosConfigured = () => Boolean(config.ai.kronosUrl);
const httpErr = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Validate the service reply: `paths` is an array of `horizon` candles each, all prices finite and positive. Throws on anything else. */
export function validatePaths(json, horizon) {
  const paths = json?.paths;
  if (!Array.isArray(paths) || !paths.length || paths.length > KRONOS.MAX_SAMPLES) throw new Error('reply has no usable "paths"');
  return paths.map((path) => {
    if (!Array.isArray(path) || path.length < horizon) throw new Error('a path is shorter than the horizon');
    return path.slice(0, horizon).map((c) => {
      const o = { h: Number(c?.h), l: Number(c?.l), c: Number(c?.c) };
      if (![o.h, o.l, o.c].every((v) => fin(v) && v > 0) || o.h < o.l) throw new Error('a candle has bad prices');
      return o;
    });
  });
}

const pctile = (sorted, q) => {
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

/** Per-hour spread of the forecast closes: the middle 80% of paths (p10 to p90) and the median. Small enough to store on the proposal. */
export function bandOf(paths) {
  const hours = paths[0].length;
  const round = (v) => Math.round(v * 10000) / 10000;
  const out = { p10: [], p50: [], p90: [] };
  for (let h = 0; h < hours; h++) {
    const closes = paths.map((p) => p[h].c).sort((a, b) => a - b);
    out.p10.push(round(pctile(closes, 0.1)));
    out.p50.push(round(pctile(closes, 0.5)));
    out.p90.push(round(pctile(closes, 0.9)));
  }
  return out;
}

/** Replay one forecast path against the trade. -> { exit: 'target'|'stop'|'time', win } */
export function replayPath(path, { side, entry, stopLoss, takeProfit }) {
  const long = side === 'long';
  for (const c of path) {
    if (long ? c.l <= stopLoss : c.h >= stopLoss) return { exit: 'stop', win: false };
    if (long ? c.h >= takeProfit : c.l <= takeProfit) return { exit: 'target', win: true };
  }
  const last = path[path.length - 1].c;
  const ret = (long ? last - entry : entry - last) / entry - COST;
  return { exit: 'time', win: ret > 0 };
}

/** Stats over all paths. `call` uses the same rule as the demo checker: profit chance clearly above the break-even rate -> take. */
export function summarizePaths(paths, trade, breakEven = null) {
  const res = paths.map((p) => replayPath(p, trade));
  const n = res.length;
  const count = (k) => res.filter((x) => x.exit === k).length;
  const pProfit = res.filter((x) => x.win).length / n;
  return {
    n,
    meanP: r3(pProfit),
    pTarget: r3(count('target') / n),
    pStop: r3(count('stop') / n),
    pTime: r3(count('time') / n),
    call: fin(breakEven) ? (pProfit >= breakEven + 0.03 ? 'take' : 'skip') : pProfit >= 0.5 ? 'take' : 'skip',
    edge: fin(breakEven) ? r3(pProfit - breakEven) : null,
  };
}

async function callService(body) {
  const ctl = AbortSignal.timeout(KRONOS.TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.ai.kronosUrl}/forecast`, { method: 'POST', headers: { 'content-type': 'application/json', ...(config.ai.kronosToken ? { authorization: `Bearer ${config.ai.kronosToken}` } : {}) }, body: JSON.stringify(body), signal: ctl, redirect: 'error' });
  } catch (err) {
    throw httpErr(err?.name === 'TimeoutError' ? 504 : 502, err?.name === 'TimeoutError' ? 'timeout' : 'forecast_unreachable', err?.name === 'TimeoutError' ? 'The forecast service took too long.' : 'Cannot reach the forecast service. Check KRONOS_URL and that it is running.');
  }
  if (res.status === 401 || res.status === 403) throw httpErr(502, 'forecast_unauthorized', 'The forecast service refused the token. Check KRONOS_TOKEN.');
  if (!res.ok) throw httpErr(502, 'forecast_failed', `The forecast service answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw httpErr(502, 'invalid_output', 'The forecast service sent an unreadable reply.');
  }
}

const inflight = new Map();

/** Forecast one PENDING proposal. Saved on the proposal as `kronos`; a repeat is free unless `force`. */
export async function forecastProposal(id, { force = false, samples = KRONOS.SAMPLES } = {}) {
  const found = store.getProposals().find((p) => p.id === id);
  if (!found) throw httpErr(404, 'not_found', 'proposal not found');
  if (found.kronos && !force) return { kronos: found.kronos, cached: true };
  if (found.status !== 'pending') throw httpErr(409, 'not_pending', 'only a pending proposal can be forecast (the forecast must come before the result is known)');
  if (!kronosConfigured()) throw httpErr(409, 'not_configured', 'The forecast service is not set up. Set KRONOS_URL (see docs/KRONOS.md).');
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    const horizon = Math.min(KRONOS.MAX_HORIZON, Math.max(1, Math.round(found.horizonHours || 24)));
    const bars = (await fetchBars([found.symbol])).get(found.symbol) || [];
    const ctx = bars.slice(-KRONOS.CONTEXT_BARS).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? 0 }));
    if (ctx.length < KRONOS.MIN_BARS) throw httpErr(409, 'no_history', `Only ${ctx.length} hourly bars exist for ${found.symbol}; the forecast needs ${KRONOS.MIN_BARS}.`);
    const lastClose = ctx[ctx.length - 1].c;
    if (!(Number(found.entry) > 0) || Math.abs(lastClose / Number(found.entry) - 1) > KRONOS.MAX_PRICE_GAP) throw httpErr(409, 'price_mismatch', `The latest bar price (${lastClose}) is far from the proposal entry (${found.entry}). A forecast would mean nothing, so it was not made.`);
    const n = Math.min(KRONOS.MAX_SAMPLES, Math.max(5, Math.round(samples)));
    const reply = await callService({ symbol: found.symbol, bars: ctx, horizon, samples: n });
    let paths;
    try {
      paths = validatePaths(reply, horizon);
    } catch (err) {
      throw httpErr(502, 'invalid_output', `The forecast service reply was not usable: ${err.message}`);
    }
    const entry = Number(found.entry);
    const stopDist = Math.abs(entry - Number(found.stopLoss));
    const rr = stopDist > 0 ? Math.abs(Number(found.takeProfit) - entry) / stopDist : null;
    const breakEven = rr == null ? null : r3(1 / (1 + rr));
    const k = entry / lastClose; // paths are replayed as relative moves from the entry (the last bar and the entry differ by a little)
    const scaled = paths.map((pa) => pa.map((c) => ({ h: c.h * k, l: c.l * k, c: c.c * k })));
    const stats = summarizePaths(scaled, { side: found.side, entry, stopLoss: Number(found.stopLoss), takeProfit: Number(found.takeProfit) }, breakEven);
    const lastBar = ctx[ctx.length - 1];
    const kronos = { at: new Date().toISOString(), startT: lastBar.t, lastClose: lastBar.c, band: bandOf(paths), actual: null, model: typeof reply.model === 'string' ? reply.model.slice(0, 80) : 'kronos', horizonHours: horizon, contextBars: ctx.length, samples: paths.length, breakEvenWinRate: breakEven, stats };
    if (!patchProposal(id, { kronos })) throw httpErr(404, 'not_found', 'the proposal disappeared while the forecast was running');
    store.addLog({ level: 'info', message: `Kronos forecast for ${found.symbol}: ${stats.call.toUpperCase()}, ${Math.round(stats.meanP * 100)}% profit chance over ${stats.n} paths` });
    return { kronos, cached: false };
  })().finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}

/** Forecast several pending proposals one after another (the service is the slow part). Stops when the service is down or unset. */
export async function forecastMany(ids, { max = 12 } = {}) {
  const out = { done: 0, cached: 0, failed: 0 };
  for (const id of ids.slice(0, max)) {
    try {
      const r = await forecastProposal(id);
      if (r.cached) out.cached += 1;
      else out.done += 1;
    } catch (err) {
      out.failed += 1;
      if (err?.code === 'not_configured' || err?.code === 'forecast_unreachable' || err?.code === 'forecast_unauthorized') break;
    }
  }
  if (out.done || out.failed) store.addLog({ level: out.failed ? 'warn' : 'info', message: `Kronos batch: ${out.done} forecast, ${out.cached} already done, ${out.failed} failed` });
  return out;
}

const HOUR = 3600_000;
export const COMPARE_MAX = 30;

/** Actual hourly closes after the forecast start. */
export function actualCloses(bars, startT, horizon) {
  const t0 = Date.parse(startT);
  return bars.filter((b) => Date.parse(b.t) > t0 && Date.parse(b.t) <= t0 + horizon * HOUR).map((b) => ({ t: b.t, c: b.c }));
}

/**
 * How far did the middle 80% band hold? `inside` is the share of hours whose actual close fell between p10 and p90 (about 0.8 if the
 * forecast is well calibrated). `direction` says whether the median and the real price moved the same way over the whole horizon.
 */
export function scoreForecast(k) {
  const a = k.actual || [];
  if (!a.length) return null;
  let inside = 0;
  a.forEach((x, i) => {
    if (x.c >= k.band.p10[i] && x.c <= k.band.p90[i]) inside += 1;
  });
  const i = a.length - 1;
  const moveReal = a[i].c - k.lastClose;
  const moveFore = k.band.p50[i] - k.lastClose;
  return { hours: a.length, inside: r3(inside / a.length), direction: moveReal === 0 || moveFore === 0 ? null : moveReal > 0 === moveFore > 0, medianErrorPct: r3(((k.band.p50[i] - a[i].c) / a[i].c) * 100) };
}

/**
 * The newest forecasts next to what the price really did. Once a forecast's horizon is over, the real closes are saved on the proposal,
 * so the comparison stays after the exchange's bar history rolls off.
 */
export async function compareForecasts({ now = Date.now() } = {}) {
  const rows = store.getProposals().filter((p) => p.kronos?.band).sort((a, b) => Date.parse(b.kronos.at) - Date.parse(a.kronos.at)).slice(0, COMPARE_MAX);
  const need = rows.filter((p) => !p.kronos.actualDone);
  const barsBy = need.length ? await fetchBars(new Set(need.map((p) => p.symbol))) : new Map();
  const items = rows.map((p) => {
    let k = p.kronos;
    if (!k.actualDone) {
      const actual = actualCloses(barsBy.get(p.symbol) || [], k.startT, k.horizonHours);
      const over = now >= Date.parse(k.startT) + (k.horizonHours + 1) * HOUR;
      k = { ...k, actual };
      if (over && actual.length) {
        k = { ...k, actualDone: true };
        patchProposal(p.id, { kronos: k });
      }
    }
    return { id: p.id, symbol: p.symbol, side: p.side, status: p.status, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, startT: k.startT, lastClose: k.lastClose, horizonHours: k.horizonHours, band: k.band, actual: k.actual || [], complete: Boolean(k.actualDone), call: k.stats.call, meanP: k.stats.meanP, score: scoreForecast(k) };
  });
  const done = items.filter((x) => x.complete && x.score);
  const summary = {
    forecasts: items.length,
    complete: done.length,
    inside: done.length ? r3(done.reduce((s, x) => s + x.score.inside, 0) / done.length) : null,
    directionRight: done.length ? r3(done.filter((x) => x.score.direction === true).length / done.length) : null,
  };
  return { items, summary };
}
