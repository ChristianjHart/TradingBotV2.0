import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { config, hasOpenRouterKey } from '../config.js';
import { alpaca } from './alpaca.js';
import { gatherMarketData, runScannerBot } from './aiScanner.js';
import { runTraderBot } from './traderBot.js';
import { runNewsStage } from './newsBot.js';
import { monitorPositions } from './positions.js';
import { recordPicks, scorePicks } from './pickScoring.js';
import { scoreShadows } from './shadow.js';
import { expireProposals } from './proposals.js';
import { AiError, stageFor, isAiError } from './aiErrors.js';
import { mockLlmEnabled } from './mockLlm.js';
import { budgetStatus, estimateCallCostUsd } from './spend.js';
import { setupOf } from './debate.js';

const log = (msg) => console.log(`[run] ${msg}`);

export const runState = {
  running: false,
  stage: 'idle', // idle | fetching | scanning | news | trading | done | error | blocked
  runId: null,
  startedAt: null,
  finishedAt: null,
  error: null, // human message when stage is 'error' | 'blocked'
  code: null, // machine-readable AiError code (no_api_key, budget_exhausted, rate_limited, model_unavailable, invalid_output, upstream_error, timeout) or 'run_failed'
  picks: 0,
  proposals: 0, // pending proposals created by this run
  autoApproved: 0, // positions opened by auto-approval (0 unless the owner enabled it)
  opened: 0, // legacy alias of autoApproved
  demo: false, // true when the run used the MOCK_LLM test fixture
  news: null, // { status:'ok'|'partial'|'skipped'|'error', reason, symbols, headlines, earningsKnown, costUsd, notes } of the current/last run's news stage
  trigger: null, // { type:'manual'|'schedule'|'event'|'test', plan, slot, reason } of the current/last run
};

/** Can the AI run right now? Never spends anything. { required:true, ready, blockedReason?, demo } */
export function aiStatus() {
  const demo = mockLlmEnabled();
  if (!demo && !hasOpenRouterKey()) return { required: true, ready: false, blockedReason: 'no_api_key', demo: false };
  if (!demo) {
    const b = budgetStatus();
    if (b.level === 'blocked') {
      const est = estimateCallCostUsd({ bot: 'scanner', model: config.openrouter.scannerModel });
      if (est > 0) return { required: true, ready: false, blockedReason: 'budget_exhausted', demo: false };
    }
  }
  return { required: true, ready: true, demo };
}

/** Throws AiError before any market data is fetched or anything is spent/changed. */
export function assertAiReady() {
  const s = aiStatus();
  if (s.ready) return s;
  if (s.blockedReason === 'no_api_key') throw new AiError('no_api_key', 'OpenRouter key not set (add it under Settings → Account or set OPENROUTER_API_KEY). The AI cannot run without it and nothing is traded.');
  const b = budgetStatus();
  throw new AiError('budget_exhausted', `monthly AI budget reached: $${b.spentUsd.toFixed(4)} spent of $${b.capUsd.toFixed(2)}; it resets ${b.resetsAt.slice(0, 10)} (UTC), or raise the budget / pick a free model under Settings. Nothing was run or traded.`, {
    details: { capUsd: b.capUsd, spentUsd: b.spentUsd, resetsAt: b.resetsAt },
  });
}

/** Persist a run summary locally (history + latest) and to Supabase. */
function saveRun(summary, { latest = true } = {}) {
  if (latest) store.setRunSummary(summary);
  store.addRun(summary);
  upsert('runs', {
    id: summary.runId,
    at: summary.at,
    ok: !summary.error,
    scanner_source: summary.scannerSource ?? null,
    trader_source: summary.traderSource ?? null,
    picks: summary.picks ?? 0,
    opened: summary.autoApproved ?? 0,
    duration_ms: summary.durationMs ?? null,
    raw: summary,
  });
}

const compact = (p) => ({ earningsInDays: p.earningsInDays ?? null, riskFlags: p.riskFlags ?? [], rejectReason: p.rejectReason ?? null, id: p.id, symbol: p.symbol, side: p.side, allocationUsd: p.allocationUsd, entry: p.entry, stopLoss: p.stopLoss, takeProfit: p.takeProfit, confidence: p.confidence, reason: p.reason, status: p.status, expiresAt: p.expiresAt });

export function startAiRun({ trigger } = {}) {
  if (runState.running) return false;
  const trig = { type: 'manual', plan: null, slot: null, reason: null, ...(trigger || {}) };
  const runId = `run_${Date.now()}`;
  Object.assign(runState, {
    running: true,
    stage: 'fetching',
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    code: null,
    picks: 0,
    proposals: 0,
    autoApproved: 0,
    opened: 0,
    demo: false,
    news: null,
    trigger: trig,
  });
  (async () => {
    const t0 = Date.now();
    const usage = { costUsd: 0, calls: 0, costSource: 'reported' };
    const addUsage = (u) => {
      if (!u) return;
      usage.costUsd = Math.round((usage.costUsd + u.costUsd) * 1e6) / 1e6;
      usage.calls += u.calls || 0;
      if (u.costSource === 'estimated') usage.costSource = 'estimated';
    };
    try {
      // The AI is REQUIRED: check it (key, budget) before touching anything.
      runState.demo = assertAiReady().demo;
      store.addLog({ level: 'info', message: `AI run started — scanner bot → trader bot${runState.demo ? ' (DEMO: MOCK_LLM test fixture)' : ''}` });
      const lap = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
      log('started');
      alpaca.clearCache();
      await monitorPositions();
      await scorePicks();
      await scoreShadows();
      expireProposals();
      const { data, regime } = await gatherMarketData();
      log(`market data for ${data.length} symbols (${lap()})`);
      if (!data.length) throw new Error('no market data available');
      runState.stage = 'scanning';
      const scan = await runScannerBot(data, { regime, runId }); // dashboard shows this list as soon as it is saved
      addUsage(scan.usage);
      runState.picks = scan.picks.length;
      recordPicks(runId, scan.picks);
      log(`scanner bot ${scan.model} → ${scan.picks.length} picks (${lap()})`);
      store.addLog({ level: 'info', message: `scanner bot (${scan.source}, ${scan.model}) → ${scan.picks.length} picks` });
      // News & earnings: OPTIONAL context. Never throws; when it cannot run the trader still runs (without notes) and the record says why.
      runState.stage = 'news';
      const newsRes = await runNewsStage(scan.picks, { runId });
      addUsage(newsRes.usage);
      runState.news = newsRes.news;
      log(`news bot → ${newsRes.news.status}${newsRes.news.reason && newsRes.news.status !== 'ok' ? ` (${newsRes.news.reason})` : ''} (${lap()})`);
      runState.stage = 'trading';
      const features = new Map(data.map((d) => [d.symbol, setupOf(d.row)]));
      const trades = await runTraderBot(scan.picks, { regime, runId, scannerModel: scan.model, notes: newsRes.notes, features });
      addUsage(trades.usage);
      runState.proposals = trades.proposalCount;
      runState.autoApproved = trades.autoApproved.length;
      runState.opened = trades.autoApproved.length;
      saveRun({
        runId,
        at: new Date().toISOString(),
        status: 'done',
        durationMs: Date.now() - t0,
        picks: scan.picks.length,
        scannerSource: scan.source,
        scannerModel: scan.model,
        regime: regime?.line || null,
        traderSource: trades.source,
        traderModel: trades.model || null,
        persona: trades.persona ?? null,
        demo: runState.demo,
        trigger: trig,
        proposed: trades.proposed ?? 0, // how many trades the model suggested
        proposalCount: trades.proposalCount, // how many became pending proposals after the risk engine
        autoApproved: trades.autoApproved.length,
        proposals: trades.proposals.map(compact),
        newsBlocked: (trades.newsBlocked || []).map(compact), // proposals the news guard auto-rejected (earnings blackout / blocking risk flag)
        news: runState.news,
        note: trades.note || '',
        rejected: trades.skippedList || [],
        adjusted: trades.adjustedList || [],
        trades: trades.autoApproved, // positions opened by auto-approval (empty unless enabled)
        costUsd: usage.costUsd,
        costSource: usage.costSource,
        aiCalls: usage.calls,
      });
      store.setWorker({ ...store.getWorker(), lastScanAt: new Date().toISOString() });
      log(`trader bot ${trades.source} → ${trades.proposalCount} proposals (${lap()})`);
      runState.stage = 'done';
    } catch (err) {
      const code = isAiError(err) ? err.code : 'run_failed';
      runState.stage = stageFor({ code });
      runState.error = err.message;
      runState.code = code;
      log(`${runState.stage.toUpperCase()} (${code}): ${err.message}`);
      store.addLog({ level: runState.stage === 'blocked' ? 'warn' : 'error', message: `AI run ${runState.stage} (${code}): ${err.message}` });
      // Failed runs go to history only, so /ai/summary keeps the last good run; previous picks/proposals/positions are untouched.
      saveRun(
        { runId, at: new Date().toISOString(), status: runState.stage, code, durationMs: Date.now() - t0, error: err.message, picks: runState.picks, proposalCount: 0, proposals: [], trades: [], rejected: [], demo: runState.demo, news: runState.news, trigger: trig, costUsd: usage.costUsd, aiCalls: usage.calls },
        { latest: false },
      );
    } finally {
      runState.running = false;
      runState.finishedAt = new Date().toISOString();
    }
  })();
  return true;
}
