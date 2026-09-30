// Small GET-JSON helper for the optional news/earnings data sources: fixed-host allow-list, per-request timeout, bounded retries with
// backoff on network errors / 429 / 5xx, and loggedFetch (status + timing only: never headers, query strings or bodies).
import { loggedFetch } from './http.js';
import { scrubSecrets } from '../config.js';

export const upstreamTuning = {
  timeoutMs: 10_000,
  maxAttempts: 3,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export class UpstreamError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = code; // key_rejected | rate_limited | upstream_error | timeout | bad_response | host_not_allowed
    Object.assign(this, extra);
  }
}

const backoff = (attempt, retryAfter) => {
  const ra = Number(retryAfter);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 5_000);
  return Math.min(300 * 2 ** attempt + Math.random() * 150, 3_000);
};

/** GET `url` (host must be in `allowedHosts`) and parse the JSON body. Never logs or returns secrets. */
export async function getJson(service, url, { headers = {}, allowedHosts = [] } = {}) {
  let host = '';
  try {
    const u = new URL(url);
    host = u.hostname;
    if (u.protocol !== 'https:' || !allowedHosts.includes(host)) throw new Error('not allowed');
  } catch {
    throw new UpstreamError('host_not_allowed', `${service}: request host is not on the allow-list`);
  }
  let last = null;
  for (let attempt = 0; attempt < upstreamTuning.maxAttempts; attempt++) {
    let retryAfter = null;
    try {
      const res = await loggedFetch(service, url, { headers, redirect: 'error', signal: AbortSignal.timeout(upstreamTuning.timeoutMs) });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw new UpstreamError('bad_response', `${service}: response was not JSON`, { status: res.status, fatal: true });
        }
      }
      const status = res.status;
      if (status === 401 || status === 403) throw new UpstreamError('key_rejected', `${service}: credentials rejected (HTTP ${status})`, { status, fatal: true });
      if (status === 429 || status >= 500) {
        retryAfter = res.headers?.get?.('retry-after') ?? null;
        last = new UpstreamError(status === 429 ? 'rate_limited' : 'upstream_error', `${service}: HTTP ${status}`, { status });
      } else throw new UpstreamError('upstream_error', `${service}: HTTP ${status}`, { status, fatal: true });
    } catch (err) {
      if (err instanceof UpstreamError && err.fatal) throw err;
      if (err instanceof UpstreamError) last = err;
      else {
        const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';
        last = new UpstreamError(timedOut ? 'timeout' : 'upstream_error', timedOut ? `${service}: request timed out` : `${service}: could not connect (${scrubSecrets(err?.cause?.message || err?.message || 'network error').slice(0, 80)})`);
      }
    }
    if (attempt < upstreamTuning.maxAttempts - 1) await upstreamTuning.sleep(backoff(attempt, retryAfter));
  }
  throw last || new UpstreamError('upstream_error', `${service}: request failed`);
}
