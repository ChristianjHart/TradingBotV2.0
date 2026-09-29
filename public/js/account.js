import { api, escapeHtml as esc } from './api.js';
import { authErrorMessage, buildKeyPayload, keyStatus, validateModel, validatePasswordChange } from './auth-logic.js';
import { forceLock } from './auth.js';
import { refresh } from './data.js';
import { hooks, state } from './state.js';
import { confirmDialog, toast } from './ui.js';

const testResults = {}; // service -> {ok, message} (kept across re-renders; contains only server-supplied text)
let host = null;

const errOf = (e, ctx) => authErrorMessage({ status: e.status, code: e.code, message: e.message, retryAfter: e.retryAfter, network: e.network }, ctx);

function chip(tone, label) {
  return `<span class="chip chip-${tone}"><span class="chip-dot" aria-hidden="true"></span>${esc(label)}</span>`;
}

function pwField(id, label, auto) {
  return `<label for="${id}">${label}<input id="${id}" name="${id}" type="password" autocomplete="${auto}" spellcheck="false" autocapitalize="none" required aria-describedby="${id}-e" /><span class="fld-err" id="${id}-e"></span></label>`;
}

function secretField(id, label, disabled) {
  return `<label for="${id}">${label}<input id="${id}" name="${id}" type="password" autocomplete="off" spellcheck="false" autocapitalize="none" data-lpignore="true" ${disabled ? 'disabled' : ''} aria-describedby="${id}-e" placeholder="Paste to save or replace" /><span class="fld-err" id="${id}-e"></span></label>`;
}

function keyGroup(kind, a) {
  const g = a.keys?.[kind];
  const st = keyStatus(kind, g);
  const title = kind === 'openrouter' ? 'OpenRouter' : 'Alpaca';
  const lock = a.encryptionReady === false;
  const t = testResults[kind];
  const fields =
    kind === 'openrouter'
      ? secretField('k-or', 'API key', lock)
      : `${secretField('k-ak', 'Key ID', lock)}${secretField('k-as', 'Secret key', lock)}`;
  return `<form class="keygrp" data-kind="${kind}" novalidate aria-labelledby="kh-${kind}">
    <div class="keygrp-head"><h3 id="kh-${kind}">${title}</h3>${chip(st.tone, st.label)}</div>
    ${st.consequence ? `<p class="dim keygrp-note">${esc(st.consequence)}</p>` : `<p class="dim keygrp-note">${kind === 'openrouter' ? 'AI scanner and trader bots are enabled.' : 'Live market data is enabled.'}</p>`}
    <div class="keygrp-fields">${fields}</div>
    <div class="keygrp-actions">
      <button class="btn-accent" type="submit" data-act="save" ${lock ? 'disabled' : ''}>Save ${title} key${kind === 'alpaca' ? 's' : ''}</button>
      <button class="btn-ghost" type="button" data-act="test" ${st.set ? '' : 'disabled'}>Test connection</button>
      <button class="btn-ghost btn-remove" type="button" data-act="remove" ${st.source === 'account' ? '' : 'disabled'}>Remove</button>
    </div>
    <div class="test-result ${t ? (t.ok ? 'ok' : 'bad') : ''}" role="status" aria-live="polite">${t ? `${t.ok ? '✓' : '✕'} ${esc(t.message || (t.ok ? 'Connection OK' : 'Connection failed'))}` : ''}</div>
    <div class="form-err" role="alert" data-err></div>
  </form>`;
}

function render() {
  const a = state.account;
  const created = a.createdAt ? new Date(a.createdAt) : null;
  const since = created && !Number.isNaN(created.getTime()) ? created.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
  const d = a.models?.defaults || {};
  host.innerHTML = `
  <section class="widget acct-card" aria-labelledby="h-acct"><h2 class="widget-title" id="h-acct">ACCOUNT</h2>
    <dl class="kv"><dt>Email</dt><dd class="acct-mail">${esc(a.email || state.auth.user?.email || '—')}</dd><dt>Member since</dt><dd>${esc(since)}</dd></dl>
    <form class="settings-form pw-form" id="f-pw" novalidate aria-labelledby="h-pw">
      <h3 id="h-pw" class="sub-h">Change password</h3>
      ${pwField('pw-cur', 'Current password', 'current-password')}
      ${pwField('pw-new', 'New password (min 10 characters)', 'new-password')}
      ${pwField('pw-conf', 'Confirm new password', 'new-password')}
      <div class="form-err" role="alert" data-err></div>
      <div class="row-actions"><button class="btn-accent" type="submit">Change password</button></div>
    </form>
    <div class="row-actions signout-all"><button class="btn-ghost" type="button" id="btn-logout-all">Sign out everywhere</button><span class="dim">Ends every session, on every device.</span></div>
  </section>
  <section class="widget keys-card" aria-labelledby="h-keys"><h2 class="widget-title" id="h-keys">API KEYS</h2>
    ${a.encryptionReady === false ? `<div class="notice" role="alert"><strong>Server needs APP_SECRET before keys can be saved.</strong> The server owner must set the <code>APP_SECRET</code> environment variable (a long random string) and restart the server. Until then the key fields are disabled.</div>` : ''}
    <p class="dim keys-note">Keys are encrypted on the server and attached to your account. They are never sent back to the browser — only the last 4 characters are shown. Fields are always empty; paste a new value to replace a key.</p>
    ${keyGroup('openrouter', a)}
    ${keyGroup('alpaca', a)}
  </section>
  <section class="widget models-card" aria-labelledby="h-models"><h2 class="widget-title" id="h-models">MODELS</h2>
    <form class="settings-form" id="f-models" novalidate>
      <label for="m-scan">Scanner model<input id="m-scan" name="scanner" type="text" spellcheck="false" autocomplete="off" autocapitalize="none" value="${esc(a.models?.scanner ?? d.scanner ?? '')}" placeholder="${esc(d.scanner || 'vendor/model')}" aria-describedby="m-scan-h m-scan-e" /><span class="fld-hint" id="m-scan-h">Default: <code>${esc(d.scanner || '—')}</code></span><span class="fld-err" id="m-scan-e"></span></label>
      <label for="m-trad">Trader model<input id="m-trad" name="trader" type="text" spellcheck="false" autocomplete="off" autocapitalize="none" value="${esc(a.models?.trader ?? d.trader ?? '')}" placeholder="${esc(d.trader || 'vendor/model')}" aria-describedby="m-trad-h m-trad-e" /><span class="fld-hint" id="m-trad-h">Default: <code>${esc(d.trader || '—')}</code></span><span class="fld-err" id="m-trad-e"></span></label>
      <div class="form-err" role="alert" data-err></div>
      <div class="row-actions"><button class="btn-accent" type="submit">Save models</button><button class="btn-ghost" type="button" id="btn-models-reset" ${d.scanner || d.trader ? '' : 'disabled'}>Reset to defaults</button></div>
    </form>
  </section>`;
  wire();
}

function pending(btn, label, fn) {
  if (btn.disabled) return Promise.resolve();
  const orig = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  btn.innerHTML = `<span class="spin" aria-hidden="true"></span> ${esc(label)}`;
  return Promise.resolve(fn()).finally(() => {
    if (btn.isConnected) {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.textContent = orig;
    }
  });
}

const setErr = (form, msg) => {
  const e = form.querySelector('[data-err]');
  if (e) e.textContent = msg || '';
};

async function afterKeysChange(summary, focusSel) {
  state.account = { ...state.account, ...summary };
  render();
  refresh()
    .then(() => hooks.patchCurrent())
    .catch(() => {});
  if (focusSel) host.querySelector(focusSel)?.focus();
}

function wire() {
  const pw = host.querySelector('#f-pw');
  pw.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = { current: pw.querySelector('#pw-cur').value, next: pw.querySelector('#pw-new').value, confirm: pw.querySelector('#pw-conf').value };
    const errs = validatePasswordChange(v);
    ['current', 'next', 'confirm'].forEach((k) => {
      const id = { current: 'pw-cur', next: 'pw-new', confirm: 'pw-conf' }[k];
      pw.querySelector(`#${id}-e`).textContent = errs[k] || '';
      pw.querySelector(`#${id}`).toggleAttribute('aria-invalid', !!errs[k]);
    });
    setErr(pw, '');
    const bad = ['pw-cur', 'pw-new', 'pw-conf'].find((id, i) => errs[['current', 'next', 'confirm'][i]]);
    if (bad) return pw.querySelector(`#${bad}`).focus();
    pending(pw.querySelector('button[type=submit]'), 'Changing…', async () => {
      try {
        await api('/auth/password', { method: 'POST', body: JSON.stringify({ current: v.current, next: v.next }), skipAuthRedirect: true });
        pw.reset();
        toast('Password changed', 'success');
      } catch (err) {
        if (err.code === 'login_required') return forceLock(errOf(err, 'password'));
        setErr(pw, errOf(err, 'password'));
      }
    });
  });

  host.querySelector('#btn-logout-all').addEventListener('click', async (e) => {
    if (!(await confirmDialog({ title: 'Sign out everywhere?', message: 'This ends your session on every device, including this one. You will need to sign in again.', confirmText: 'Sign out everywhere', danger: true }))) return;
    pending(e.currentTarget, 'Signing out…', async () => {
      try {
        await api('/auth/logout-all', { method: 'POST', body: '{}', skipAuthRedirect: true });
        forceLock('You have been signed out on all devices.');
      } catch (err) {
        if (err.code === 'login_required') return forceLock(errOf(err, 'generic'));
        toast(`Could not sign out everywhere: ${errOf(err, 'generic')}`, 'error');
      }
    });
  });

  host.querySelectorAll('.keygrp').forEach((form) => {
    const kind = form.dataset.kind;
    const first = kind === 'openrouter' ? '#k-or' : '#k-ak';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      setErr(form, '');
      const vals = { openrouterKey: form.querySelector('#k-or')?.value, alpacaKey: form.querySelector('#k-ak')?.value, alpacaSecret: form.querySelector('#k-as')?.value };
      const { payload, errors } = buildKeyPayload(kind, vals);
      const ids = { openrouterKey: 'k-or', alpacaKey: 'k-ak', alpacaSecret: 'k-as' };
      form.querySelectorAll('.fld-err').forEach((n) => (n.textContent = ''));
      const keys = Object.keys(errors);
      keys.forEach((k) => {
        form.querySelector(`#${ids[k]}-e`).textContent = errors[k];
      });
      if (keys.length) return form.querySelector(`#${ids[keys[0]]}`).focus();
      pending(form.querySelector('[data-act=save]'), 'Saving…', async () => {
        try {
          const summary = await api('/account/keys', { method: 'PUT', body: JSON.stringify(payload), skipAuthRedirect: false });
          form.querySelectorAll('input').forEach((i) => (i.value = '')); // clear immediately
          delete testResults[kind];
          toast(`${kind === 'openrouter' ? 'OpenRouter' : 'Alpaca'} key saved`, 'success');
          await afterKeysChange(summary, `.keygrp[data-kind="${kind}"] ${first}`);
        } catch (err) {
          if (err.code === 'encryption_not_configured') state.account = { ...state.account, encryptionReady: false };
          if (err.code === 'encryption_not_configured') return render();
          setErr(form, errOf(err, 'keys'));
        }
      });
    });
    form.querySelector('[data-act=test]').addEventListener('click', (e) => {
      setErr(form, '');
      pending(e.currentTarget, 'Testing…', async () => {
        try {
          const r = await api('/account/test', { method: 'POST', body: JSON.stringify({ service: kind }) });
          testResults[kind] = { ok: !!r.ok, message: String(r.message ?? '') };
        } catch (err) {
          testResults[kind] = { ok: false, message: errOf(err, 'test') };
        }
        const el = form.querySelector('.test-result');
        const t = testResults[kind];
        el.className = `test-result ${t.ok ? 'ok' : 'bad'}`;
        el.textContent = `${t.ok ? '✓' : '✕'} ${t.message || (t.ok ? 'Connection OK' : 'Connection failed')}`;
      });
    });
    form.querySelector('[data-act=remove]').addEventListener('click', async (e) => {
      const name = kind === 'openrouter' ? 'OpenRouter' : 'Alpaca';
      const ok = await confirmDialog({ title: `Remove ${name} key${kind === 'alpaca' ? 's' : ''}?`, message: kind === 'openrouter' ? 'The bots will fall back to rule-based decisions (no AI) until you add a key again.' : 'The dashboard will fall back to synthetic mock data until you add keys again.', confirmText: 'Remove', danger: true });
      if (!ok) return;
      setErr(form, '');
      pending(e.target.closest('button'), 'Removing…', async () => {
        try {
          const summary = await api('/account/keys', { method: 'PUT', body: JSON.stringify({ clear: [kind] }) });
          delete testResults[kind];
          toast(`${name} key removed`, 'info');
          await afterKeysChange(summary, `.keygrp[data-kind="${kind}"] ${first}`);
        } catch (err) {
          setErr(form, errOf(err, 'keys'));
        }
      });
    });
  });

  const mf = host.querySelector('#f-models');
  const saveModels = (scanner, trader) =>
    pending(mf.querySelector('button[type=submit]'), 'Saving…', async () => {
      try {
        const r = await api('/account/models', { method: 'PUT', body: JSON.stringify({ scannerModel: scanner, traderModel: trader }) });
        state.account = { ...state.account, models: { ...(state.account.models || {}), ...(r?.models || { scanner, trader }) } };
        mf.querySelector('#m-scan').value = state.account.models.scanner ?? scanner;
        mf.querySelector('#m-trad').value = state.account.models.trader ?? trader;
        toast('Models saved', 'success');
      } catch (err) {
        setErr(mf, errOf(err, 'generic'));
      }
    });
  mf.addEventListener('submit', (e) => {
    e.preventDefault();
    setErr(mf, '');
    const s = mf.querySelector('#m-scan');
    const t = mf.querySelector('#m-trad');
    const es = validateModel(s.value);
    const et = validateModel(t.value);
    mf.querySelector('#m-scan-e').textContent = es || '';
    mf.querySelector('#m-trad-e').textContent = et || '';
    s.toggleAttribute('aria-invalid', !!es);
    t.toggleAttribute('aria-invalid', !!et);
    if (es) return s.focus();
    if (et) return t.focus();
    saveModels(s.value.trim(), t.value.trim());
  });
  mf.querySelector('#btn-models-reset').addEventListener('click', () => {
    const d = state.account.models?.defaults || {};
    mf.querySelector('#m-scan').value = d.scanner || '';
    mf.querySelector('#m-trad').value = d.trader || '';
    mf.querySelector('#m-scan-e').textContent = '';
    mf.querySelector('#m-trad-e').textContent = '';
    mf.requestSubmit();
  });
}

/** Mount the account/keys/models cards into `el`. Degrades to a short note on servers without the account API. */
export async function mountAccount(el) {
  host = el;
  host.innerHTML = '<section class="widget" aria-busy="true"><h2 class="widget-title">ACCOUNT</h2><div class="skel-wrap" aria-hidden="true"><div class="skeleton"></div><div class="skeleton"></div></div></section>';
  try {
    state.account = await api('/account');
  } catch (e) {
    if (!host.isConnected) return;
    if (e.code === 'login_required') return; // auth screen takes over
    host.innerHTML =
      e.status === 404
        ? '<section class="widget" aria-labelledby="h-acct"><h2 class="widget-title" id="h-acct">ACCOUNT &amp; API KEYS</h2><p class="dim">This server does not have accounts enabled, so API keys are read from the server environment (.env) instead.</p></section>'
        : `<section class="widget" aria-labelledby="h-acct"><h2 class="widget-title" id="h-acct">ACCOUNT &amp; API KEYS</h2><div class="notice" role="alert">Could not load your account: ${esc(errOf(e, 'generic'))}</div><button class="btn-ghost" type="button" id="acct-retry">Retry</button></section>`;
    host.querySelector('#acct-retry')?.addEventListener('click', () => mountAccount(host));
    return;
  }
  if (host.isConnected) render();
}
