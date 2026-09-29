import { config, hasOpenRouterKey } from '../config.js';
import { insert } from '../db/supabase.js';
import { loggedFetch } from './http.js';

/** Pull the first JSON object out of an LLM reply (handles ``` fences and chatter). */
export function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model reply contained no JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** One model call. Always writes an ai_logs row: full prompt sent + raw reply (or the error). */
export async function chatJson({ bot, model, system, user, maxTokens = 8000, timeoutMs = 170_000 }) {
  if (!hasOpenRouterKey()) throw new Error('OPENROUTER_API_KEY not set');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const started = Date.now();
  const log = { bot, model, request: { model, max_tokens: maxTokens, messages }, response: null, usage: null, ok: false, error: null };
  try {
    const res = await loggedFetch('openrouter', `${config.openrouter.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openrouter.key}`,
        'Content-Type': 'application/json',
        'X-Title': 'TradingBot V2',
      },
      body: JSON.stringify({ model, temperature: 0.2, max_tokens: maxTokens, messages }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    log.response = text;
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    log.usage = data.usage || null;
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error(`OpenRouter returned no content (${JSON.stringify(data.error || {}).slice(0, 150)})`);
    log.response = content;
    const json = extractJson(content);
    log.ok = true;
    return { json, usage: log.usage };
  } catch (err) {
    log.error = err.message;
    throw err;
  } finally {
    insert('ai_logs', { ...log, duration_ms: Date.now() - started });
  }
}
