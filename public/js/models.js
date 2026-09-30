import { api, escapeHtml as esc } from './api.js';
import { BOTS, FREE_NOTES, PAGE_SIZE, catalogStatus, combineEstimates, currentModel, estimateView, filterModels, formatContext, formatPrice, isDefault, paginate, priceLine, sortModels, validModelId } from './models-logic.js';
import { state } from './state.js';
import { toast } from './ui.js';

/* Model finder (Settings → Models): searchable, cheapest-first OpenRouter catalog with per-bot selection and live cost estimates. */

const M = {
  bot: 'scanner',
  q: '',
  freeOnly: false,
  maxPrice: '',
  page: 1,
  res: null, // /api/models response
  err: null,
  loading: true,
  open: null, // expanded model id
  est: {}, // `${bot}|${model}` -> estimate | 'loading' | null
  warnings: [],
  notes: [],
  saving: false,
  sel: {}, // effective selection {scanner, trader, news}
  defaults: {},
};
let host = null;
let timer = 0;

const botLabel = (id) => BOTS.find((b) => b.id === id)?.label || id;
const debounce = (fn, ms) => (...a) => {
  clearTimeout(timer);
  timer = setTimeout(() => fn(...a), ms);
};

function syncSelection() {
  const am = state.account?.models;
  const s = M.res?.selected || {};
  M.sel = { scanner: am?.scanner || s.scanner || '', trader: am?.trader || s.trader || '', news: am?.news || s.news || '' };
  M.defaults = am?.defaults || {};
}

const models = () => sortModels(filterModels(M.res?.models || [], { q: M.q, freeOnly: M.freeOnly, maxPrice: M.maxPrice }));

/* ---------- estimates ---------- */

async function estimate(bot, model) {
  const key = `${bot}|${model}`;
  if (key in M.est) return M.est[key];
  M.est[key] = 'loading';
  try {
    M.est[key] = await api(`/models/estimate?bot=${encodeURIComponent(bot)}&model=${encodeURIComponent(model)}`);
  } catch {
    M.est[key] = null;
  }
  return M.est[key];
}

async function loadDetail(id) {
  const other = M.bot === 'scanner' ? 'trader' : 'scanner';
  await Promise.all([estimate(M.bot, id), M.sel[other] ? estimate(other, M.sel[other]) : null]);
  if (M.open === id) renderList({ keepFocus: true });
}

/* ---------- rendering ---------- */

function currentHtml() {
  return `<ul class="mf-cur" aria-label="Current models">${BOTS.map((b) => {
    if (b.disabled) return `<li class="mf-cur-row is-off"><span class="mf-cur-l">${b.label}</span><span class="dim">Not built yet: coming with the news bot</span></li>`;
    const cur = currentModel(state.account?.models || { ...M.sel, defaults: M.defaults }, b.id) || M.sel[b.id];
    const def = isDefault({ ...M.sel, defaults: M.defaults }, b.id);
    return `<li class="mf-cur-row"><span class="mf-cur-l">${b.label}</span><code class="mf-cur-id">${esc(M.sel[b.id] || cur || '—')}</code>${def ? '<span class="chip chip-off">default</span>' : `<button type="button" class="btn-ghost mf-reset" data-reset="${b.id}" ${M.saving ? 'disabled' : ''}>Reset to default</button>`}</li>`;
  }).join('')}</ul>`;
}

function segHtml() {
  return `<div class="seg mf-seg" role="radiogroup" aria-label="Choose a model for which bot">${BOTS.map((b) => `<button type="button" class="seg-btn" role="radio" data-bot="${b.id}" aria-checked="${M.bot === b.id}" ${b.disabled ? 'disabled aria-disabled="true"' : ''} tabindex="${M.bot === b.id ? 0 : -1}">${b.label}${b.disabled ? '<small>coming with the news bot</small>' : ''}</button>`).join('')}</div>`;
}

function notesHtml() {
  const notes = M.res?.notes?.length ? M.res.notes : FREE_NOTES;
  return `<details class="mf-caveat" ${M.freeOnly ? 'open' : ''}><summary>About free models: read this first</summary><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>`;
}

function rowHtml(m) {
  const open = M.open === m.id;
  const used = M.sel[M.bot] === m.id;
  const json = m.supportsJson === true ? '<span class="tag tag-json" title="Supports JSON mode">JSON</span>' : m.supportsJson === false ? '<span class="tag tag-nojson" title="No JSON mode: may return unusable output">no JSON mode</span>' : '';
  let detail = '';
  if (open) {
    const a = M.est[`${M.bot}|${m.id}`];
    const other = M.bot === 'scanner' ? 'trader' : 'scanner';
    const b = M.est[`${other}|${M.sel[other]}`];
    if (a === 'loading' || a === undefined) detail = '<p class="mf-est dim" role="status">Estimating cost…</p>';
    else if (a === null) detail = '<p class="mf-est dim">Couldn’t get a cost estimate. You can still pick this model.</p>';
    else {
      const ev = estimateView(a);
      const full = b && b !== 'loading' ? combineEstimates(a, b) : null;
      detail = `<p class="mf-est"><strong>${botLabel(M.bot)}:</strong> ${esc(ev.perCallText)} <span class="dim">· ${esc(ev.basisText)}</span></p>
        ${full ? `<p class="mf-est"><strong>Full run</strong> (scanner + trader): ${esc(full.text)}</p>` : ''}
        <p class="mf-est dim">${esc(ev.runsText)}${ev.runsRemainingText ? ` · ${esc(ev.runsRemainingText)}` : ''}</p>
        ${ev.free || m.isFree ? '<p class="mf-free-warn"><strong>Free model.</strong> Expect rate limits and failed runs; the provider may log your prompts. Fine for paper trading with public market data.</p>' : ''}
        ${!ev.priceKnown ? '<p class="mf-free-warn"><strong>No listed price.</strong> Spend can’t be estimated, so the budget governor will assume a conservative price.</p>' : ''}`;
    }
    detail = `<div class="mf-detail">${detail}<button type="button" class="btn-accent mf-use" data-use="${esc(m.id)}" ${used || M.saving ? 'disabled' : ''}>${used ? `Selected for ${botLabel(M.bot)}` : M.saving ? 'Saving…' : `Use for ${botLabel(M.bot)}`}</button></div>`;
  }
  return `<li class="mf-row${open ? ' is-open' : ''}${used ? ' is-used' : ''}"><button type="button" class="mf-pick" data-pick="${esc(m.id)}" aria-expanded="${open}">
      <span class="mf-name"><span class="mf-n">${esc(m.name || m.id)}</span>${m.isFree ? '<span class="tag tag-free">FREE</span>' : ''}${json}${used ? `<span class="tag tag-used">In use (${esc(botLabel(M.bot))})</span>` : ''}</span>
      <code class="mf-id">${esc(m.id)}</code>
      <span class="mf-meta"><span><span class="dim">in</span> ${esc(formatPrice(m.promptPerM, { free: m.isFree }))}</span><span><span class="dim">out</span> ${esc(formatPrice(m.completionPerM, { free: m.isFree }))}</span><span class="dim">per 1M</span><span><span class="dim">ctx</span> ${esc(formatContext(m.contextLength))}</span></span>
    </button>${detail}</li>`;
}

function renderList({ keepFocus = false } = {}) {
  const list = host.querySelector('#mf-list');
  const pager = host.querySelector('#mf-pager');
  const status = host.querySelector('#mf-status');
  if (!list) return;
  const focusId = keepFocus ? document.activeElement?.dataset?.pick || document.activeElement?.dataset?.use : null;
  const cs = catalogStatus(M.res, M.err);
  if (M.loading) {
    list.innerHTML = '<li class="mf-msg dim" aria-busy="true">Loading the model list…</li>';
    pager.innerHTML = '';
    status.textContent = '';
    return;
  }
  if (!M.res) {
    list.innerHTML = `<li class="mf-msg"><div class="notice" role="alert">${esc(cs.text)}</div><button type="button" class="btn-ghost" id="mf-retry">Retry</button></li>`;
    pager.innerHTML = '';
    status.textContent = '';
    return;
  }
  const all = models();
  const pg = paginate(all, M.page, PAGE_SIZE);
  M.page = pg.page;
  status.innerHTML = `${cs.kind === 'stale' ? `<span class="mf-stale">${esc(cs.text)}</span> ` : ''}${all.length ? `${pg.from}–${pg.to} of ${all.length}${all.length !== M.res.total ? ` (of ${M.res.total} models)` : ''}, cheapest first` : ''}`;
  list.innerHTML = pg.items.length ? pg.items.map(rowHtml).join('') : `<li class="mf-msg dim">No models match.${M.maxPrice ? ' Models with an unknown price are hidden when a max price is set.' : ''} <button type="button" class="linklike" id="mf-clear">Clear filters</button></li>`;
  pager.innerHTML = pg.pages > 1 ? `<button type="button" class="btn-ghost" data-page="${pg.page - 1}" ${pg.page <= 1 ? 'disabled' : ''}>Previous</button><span class="mf-pg" aria-live="polite">Page ${pg.page} of ${pg.pages}</span><button type="button" class="btn-ghost" data-page="${pg.page + 1}" ${pg.page >= pg.pages ? 'disabled' : ''}>Next</button>` : '';
  if (focusId) {
    const t = list.querySelector(`[data-pick="${CSS.escape(focusId)}"]`) || list.querySelector(`[data-use="${CSS.escape(focusId)}"]`);
    t?.focus({ preventScroll: true });
  }
}

function renderTop() {
  host.querySelector('#mf-current').innerHTML = currentHtml();
  host.querySelector('#mf-segwrap').innerHTML = segHtml();
  host.querySelector('#mf-caveatwrap').innerHTML = notesHtml();
  const warn = host.querySelector('#mf-warn');
  warn.innerHTML = [...M.warnings.map((w) => `<li class="mf-w">${esc(w)}</li>`), ...M.notes.map((w) => `<li class="mf-n2">${esc(w)}</li>`)].join('');
  warn.hidden = !warn.innerHTML;
  const manual = host.querySelector('#mf-manual-btn');
  if (manual) manual.textContent = `Use for ${botLabel(M.bot)}`;
}

function shell() {
  host.innerHTML = `<section class="widget models-card" id="sec-models" aria-labelledby="h-models"><h2 class="widget-title" id="h-models">MODELS</h2>
    <p class="dim mf-lead">Pick the AI model for each bot. Cheaper models stretch the $20 monthly budget further; stronger ones may propose better trades.</p>
    <div id="mf-current"></div>
    <ul class="mf-warn" id="mf-warn" role="status" hidden></ul>
    <div id="mf-segwrap"></div>
    <div id="mf-caveatwrap"></div>
    <div class="mf-filters" role="search">
      <label for="mf-q" class="mf-q">Search models<input id="mf-q" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="name or vendor/model" value="${esc(M.q)}" /></label>
      <label class="mf-free"><input id="mf-free" type="checkbox" ${M.freeOnly ? 'checked' : ''} /> <span>Free only</span></label>
      <label for="mf-max" class="mf-max">Max price $ per 1M tokens<input id="mf-max" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" placeholder="e.g. 1" value="${esc(M.maxPrice)}" /></label>
    </div>
    <div class="mf-status dim" id="mf-status" aria-live="polite"></div>
    <ul class="mf-list" id="mf-list"></ul>
    <div class="mf-pager" id="mf-pager"></div>
    <details class="mf-manual" ${!M.loading && !M.res ? 'open' : ''}><summary>Enter a model id manually</summary>
      <form id="mf-manual" novalidate><label for="mf-mid">Model id<input id="mf-mid" type="text" inputmode="text" enterkeyhint="go" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="vendor/model-name" aria-describedby="mf-mid-e" /><span class="fld-err" id="mf-mid-e" role="alert"></span></label>
      <button type="submit" class="btn-accent" id="mf-manual-btn">Use for ${botLabel(M.bot)}</button></form></details>
  </section>`;
  renderTop();
  renderList();
  wire();
}

/* ---------- actions ---------- */

async function save(payload, label) {
  if (M.saving) return;
  M.saving = true;
  renderTop();
  renderList({ keepFocus: true });
  try {
    const r = await api('/account/models', { method: 'PUT', body: JSON.stringify(payload) });
    state.account = { ...(state.account || {}), ...r, models: { ...(state.account?.models || {}), ...(r?.models || {}) } };
    M.warnings = Array.isArray(r?.warnings) ? r.warnings.map(String) : [];
    M.notes = Array.isArray(r?.notes) ? r.notes.map(String) : [];
    syncSelection();
    M.est = {}; // other-bot estimates depend on the selection
    toast(label, 'success');
  } catch (e) {
    toast(`Could not save the model: ${e.message}`, 'error', 8000);
  } finally {
    M.saving = false;
    renderTop();
    renderList({ keepFocus: true });
    if (M.open) loadDetail(M.open);
  }
}

const fieldOf = (bot) => BOTS.find((b) => b.id === bot).field;

function wire() {
  const q = host.querySelector('#mf-q');
  const fr = host.querySelector('#mf-free');
  const mx = host.querySelector('#mf-max');
  const re = debounce(() => {
    M.page = 1;
    renderList();
  }, 220);
  q.addEventListener('input', () => {
    M.q = q.value;
    re();
  });
  mx.addEventListener('input', () => {
    M.maxPrice = mx.value.trim();
    re();
  });
  fr.addEventListener('change', () => {
    M.freeOnly = fr.checked;
    M.page = 1;
    renderTop();
    renderList();
  });
  host.querySelector('#mf-manual').addEventListener('submit', onManual);
}

function wireHost() {
  host.addEventListener('click', (e) => {
    const t = e.target;
    const bot = t.closest('[data-bot]');
    if (bot && !bot.disabled) {
      M.bot = bot.dataset.bot;
      M.open = null;
      renderTop();
      renderList();
      host.querySelector(`[data-bot="${M.bot}"]`)?.focus({ preventScroll: true });
      return;
    }
    const pick = t.closest('[data-pick]');
    if (pick) {
      const id = pick.dataset.pick;
      M.open = M.open === id ? null : id;
      renderList({ keepFocus: true });
      if (M.open) loadDetail(M.open);
      return;
    }
    const use = t.closest('[data-use]');
    if (use) {
      save({ [fieldOf(M.bot)]: use.dataset.use }, `${botLabel(M.bot)} model set to ${use.dataset.use}`);
      return;
    }
    const reset = t.closest('[data-reset]');
    if (reset) {
      save({ [fieldOf(reset.dataset.reset)]: '' }, `${botLabel(reset.dataset.reset)} model reset to the default`);
      return;
    }
    const pg = t.closest('[data-page]');
    if (pg && !pg.disabled) {
      M.page = Number(pg.dataset.page);
      renderList();
      host.querySelector('#mf-status')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (t.closest('#mf-clear')) {
      Object.assign(M, { q: '', freeOnly: false, maxPrice: '', page: 1 });
      host.querySelector('#mf-q').value = '';
      host.querySelector('#mf-free').checked = false;
      host.querySelector('#mf-max').value = '';
      renderTop();
      renderList();
      return;
    }
    if (t.closest('#mf-retry')) load();
  });
  host.addEventListener('keydown', (e) => {
    const r = e.target.closest?.('[role=radio]');
    if (!r || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const enabled = BOTS.filter((b) => !b.disabled);
    const i = enabled.findIndex((b) => b.id === M.bot);
    M.bot = enabled[(i + (e.key === 'ArrowRight' ? 1 : enabled.length - 1)) % enabled.length].id;
    M.open = null;
    renderTop();
    renderList();
    host.querySelector(`[data-bot="${M.bot}"]`)?.focus({ preventScroll: true });
  });
}

function onManual(e) {
    e.preventDefault();
    const inp = host.querySelector('#mf-mid');
    const err = host.querySelector('#mf-mid-e');
    const id = inp.value.trim();
    if (!validModelId(id)) {
      err.textContent = 'Use the form vendor/model-name, like openai/gpt-4o-mini.';
      inp.setAttribute('aria-invalid', 'true');
      return inp.focus();
    }
    err.textContent = '';
    inp.removeAttribute('aria-invalid');
    save({ [fieldOf(M.bot)]: id }, `${botLabel(M.bot)} model set to ${id}`);
}

async function load() {
  M.loading = true;
  M.err = null;
  if (host?.querySelector('#mf-list')) renderList();
  try {
    M.res = await api('/models');
  } catch (e) {
    M.err = e;
    M.res = null;
  }
  M.loading = false;
  syncSelection();
  if (!host?.isConnected) return;
  shell();
}

/** Mount the finder into `el`. Needs state.account (for defaults); fetches it when missing. */
export async function mountModels(el) {
  if (host !== el) {
    host = el;
    wireHost();
  }
  M.open = null;
  M.loading = true;
  el.innerHTML = '<section class="widget models-card" id="sec-models" aria-busy="true"><h2 class="widget-title">MODELS</h2><div class="skel-wrap" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div></div></section>';
  if (!state.account) {
    try {
      state.account = await api('/account');
    } catch {
      /* finder still works read-only */
    }
  }
  await load();
}
