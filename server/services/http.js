import { insert } from '../db/supabase.js';
import { scrubSecrets } from '../config.js';

const SECRET = /key|secret|token|authorization|password|cookie|passwd|code|current|next/i;
// Credential-bearing routes: their bodies are never logged at all.
const SENSITIVE_PATH = /^\/api\/(auth|account)(\/|$)/;

export function redact(value, depth = 0) {
  if (value == null || depth > 4) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET.test(k) ? '[redacted]' : redact(v, depth + 1)]),
    );
  }
  return typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
}

/** fetch() that records an outbound row in api_logs (status, timing, errors — never headers/bodies). */
export async function loggedFetch(service, url, options = {}) {
  const started = Date.now();
  const row = {
    direction: 'outbound',
    service,
    method: options.method || 'GET',
    url: String(url).split('?')[0] + (String(url).includes('?') ? '?…' : ''),
  };
  try {
    // Never let one hung upstream request stall a whole scan.
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), ...options });
    insert('api_logs', { ...row, status: res.status, duration_ms: Date.now() - started });
    return res;
  } catch (err) {
    insert('api_logs', { ...row, duration_ms: Date.now() - started, error: scrubSecrets(err.message) });
    throw err;
  }
}

/** Express middleware: one api_logs row per inbound /api request. */
export function requestLogger(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    if (req.originalUrl.startsWith('/api/health')) return;
    insert('api_logs', {
      direction: 'inbound',
      service: 'app',
      method: req.method,
      url: req.originalUrl.split('?')[0],
      status: res.statusCode,
      duration_ms: Date.now() - started,
      request: SENSITIVE_PATH.test(req.originalUrl) ? { redacted: true } : redact({ query: req.query, body: req.body }),
    });
  });
  next();
}
