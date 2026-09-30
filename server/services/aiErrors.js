// Typed AI failures. There is NO fallback: when the AI cannot run, the run ends in an error/blocked state
// carrying one of these machine-readable codes and nothing is traded or guessed.
export const AI_ERROR_CODES = ['no_api_key', 'budget_exhausted', 'rate_limited', 'model_unavailable', 'invalid_output', 'upstream_error', 'timeout'];

/** Codes that put a run in the 'blocked' stage (the owner must act) rather than 'error' (retry later / different model). */
export const BLOCKING_CODES = new Set(['no_api_key', 'budget_exhausted']);

export class AiError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    Object.assign(this, extra); // status, retryAfterSec, details
  }
}

export const isAiError = (e) => e instanceof AiError || (e && typeof e.code === 'string' && AI_ERROR_CODES.includes(e.code));

/** Run stage for a failure: 'blocked' for owner-actionable codes, else 'error'. */
export const stageFor = (err) => (err?.code && BLOCKING_CODES.has(err.code) ? 'blocked' : 'error');
