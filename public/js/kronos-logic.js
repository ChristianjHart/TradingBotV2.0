// Pure helpers for the Kronos forecast views (no DOM), so node --test can cover them.
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const W = 320;
const H = 120;
const PAD = 6;

const pct = (x) => `${Math.round(x * 100)}%`;
const move = (from, to) => (fin(from) && fin(to) && from > 0 ? ((to - from) / from) * 100 : null);

/**
 * Inline SVG: the forecast band (middle 80% of paths), the median, and the real closes. Entry/stop/target lines show only when they
 * fall inside the plotted price range, so a far-away stop does not squash the chart. Returns '' when there is nothing to draw.
 */
export function chartSvg(item, { levels = false } = {}) {
  const b = item?.band;
  if (!b || !b.p50?.length) return '';
  const n = b.p50.length;
  const actual = (item.actual || []).map((a) => a.c).filter(fin);
  const vals = [item.lastClose, ...b.p10, ...b.p90, ...actual, ...(levels ? [item.entry, item.stopLoss, item.takeProfit] : [])].filter(fin);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const padY = (hi - lo) * 0.08;
  lo -= padY;
  hi += padY;
  const x = (i) => PAD + (i / n) * (W - 2 * PAD); // i = 0 is the start price, 1..n are the forecast hours
  const y = (v) => PAD + (1 - (v - lo) / (hi - lo)) * (H - 2 * PAD);
  const pts = (arr, from = 0) => arr.map((v, i) => `${x(i + from).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const upper = [item.lastClose, ...b.p90];
  const lower = [item.lastClose, ...b.p10];
  const poly = `${pts(upper)} ${lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join(' ')}`;
  const line = (v, cls) => (fin(v) && v >= lo && v <= hi ? `<line class="${cls}" x1="${PAD}" x2="${W - PAD}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/>` : '');
  const median = pts([item.lastClose, ...b.p50]);
  const real = actual.length ? pts([item.lastClose, ...actual]) : '';
  return `<svg class="kr-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    <polygon class="kr-band" points="${poly}"/>${line(item.takeProfit, 'kr-tgt')}${line(item.stopLoss, 'kr-stop')}${line(item.entry, 'kr-entry')}
    <polyline class="kr-med" points="${median}" fill="none"/>${real ? `<polyline class="kr-real" points="${real}" fill="none"/>` : ''}</svg>`;
}

/** One-line plain text for a forecast row. */
export function itemView(item) {
  const sc = item.score;
  const lastReal = item.actual?.length ? item.actual[item.actual.length - 1].c : null;
  const realMove = move(item.lastClose, lastReal);
  const foreMove = move(item.lastClose, item.band?.p50?.[(item.actual?.length || item.band.p50.length) - 1]);
  const fmt = (m) => (m == null ? '—' : `${m > 0 ? '+' : ''}${m.toFixed(1)}%`);
  const state = item.complete ? 'Finished' : item.actual?.length ? `${item.actual.length} of ${item.horizonHours} hours so far` : 'Waiting for prices';
  const head = `${item.symbol} ${item.side} · Kronos said ${item.call === 'take' ? 'TAKE' : 'SKIP'} (${pct(item.meanP)} chance of profit)`;
  const detail = item.actual?.length ? `Median path ${fmt(foreMove)}, real price ${fmt(realMove)}.${sc ? ` ${pct(sc.inside)} of hours stayed inside the band.` : ''}` : 'No real prices after the forecast yet.';
  const label = `${head}. ${state}. ${detail}`;
  return { head, state, detail, label, right: sc?.direction === true ? 'right direction' : sc?.direction === false ? 'wrong direction' : '' };
}

/** Summary line for the section top. */
export function compareSummary(s) {
  if (!s || !s.forecasts) return 'No forecasts saved yet. Turn on auto-forecast in Settings, or press Forecast on a trade.';
  if (!s.complete) return `${s.forecasts} forecasts saved. None has finished yet, so there is nothing to score.`;
  const inside = `${pct(s.inside)} of hours stayed inside the 80% band (a good forecast gives about 80%)`;
  const dir = `the median path pointed the right way in ${pct(s.directionRight)} of ${s.complete} finished forecasts`;
  return `${inside}; ${dir}. Under about 20 finished forecasts, treat this as a hint, not proof.`;
}

const signed = (m) => (m == null ? '—' : `${m > 0 ? '+' : ''}${m.toFixed(1)}%`);

/**
 * Plain numbers behind a forecast, worked out from the saved band, so an odd headline (like 0%) can be checked at a glance:
 * where the median path ends, how wide the middle 80% is, and how far the stop and target are.
 * `warning` is set when the paths are almost identical, which would mean the forecast service is not sampling.
 */
export function forecastFacts(item) {
  const b = item?.band;
  const n = b?.p50?.length;
  if (!n || !fin(item.lastClose) || !(item.lastClose > 0)) return null;
  const at = (arr) => ((arr[n - 1] - item.lastClose) / item.lastClose) * 100;
  const median = at(b.p50);
  const low = at(b.p10);
  const high = at(b.p90);
  const sgn = item.side === 'short' ? -1 : 1;
  const stop = fin(item.stopLoss) && fin(item.entry) ? ((item.stopLoss - item.entry) / item.entry) * 100 : null;
  const target = fin(item.takeProfit) && fin(item.entry) ? ((item.takeProfit - item.entry) / item.entry) * 100 : null;
  const hours = item.horizonHours || n;
  const mood = Math.abs(median) < 0.2 ? 'stay about flat' : median > 0 ? 'rise' : 'fall';
  const helps = Math.abs(median) < 0.2 ? null : median * sgn > 0;
  const spread = high - low;
  const sentence = `Kronos expects the price to ${mood} over ${hours}h (median ${signed(median)}, middle 80% from ${signed(low)} to ${signed(high)}). The target needs ${signed(target)} and the stop is ${signed(stop)}${helps === null ? '. A flat price ends slightly behind after costs.' : helps ? '. That helps this trade.' : '. That works against this trade.'}`;
  const warning = spread < 0.05 ? 'The paths are almost identical. The forecast service may not be drawing different paths.' : '';
  // Most paths hit the stop although the closing prices never get there: the forecast candles' highs and lows did it.
  const stopClose = fin(item.stopLoss) ? ((item.stopLoss - item.lastClose) / item.lastClose) * 100 : null;
  const wicks = item.stats && item.stats.pStop >= 0.6 && stopClose != null && (sgn > 0 ? low > stopClose : high < stopClose) ? 'Most paths touch the stop through short spikes (candle highs and lows), not through their closing prices.' : '';
  return { median, low, high, stop, target, hours, helps, sentence, warning, wicks };
}
