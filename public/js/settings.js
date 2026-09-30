import { api, escapeHtml as esc, getToken } from './api.js';
import { mountAccount } from './account.js';
import { netEdgeFormula, validateRange } from './ai-logic.js';
import { budgetCardHtml, patchBudgetCard, wireBudgetCard } from './budget.js';
import { authClick } from './chrome.js';
import { refresh } from './data.js';
import { mountModels } from './models.js';
import { newsCardHtml, wireNewsCard } from './news.js';
import { mountSchedule } from './schedule.js';
import { $, hooks, root, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

const SECTION = { account: 'account-root', budget: 'sec-budget', models: 'models-root', auto: 'sec-auto', edge: 'sec-edge', schedule: 'sched-root', news: 'sec-news' };

/** Scroll to the section named by `#settings/<section>` (once the page has been mounted). */
export function applySettingsFocus() {
  const id = SECTION[state.settingsFocus];
  const el = id && document.getElementById(id);
  if (!el) return;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
}

const savePatch = (patch) => api('/settings', { method: 'PATCH', body: JSON.stringify(patch) });

function autoCardHtml(s) {
  const on = s.autoApprove === true;
  return `<section class="widget auto-card" id="sec-auto" aria-labelledby="h-auto"><h2 class="widget-title" id="h-auto">PROPOSALS &amp; AUTO-APPROVE</h2>
    <div class="sw-row"><div class="sw-txt"><strong id="aa-l">Auto-approve</strong><p class="dim" id="aa-d">${on ? 'ON: small proposals within your caps open simulated positions without asking. Everything else still waits for you.' : 'OFF (recommended): every proposal waits for your approval. Nothing opens by itself.'}</p></div>
      <button type="button" class="switch" id="sw-auto" role="switch" aria-checked="${on}" aria-labelledby="aa-l" aria-describedby="aa-d"><span class="sw-knob" aria-hidden="true"></span><span class="sw-state">${on ? 'ON' : 'OFF'}</span></button></div>
    <form class="settings-form" id="f-prop" novalidate>
      <label for="aa-pct">Auto-approve only trades up to (% of equity)<input id="aa-pct" name="pct" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" value="${esc(s.autoApproveMaxAllocPct ?? 5)}" aria-describedby="aa-pct-h aa-pct-e" /><span class="fld-hint" id="aa-pct-h">Between 0.1 and 25. Larger proposals always wait for you.</span><span class="fld-err" id="aa-pct-e" role="alert"></span></label>
      <label for="aa-ttl">Proposals expire after (hours)<input id="aa-ttl" name="ttl" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${esc(s.proposalTtlHours ?? 6)}" aria-describedby="aa-ttl-h aa-ttl-e" /><span class="fld-hint" id="aa-ttl-h">Between 0.25 and 72. An unapproved proposal expires, and is scored later as a “what if”.</span><span class="fld-err" id="aa-ttl-e" role="alert"></span></label>
      <div class="row-actions"><button class="btn-accent" type="submit">Save</button></div>
    </form></section>`;
}

function edgeCardHtml(s) {
  const w = { drawdown: s.netEdgeDrawdownWeight ?? 0.5, avoided: s.netEdgeAvoidedWeight ?? 1 };
  return `<section class="widget edge-card" id="sec-edge" aria-labelledby="h-edge"><h2 class="widget-title" id="h-edge">HOW THE AI IS SCORED (NET EDGE)</h2>
    <p class="edge-formula mono" id="edge-formula">${esc(netEdgeFormula(w))}</p>
    <ul class="edge-expl"><li><strong>Realized P&amp;L</strong>: profit and loss of the trades you approved and that have closed.</li><li><strong>Max drawdown</strong>: the worst peak-to-trough drop in equity. It is subtracted, so a bumpy path scores lower than a smooth one.</li><li><strong>Avoided loss</strong>: money you did not lose because you rejected, or let expire, proposals that would have lost.</li></ul>
    <p class="dim">The formula is fixed. You can only change how much the drawdown penalty and the avoided-loss credit count.</p>
    <form class="settings-form" id="f-edge" novalidate>
      <label for="ne-dd">Drawdown weight (0 to 10)<input id="ne-dd" type="text" inputmode="decimal" enterkeyhint="next" autocomplete="off" value="${esc(w.drawdown)}" aria-describedby="ne-dd-e" /><span class="fld-err" id="ne-dd-e" role="alert"></span></label>
      <label for="ne-av">Avoided-loss weight (0 to 10)<input id="ne-av" type="text" inputmode="decimal" enterkeyhint="done" autocomplete="off" value="${esc(w.avoided)}" aria-describedby="ne-av-e" /><span class="fld-err" id="ne-av-e" role="alert"></span></label>
      <div class="row-actions"><button class="btn-accent" type="submit">Save weights</button></div>
    </form></section>`;
}

function busy(btn, label, fn) {
  const orig = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin" aria-hidden="true"></span> ${esc(label)}`;
  return Promise.resolve(fn()).finally(() => {
    btn.disabled = false;
    btn.textContent = orig;
  });
}

function wireAuto() {
  const sw = $('sw-auto');
  const setSwitch = (on) => {
    sw.setAttribute('aria-checked', String(on));
    sw.querySelector('.sw-state').textContent = on ? 'ON' : 'OFF';
    $('aa-d').textContent = on ? 'ON: small proposals within your caps open simulated positions without asking. Everything else still waits for you.' : 'OFF (recommended): every proposal waits for your approval. Nothing opens by itself.';
  };
  sw.addEventListener('click', async () => {
    const next = sw.getAttribute('aria-checked') !== 'true';
    if (next) {
      const pct = validateRange($('aa-pct').value, { min: 0.1, max: 25, label: 'Max allocation' });
      if (!pct.ok) {
        $('aa-pct-e').textContent = pct.error;
        return $('aa-pct').focus();
      }
      const ok = await confirmDialog({
        title: 'Turn on auto-approve?',
        message: `When the AI proposes a trade of ${pct.value}% of equity or less that passes every risk check, it will open a simulated position straight away, without asking you. Larger proposals still wait. All positions are simulated and no real orders are ever sent. You can turn this off at any time.`,
        confirmText: 'Turn on auto-approve',
      });
      if (!ok) return;
    }
    sw.disabled = true;
    try {
      const patch = { autoApprove: next };
      if (next) patch.autoApproveMaxAllocPct = Number($('aa-pct').value);
      await savePatch(patch);
      setSwitch(next);
      toast(next ? 'Auto-approve is ON' : 'Auto-approve is OFF: every proposal waits for you', next ? 'warn' : 'success');
      await refresh();
      hooks.patchCurrent();
    } catch (e) {
      toast(`Could not change auto-approve: ${e.message}`, 'error');
    } finally {
      sw.disabled = false;
    }
  });
  $('f-prop').addEventListener('submit', (e) => {
    e.preventDefault();
    const pct = validateRange($('aa-pct').value, { min: 0.1, max: 25, label: 'Max allocation' });
    const ttl = validateRange($('aa-ttl').value, { min: 0.25, max: 72, label: 'Expiry' });
    $('aa-pct-e').textContent = pct.error;
    $('aa-ttl-e').textContent = ttl.error;
    $('aa-pct').toggleAttribute('aria-invalid', !pct.ok);
    $('aa-ttl').toggleAttribute('aria-invalid', !ttl.ok);
    if (!pct.ok) return $('aa-pct').focus();
    if (!ttl.ok) return $('aa-ttl').focus();
    busy(e.target.querySelector('button[type=submit]'), 'Saving…', async () => {
      try {
        await savePatch({ autoApproveMaxAllocPct: pct.value, proposalTtlHours: ttl.value });
        toast('Proposal settings saved', 'success');
        await refresh();
      } catch (er) {
        toast(`Could not save: ${er.message}`, 'error');
      }
    });
  });
}

function wireEdge() {
  $('f-edge').addEventListener('submit', (e) => {
    e.preventDefault();
    const dd = validateRange($('ne-dd').value, { min: 0, max: 10, label: 'Drawdown weight' });
    const av = validateRange($('ne-av').value, { min: 0, max: 10, label: 'Avoided-loss weight' });
    $('ne-dd-e').textContent = dd.error;
    $('ne-av-e').textContent = av.error;
    $('ne-dd').toggleAttribute('aria-invalid', !dd.ok);
    $('ne-av').toggleAttribute('aria-invalid', !av.ok);
    if (!dd.ok) return $('ne-dd').focus();
    if (!av.ok) return $('ne-av').focus();
    busy(e.target.querySelector('button[type=submit]'), 'Saving…', async () => {
      try {
        await savePatch({ netEdgeDrawdownWeight: dd.value, netEdgeAvoidedWeight: av.value });
        $('edge-formula').textContent = netEdgeFormula({ drawdown: dd.value, avoided: av.value });
        toast('Net-edge weights saved', 'success');
        await refresh();
      } catch (er) {
        toast(`Could not save: ${er.message}`, 'error');
      }
    });
  });
}

/* settings page */
export function mountSettings() {
  const s = state.status?.settings || {};
  const st = state.status || {};
  root.innerHTML = `<div class="page">
    <div class="notice">Trading is permanently disabled in this build. Alpaca is used for market data only; all positions are simulated.</div>
    <div class="settings-grid">${budgetCardHtml()}${autoCardHtml(s)}</div>
    <div class="sched-wrap" id="sched-root"></div>
    <div class="models-wrap" id="models-root"></div>
    <div class="settings-grid account-grid">
    <section class="widget" aria-labelledby="h-set"><h2 class="widget-title" id="h-set">SETTINGS</h2>
      <form class="settings-form" id="settings-form">
        <label for="s-hz">Position / prediction horizon (hours)<input id="s-hz" name="horizonHours" type="number" inputmode="numeric" enterkeyhint="next" min="1" max="168" value="${esc(s.horizonHours ?? 24)}" /></label>
        <label for="s-wl">Watchlist size (legacy scanner)<input id="s-wl" name="watchlistSize" type="number" inputmode="numeric" enterkeyhint="done" min="3" max="40" value="${esc(s.watchlistSize ?? 12)}" /></label>
        <label for="s-as">Auto scan (legacy scanner)<select id="s-as" name="autoScan"><option value="true" ${s.autoScan !== false ? 'selected' : ''}>On</option><option value="false" ${s.autoScan === false ? 'selected' : ''}>Off</option></select></label>
        <button class="btn-accent" type="submit">Save</button>
      </form></section>
    <section class="widget" aria-labelledby="h-sys"><h2 class="widget-title" id="h-sys">SYSTEM</h2>
      <dl class="kv">
        <dt>Data mode</dt><dd>${esc(st.dataMode || 'unknown')}${st.mockData ? ' <span class="badge-demo">DEMO DATA</span>' : ''}</dd>
        <dt>Market</dt><dd>${st.marketOpen == null ? 'unknown' : st.marketOpen ? 'US stocks open' : 'US stocks closed'}</dd>
        <dt>Alpaca keys</dt><dd>${st.alpacaConfigured ? 'configured' : 'missing (mock data) — <a class="prop-link" href="#settings/account">add them under Account</a>'}</dd>
        <dt>OpenRouter key</dt><dd>${st.openrouterConfigured ? 'configured' : '<span class="neg">missing (the AI can’t run)</span> — <a class="prop-link" href="#settings/account">add it under Account</a>'}</dd>
        <dt>Supabase</dt><dd>${st.supabaseConfigured ? 'connected' : 'not configured (data resets on restart)'}</dd>
        <dt>Access control</dt><dd>${state.auth.mode === 'session' ? `signed in${state.auth.user ? ` as ${esc(state.auth.user.email)}` : ''}` : state.auth.required ? (getToken() ? 'admin token saved in this browser' : 'admin token required — not signed in') : 'open (no login)'}</dd>
      </dl>
      ${state.auth.required && state.auth.mode !== 'session' ? `<button class="btn-ghost" id="btn-auth2" type="button">${getToken() ? 'Sign out' : 'Sign in'}</button>` : ''}
    </section></div>
    <div class="settings-grid">${newsCardHtml(s)}${edgeCardHtml(s)}</div>
    <div class="settings-grid account-grid" id="account-root" aria-live="polite"></div></div>`;
  if (state.auth.mode !== 'token') mountAccount($('account-root'));
  mountSchedule($('sched-root')).then(applySettingsFocus);
  mountModels($('models-root')).then(applySettingsFocus);
  wireNewsCard();
  wireBudgetCard(root);
  wireAuto();
  wireEdge();
  patchBudgetCard();
  $('btn-auth2')?.addEventListener('click', authClick);
  applySettingsFocus();
  $('settings-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await savePatch({ watchlistSize: Number(fd.get('watchlistSize')), horizonHours: Number(fd.get('horizonHours')), autoScan: fd.get('autoScan') === 'true' });
      toast('Settings saved', 'success');
      await refresh();
    } catch (err) {
      toast(`Could not save settings: ${err.message}`, 'error');
    }
  });
}
