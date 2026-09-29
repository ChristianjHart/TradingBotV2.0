import { store } from './db/store.js';
import { flush as flushSupabase } from './db/supabase.js';

let installed = false;
const uncaughtTimes = [];

/**
 * Process-level safety net. Unhandled rejections are logged and the process survives. Uncaught exceptions are logged
 * and survived too (a paper simulation should not die on one bad cycle), but a crash loop (5 within a minute) exits so the
 * platform restarts a clean process. Returns the handlers for tests.
 */
export function installProcessHandlers({ exit = (c) => process.exit(c), log = defaultLog } = {}) {
  const onRejection = (reason) => log('error', `unhandledRejection: ${reason?.stack || reason}`);
  const onException = (err) => {
    log('error', `uncaughtException: ${err?.stack || err}`);
    const now = Date.now();
    uncaughtTimes.push(now);
    while (uncaughtTimes.length && now - uncaughtTimes[0] > 60_000) uncaughtTimes.shift();
    if (uncaughtTimes.length >= 5) shutdown('crash loop', { exit, code: 1 });
  };
  if (!installed) {
    installed = true;
    process.on('unhandledRejection', onRejection);
    process.on('uncaughtException', onException);
  }
  return { onRejection, onException };
}

function defaultLog(level, message) {
  console.error(`[process] ${message}`);
  try {
    store.addLog({ level, message: message.split('\n')[0].slice(0, 300) });
  } catch {
    /* logging must never throw */
  }
}

/** Flush the log debouncer and the Supabase queue (works whether or not Supabase is enabled). */
export async function flushAll() {
  try {
    store.flush();
  } catch {
    /* best effort */
  }
  try {
    await flushSupabase();
  } catch {
    /* best effort */
  }
}

export async function shutdown(reason, { exit = (c) => process.exit(c), code = 0 } = {}) {
  console.log(`[process] ${reason}: flushing and exiting`);
  await flushAll();
  exit(code);
}

/** SIGTERM (Render deploys) / SIGINT (Ctrl-C): flush then exit. */
export function installShutdownHandlers(opts) {
  for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => shutdown(sig, opts));
}
