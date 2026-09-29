import { store } from '../db/store.js';

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
