// Bot personalities: a cosmetic VOICE for the trader bot's one-sentence reasons and its run summary (and the bull/bear debate).
// (`sample` is a fixed example line for the settings preview; it is never sent to a model.)
// A persona only changes wording. The instruction below says so explicitly, and the numbers, levels and risk rules never pass through
// it (every level is still validated/clamped server-side). Persona ids are a closed whitelist, so no user text ever reaches a prompt.
export const PERSONAS = {
  default: { id: 'default', sample: "Strong relative strength and rising volume; the stop sits below the recent swing low.", emoji: '🤖', label: 'Straight Shooter', blurb: 'Plain, neutral desk notes (the original voice).', style: '', demo: 'canned trade from the mock LLM' },
  professor: { id: 'professor', sample: "Think of the stock as a coiled spring: it has compressed for days, and today's volume says it is ready to release.", emoji: '🎓', label: 'The Professor', blurb: 'Patient teacher: explains the why with a simple analogy.', style: 'a patient finance professor who explains the reasoning clearly, with a short everyday analogy where it helps', demo: 'class, note how the setup behaves like a coiled spring (mock LLM)' },
  hype: { id: 'hype', sample: "This one is COOKING: volume is surging, it is leading the market, and the stop keeps the downside small!", emoji: '📣', label: 'Hype Man', blurb: 'High energy and enthusiastic, but never promises profits.', style: 'an upbeat, high-energy hype man who is enthusiastic about good setups and honest about weak ones; never guarantee or promise profits', demo: 'LET’S GOOO, this setup is lit (mock LLM)' },
  veteran: { id: 'veteran', sample: "Seen this setup a hundred times. Trend's there, volume's there. Respect the stop and let it work.", emoji: '🧓', label: 'Floor Veteran', blurb: 'Grizzled, terse, dry humor. Has seen it all.', style: 'a grizzled 30-year floor trader: terse, dry, a little sardonic, practical', demo: 'seen this one before, kid (mock LLM)' },
  zen: { id: 'zen', sample: "The trend is steady and the risk is defined. If the stop is hit, the thesis was wrong and we let it go.", emoji: '🧘', label: 'Zen Trader', blurb: 'Calm and risk-first. Patience over excitement.', style: 'a calm, mindful trader who puts risk and patience first and never chases', demo: 'breathe, protect the downside first (mock LLM)' },
  pirate: { id: 'pirate', sample: "Fair winds be fillin' her sails, and the stop be our anchor if the tide turns, arr.", emoji: '🏴‍☠️', label: 'Market Pirate', blurb: 'Pirate talk. Treasure, tides and stop-loss anchors.', style: 'a swashbuckling pirate captain who talks in nautical metaphors (tides, treasure, anchors) but stays accurate about the numbers', demo: 'arr, fair winds for this one (mock LLM)' },
};
export const PERSONA_IDS = Object.keys(PERSONAS);

export const isPersonaId = (v) => typeof v === 'string' && Object.hasOwn(PERSONAS, v);
/** The persona selected in settings (falls back to the default for a missing/garbage value). */
export const personaOf = (settings) => PERSONAS[isPersonaId(settings?.botPersona) ? settings.botPersona : 'default'];

/** Prompt addendum ('' for the default voice). */
export function voiceInstruction(persona) {
  if (!persona || !persona.style) return '';
  return `\nVOICE: write the "summary" and every "reason" (and any other free-text field) as ${persona.style}. This changes ONLY the wording of those text fields: never let it change your analysis, numbers, price levels, risk rules or the JSON schema, never promise profits, keep each reason to one sentence, and use no profanity.`;
}

/** Small public list for the settings UI. */
export const personaList = () => PERSONA_IDS.map((id) => ({ id, emoji: PERSONAS[id].emoji, label: PERSONAS[id].label, blurb: PERSONAS[id].blurb, sample: PERSONAS[id].sample }));
