// Trade proposals: the trader bot only PROPOSES. The owner approves (or rejects) each one; approval re-runs the whole risk engine
// with a FRESH quote and only then opens the simulated position through the normal openPosition path.
import { config } from '../config.js';
import { store } from '../db/store.js';
import { upsert } from '../db/supabase.js';
import { alpaca } from './alpaca.js';
import { getAccount, livePrices, openPosition } from './positions.js';
import { limitsFrom, todaysPnl, isHalted } from './risk.js';
import { sizeTrade } from './sizing.js';
import { isCrypto } from './market.js';

export const STATUSES = ['pending', 'approved', 'rejected', 'expired', 'superseded'];

export class ProposalError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

const iso = (ms = Date.now()) => new Date(ms).toISOString();

export function syncRow(p) {
  upsert('proposals', {
    id: p.id,
    run_id: p.runId,
    symbol: p.symbol,
    side: p.side,
    status: p.status,
    created_at: p.createdAt,
    expires_at: p.expiresAt,
    decided_at: p.decidedAt ?? null,
    raw: p,
    updated_at: iso(),
  });
}

/** Merge a patch onto the LATEST stored copy of a proposal (synchronously) and persist it. Returns the merged proposal or null. */
export function patchProposal(id, patch) {
  const all = store.getProposals();
  const i = all.findIndex((p) => p.id === id);
  if (i < 0) return null;
  all[i] = { ...all[i], ...patch };
  store.setProposals(all);
  syncRow(all[i]);
  return all[i];
}

/**
 * Store the proposals of one run. `items` are fully sized trades (see traderBot). Older still-pending proposals for the SAME
 * symbols become 'superseded'. Returns the stored proposals.
 */
export function createProposals({ runId, items, source, models, ttlHours }) {
  const ttl = Number(ttlHours) > 0 ? Number(ttlHours) : store.getSettings().proposalTtlHours || config.ai.proposalTtlHours;
  const now = Date.now();
  const created = items.map((t) => ({
    id: `prop_${runId}_${t.symbol.replace(/\W/g, '')}`,
    runId,
    bot: 'trader',
    symbol: t.symbol,
    side: t.side,
    allocationUsd: +t.alloc.toFixed(2),
    entry: +t.quoted.toFixed(4), // quoted price at proposal time (drift is measured against this)
    entryFill: +t.entry.toFixed(4), // what the simulated fill would have been (quote + slippage)
    stopLoss: +t.stop.toFixed(4),
    takeProfit: +t.target.toFixed(4),
    qty: +(t.alloc / t.entry).toFixed(6),
    atrPct: t.atrPct ?? null,
    confidence: t.confidence ?? null,
    reason: String(t.reason || '').slice(0, 300),
    source, // 'ai' | 'demo'
    models: { scanner: models?.scanner ?? null, trader: models?.trader ?? null },
    status: 'pending',
    createdAt: iso(now),
    expiresAt: iso(now + ttl * 3600_000),
    horizonHours: store.getSettings().horizonHours || 24, // shadow scoring horizon
    decidedAt: null,
    decidedBy: null,
    rejectReason: null,
    riskCheck: t.riskCheck,
    shadow: null,
  }));
  const syms = new Set(created.map((p) => p.symbol));
  const all = store.getProposals();
  const changed = [];
  for (const old of all) {
    if (old.status === 'pending' && syms.has(old.symbol) && !created.some((c) => c.id === old.id)) {
      const successor = created.find((c) => c.symbol === old.symbol);
      Object.assign(old, { status: 'superseded', decidedAt: iso(now), decidedBy: 'system', supersededBy: successor?.id ?? null });
      changed.push(old);
    }
  }
  const ids = new Set(created.map((c) => c.id));
  store.setProposals([...created, ...all.filter((p) => !ids.has(p.id))]);
  for (const p of [...created, ...changed]) syncRow(p);
  if (changed.length) store.addLog({ level: 'info', message: `proposals: superseded ${changed.length} older pending proposal(s) (${changed.map((p) => p.symbol).join(', ')})` });
  return created;
}

/** Mark pending proposals past their expiry as 'expired'. Returns how many. */
export function expireProposals(now = Date.now()) {
  const all = store.getProposals();
  const hit = all.filter((p) => p.status === 'pending' && Date.parse(p.expiresAt) <= now);
  if (!hit.length) return 0;
  for (const p of hit) Object.assign(p, { status: 'expired', decidedAt: iso(now), decidedBy: 'system' });
  store.setProposals(all);
  for (const p of hit) syncRow(p);
  store.addLog({ level: 'info', message: `proposals: ${hit.length} expired unanswered (${hit.map((p) => p.symbol).join(', ')})` });
  return hit.length;
}

export function countsOf(list) {
  const c = { total: list.length, pending: 0, approved: 0, rejected: 0, expired: 0, superseded: 0 };
  for (const p of list) if (p.status in c) c[p.status] += 1;
  return c;
}

/** GET /api/proposals payload (expires stale ones first so the list is truthful). */
export function listProposals({ status, limit = 100 } = {}) {
  expireProposals();
  const all = store.getProposals();
  const rows = (status && status !== 'all' ? all.filter((p) => p.status === status) : all).slice(0, Math.min(Math.max(Number(limit) || 100, 1), 500));
  const now = Date.now();
  return {
    proposals: rows.map((p) => (p.status === 'pending' ? { ...p, secondsLeft: Math.max(0, Math.round((Date.parse(p.expiresAt) - now) / 1000)) } : p)),
    counts: countsOf(all),
  };
}

// ---- approval ----
// Approvals are serialised: each one awaits a fresh quote between its risk check and openPosition, so two at once could both
// pass the same cap. A per-id in-flight map makes a double-click on the same proposal share ONE result.
let tail = Promise.resolve();
const serialize = (fn) => {
  const run = tail.then(fn, fn);
  tail = run.then(() => {}, () => {});
  return run;
};
const inflight = new Map();

export function approveProposal(id, { by = 'user' } = {}) {
  if (inflight.has(id)) return inflight.get(id);
  const p = serialize(() => doApprove(id, by)).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

const stale = (symbol, q) => new ProposalError(409, 'stale_quote', q ? `the ${symbol} quote is stale (market closed or old data); try again when the market is open` : `no fresh ${symbol} quote is available; try again shortly`, { symbol, unavailable: !q });

async function doApprove(id, by) {
  const found = store.getProposals().find((p) => p.id === id);
  if (!found) throw new ProposalError(404, 'not_found', 'proposal not found');
  if (found.status !== 'pending') throw new ProposalError(409, 'already_decided', `proposal is already ${found.status}`, { status: found.status });
  if (Date.parse(found.expiresAt) <= Date.now()) {
    patchProposal(id, { status: 'expired', decidedAt: iso(), decidedBy: 'system' });
    throw new ProposalError(409, 'expired', 'the proposal expired; run the AI again for fresh numbers', { expiresAt: found.expiresAt });
  }
  const ws = store.getWorker().status;
  if (ws === 'stopped' || ws === 'killed') throw new ProposalError(409, 'worker_not_running', `worker is ${ws}: start the worker before approving trades`, { workerStatus: ws });

  const settings = store.getSettings();
  const limits = limitsFrom(settings);
  const openNow = () => store.getPositions().filter((p) => p.status === 'open');
  const gateOpen = () => {
    const open = openNow();
    if (open.length >= config.maxOpenPositions) throw new ProposalError(409, 'no_slots', `all ${config.maxOpenPositions} position slots are full`, { open: open.length, max: config.maxOpenPositions });
    if (open.some((p) => p.symbol === found.symbol)) throw new ProposalError(409, 'risk_blocked', `a ${found.symbol} position is already open`, { reason: 'already open' });
  };
  gateOpen();
  if (found.side === 'short' && isCrypto(found.symbol)) throw new ProposalError(409, 'risk_blocked', 'crypto cannot be shorted', { reason: 'crypto short' });

  let q = null;
  try {
    q = await alpaca.getQuote(found.symbol);
  } catch {
    q = null;
  }
  if (!q || !Number.isFinite(q.price) || q.stale) throw stale(found.symbol, q && Number.isFinite(q.price) ? q : null);

  const threshold = Math.max((found.atrPct || 0) / 100, 0.015);
  const drift = Math.abs(q.price - found.entry) / found.entry;
  if (drift > threshold) {
    throw new ProposalError(409, 'price_moved', `${found.symbol} moved ${(drift * 100).toFixed(2)}% since the proposal (limit ${(threshold * 100).toFixed(2)}%); run the AI again for fresh levels`, {
      proposalEntry: found.entry,
      freshPrice: q.price,
      driftPct: +(drift * 100).toFixed(3),
      thresholdPct: +(threshold * 100).toFixed(3),
    });
  }

  const open = openNow();
  const prices = await livePrices(open);
  const account = getAccount(prices);
  if (isHalted(todaysPnl(account.equity), account.equity, limits)) {
    throw new ProposalError(409, 'risk_blocked', `daily loss halt: today's P&L is below -${settings.dailyLossHaltPct}% of equity`, { reason: 'daily_loss_halt' });
  }
  gateOpen(); // state may have changed while we awaited
  const sized = sizeTrade({
    symbol: found.symbol,
    side: found.side,
    quoted: q.price,
    atrPct: found.atrPct,
    stopLoss: found.stopLoss,
    takeProfit: found.takeProfit,
    allocationUsd: found.allocationUsd,
    equity: account.equity,
    cash: account.cash,
    open: openNow(),
    settings,
    limits,
    repair: false,
  });
  if (!sized.ok) throw new ProposalError(409, sized.code, sized.reason, { reason: sized.reason, freshPrice: q.price, proposalEntry: found.entry });

  const model = found.models?.trader ?? null;
  const pos = openPosition({
    symbol: found.symbol,
    side: found.side,
    entry: +sized.entry.toFixed(4),
    stopLoss: +sized.stop.toFixed(4),
    takeProfit: +sized.target.toFixed(4),
    allocation: +sized.alloc.toFixed(2),
    qty: +(sized.alloc / sized.entry).toFixed(6),
    fees: sized.fee,
    slippage: +(Math.abs(sized.entry - q.price) * (sized.alloc / sized.entry)).toFixed(2),
    confidence: found.confidence,
    reason: found.reason,
    source: found.source,
    model,
    proposalId: found.id,
    runId: found.runId,
  });
  const proposal = patchProposal(id, {
    status: 'approved',
    decidedAt: iso(),
    decidedBy: by,
    positionId: pos.id,
    approval: { freshPrice: q.price, entryFill: pos.entry, allocationUsd: pos.allocation, driftPct: +(drift * 100).toFixed(3), riskCheck: sized.riskCheck },
  });
  store.addLog({ level: 'info', message: `proposal approved (${by}): ${found.side.toUpperCase()} ${found.symbol} $${pos.allocation} @ ${pos.entry}` });
  return { proposal, position: pos };
}

/** Reject a pending proposal. */
export function rejectProposal(id, { reason, by = 'user' } = {}) {
  const found = store.getProposals().find((p) => p.id === id);
  if (!found) throw new ProposalError(404, 'not_found', 'proposal not found');
  if (found.status !== 'pending') throw new ProposalError(409, 'already_decided', `proposal is already ${found.status}`, { status: found.status });
  const clean = typeof reason === 'string' ? reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 200) : '';
  const proposal = patchProposal(id, { status: 'rejected', decidedAt: iso(), decidedBy: by, rejectReason: clean || null });
  store.addLog({ level: 'info', message: `proposal rejected (${by}): ${found.side.toUpperCase()} ${found.symbol}${clean ? ` — ${clean}` : ''}` });
  return { proposal };
}

/** Approve every pending proposal that passes its re-checks (best confidence first). Failures are reported, not fatal. */
export async function approveAll({ by = 'user' } = {}) {
  expireProposals();
  const pending = store.getProposals().filter((p) => p.status === 'pending').sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const approved = [];
  const failed = [];
  for (const p of pending) {
    try {
      const r = await approveProposal(p.id, { by });
      approved.push({ id: p.id, symbol: p.symbol, positionId: r.position.id });
    } catch (err) {
      failed.push({ id: p.id, symbol: p.symbol, code: err.code || 'error', error: err.message, ...(err.details ? { details: err.details } : {}) });
    }
  }
  return { approved, failed };
}

/**
 * Auto-approval (setting `autoApprove`, default OFF). Runs only when the switch is exactly true; every proposal still goes through
 * the full approval path (fresh quote, drift check, caps, slots, halt), is limited to `autoApproveMaxAllocPct` of equity, never
 * applies to demo (mock LLM) proposals, and every outcome is logged.
 */
export async function autoApproveProposals(created) {
  const s = store.getSettings();
  const out = { approved: [], skipped: [] };
  if (s.autoApprove !== true) return out;
  const equity = getAccount(await livePrices()).equity;
  const maxAlloc = (equity * (Number(s.autoApproveMaxAllocPct) || 0)) / 100;
  for (const p of created) {
    if (p.source === 'demo') {
      out.skipped.push({ id: p.id, reason: 'demo proposal' });
      continue;
    }
    if (p.allocationUsd > maxAlloc + 1e-9) {
      out.skipped.push({ id: p.id, reason: `allocation $${p.allocationUsd} above auto-approve limit $${maxAlloc.toFixed(0)}` });
      store.addLog({ level: 'info', message: `AUTO-APPROVE skipped ${p.symbol}: allocation $${p.allocationUsd} is above the ${s.autoApproveMaxAllocPct}% limit ($${maxAlloc.toFixed(0)}); left pending for manual approval` });
      continue;
    }
    try {
      const r = await approveProposal(p.id, { by: 'auto' });
      out.approved.push({ id: p.id, symbol: p.symbol, positionId: r.position.id });
      store.addLog({ level: 'warn', message: `AUTO-APPROVED ${p.side.toUpperCase()} ${p.symbol} $${r.position.allocation} (auto-approve is ON, max ${s.autoApproveMaxAllocPct}% of equity per trade)` });
    } catch (err) {
      out.skipped.push({ id: p.id, reason: `${err.code || 'error'}: ${err.message}` });
      store.addLog({ level: 'info', message: `AUTO-APPROVE could not open ${p.symbol}: ${err.code || 'error'} — ${err.message}; left pending` });
    }
  }
  return out;
}
