import { config, hasOpenRouterKey, scrubSecrets } from '../config.js';
import { insert } from '../db/supabase.js';
import { loggedFetch } from './http.js';
import { AiError } from './aiErrors.js';
import { mockLlmEnabled, mockChat, MOCK_MODEL } from './mockLlm.js';
import { getCatalog, catalogEntry } from './catalog.js';
import { recordSpend, checkBudget, estimateCallCostUsd, estimateTokensFromChars, priceOf, costFromTokens, FALLBACK_PRICE } from './spend.js';

/** Tunables (mutable so tests can make waits instant). */
export const aiTuning = {
  rateLimitMaxWaitMs: 15_000, // a 429 with Retry-After beyond this fails immediately instead of waiting
  defaultRetryWaitMs: 3_000, // 429 without Retry-After: one short wait
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Models that rejected response_format at runtime: prompt-only JSON from then on. */
const noJsonMode = new Set();
export const _resetJsonMode = () => noJsonMode.clear();

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v) => {
  if (typeof v === 'boolean' || v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Pull the first JSON object out of an LLM reply (handles ``` fences and chatter). */
export function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model reply contained no JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Reply text from any of the response shapes seen in the wild (string, content parts, legacy `text`). */
export function contentOf(data) {
  const c = Array.isArray(data?.choices) ? data.choices[0] : null;
  if (!isPlain(c)) return '';
  const raw = c.message?.content ?? c.text ?? '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Token counts + reported cost from whatever `usage` shape came back (all fields optional, strings tolerated). */
export function readUsage(data) {
  const u = isPlain(data?.usage) ? data.usage : {};
  let prompt = numOrNull(u.prompt_tokens ?? u.input_tokens);
  const completion = numOrNull(u.completion_tokens ?? u.output_tokens);
  const total = numOrNull(u.total_tokens);
  if (prompt === null && total !== null && completion !== null && total >= completion) prompt = total - completion;
  return { raw: u, prompt, completion, cost: numOrNull(u.cost) };
}

/** Retry-After header (seconds or HTTP date) -> seconds, or null. */
export function parseRetryAfter(headers, now = Date.now()) {
  const v = headers?.get?.('retry-after');
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, (t - now) / 1000) : null;
}

const errText = (status, body) => {
  let msg = '';
  try {
    const j = JSON.parse(body);
    msg = j?.error?.message || j?.message || '';
    if (isPlain(j?.error?.metadata) && typeof j.error.metadata.raw === 'string') msg += ` ${j.error.metadata.raw}`;
  } catch {
    /* not JSON */
  }
  return scrubSecrets(msg || String(body || '')).replace(/\s+/g, ' ').trim().slice(0, 200);
};

/** Map an upstream failure status (+ body) to a typed AiError. */
export function classifyFailure(status, body, retryAfterSec = null) {
  const detail = errText(status, body);
  const suffix = detail ? `: ${detail}` : '';
  if (status === 429) return new AiError('rate_limited', `OpenRouter rate limit (HTTP 429)${suffix}. Free models are often rate limited; try again later or pick another model.`, { status, retryAfterSec });
  if (status === 401 || (status === 403 && !/moderat|flagged/i.test(detail))) return new AiError('no_api_key', `OpenRouter rejected the API key (HTTP ${status}). Check the key under Settings → Account.`, { status });
  if (status === 402) return new AiError('budget_exhausted', `OpenRouter account has insufficient credits (HTTP 402). Add credits at openrouter.ai or choose a free model.`, { status, details: { source: 'openrouter' } });
  if (status === 404 || (/not a valid model|invalid model|no endpoints? (found|available)|no allowed providers|model .*(not found|does not exist|unavailable)|no available (provider|endpoint)/i.test(detail) && status >= 400 && status < 600 && status !== 401)) {
    return new AiError('model_unavailable', `Model not available on OpenRouter (HTTP ${status})${suffix}. Pick another model under Settings.`, { status });
  }
  if (status === 408 || status === 504) return new AiError('timeout', `OpenRouter timed out (HTTP ${status})${suffix}`, { status });
  return new AiError('upstream_error', `OpenRouter error (HTTP ${status})${suffix}`, { status });
}

const looksLikeJsonModeRejection = (status, body) => status === 400 && /response_format|json_object|json mode|structured|not support/i.test(errText(status, body));

function networkError(err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.cause?.name === 'TimeoutError';
  return timedOut
    ? new AiError('timeout', 'OpenRouter request timed out')
    : new AiError('upstream_error', `could not reach OpenRouter: ${scrubSecrets(err?.cause?.message || err?.message || 'network error').slice(0, 150)}`);
}

/**
 * ONE model call: budget governor -> request (json mode when supported, one bounded wait on 429, one json-mode downgrade) ->
 * cost accounting (ledger + ai_logs.usage). Returns { content, usage:{promptTokens,completionTokens,costUsd,costSource} }.
 * Throws AiError. The estimate is checked BEFORE any request is sent.
 */
async function callOnce({ bot, model, messages, maxTokens, timeoutMs, runId, kind }) {
  const promptChars = messages.reduce((s, m) => s + String(m.content).length, 0);

  if (mockLlmEnabled()) {
    const { content, usage } = mockChat({ bot, user: messages[1].content });
    recordSpend({ bot, model: MOCK_MODEL, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, costUsd: 0, costSource: 'reported', ok: true, runId, mock: true });
    return { content, usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, costUsd: 0, costSource: 'reported' }, mock: true };
  }

  checkBudget(estimateCallCostUsd({ bot, model, promptChars, maxTokens }));
  let useJson = !noJsonMode.has(model) && catalogEntry(model)?.supportsJson !== false;
  let waited = false;
  let downgraded = false;
  const started = Date.now();
  const log = { bot, model, request: { model, max_tokens: maxTokens, kind, messages }, response: null, usage: null, ok: false, error: null };
  const finish = () => insert('ai_logs', { ...log, duration_ms: Date.now() - started });
  try {
    for (;;) {
      const body = { model, temperature: 0.2, max_tokens: maxTokens, messages, usage: { include: true } };
      if (useJson) body.response_format = { type: 'json_object' };
      let res;
      let text;
      try {
        res = await loggedFetch('openrouter', `${config.openrouter.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.openrouter.key}`, 'Content-Type': 'application/json', 'X-Title': 'TradingBot V2' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await res.text();
      } catch (err) {
        throw networkError(err);
      }
      log.response = scrubSecrets(text);
      let status = res.status;
      let data = null;
      if (res.ok) {
        try {
          data = JSON.parse(text);
        } catch {
          throw new AiError('upstream_error', 'OpenRouter returned a non-JSON response');
        }
        const be = isPlain(data) && isPlain(data.error) ? data.error : null;
        const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
        if (be && !choice) status = Number(be.code) >= 400 && Number(be.code) < 600 ? Number(be.code) : 502; // 200 carrying an error body
        else if (isPlain(choice) && isPlain(choice.error)) status = Number(choice.error.code) >= 400 && Number(choice.error.code) < 600 ? Number(choice.error.code) : 502;
      }
      if (status < 400) {
        const u = readUsage(data);
        const content = contentOf(data);
        const price = priceOf(model);
        const promptTokens = u.prompt ?? estimateTokensFromChars(promptChars);
        const completionTokens = u.completion ?? estimateTokensFromChars(content.length);
        const reported = u.cost !== null;
        const costUsd = reported ? u.cost : costFromTokens(price || FALLBACK_PRICE, promptTokens, completionTokens);
        const costSource = reported ? 'reported' : 'estimated';
        log.usage = { ...u.raw, prompt_tokens: promptTokens, completion_tokens: completionTokens, cost_usd: costUsd, cost_source: costSource, run_id: runId ?? null, kind };
        log.response = content || log.response;
        log.ok = true;
        recordSpend({ bot, model, promptTokens, completionTokens, costUsd, costSource, ok: true, runId });
        return { content, usage: { promptTokens, completionTokens, costUsd, costSource } };
      }
      const failBody = res.ok ? JSON.stringify(data.error || data.choices?.[0]?.error || {}) : text;
      const retryAfter = parseRetryAfter(res.headers);
      if (status === 429 && !waited) {
        const waitMs = retryAfter !== null ? retryAfter * 1000 : aiTuning.defaultRetryWaitMs;
        if (waitMs <= aiTuning.rateLimitMaxWaitMs) {
          waited = true;
          await aiTuning.sleep(waitMs);
          continue;
        }
      }
      if (useJson && !downgraded && (looksLikeJsonModeRejection(status, failBody) || (status === 404 && /response_format|json/i.test(errText(status, failBody))))) {
        noJsonMode.add(model);
        useJson = false;
        downgraded = true;
        continue;
      }
      throw classifyFailure(status, failBody, retryAfter);
    }
  } catch (err) {
    const e = err instanceof AiError ? err : new AiError('upstream_error', scrubSecrets(err?.message || 'unexpected error'));
    log.error = `${e.code}: ${scrubSecrets(e.message)}`;
    throw e;
  } finally {
    finish();
  }
}

const REPAIR = (why) =>
  `Your previous reply could not be used (${String(why).replace(/\s+/g, ' ').slice(0, 200)}). Reply again with ONLY a single valid JSON object that follows the requested schema exactly: no prose, no markdown fences, no comments, no trailing text. Keep it compact.`;

/**
 * Ask a model for JSON. There is NO fallback: every failure is an AiError with a machine-readable code
 * (no_api_key, budget_exhausted, rate_limited, model_unavailable, invalid_output, upstream_error, timeout).
 * `validate(json)` (optional) must return the cleaned value or throw; unusable output gets exactly ONE repair retry (billed and
 * ledgered like any call), after which the call fails with invalid_output.
 * Returns { json, value, usage:{promptTokens,completionTokens,costUsd,costSource,calls}, model, repaired, mock }.
 */
export async function chatJson({ bot = 'other', model, system, user, maxTokens = 8000, timeoutMs = 170_000, runId = null, validate }) {
  const mock = mockLlmEnabled();
  if (!mock && !hasOpenRouterKey()) throw new AiError('no_api_key', 'OpenRouter key not set (add it under Settings → Account or set OPENROUTER_API_KEY). The AI cannot run without it and nothing is traded.');
  if (!mock) await getCatalog().catch(() => null); // best effort: pricing + json-mode support (cached 1h)
  const usedModel = mock ? MOCK_MODEL : model;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const total = { promptTokens: 0, completionTokens: 0, costUsd: 0, costSource: 'reported', calls: 0 };
  const add = (u) => {
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.costUsd = Math.round((total.costUsd + u.costUsd) * 1e6) / 1e6;
    if (u.costSource === 'estimated') total.costSource = 'estimated';
    total.calls += 1;
  };
  const parse = (content) => {
    const json = extractJson(content);
    return { json, value: validate ? validate(json) : json };
  };

  const first = await callOnce({ bot, model: usedModel, messages, maxTokens, timeoutMs, runId, kind: 'first' });
  add(first.usage);
  try {
    const out = parse(first.content);
    return { ...out, usage: total, model: usedModel, repaired: false, mock };
  } catch (err) {
    const why = err.message;
    const repairMessages = [...messages, { role: 'assistant', content: String(first.content || '(empty reply)').slice(0, 6000) }, { role: 'user', content: REPAIR(why) }];
    const second = await callOnce({ bot, model: usedModel, messages: repairMessages, maxTokens, timeoutMs, runId, kind: 'repair' });
    add(second.usage);
    try {
      const out = parse(second.content);
      return { ...out, usage: total, model: usedModel, repaired: true, mock };
    } catch (err2) {
      throw new AiError('invalid_output', `the model returned unusable output twice (${scrubSecrets(err2.message).slice(0, 160)}); nothing was traded`, { details: { calls: total.calls, costUsd: total.costUsd } });
    }
  }
}
