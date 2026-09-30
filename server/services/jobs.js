import { store } from '../db/store.js';
import { aiStatus } from './aiRun.js';
import { budgetStatus } from './spend.js';

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
 * Scheduled AI runs need the AI (OpenRouter key) and budget headroom. Otherwise skip and say why (at most once an hour) instead of
 * looping on errors or spending past the cap. Returns the skip reason, or null when the run may proceed.
 */
export function scheduledRunSkipReason({ now = Date.now(), log = (m) => store.addLog({ level: 'warn', message: m }) } = {}) {
  const ai = aiStatus();
  let reason = null;
  if (!ai.ready) {
    reason =
      ai.blockedReason === 'no_api_key'
        ? 'cron run skipped: no OpenRouter key configured (add it under Settings → Account or set OPENROUTER_API_KEY); the AI is required and nothing is traded without it'
        : 'cron run skipped: the monthly AI budget is used up (raise it under Settings or wait for the UTC month reset)';
  } else if (!ai.demo) {
    const b = budgetStatus();
    if (b.avgCostPerRun && b.remainingUsd < b.avgCostPerRun) {
      reason = `cron run skipped: remaining AI budget $${b.remainingUsd.toFixed(4)} is below the average cost of a run ($${b.avgCostPerRun.toFixed(4)})`;
    }
  }
  if (reason && now - lastSkipLog > 3600_000) {
    lastSkipLog = now;
    log(reason);
  }
  return reason;
}
