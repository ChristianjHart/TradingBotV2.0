import cron from 'node-cron';
import { config } from './config.js';
import { createApp } from './app.js';
import { store } from './db/store.js';
import { startAiRun } from './services/aiRun.js';
import { scorePicks } from './services/pickScoring.js';
import { scoreShadows } from './services/shadow.js';
import { expireProposals } from './services/proposals.js';
import { mockLlmEnabled } from './services/mockLlm.js';
import { alpaca } from './services/alpaca.js';
import { monitorPositions } from './services/positions.js';
import { guarded, scheduledRunSkipReason } from './services/jobs.js';
import { warnIfProxyMisconfigured } from './middleware.js';
import { hydrateFromSupabase } from './db/hydrate.js';
import { supabaseEnabled } from './db/supabase.js';
import { applyOwnerCredentials } from './auth/accounts.js';
import { announceSetupCode } from './auth/policy.js';
import { installProcessHandlers, installShutdownHandlers } from './lifecycle.js';

installProcessHandlers();
installShutdownHandlers();

// Account-attached keys (local users file) take effect before anything reads credentials; re-applied after the Supabase restore.
applyOwnerCredentials();
if (!config.appSecret) {
  const msg = 'APP_SECRET is not set: sessions use a random per-boot secret (everyone is signed out on restart) and API keys CANNOT be saved. Set APP_SECRET to a long random string.';
  console.warn(`\n[security] WARNING: ${msg}\n`);
  store.addLog({ level: 'warn', message: msg });
}

// Which security settings did the server actually find? (names/booleans only — never values)
{
  const exact = ['SIGNUP_CODE', 'ADMIN_TOKEN', 'APP_SECRET', 'TRUST_PROXY'];
  const flag = (v) => (v ? 'set' : 'MISSING');
  const near = Object.keys(process.env).filter((k) => /sign.?up|admin.?token|app.?secret|trust.?proxy/i.test(k) && !exact.includes(k.toUpperCase().replace(/[^A-Z_]/g, '')));
  console.log(
    `[security] detected: SIGNUP_CODE=${flag(config.signupCode)} ADMIN_TOKEN=${flag(config.adminToken)} APP_SECRET=${flag(config.appSecret)} TRUST_PROXY=${config.trustProxy ? 'true' : 'MISSING'} production=${config.isProduction}`,
  );
  if (near.length) console.warn(`[security] variables with similar but unrecognised names (ignored): ${near.join(', ')} — expected exactly ${exact.join(', ')}`);
}

if (config.ai.mockLlmRequested) {
  if (mockLlmEnabled()) {
    const msg = 'MOCK_LLM is ON: the AI is replaced by a canned test fixture; every result is labelled DEMO DATA. Never use this for real decisions.';
    console.warn(`\n[dev] WARNING: ${msg}\n`);
    store.addLog({ level: 'warn', message: msg });
  } // else: mockLlmEnabled() already logged the loud production refusal
}

const app = createApp();

function workerAlive() {
  const w = store.getWorker();
  return w.status === 'online' || w.status === 'degraded';
}

function bootWorker() {
  store.setWorker({ ...store.getWorker(), status: 'online' });
  store.addLog({
    level: 'info',
    message: `bot started (paper trading simulation${alpaca.usingMock() ? ', mock data' : ', alpaca'})`,
  });
}

// Position monitoring (stops, targets, trailing, time exit) always runs.
cron.schedule('*/5 * * * *', guarded('monitor', monitorPositions));

// Score scanner picks whose horizon has passed.
cron.schedule('*/15 * * * *', guarded('score', scorePicks));

// Counterfactual (shadow) scores for decided proposals whose horizon has passed.
cron.schedule('*/15 * * * *', guarded('shadow', scoreShadows));

// Pending proposals expire after their TTL (default 6h).
cron.schedule('*/5 * * * *', guarded('proposals', () => expireProposals()));

// Scheduled AI runs cost OpenRouter credits, so they are opt-in (settings.autoRun).
const minutes = Math.max(5, config.scanIntervalMinutes);
// startAiRun() itself refuses to start while a run is in flight (runState.running).
cron.schedule(
  `*/${minutes} * * * *`,
  guarded('run', () => {
    const settings = store.getSettings();
    if (workerAlive() && settings.autoRun && !scheduledRunSkipReason() && !startAiRun()) store.addLog({ level: 'warn', message: 'cron run: a run is already in progress, skipping' });
  }),
);

const host = process.env.HOST || '0.0.0.0';
app.listen(config.port, host, () => {
  console.log(`TradingBot V2.0 (paper simulation) → http://${host}:${config.port}`);
  console.log(`Supabase: ${supabaseEnabled ? 'ON' : 'off'}`);
  console.log(`Data mode: ${alpaca.usingMock() ? 'MOCK' : 'ALPACA'}`);
  warnIfProxyMisconfigured((message) => store.addLog({ level: 'warn', message }));
  hydrateFromSupabase()
    .then(() => applyOwnerCredentials())
    .then(() => announceSetupCode())
    .finally(bootWorker);
});
