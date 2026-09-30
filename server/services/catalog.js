// OpenRouter model catalog: live pricing so the owner can pick a free/cheaper model. PUBLIC endpoint, fixed host, the API key is
// NEVER sent. Cached 1h; when a refresh fails the last good copy is served (stale-while-error).
import { loggedFetch } from './http.js';

export const CATALOG_URL = 'https://openrouter.ai/api/v1/models'; // fixed constant: never built from user input
export const CATALOG_TTL_MS = 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
const NEGATIVE_TTL_MS = 60_000; // after a failed fetch with nothing cached, do not hammer the endpoint

let cache = null; // { models, fetchedAt }
let inflight = null;
let lastFailAt = 0;
let lastError = null;

/** USD per token (number or string) -> USD per 1M tokens; null for missing/negative sentinel/non-numeric. */
export function toPerM(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null; // -1 is OpenRouter's "variable price" sentinel (auto routers)
  return Number((n * 1e6).toPrecision(8));
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Normalise one raw catalog entry; returns null when it has no usable id. */
export function normalizeModel(raw) {
  if (!isPlain(raw) || typeof raw.id !== 'string' || !/^[\w.\-:/]{1,100}$/.test(raw.id)) return null;
  const pricing = isPlain(raw.pricing) ? raw.pricing : {};
  let promptPerM = toPerM(pricing.prompt);
  let completionPerM = toPerM(pricing.completion);
  const freeId = raw.id.endsWith(':free');
  if (freeId) {
    promptPerM ??= 0;
    completionPerM ??= 0;
  }
  const isFree = freeId || (promptPerM === 0 && completionPerM === 0);
  const ctx = Number(raw.context_length ?? raw.top_provider?.context_length);
  const sp = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : null;
  const created = Number(raw.created);
  const out = {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name.slice(0, 120) : raw.id,
    promptPerM,
    completionPerM,
    contextLength: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
    isFree,
  };
  if (sp) out.supportsJson = sp.includes('response_format') || sp.includes('structured_outputs');
  if (Number.isFinite(created) && created > 0) out.created = created;
  return out;
}

const blended = (m) => (m.promptPerM ?? Infinity) + (m.completionPerM ?? Infinity);

/** Parse the raw /models body (either {data:[…]} or a bare array), dedupe by id, sort cheapest first (unknown prices last). */
export function parseCatalog(body) {
  const list = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : null;
  if (!list) throw new Error('unexpected catalog response shape');
  const seen = new Map();
  for (const raw of list) {
    const m = normalizeModel(raw);
    if (m && !seen.has(m.id)) seen.set(m.id, m);
  }
  return [...seen.values()].sort((a, b) => {
    const d = blended(a) - blended(b);
    return Number.isNaN(d) || d === 0 ? a.id.localeCompare(b.id) : d;
  });
}

async function fetchCatalog() {
  const res = await loggedFetch('openrouter-models', CATALOG_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`OpenRouter models HTTP ${res.status}`);
  const models = parseCatalog(JSON.parse(await res.text()));
  if (!models.length) throw new Error('OpenRouter models list was empty');
  return models;
}

/**
 * Cached catalog. Returns { models, fetchedAt, stale, error? }. Throws only when there is nothing to serve
 * (no cache and the fetch failed). `force` bypasses the TTL (still coalesced).
 */
export async function getCatalog({ force = false, now = Date.now() } = {}) {
  const fresh = cache && now - cache.fetchedAt < CATALOG_TTL_MS;
  if (fresh && !force) return { models: cache.models, fetchedAt: cache.fetchedAt, stale: false };
  if (!cache && lastFailAt && now - lastFailAt < NEGATIVE_TTL_MS && !force) throw new Error(lastError || 'model catalog unavailable');
  try {
    inflight ||= fetchCatalog().finally(() => {
      inflight = null;
    });
    const models = await inflight;
    cache = { models, fetchedAt: Date.now() };
    lastFailAt = 0;
    lastError = null;
    return { models, fetchedAt: cache.fetchedAt, stale: false };
  } catch (err) {
    lastFailAt = Date.now();
    lastError = String(err.message).slice(0, 200);
    if (cache) return { models: cache.models, fetchedAt: cache.fetchedAt, stale: true, error: lastError };
    throw err;
  }
}

/** Cached models without any network I/O (or null). */
export const peekCatalog = () => (cache ? cache.models : null);

/** One catalog entry from the cache (no I/O), or null when unknown / not loaded. */
export const catalogEntry = (id) => (cache ? cache.models.find((m) => m.id === id) || null : null);

/** Apply ?free=1 &q= &maxPrice= (USD per 1M tokens; both prompt and completion must be <= maxPrice) &limit=. */
export function filterModels(models, { free, q, maxPrice, limit } = {}) {
  let out = models;
  if (free) out = out.filter((m) => m.isFree);
  if (q) {
    const needle = String(q).toLowerCase().slice(0, 100);
    out = out.filter((m) => m.id.toLowerCase().includes(needle) || m.name.toLowerCase().includes(needle));
  }
  const max = maxPrice === undefined || maxPrice === '' ? NaN : Number(maxPrice);
  if (Number.isFinite(max)) out = out.filter((m) => m.promptPerM !== null && m.completionPerM !== null && m.promptPerM <= max && m.completionPerM <= max);
  if (Number.isFinite(limit) && limit > 0) out = out.slice(0, limit);
  return out;
}

export const FREE_MODEL_NOTES = [
  'Free (":free") models are heavily rate limited and often answer HTTP 429; a run may fail with code rate_limited and can simply be retried later.',
  'Free-model providers may log your prompts and use them for training. This app only sends market data (no personal data, paper trading), so that is usually acceptable.',
  'Free models can be slower, less reliable at strict JSON and are sometimes withdrawn (code model_unavailable). Invalid output ends the run cleanly; nothing is traded.',
];

/** Test hook. */
export function _resetCatalog() {
  cache = null;
  inflight = null;
  lastFailAt = 0;
  lastError = null;
}
