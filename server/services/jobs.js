import { store } from '../db/store.js';
import { hasAlpacaCredentials, hasOpenRouterKey } from '../config.js';

/**
 * Wrap a scheduled job: never throws, logs failures, and skips a tick while the previous one is still running.
 */
export function guarded(name, fn, { onError } = {}) {
  let running = false;
  return async () => {
    if (running) {
      store.addLog({ level: 'warn', message: `cron ${name}: previous run still in progress, skipping this tick` });
      return false;
    }
    running = true;
    try {
      await fn();
      return true;
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err);
      store.addLog({ level: 'error', message: `cron ${name} failed: ${err.message}` });
      onError?.(err);
      return false;
    } finally {
      running = false;
    }
  };
}

let lastSkipLog = 0;
/**
 * Scheduled AI runs use the ACTIVE credentials (account keys, else env). With neither an OpenRouter key nor Alpaca
 * credentials there is nothing meaningful to run: skip and say why (at most once an hour) instead of looping on errors.
 * Returns the skip reason, or null when the run may proceed.
 */
export function scheduledRunSkipReason({ now = Date.now(), log = (m) => store.addLog({ level: 'warn', message: m }) } = {}) {
  if (hasOpenRouterKey() || hasAlpacaCredentials()) return null;
  const reason = 'cron run skipped: no OpenRouter or Alpaca credentials configured (add keys under Settings → Account or set env vars)';
  if (now - lastSkipLog > 3600_000) {
    lastSkipLog = now;
    log(reason);
  }
  return reason;
}
