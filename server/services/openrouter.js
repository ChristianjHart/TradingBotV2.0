import { config, hasOpenRouterKey } from '../config.js';

/** Pull the first JSON object out of an LLM reply (handles ``` fences and chatter). */
export function extractJson(text) {
  const cleaned = String(text || '').replace(/```(?:json)?/gi, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('model reply contained no JSON');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function chatJson({ model, system, user, maxTokens = 8000, timeoutMs = 170_000 }) {
  if (!hasOpenRouterKey()) throw new Error('OPENROUTER_API_KEY not set');
  const res = await fetch(`${config.openrouter.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.key}`,
      'Content-Type': 'application/json',
      'X-Title': 'TradingBot V2',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`OpenRouter returned no content (${JSON.stringify(data.error || {}).slice(0, 150)})`);
  return { json: extractJson(content), usage: data.usage || null };
}
