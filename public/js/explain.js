import { api, escapeHtml as esc } from './api.js';
import { debateProblem, debateView, explainView } from './explain-logic.js';
import { state } from './state.js';
import { toast } from './ui.js';

/* "Why did the AI pick this?" panel + on-demand bull-vs-bear debate, shown on proposal cards (pending and history). */

const STANCE_ICON = { for: '✓', against: '✗', neutral: '•' };
const STANCE_WORD = { for: 'Supports the trade', against: 'Conflicts with the trade', neutral: 'Neutral' };

const personaInfo = (id) => (state.status?.personas || []).find((x) => x.id === id) || null;

/** "🎓 The Professor" for non-default voices, else ''. */
export function personaBadge(p) {
  if (!p?.persona || p.persona === 'default') return '';
  const x = personaInfo(p.persona);
  return x ? `<span class="persona-tag" title="The trader bot wrote this in the ${esc(x.label)} voice (wording only)">${esc(x.emoji)} ${esc(x.label)}</span>` : '';
}

/** The newest debate: one fetched with the proposal, or one just received (a re-run is newer than what the last poll carried). */
const debateOf = (p) => {
  const a = p.debate || null;
  const b = state.debateLocal[p.id] || null;
  return b && (!a || String(b.at) >= String(a.at)) ? b : a;
};

/** Everything that should force a card re-render when it changes (used in the keyed reconcile signature). */
export function whySig(p) {
  const d = debateOf(p);
  return JSON.stringify([!!state.why[p.id], state.debateUi[p.id] || null, d?.at || null, state.calendar?.generatedAt || null, p.persona || null]);
}

function debateHtml(p) {
  const ui = state.debateUi[p.id] || {};
  const d = debateView(debateOf(p));
  if (ui.busy) return `<div class="dbt dbt-busy" role="status"><span class="spin" aria-hidden="true"></span> The two analysts are arguing… (one AI call)</div>`;
  if (!d) {
    return `<div class="dbt"><div class="dbt-ask"><button type="button" class="btn-ghost dbt-btn" data-act="debate">🐂 vs 🐻 Run the bull vs bear debate</button><small class="dim">Uses one AI call from your budget (usually a fraction of a cent). The result is saved on this proposal.</small></div>${ui.error ? `<p class="dbt-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
  }
  const side = (cls, icon, title, s) => `<div class="dbt-side dbt-${cls}"><h4>${icon} ${title}</h4><p class="dbt-thesis">${esc(s.thesis)}</p><ul>${s.points.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  return `<div class="dbt">
    <div class="dbt-cols">${side('for', '🐂', 'The case FOR', d.forTrade)}${side('against', '🐻', 'The case AGAINST', d.againstTrade)}</div>
    <div class="dbt-verdict dbt-lean-${d.lean}"><strong>${esc(d.leanLabel)}.</strong> ${esc(d.note)}</div>
    <div class="dbt-foot"><span class="dim">${d.demo ? '<span class="badge-demo">DEMO DATA</span> ' : ''}${esc(d.meta)}</span><button type="button" class="linklike" data-act="debate-redo">Run again (new AI call)</button></div>
    ${ui.error ? `<p class="dbt-err" role="alert">${esc(ui.error)}</p>` : ''}</div>`;
}

function panelHtml(p) {
  const v = explainView(p, { calendar: state.calendar });
  const sig = v.signals.map((s) => `<li class="why-sig why-${s.stance}"><span class="why-ic" aria-hidden="true">${STANCE_ICON[s.stance]}</span><span class="sr-only">${esc(STANCE_WORD[s.stance])}: </span><span>${esc(s.text)}</span></li>`).join('');
  const rows = [];
  if (v.scannerReason) rows.push(`<div><span class="lbl">SCANNER SAID</span><p>${esc(v.scannerReason)}</p></div>`);
  if (v.traderReason) rows.push(`<div><span class="lbl">TRADER SAID ${personaBadge(p)}</span><p>${esc(v.traderReason)}</p></div>`);
  const ctx = [];
  if (p.models?.trader) ctx.push(`${p.source === 'demo' ? 'Demo AI' : 'AI'} ${p.models.trader}`);
  if (v.confidencePct != null) ctx.push(`Scanner confidence ${v.confidencePct}%`);
  if (v.rr != null) ctx.push(`reward-to-risk ${v.rr.toFixed(1)} to 1`);
  if (v.stopPct != null) ctx.push(`stop ${v.stopPct.toFixed(1)}% away`);
  if (v.sentiment) ctx.push(`news sentiment ${v.sentiment.text}`);
  return `<div class="why-panel" id="why-${esc(p.id)}">
    <p class="why-head"><strong>${esc(v.headline)}</strong></p>
    ${ctx.length ? `<p class="dim why-ctx">${esc(ctx.join(' · '))}</p>` : ''}
    ${rows.join('')}
    ${sig ? `<div><span class="lbl">THE SETUP, READ FOR A ${esc(v.side.toUpperCase())}</span><ul class="why-sigs">${sig}</ul></div>` : ''}
    ${v.regime ? `<div><span class="lbl">MARKET BACKDROP</span><p>${esc(v.regime)}</p></div>` : ''}
    ${v.sentiment?.note ? `<div><span class="lbl">NEWS</span><p>${esc(v.sentiment.note)}</p></div>` : ''}
    ${v.caution.length ? `<div class="why-caution"><span class="lbl">WATCH OUT FOR</span><ul>${v.caution.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : ''}
    ${debateHtml(p)}
  </div>`;
}

/** The collapsed button + (when open) the panel. `p` is the stored proposal. */
export function whyHtml(p) {
  const open = !!state.why[p.id];
  return `<div class="why${open ? ' is-open' : ''}"><button type="button" class="why-btn" data-act="why" aria-expanded="${open}" aria-controls="why-${esc(p.id)}"><span aria-hidden="true">🔍</span> Why did the AI pick this?<svg class="why-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>${open ? panelHtml(p) : ''}</div>`;
}

/**
 * Handle a click on one of this module's data-act buttons. `rerender()` repaints the cards. Returns true when the act was ours.
 */
export async function handleWhyAct(act, p, rerender) {
  if (act === 'why') {
    if (state.why[p.id]) delete state.why[p.id];
    else state.why[p.id] = true;
    rerender();
    return true;
  }
  if (act !== 'debate' && act !== 'debate-redo') return false;
  if (state.debateUi[p.id]?.busy) return true;
  state.debateUi[p.id] = { busy: true };
  rerender();
  try {
    const res = await api(`/proposals/${encodeURIComponent(p.id)}/debate${act === 'debate-redo' ? '?force=1' : ''}`, { method: 'POST', body: '{}' });
    state.debateLocal[p.id] = res.debate;
    delete state.debateUi[p.id];
    if (!res.cached) toast(`Debate ready for ${p.symbol}${res.debate?.costUsd ? ` (cost $${res.debate.costUsd < 0.1 ? res.debate.costUsd.toFixed(4) : res.debate.costUsd.toFixed(2)})` : ''}.`, 'success', 4500);
  } catch (e) {
    state.debateUi[p.id] = { error: debateProblem(e) };
  }
  rerender();
  return true;
}
