import { api, escapeHtml as esc, fmtMoney } from './api.js';
import { signedMoney, whatifBody, whatifSvg, whatifVerdict, WHATIF_DEFAULTS } from './fun-logic.js';
import { $, state } from './state.js';

/* What-if replay (Performance page): re-run past proposals under different rules and compare with what really happened. */

const ui = { ...WHATIF_DEFAULTS };
let seq = 0; // only the newest response is shown
let timer = null;
let last = null; // last good response
let status = 'idle'; // idle | busy | error
let errorText = '';

const HOLD = [null, 4, 8, 12, 24, 48, 72];
const TRAIL = [null, 0, 1, 1.5, 2];
const SCOPES = [['all', 'All decided'], ['approved', 'Only approved'], ['declined', 'Only passed on']];

const opt = (list, cur, label) => list.map((v) => `<option value="${v === null ? '' : v}"${v === cur ? ' selected' : ''}>${esc(label(v))}</option>`).join('');

/** Forget the last result and controls (called when the app locks: no private numbers stay in memory). */
export function resetWhatif() {
  Object.assign(ui, WHATIF_DEFAULTS);
  last = null;
  status = 'idle';
  errorText = '';
  clearTimeout(timer);
  seq++;
}

export function whatifShellHtml() {
  return `<section class="widget wir" id="sec-whatif" aria-labelledby="h-wir"><h2 class="widget-title" id="h-wir"><span>WHAT-IF REPLAY <span class="dim">— would different rules have done better?</span></span><button type="button" class="btn-ghost wir-reset" id="wir-reset">Reset</button></h2>
    <div class="wir-grid">
      <form class="wir-controls" id="wir-form" onsubmit="return false" aria-label="What-if settings">
        <label for="wir-stop">Stop distance <output id="o-stop" class="mono"></output><input id="wir-stop" type="range" min="0.5" max="2" step="0.1" value="${ui.stopMult}" /><small class="dim">Tighter stops cut losses sooner but get hit more.</small></label>
        <label for="wir-tgt">Target distance <output id="o-tgt" class="mono"></output><input id="wir-tgt" type="range" min="0.5" max="2" step="0.1" value="${ui.targetMult}" /><small class="dim">Nearer targets win more often but smaller.</small></label>
        <label for="wir-size">Position size <output id="o-size" class="mono"></output><input id="wir-size" type="range" min="0.5" max="2" step="0.25" value="${ui.sizeMult}" /><small class="dim">Scales every trade’s dollars.</small></label>
        <label for="wir-hold">Max hold<select id="wir-hold">${opt(HOLD, ui.horizonHours, (v) => (v === null ? 'As it was' : `${v} hours`))}</select></label>
        <label for="wir-be">Break-even stop<select id="wir-be"><option value="">As it was</option><option value="true"${ui.breakEven === true ? ' selected' : ''}>On</option><option value="false"${ui.breakEven === false ? ' selected' : ''}>Off</option></select></label>
        <label for="wir-trail">Trailing stop<select id="wir-trail">${opt(TRAIL, ui.trailR, (v) => (v === null ? 'As it was' : v === 0 ? 'Off' : `${v}R behind the best price`))}</select></label>
        <div class="wir-scope" role="group" aria-label="Which proposals"><span class="lbl">REPLAY</span><div class="seg">${SCOPES.map(([id, l]) => `<button type="button" class="seg-btn" data-wscope="${id}" aria-pressed="${ui.scope === id}">${l}</button>`).join('')}</div></div>
      </form>
      <div class="wir-out" id="wir-out" aria-live="polite" aria-busy="false"></div>
    </div></section>`;
}

function stat(label, s) {
  return `<div class="wir-stat"><span class="lbl">${label}</span><strong class="mono ${s.pnl > 0 ? 'pos' : s.pnl < 0 ? 'neg' : ''}">${signedMoney(s.pnl, 0)}</strong><small class="dim">${s.winRate == null ? '—' : `${Math.round(s.winRate * 100)}% win`} · worst dip ${fmtMoney(s.maxDrawdownUsd, 0)}</small></div>`;
}

/** SVG user units = CSS pixels, so chart text keeps its real size on a phone instead of shrinking with the viewBox. */
function chartSize() {
  const w = Math.round(Math.min(720, Math.max(260, $('wir-out')?.clientWidth || 560)));
  return { w, h: Math.round(w * (w < 420 ? 0.62 : 0.34)) };
}

function outHtml() {
  if (status === 'error') return `<div class="notice" role="alert">${esc(errorText)}</div>`;
  if (!last) return '<div class="skel-wrap" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div></div>';
  const r = last;
  const v = whatifVerdict(r);
  const sk = r.skipped || {};
  const skipBits = [sk.noPriceHistory ? `${sk.noPriceHistory} without price history` : '', sk.tooRecent ? `${sk.tooRecent} not finished yet` : '', sk.superseded ? `${sk.superseded} superseded` : ''].filter(Boolean);
  if (!r.replayed) return `<p class="wir-verdict wir-none">${esc(v.text)}</p>${skipBits.length ? `<p class="dim">Skipped: ${esc(skipBits.join(', '))}.</p>` : ''}`;
  const movers = (r.movers || []).filter((m) => Math.abs(m.delta) >= 0.01);
  return `<p class="wir-verdict wir-${v.tone}" role="status"><strong>${esc(v.text)}</strong></p>
    <div class="wir-stats">${stat('REAL RULES', r.baseline)}${stat('WITH YOUR CHANGES', r.scenario)}<div class="wir-stat"><span class="lbl">DIFFERENCE</span><strong class="mono ${r.delta.pnl > 0 ? 'pos' : r.delta.pnl < 0 ? 'neg' : ''}">${signedMoney(r.delta.pnl, 0)}</strong><small class="dim">${r.replayed} trades replayed</small></div></div>
    <div class="wir-chart">${whatifSvg(r.curves, chartSize())}<div class="wir-legend"><span class="wir-key wir-kb"></span> Real rules <span class="wir-key wir-ks"></span> With your changes</div></div>
    ${movers.length ? `<details class="wir-movers"><summary>Biggest changes (${movers.length})</summary><table class="table"><thead><tr><th scope="col">TRADE</th><th scope="col">REAL</th><th scope="col">NEW</th><th scope="col">CHANGE</th></tr></thead><tbody>${movers.map((m) => `<tr><th scope="row">${esc(m.symbol)} <span class="pill pill-${m.side}">${esc(m.side)}</span></th><td class="mono" data-label="Real">${signedMoney(m.basePnl, 0)} <small class="dim">${esc(String(m.baseExit || '').replace(/-/g, ' '))}</small></td><td class="mono" data-label="New">${signedMoney(m.scenPnl, 0)} <small class="dim">${esc(String(m.scenExit || '').replace(/-/g, ' '))}</small></td><td class="mono ${m.delta > 0 ? 'pos' : 'neg'}" data-label="Change">${signedMoney(m.delta, 0)}</td></tr>`).join('')}</tbody></table></details>` : ''}
    <p class="dim wir-note">${esc(r.note)}${skipBits.length ? ` Skipped: ${esc(skipBits.join(', '))}.` : ''}</p>`;
}

function paint() {
  const out = $('wir-out');
  if (!out) return;
  out.setAttribute('aria-busy', String(status === 'busy'));
  const html = outHtml();
  if (out.__h !== html) {
    out.innerHTML = html;
    out.__h = html;
  }
  out.classList.toggle('is-busy', status === 'busy');
  const set = (id, text) => {
    const o = $(id);
    if (o) o.textContent = text;
  };
  set('o-stop', `${ui.stopMult.toFixed(1)}×`);
  set('o-tgt', `${ui.targetMult.toFixed(1)}×`);
  set('o-size', `${ui.sizeMult.toFixed(2)}×`);
  const rb = $('wir-reset');
  if (rb) rb.disabled = Object.keys(whatifBody(ui)).length === 0;
}

async function run() {
  const mine = ++seq;
  status = 'busy';
  paint();
  try {
    const r = await api('/whatif', { method: 'POST', body: JSON.stringify(whatifBody(ui)) });
    if (mine !== seq) return; // a newer request superseded this one
    last = r;
    status = 'idle';
  } catch (e) {
    if (mine !== seq) return;
    status = 'error';
    errorText = e.network ? 'Could not reach the server. Check your connection.' : `The replay could not run: ${e.message}`;
  }
  paint();
}
const later = () => {
  clearTimeout(timer);
  timer = setTimeout(run, 350);
};

export function mountWhatif() {
  const form = $('wir-form');
  if (!form) return;
  const num = (id, key) =>
    $(id).addEventListener('input', (e) => {
      ui[key] = Number(e.target.value);
      paint();
      later();
    });
  num('wir-stop', 'stopMult');
  num('wir-tgt', 'targetMult');
  num('wir-size', 'sizeMult');
  $('wir-hold').addEventListener('change', (e) => {
    ui.horizonHours = e.target.value === '' ? null : Number(e.target.value);
    later();
  });
  $('wir-be').addEventListener('change', (e) => {
    ui.breakEven = e.target.value === '' ? null : e.target.value === 'true';
    later();
  });
  $('wir-trail').addEventListener('change', (e) => {
    ui.trailR = e.target.value === '' ? null : Number(e.target.value);
    later();
  });
  form.addEventListener('click', (e) => {
    const b = e.target.closest('[data-wscope]');
    if (!b) return;
    ui.scope = b.dataset.wscope;
    form.querySelectorAll('[data-wscope]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    later();
  });
  $('wir-reset').addEventListener('click', () => {
    Object.assign(ui, WHATIF_DEFAULTS);
    $('wir-stop').value = '1';
    $('wir-tgt').value = '1';
    $('wir-size').value = '1';
    $('wir-hold').value = '';
    $('wir-be').value = '';
    $('wir-trail').value = '';
    form.querySelectorAll('[data-wscope]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.wscope === 'all')));
    run();
  });
  paint();
  run();
}
