// DEV / TEST FIXTURE ONLY. MOCK_LLM=true swaps the OpenRouter call for a deterministic canned reply so screenshots and tests
// run with no key. It is NOT a fallback for a missing AI: it is never used automatically, is refused (ignored + loud warning) in production
// (NODE_ENV=production or RENDER), and everything it produces is labelled source:'demo' / model:'mock-llm'.
import { config } from '../config.js';
import { store } from '../db/store.js';
import { isCrypto } from './market.js';
import { PERSONAS, isPersonaId } from './personas.js';

export const MOCK_MODEL = 'mock-llm';
let warned = false;

/** True only when MOCK_LLM is requested AND we are not deployed. Logs a loud warning once when a deployed instance asked for it. */
export function mockLlmEnabled() {
  if (!config.ai.mockLlmRequested) return false;
  if (config.isProduction) {
    if (!warned) {
      warned = true;
      const msg = 'MOCK_LLM=true is REFUSED in production/Render: the canned demo LLM is a dev/test fixture only and is being ignored. Remove MOCK_LLM from the environment.';
      console.warn(`\n[security] WARNING: ${msg}\n`);
      try {
        store.addLog({ level: 'error', message: msg });
      } catch {
        /* logging must never throw */
      }
    }
    return false;
  }
  return true;
}

/** Test hook. */
export const _resetMockWarning = () => {
  warned = false;
};

const rnd2 = (n) => Math.round(n * 100) / 100;

function scannerReply(input) {
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  const picks = rows
    .filter((r) => r && typeof r.symbol === 'string')
    .slice(0, 20)
    .map((r, i) => ({
      symbol: r.symbol,
      direction: i % 2 === 0 || isCrypto(r.symbol) ? 'long' : 'short',
      confidence: rnd2(Math.max(0.5, 0.78 - i * 0.012)),
      reason: 'DEMO DATA: canned pick from the mock LLM (not a real model output)',
    }));
  return { picks };
}

function traderReply(input) {
  const cands = Array.isArray(input?.candidates) ? input.candidates : [];
  const slots = Number.isFinite(input?.freeSlots) ? Math.max(0, input.freeSlots) : 3;
  const equity = Number(input?.account?.equity) || 100000;
  const trades = cands
    .filter((c) => c && typeof c.symbol === 'string' && Number(c.price) > 0)
    .slice(0, Math.min(3, slots))
    .map((c) => {
      const price = Number(c.price);
      const atrAbs = price * ((Number(c.atrPct) || 1.5) / 100);
      const dir = c.direction === 'short' ? -1 : 1;
      return {
        symbol: c.symbol,
        side: dir === 1 ? 'long' : 'short',
        allocationUsd: Math.round(equity * 0.05),
        stopLoss: +(price - dir * atrAbs * 2).toFixed(4),
        takeProfit: +(price + dir * atrAbs * 3.5).toFixed(4),
        reason: `DEMO DATA: ${PERSONAS[isPersonaId(input?.voice) ? input.voice : 'default'].demo}`,
      };
    });
  return { summary: 'DEMO DATA: the mock LLM proposed the top candidates. This is a test fixture, not a real analysis.', trades };
}

function debateReply(input) {
  const p = input?.proposal || {};
  const v = isPersonaId(input?.voice) ? PERSONAS[input.voice].demo : 'canned debate from the mock LLM';
  const lean = Number(p.confidence) >= 0.7 ? 'for' : Number(p.confidence) <= 0.55 ? 'against' : 'even';
  return {
    forTrade: { thesis: `DEMO DATA: ${v}. The case FOR ${p.side || 'the trade'} ${p.symbol || ''}.`, points: ['DEMO DATA: canned supporting point (not a real analysis)', `Reward-to-risk is ${p.rewardToRisk ?? 'unknown'}`] },
    againstTrade: { thesis: 'DEMO DATA: the case AGAINST the trade (canned).', points: ['DEMO DATA: canned counter-point (not a real analysis)'] },
    verdict: { lean, note: 'DEMO DATA: canned moderator note from the mock LLM.' },
  };
}

function newsReply(input) {
  const items = (Array.isArray(input?.untrusted_news_data) ? input.untrusted_news_data : []).filter((x) => x && typeof x.symbol === 'string');
  const imminent = items.findIndex((x) => Number.isFinite(x.earningsInDays) && x.earningsInDays <= 2);
  const flagAt = imminent >= 0 ? -1 : 0; // guarantee one earnings_imminent case even when no symbol has a near date
  const notes = items.slice(0, 40).map((x, i) => {
    let h = 0;
    for (const ch of x.symbol) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const days = Number.isFinite(x.earningsInDays) ? x.earningsInDays : null;
    const first = Array.isArray(x.headlines) ? x.headlines[0] : null;
    return {
      symbol: x.symbol,
      sentiment: rnd2(((h % 21) - 10) / 10),
      catalyst: 'DEMO DATA: canned catalyst from the mock LLM',
      earningsInDays: days,
      riskFlags: (days !== null && days <= 2) || i === flagAt ? ['earnings_imminent'] : [],
      summary: 'DEMO DATA: canned news summary from the mock LLM (not a real analysis)',
      sources: first ? [{ id: first.id }] : [],
    };
  });
  return { notes };
}

/** Deterministic canned "completion" for a bot, derived from the prompt input. Returns { content, usage } like a real reply. */
export function mockChat({ bot, user }) {
  let input = null;
  try {
    input = JSON.parse(user);
  } catch {
    /* canned reply with empty input */
  }
  const out = input?.task === 'bull_bear_debate' ? debateReply(input) : bot === 'scanner' ? scannerReply(input) : bot === 'trader' ? traderReply(input) : bot === 'news' ? newsReply(input) : { items: [] };
  const content = JSON.stringify(out);
  return { content, usage: { prompt_tokens: Math.ceil(String(user).length / 4), completion_tokens: Math.ceil(content.length / 4), cost: 0 } };
}
