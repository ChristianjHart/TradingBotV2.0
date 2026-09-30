import { api, apiOptional, escapeHtml as esc, fmtDateTime, fmtMoney, fmtPct } from './api.js';
import { approveAllOutcome, approveAllPlan, approveProblem, outcomeText, proposalView, shadowView, timeLeft } from './ai-logic.js';
import { refresh } from './data.js';
import { $, empty, hooks, setHtml, setText, skeleton, state, TITLES } from './state.js';
import { aiBlocked } from './ai-logic.js';
import { revealSection } from './sections.js';
import { jumpTo, modal, toast } from './ui.js';

/* ---------- selectors over state ---------- */

export const pendingList = () => state.proposals?.proposals?.filter((p) => p.status === 'pending') || [];
export const pendingCount = () => state.status?.proposalsPending ?? state.proposals?.counts?.pending ?? pendingList().length;

const STATUS_LABEL = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired', superseded: 'Superseded', pending: 'Pending' };

/* ---------- badge in the nav + document title ---------- */

export function applyBadge() {
  const n = state.locked ? 0 : pendingCount();
  const b = $('nav-badge');
  const link = document.querySelector('#main-nav [data-nav="dashboard"]');
  if (b) {
    b.hidden = n <= 0;
    setText(b, n > 99 ? '99+' : String(n));
  }
  if (link) link.setAttribute('aria-label', n > 0 ? `Dashboard, ${n} ${n === 1 ? 'proposal' : 'proposals'} waiting for approval` : 'Dashboard');
  document.title = `${n > 0 ? `(${n}) ` : ''}${TITLES[state.page] || 'Dashboard'} · tradingbot`;
}

/* ---------- card markup ---------- */

const CLOCK = '<svg class="ic-clock" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';

function priceCell(label, value, sub, cls = '') {
  return `<div class="pc-price ${cls}"><dt>${label}</dt><dd class="mono">${value == null ? '—' : fmtMoney(value)}${sub ? `<small>${esc(sub)}</small>` : ''}</dd></div>`;
}

function riskHtml(v) {
  const r = v.risk;
  if (!r.lines.length && !r.notes.length && r.ok == null) return '';
  const head = r.ok === false ? '<span class="rc-bad">✕ Fails the risk check</span>' : '<span class="rc-ok">✓ Within risk limits</span>';
  return `<div class="pc-risk"><div class="pc-risk-h"><span class="lbl">RISK CHECK</span>${head}</div>
    ${r.lines.length ? `<dl class="pc-risk-l">${r.lines.map((l) => `<div><dt>${esc(l.k)}</dt><dd class="mono">${esc(l.v)}</dd></div>`).join('')}</dl>` : ''}
    ${r.notes.length ? `<ul class="pc-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}</div>`;
}

function msgHtml(msg) {
  if (!msg) return '';
  const acts = (msg.actions || [])
    .map((a) => (a.href ? `<a class="btn-ghost pc-msg-btn" href="${esc(a.href)}">${esc(a.label)}</a>` : `<button type="button" class="btn-ghost pc-msg-btn" data-act="${esc(a.id)}"${a.target ? ` data-target="${esc(a.target)}"` : ''}>${esc(a.label)}</button>`))
    .join('');
  return `<div class="pc-msg pc-msg-${esc(msg.tone || 'warn')}"><div class="pc-msg-t"><strong>${esc(msg.title)}</strong><button type="button" class="pc-msg-x" data-act="dismiss" aria-label="Dismiss message"><span aria-hidden="true">×</span></button></div><p>${esc(msg.message)}</p>${acts ? `<div class="pc-msg-a">${acts}</div>` : ''}</div>`;
}

const spin = '<span class="spin" aria-hidden="true"></span>';

export function cardHtml(v, busy, msg) {
  const side = v.side;
  const expired = v.expired;
  const dis = busy || expired ? 'disabled' : '';
  const lvl = v.left.level;
  const bar = `linear-gradient(90deg, rgba(239,68,68,.4) ${v.entryAt * 100}%, rgba(34,197,94,.4) ${v.entryAt * 100}%)`;
  const barLabel = v.stopPct != null && v.targetPct != null ? `Stop ${v.stopPct.toFixed(1)}% from entry, target ${v.targetPct.toFixed(1)}% from entry${v.rr != null ? `, reward to risk ${v.rr.toFixed(1)} to 1` : ''}` : 'Stop to target range';
  return `<article class="pcard pcard-${side}${expired ? ' is-expired' : ''}" data-pid="${esc(v.id)}" aria-labelledby="pc-${esc(v.id)}-t">
    <header class="pc-head">
      <div class="pc-id"><h3 class="pc-sym sym" id="pc-${esc(v.id)}-t">${esc(v.symbol)}</h3><span class="pill pill-${side}">${side}</span>${v.demo ? '<span class="badge-demo" title="Produced by the built-in test AI, not a real analysis">DEMO DATA</span>' : ''}</div>
      <span class="pc-left" data-level="${lvl}" title="Time left to approve">${CLOCK}<span data-pexp="${esc(v.expiresAt)}" data-pid-left="${esc(v.id)}">${esc(v.left.text)}</span>${expired ? '' : '<span class="pc-left-w"> left</span>'}</span>
    </header>
    <div class="pc-top">
      <div><span class="lbl">ALLOCATION</span><strong class="mono pc-alloc">${v.allocationUsd == null ? '—' : fmtMoney(v.allocationUsd, 0)}</strong></div>
      <div class="pc-conf"><span class="lbl">CONFIDENCE</span><strong class="mono">${v.confidencePct == null ? '—' : `${v.confidencePct}%`}</strong>${v.confidencePct == null ? '' : `<span class="conf-bar" role="img" aria-label="Confidence ${v.confidencePct} percent"><span style="width:${Math.min(100, v.confidencePct)}%"></span></span>`}</div>
    </div>
    <dl class="pc-prices">${priceCell('Entry', v.entry, '')}${priceCell('Stop', v.stop, v.stopPct != null ? `-${v.stopPct.toFixed(1)}%` : '', 'pc-stop')}${priceCell('Target', v.target, v.targetPct != null ? `+${v.targetPct.toFixed(1)}%${v.rr != null ? ` · ${v.rr.toFixed(1)}R` : ''}` : '', 'pc-tgt')}</dl>
    <div class="rbar pc-bar" role="img" aria-label="${esc(barLabel)}" style="background:${bar}"><span class="rentry" style="left:${v.entryAt * 100}%"></span></div>
    ${v.reason ? `<div class="pc-why"><span class="lbl">WHY</span><div class="clamp">${esc(v.reason)}</div></div>` : ''}
    ${riskHtml(v)}
    <p class="pc-src dim">${v.demo ? 'Demo AI' : 'AI'}${v.model ? ` · ${esc(v.model)}` : ''}</p>
    <div class="pc-msgs" role="status" aria-live="polite">${msgHtml(msg)}</div>
    <div class="pc-actions">
      <button type="button" class="btn-reject" data-act="reject" ${dis} aria-label="Reject ${esc(v.symbol)} ${side} proposal">${busy === 'reject' ? `${spin} Rejecting…` : 'Reject'}</button>
      <button type="button" class="btn-approve" data-act="approve" ${dis} ${busy === 'approve' ? 'aria-busy="true"' : ''} aria-label="Approve ${esc(v.symbol)} ${side} proposal${v.allocationUsd != null ? `, ${fmtMoney(v.allocationUsd, 0)}` : ''}">${busy === 'approve' ? `${spin} Approving…` : 'Approve'}</button>
    </div>
  </article>`;
}

/** Signature of everything a card shows except the ticking countdown text, so live polls only touch cards that changed. */
function sigOf(v, busy, msg) {
  return JSON.stringify([v.id, v.allocationUsd, v.entry, v.stop, v.target, v.confidencePct, v.reason, v.risk, v.demo, v.model, v.expired, v.left.level, busy || '', msg || '', v.status]);
}

/** Keyed reconcile: keep untouched card nodes (scroll, expanded text, focus) and replace only the changed ones. */
function reconcile(host, items, htmlOf, sigFn, keyAttr = 'data-pid') {
  [...host.children].forEach((c) => {
    if (!c.hasAttribute(keyAttr)) c.remove();
  });
  const existing = new Map([...host.children].map((n) => [n.getAttribute(keyAttr), n]));
  let prev = null;
  for (const it of items) {
    const key = it.key;
    const sig = sigFn(it);
    let node = existing.get(key);
    if (!node || node.__sig !== sig) {
      const t = document.createElement('div');
      t.innerHTML = htmlOf(it);
      const fresh = t.firstElementChild;
      fresh.__sig = sig;
      if (node) {
        const a = document.activeElement;
        const focusAct = node.contains(a) ? a.dataset?.act : null;
        const open = node.querySelector('.clamp.is-open');
        if (open) fresh.querySelector('.clamp')?.classList.add('is-open');
        node.replaceWith(fresh);
        if (focusAct) fresh.querySelector(`[data-act="${focusAct}"]:not(:disabled)`)?.focus({ preventScroll: true });
      }
      node = fresh;
    }
    const want = prev ? prev.nextSibling : host.firstChild;
    if (node !== want) host.insertBefore(node, want);
    prev = node;
    existing.delete(key);
  }
  existing.forEach((n) => n.remove());
}

/* ---------- section shell ---------- */

export function proposalsShellHtml() {
  return `<section class="widget proposals-card" id="sec-proposals" aria-labelledby="h-prop">
    <h2 class="widget-title" id="h-prop"><span>PROPOSALS <span class="count-pill" id="prop-count" hidden></span></span><span class="dim" id="prop-sub"></span></h2>
    <div class="prop-toolbar">
      <div class="tabs" role="tablist" aria-label="Proposals">
        <button class="tab active" role="tab" id="ptab-pending" data-ptab="pending" aria-controls="prop-pending" aria-selected="true" type="button">Pending <span class="tab-n" id="ptab-n"></span></button>
        <button class="tab" role="tab" id="ptab-history" data-ptab="history" aria-controls="prop-history" aria-selected="false" tabindex="-1" type="button">History</button>
      </div>
      <button class="btn-accent btn-approve-all" id="btn-approve-all" type="button" hidden>Approve all</button>
    </div>
    <div id="prop-note"></div>
    <div id="prop-pending" class="prop-list" role="tabpanel" aria-labelledby="ptab-pending"></div>
    <div id="prop-history" role="tabpanel" aria-labelledby="ptab-history" hidden></div>
  </section>`;
}

function emptyPendingHtml() {
  const blocked = aiBlocked(state.status?.ai);
  const sm = state.summary;
  const ranNone = sm?.at && (sm.proposalCount ?? sm.proposed ?? 0) === 0 && !sm.trades?.length;
  const head = blocked ? 'The AI can’t run yet' : ranNone ? 'The last run proposed no trades' : 'No proposals waiting';
  const lead = blocked ? `${esc(blocked.message)} ${blocked.actions.map((a) => `<a class="prop-link" href="${esc(a.href)}">${esc(a.label)}</a>`).join(' ')}` : ranNone ? 'The AI looked at the market and found nothing worth proposing. Nothing opened. You can run it again later.' : 'The AI never opens anything by itself. Here is how it works:';
  return `<div class="prop-empty"><strong>${head}</strong><p>${lead}</p>
    <ol class="flow"><li><b>RUN</b> — the AI scans the market and proposes trades.</li><li><b>Review</b> — each proposal shows entry, stop, target, risk and the AI’s reasoning.</li><li><b>Approve or reject</b> — only approved proposals open a simulated position.</li></ol></div>`;
}

/* ---------- pending list ---------- */

function patchPending() {
  const host = $('prop-pending');
  if (!host) return;
  if (!state.loaded) return setHtml(host, skeleton(3));
  if (state.proposals === null) return setHtml(host, empty('Proposals aren’t available from the server.'));
  const list = pendingList();
  if (!list.length) {
    const h = emptyPendingHtml();
    if (host.__eh !== h) {
      host.innerHTML = h;
      host.__eh = h;
    }
    return;
  }
  host.__eh = null;
  const now = Date.now();
  const items = list.map((p) => ({ key: String(p.id), v: proposalView(p, now) }));
  reconcile(
    host,
    items,
    (it) => cardHtml(it.v, state.pendingBusy[it.key], state.pendingMsg[it.key]),
    (it) => sigOf(it.v, state.pendingBusy[it.key], JSON.stringify(state.pendingMsg[it.key] || '')),
  );
}

function patchToolbar() {
  const n = pendingCount();
  const c = $('prop-count');
  if (c) {
    c.hidden = n <= 0;
    setText(c, String(n));
  }
  setText($('ptab-n'), n > 0 ? `(${n})` : '');
  const b = $('btn-approve-all');
  if (b) {
    const list = pendingList();
    const show = state.propTab === 'pending' && list.length >= 2;
    b.hidden = !show;
    const busy = b.dataset.busy === '1';
    if (!busy) setText(b, `Approve all (${list.length})`);
  }
  setText($('prop-sub'), state.status?.settings?.autoApprove ? 'Auto-approve is ON' : '');
}

/** Live-patch everything in the proposals section. Cheap when nothing changed. */
export function patchProposals() {
  applyBadge();
  if (!$('sec-proposals')) return;
  patchToolbar();
  patchPending();
  if (state.propTab === 'history') patchHistory();
}

/** 1s ticker: countdown text + flip a card to "expired" exactly when the clock runs out (then reload from the server). */
let expiredReload = 0;
export function tickProposals() {
  const els = document.querySelectorAll('[data-pexp]');
  let crossed = false;
  els.forEach((el) => {
    const t = timeLeft(el.dataset.pexp);
    setText(el, t.text);
    const wrap = el.closest('.pc-left');
    if (wrap && wrap.dataset.level !== t.level) {
      wrap.dataset.level = t.level;
      if (t.level === 'expired') crossed = true;
    }
  });
  if (crossed && Date.now() - expiredReload > 5000) {
    expiredReload = Date.now();
    refresh()
      .then(() => hooks.patchCurrent())
      .catch(() => {});
  }
}

/* ---------- actions ---------- */

async function reloadAll() {
  await refresh().catch(() => {});
  hooks.patchCurrent();
  if (state.propTab === 'history') await loadHistory();
}

function setMsg(id, msg) {
  if (msg) state.pendingMsg[id] = msg;
  else delete state.pendingMsg[id];
}

function showProblem(id, p) {
  setMsg(id, { tone: p.tone, title: p.title, message: p.message, actions: p.actions });
  toast(p.refresh ? `${p.title}: ${p.message}` : `${p.title}. Details are on the card.`, p.tone === 'error' ? 'error' : 'warn', p.refresh ? 9000 : 5000);
}

async function approveOne(id) {
  const p = pendingList().find((x) => String(x.id) === id);
  if (!p || state.pendingBusy[id]) return;
  state.pendingBusy[id] = 'approve';
  setMsg(id, null);
  patchPending();
  try {
    const res = await api('/proposals/' + encodeURIComponent(id) + '/approve', { method: 'POST', body: '{}' });
    const pos = res?.position;
    toast(`Approved ${p.symbol} ${p.side}: simulated position opened${pos?.allocation ? ` (${fmtMoney(pos.allocation, 0)})` : ''}.`, 'success', 6500, { label: 'View position', href: '#dashboard', jump: 'pos-open' });
    delete state.pendingBusy[id];
    setMsg(id, null);
    await reloadAll();
  } catch (e) {
    delete state.pendingBusy[id];
    const pr = approveProblem({ status: e.status, code: e.code, message: e.message, details: e.data?.details, network: e.network }, p.symbol);
    showProblem(id, pr);
    if (pr.refresh) {
      // the list changed under us (expired / decided elsewhere / risk): reload, but keep the explanation visible
      const keep = state.pendingMsg[id];
      await reloadAll();
      if (!pendingList().some((x) => String(x.id) === id)) delete state.pendingMsg[id];
      else state.pendingMsg[id] = keep;
    }
    patchProposals();
  }
}

async function rejectOne(id) {
  const p = pendingList().find((x) => String(x.id) === id);
  if (!p || state.pendingBusy[id]) return;
  const r = await modal({
    title: `Reject ${p.symbol} ${p.side}?`,
    bodyHtml: `<p>Nothing will open. The proposal moves to History, where it is scored later so you can see whether passing on it was right.</p>
      <label class="modal-field" for="rej-why">Reason (optional)<textarea id="rej-why" rows="3" maxlength="300" autocomplete="off" enterkeyhint="done" placeholder="e.g. too risky, don’t like this sector"></textarea></label>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-ghost' },
      { id: 'ok', label: 'Reject proposal', cls: 'btn-kill' },
    ],
    initialFocus: '#rej-why',
  });
  if (r.act !== 'ok') return;
  state.pendingBusy[id] = 'reject';
  setMsg(id, null);
  patchPending();
  try {
    const why = String(r.value || '').trim();
    await api('/proposals/' + encodeURIComponent(id) + '/reject', { method: 'POST', body: JSON.stringify(why ? { reason: why } : {}) });
    toast(`Rejected ${p.symbol}. Nothing opened.`, 'info');
    delete state.pendingBusy[id];
    await reloadAll();
  } catch (e) {
    delete state.pendingBusy[id];
    const pr = approveProblem({ status: e.status, code: e.code, message: e.message, details: e.data?.details, network: e.network }, p.symbol);
    showProblem(id, pr);
    if (pr.refresh) await reloadAll();
    patchProposals();
  }
}

async function approveAll() {
  const list = pendingList();
  if (!list.length) return;
  const plan = approveAllPlan(list);
  const li = (x) => `<li><span class="sym">${esc(x.symbol)}</span> <span class="pill pill-${esc(x.side)}">${esc(x.side)}</span> <span class="mono">${fmtMoney(x.allocationUsd, 0)}</span>${x.why ? ` <span class="dim">(${esc(x.why)})</span>` : ''}</li>`;
  const r = await modal({
    title: `Approve ${plan.will.length} ${plan.will.length === 1 ? 'proposal' : 'proposals'}?`,
    bodyHtml: `${plan.will.length ? `<p><strong>Will be attempted</strong> (about ${fmtMoney(plan.totalUsd, 0)} in total):</p><ul class="plan-list">${plan.will.map(li).join('')}</ul>` : ''}
      ${plan.wont.length ? `<p><strong>Won’t open</strong>:</p><ul class="plan-list">${plan.wont.map(li).join('')}</ul>` : ''}
      <p class="dim">Each one is re-checked against the live price, risk limits and free position slots. Any that fail stay listed, with the reason. All positions are simulated.</p>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-ghost' },
      ...(plan.will.length ? [{ id: 'ok', label: `Approve ${plan.will.length}`, cls: 'btn-accent' }] : []),
    ],
    initialFocus: '[data-act="cancel"]',
    cls: 'modal-plan',
  });
  if (r.act !== 'ok') return;
  const btn = $('btn-approve-all');
  if (btn) {
    btn.dataset.busy = '1';
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    btn.innerHTML = '<span class="spin" aria-hidden="true"></span> Approving…';
  }
  try {
    const res = await api('/proposals/approve-all', { method: 'POST', body: '{}' });
    const out = approveAllOutcome(res);
    await reloadAll();
    if (out.failedN) {
      await modal({
        title: out.headline,
        bodyHtml: `<ul class="plan-list">${out.failures.map((f) => `<li><span class="sym">${esc(f.symbol || '')}</span> <span class="dim">${esc(f.message)}</span></li>`).join('')}</ul><p class="dim">Failed proposals stay in the list unless they expired or were already decided.</p>`,
        actions: [{ id: 'ok', label: 'OK', cls: 'btn-accent' }],
        cls: 'modal-plan',
      });
    } else toast(out.headline, out.tone, 6500, { label: 'View positions', href: '#dashboard', jump: 'pos-open' });
  } catch (e) {
    const pr = approveProblem({ status: e.status, code: e.code, message: e.message, details: e.data?.details, network: e.network });
    toast(`${pr.title}: ${pr.message}`, 'error', 9000);
    await reloadAll();
  } finally {
    if (btn) {
      delete btn.dataset.busy;
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
    }
    patchProposals();
  }
}

/** Jump to a position row (switching to the Closed tab when needed) and flash it. */
export function jumpToPosition(id) {
  const sel = `[data-pos="${CSS.escape(String(id))}"]`;
  revealSection($('pos-open'));
  let row = document.querySelector(`#pos-open ${sel}`);
  if (!row) {
    document.getElementById('tab-closed')?.click();
    row = document.querySelector(`#pos-closed ${sel}`);
  }
  if (row) {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 1600);
    return true;
  }
  return jumpTo('pos-open');
}

async function startWorker() {
  try {
    await api('/worker/start', { method: 'POST', body: '{}' });
    toast('Worker started. You can approve now.', 'success');
    await reloadAll();
  } catch (e) {
    toast(`Could not start the worker: ${e.message}`, 'error');
  }
}

let rerunFn = null;
export function setRerun(fn) {
  rerunFn = fn;
}

function onPendingClick(e) {
  const b = e.target.closest('[data-act]');
  const card = e.target.closest('[data-pid]');
  if (!b || !card || b.disabled) return;
  const id = card.dataset.pid;
  switch (b.dataset.act) {
    case 'approve':
      approveOne(id);
      break;
    case 'reject':
      rejectOne(id);
      break;
    case 'dismiss':
      setMsg(id, null);
      patchPending();
      break;
    case 'rerun':
      setMsg(id, null);
      patchPending();
      rerunFn?.();
      break;
    case 'start':
      startWorker();
      break;
    case 'jump':
      jumpTo(b.dataset.target || 'pos-open');
      break;
    default:
  }
}

/* ---------- history ---------- */

const HIST_FILTERS = [
  ['all', 'All'],
  ['approved', 'Approved'],
  ['rejected', 'Rejected'],
  ['expired', 'Expired'],
  ['superseded', 'Superseded'],
];
let histFilter = 'all';

export async function loadHistory() {
  const r = await apiOptional('/proposals?status=all&limit=60');
  state.history = r ? { ...r, proposals: (r.proposals || []).filter((p) => p.status !== 'pending') } : state.history || { proposals: [], counts: null, failed: true };
  patchHistory();
}

function posLine(p) {
  if (p.status !== 'approved' || !p.positionId) return '';
  const all = [...(state.positions?.open || []), ...(state.positions?.closed || [])];
  const pos = all.find((x) => x.id === p.positionId);
  const now = pos ? `${pos.status === 'closed' ? 'Closed' : 'Open'} P&amp;L <strong class="mono ${pos.pnl > 0 ? 'pos' : pos.pnl < 0 ? 'neg' : ''}">${fmtMoney(pos.pnl)}</strong> <span class="dim">${fmtPct(pos.pnlPct)}</span>` : 'Position opened';
  return `<div class="hc-pos">${now} <button type="button" class="linklike" data-act="pos" data-pos-id="${esc(p.positionId)}">View position</button></div>`;
}

function historyCard(p) {
  const sv = shadowView(p);
  const v = proposalView(p);
  const when = p.decidedAt || p.createdAt;
  return `<article class="hcard hcard-${esc(p.status)}" data-hid="${esc(p.id)}">
    <header class="pc-head"><div class="pc-id"><h3 class="pc-sym sym">${esc(p.symbol)}</h3><span class="pill pill-${v.side}">${v.side}</span>${v.demo ? '<span class="badge-demo">DEMO DATA</span>' : ''}</div>
      <span class="st-pill st-${esc(p.status)}">${esc(STATUS_LABEL[p.status] || p.status)}</span></header>
    <div class="hc-line"><span class="mono">${v.allocationUsd == null ? '—' : fmtMoney(v.allocationUsd, 0)}</span><span class="dim"> · ${esc(fmtDateTime(when))}</span></div>
    <div class="hc-levels mono dim">entry ${v.entry == null ? '—' : fmtMoney(v.entry)} · stop ${v.stop == null ? '—' : fmtMoney(v.stop)} · target ${v.target == null ? '—' : fmtMoney(v.target)}</div>
    <div class="hc-out">${esc(outcomeText(p))}</div>
    ${sv.tone !== 'none' ? `<div class="whatif whatif-${sv.tone}"><span class="whatif-h">${sv.icon ? `<span aria-hidden="true">${esc(sv.icon)}</span> ` : ''}<strong>${esc(sv.label)}</strong>${sv.amountText ? ` <span class="mono">${esc(sv.amountText)}</span>` : ''}</span>${sv.detail ? `<small>${esc(sv.detail)}</small>` : ''}</div>` : ''}
    ${posLine(p)}
    ${p.reason ? `<div class="clamp">${esc(p.reason)}</div>` : ''}
  </article>`;
}

function patchHistory() {
  const host = $('prop-history');
  if (!host || host.hidden) return;
  const h = state.history;
  if (!h) return setHtml(host, skeleton(3));
  const all = h.proposals || [];
  const list = histFilter === 'all' ? all : all.filter((p) => p.status === histFilter);
  const chips = `<div class="seg hist-filters" role="group" aria-label="Filter history">${HIST_FILTERS.map(([id, l]) => {
    const n = id === 'all' ? all.length : all.filter((p) => p.status === id).length;
    return `<button type="button" class="seg-btn" data-hf="${id}" aria-pressed="${histFilter === id}">${l}${n ? ` <span class="dim">${n}</span>` : ''}</button>`;
  }).join('')}</div>`;
  const body = !list.length
    ? `<div class="empty">${h.failed ? 'History isn’t available from the server.' : all.length ? 'Nothing in this filter.' : 'No decided proposals yet. Approved, rejected and expired proposals appear here, with the “what if” result once their horizon has passed.'}</div>`
    : `<div class="hist-list">${list.map(historyCard).join('')}</div><p class="dim hist-note">“Avoided loss” = a trade you passed on that would have lost. “Missed gain” = one you passed on that would have won. Scored at the trade horizon, net of costs.</p>`;
  setHtml(host, chips + body);
}

export function setPropTab(tab, { focus = false } = {}) {
  state.propTab = tab;
  document.querySelectorAll('#sec-proposals [data-ptab]').forEach((b) => {
    const on = b.dataset.ptab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  });
  const pend = $('prop-pending');
  const hist = $('prop-history');
  if (pend) pend.hidden = tab !== 'pending';
  if (hist) hist.hidden = tab !== 'history';
  if (tab === 'history') {
    patchHistory();
    loadHistory();
  }
  patchToolbar();
}

/* ---------- wiring ---------- */

export function bindProposals() {
  const sec = $('sec-proposals');
  if (!sec) return;
  $('prop-pending').addEventListener('click', onPendingClick);
  $('btn-approve-all').addEventListener('click', approveAll);
  sec.querySelector('[role=tablist]').addEventListener('click', (e) => {
    const b = e.target.closest('[data-ptab]');
    if (b) setPropTab(b.dataset.ptab);
  });
  sec.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    setPropTab(state.propTab === 'pending' ? 'history' : 'pending', { focus: true });
  });
  $('prop-history').addEventListener('click', (e) => {
    const f = e.target.closest('[data-hf]');
    if (f) {
      histFilter = f.dataset.hf;
      patchHistory();
      $('prop-history').querySelector(`[data-hf="${histFilter}"]`)?.focus({ preventScroll: true });
      return;
    }
    const pb = e.target.closest('[data-act="pos"]');
    if (pb) jumpToPosition(pb.dataset.posId);
  });
  setPropTab(state.propTab);
}
