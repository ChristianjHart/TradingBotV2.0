// Earnings & event calendar: upcoming earnings for what you hold / were proposed / the scanner likes, plus the macro days that move
// everything (FOMC decisions, the jobs report) and NYSE closures. Earnings come from Finnhub through the same cached client the news
// stage uses; the macro list is BUILT-IN (like the NYSE holiday table) and must be extended each year.
import { store } from '../db/store.js';
import { hasFinnhubKey } from '../config.js';
import { mockNewsEnabled } from './mockNews.js';
import { getEarnings } from './finnhub.js';
import { isCrypto, NYSE_HOLIDAYS, NYSE_HALF_DAYS } from './market.js';

const DAY = 86_400_000;
export const MAX_DAYS = 28;
export const DEFAULT_DAYS = 21;
const MAX_WATCH = 40;

/** FOMC rate-decision days (second day of each meeting). Built-in list: verify on federalreserve.gov and extend yearly. */
export const FOMC_DECISIONS = ['2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28', '2026-12-09'];
export const MACRO_LIST_YEARS = [2026];

const ymdET = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const HOUR_TEXT = { bmo: 'before the open', amc: 'after the close', dmh: 'during the session' };

/** First Friday of a month as 'YYYY-MM-DD' (the usual BLS jobs-report day; the real date can shift, hence approx). */
export function firstFriday(year, month1) {
  const d = new Date(Date.UTC(year, month1 - 1, 1));
  const add = (5 - d.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month1 - 1, 1 + add)).toISOString().slice(0, 10);
}

/** Date list [today, ... today+days-1] in ET. */
export function windowDates(now, days) {
  const noon = Date.parse(`${ymdET(now)}T12:00:00Z`);
  return Array.from({ length: days }, (_, i) => ymdET(noon + i * DAY));
}

/** Macro + market-structure events for the dates (pure). */
export function staticEvents(dates) {
  const set = new Set(dates);
  const out = [];
  for (const d of FOMC_DECISIONS) {
    if (set.has(d)) out.push({ id: `fomc-${d}`, date: d, kind: 'macro', title: 'FOMC rate decision', detail: 'Fed announcement 2:00 pm ET, press conference 2:30 pm. Big-move day for everything.', impact: 'high', tags: ['macro'], approx: false });
  }
  const months = new Set(dates.map((d) => d.slice(0, 7)));
  for (const m of months) {
    const [y, mo] = m.split('-').map(Number);
    const d = firstFriday(y, mo);
    if (set.has(d)) out.push({ id: `jobs-${d}`, date: d, kind: 'macro', title: 'US jobs report (usually)', detail: 'Employment Situation, 8:30 am ET. Usually the first Friday of the month; the exact date can shift, so verify.', impact: 'high', tags: ['macro'], approx: true });
  }
  for (const d of dates) {
    if (NYSE_HOLIDAYS.has(d)) out.push({ id: `closed-${d}`, date: d, kind: 'market', title: 'US stock market closed', detail: 'NYSE holiday. Crypto still trades.', impact: 'low', tags: ['market'], approx: false });
    else if (NYSE_HALF_DAYS.has(d)) out.push({ id: `half-${d}`, date: d, kind: 'market', title: 'US stocks close early (1:00 pm ET)', detail: 'Shortened session.', impact: 'low', tags: ['market'], approx: false });
  }
  return out;
}

/** Earnings events from a Map(symbol -> { date, hour, inDays } | null) (pure). `watch` = { positions:Set, proposals:Set, picks:Set }. */
export function earningsEvents(earnings, watch, dates) {
  const set = new Set(dates);
  const out = [];
  for (const [symbol, e] of earnings || []) {
    if (!e || !set.has(e.date)) continue;
    const tags = [watch.positions?.has(symbol) && 'position', watch.proposals?.has(symbol) && 'proposal', watch.picks?.has(symbol) && 'pick'].filter(Boolean);
    out.push({
      id: `earn-${symbol}-${e.date}`,
      date: e.date,
      kind: 'earnings',
      symbol,
      title: `${symbol} earnings`,
      detail: e.hour && HOUR_TEXT[e.hour] ? `Reports ${HOUR_TEXT[e.hour]}.` : 'Report time not given.',
      hour: e.hour ?? null,
      impact: tags.includes('position') || tags.includes('proposal') ? 'high' : 'med',
      tags,
      approx: false,
    });
  }
  return out;
}

const rank = (e) => (e.kind === 'macro' ? 0 : e.kind === 'market' ? 1 : 2) * 10 + (e.tags.includes('position') ? 0 : e.tags.includes('proposal') ? 1 : 2);

/** Group events into days (every date in the window appears, empty ones too) (pure). */
export function groupByDay(dates, events, today) {
  return dates.map((date) => ({ date, today: date === today, events: events.filter((e) => e.date === date).sort((a, b) => rank(a) - rank(b) || String(a.symbol || '').localeCompare(String(b.symbol || ''))) }));
}

/** Symbols worth checking for earnings, most relevant first, capped. */
export function watchSets() {
  const positions = new Set(store.getPositions().filter((p) => p.status === 'open').map((p) => p.symbol));
  const proposals = new Set(store.getProposals().filter((p) => p.status === 'pending').map((p) => p.symbol));
  const picks = new Set((store.getAiPicks().picks || []).slice(0, 25).map((p) => p.symbol));
  const ordered = [...new Set([...positions, ...proposals, ...picks])].filter((s) => !isCrypto(s)).slice(0, MAX_WATCH);
  return { positions, proposals, picks, symbols: ordered };
}

let cache = null; // { key, at, data }
export const _clearCalendarCache = () => (cache = null);
const TTL_MS = 10 * 60_000;

export async function getCalendar({ now = Date.now(), days = DEFAULT_DAYS } = {}) {
  const n = Math.min(Math.max(Math.round(Number(days)) || DEFAULT_DAYS, 1), MAX_DAYS);
  const watch = watchSets();
  const key = `${ymdET(now)}|${n}|${watch.symbols.join(',')}|${[...watch.positions].sort()}|${[...watch.proposals].sort()}`;
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.data;
  const dates = windowDates(now, n);
  const eventsList = staticEvents(dates);
  let earningsAvailable = false;
  let earningsError = null;
  if (watch.symbols.length && (mockNewsEnabled() || hasFinnhubKey())) {
    const res = await getEarnings(watch.symbols, { now });
    earningsAvailable = res.available;
    earningsError = res.error;
    eventsList.push(...earningsEvents(res.earnings, watch, dates));
  } else if (!mockNewsEnabled() && !hasFinnhubKey()) earningsError = 'no Finnhub key';
  else earningsAvailable = true; // nothing to look up
  const data = {
    generatedAt: new Date(now).toISOString(),
    from: dates[0],
    to: dates[dates.length - 1],
    days: groupByDay(dates, eventsList, dates[0]),
    counts: { earnings: eventsList.filter((e) => e.kind === 'earnings').length, macro: eventsList.filter((e) => e.kind === 'macro').length },
    watched: watch.symbols.length,
    earningsAvailable,
    earningsError,
    macroListYears: MACRO_LIST_YEARS,
    macroCovered: MACRO_LIST_YEARS.includes(Number(dates[0].slice(0, 4))) && MACRO_LIST_YEARS.includes(Number(dates[dates.length - 1].slice(0, 4))),
  };
  cache = { key, at: now, data };
  return data;
}
