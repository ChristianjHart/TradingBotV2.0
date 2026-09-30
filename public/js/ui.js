import { escapeHtml } from './api.js';

let toastHost;
function host() {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'toasts';
    toastHost.setAttribute('role', 'region');
    toastHost.setAttribute('aria-label', 'Notifications');
    document.body.appendChild(toastHost);
  }
  return toastHost;
}

/** kind: info | success | error | warn */
export function toast(message, kind = 'info', ms = 5000, action = null) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const act = action?.href ? `<a class="toast-act" href="${escapeHtml(action.href)}"${action.jump ? ` data-jump="${escapeHtml(action.jump)}"` : ''}>${escapeHtml(action.label || 'Open')}</a>` : '';
  el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}${act ? ' ' : ''}${act}</span><button type="button" class="toast-x" aria-label="Dismiss notification"><span aria-hidden="true">×</span></button>`;
  const close = () => el.remove();
  el.querySelector('.toast-x').addEventListener('click', close);
  host().appendChild(el);
  while (host().children.length > 4) host().firstChild.remove();
  if (ms) setTimeout(close, kind === 'error' ? Math.max(ms, 8000) : ms);
}

/** Generic dialog / bottom sheet (phones). bodyHtml must already be escaped. Resolves {act, value} (value = first text input/textarea). */
export function modal({ title, bodyHtml, actions, initialFocus, cls = '' }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    back.innerHTML = `<div class="modal ${cls}" role="dialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-b">
      <h2 id="${id}-t">${escapeHtml(title)}</h2>
      <div class="modal-body" id="${id}-b">${bodyHtml}</div>
      <div class="modal-actions">${actions.map((a) => `<button type="button" class="btn ${a.cls || 'btn-ghost'}" data-act="${a.id}">${escapeHtml(a.label)}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(back);
    const dlg = back.querySelector('.modal');
    const app = document.getElementById('app');
    app?.setAttribute('inert', '');
    document.documentElement.classList.add('modal-open');
    const done = (val) => {
      document.removeEventListener('keydown', onKey, true);
      app?.removeAttribute('inert');
      back.remove();
      if (!document.querySelector('.modal-backdrop')) document.documentElement.classList.remove('modal-open');
      opener?.focus?.();
      // the opener may live in a menu sheet that has since closed: fall back to the menu button
      if (document.activeElement === document.body || document.activeElement === null) document.getElementById('btn-menu')?.focus?.({ preventScroll: true });
      resolve(val);
    };
    const value = () => dlg.querySelector('textarea, input:not([type=checkbox]):not([type=radio])')?.value ?? null;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done({ act: 'cancel', value: null });
      } else if (e.key === 'Tab') {
        const f = [...dlg.querySelectorAll('button, input, textarea, a[href], select')].filter((x) => !x.disabled);
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
        e.preventDefault();
        done({ act: 'ok', value: value() });
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('pointerdown', (e) => {
      if (e.target === back) done({ act: 'cancel', value: null });
    });
    dlg.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => done({ act: b.dataset.act, value: value() })));
    (dlg.querySelector(initialFocus || 'input, textarea') || dlg.querySelector('[data-act="ok"]') || dlg.querySelector('button')).focus();
  });
}

export async function confirmDialog({ title, message, confirmText = 'Confirm', danger = false }) {
  const r = await modal({
    title,
    bodyHtml: `<p>${escapeHtml(message)}</p>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-ghost' },
      { id: 'ok', label: confirmText, cls: danger ? 'btn-kill' : 'btn-accent' },
    ],
    initialFocus: '[data-act="cancel"]',
  });
  return r.act === 'ok';
}

export async function tokenDialog(message) {
  const r = await modal({
    title: 'Admin token required',
    bodyHtml: `<p>${escapeHtml(message || 'This action needs the admin token configured on the server (ADMIN_TOKEN).')}</p>
      <label class="modal-field">Admin token<input type="password" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" /></label>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-ghost' },
      { id: 'ok', label: 'Save & retry', cls: 'btn-accent' },
    ],
  });
  return r.act === 'ok' && r.value ? r.value.trim() : null;
}

/** Scroll an in-page section into view (respects reduced motion) and move focus to it for keyboard / screen-reader users. */
export function jumpTo(id, { flash = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return false;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  if (flash) {
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  }
  return true;
}
