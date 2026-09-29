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
export function toast(message, kind = 'info', ms = 5000) {
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-msg">${escapeHtml(message)}</span><button type="button" class="toast-x" aria-label="Dismiss notification">×</button>`;
  const close = () => el.remove();
  el.querySelector('.toast-x').addEventListener('click', close);
  host().appendChild(el);
  while (host().children.length > 4) host().firstChild.remove();
  if (ms) setTimeout(close, kind === 'error' ? Math.max(ms, 8000) : ms);
}

function modal({ title, bodyHtml, actions, initialFocus }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const back = document.createElement('div');
    back.className = 'modal-backdrop';
    const id = `dlg-${Math.random().toString(36).slice(2, 8)}`;
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="${id}-t" aria-describedby="${id}-b">
      <h2 id="${id}-t">${escapeHtml(title)}</h2>
      <div class="modal-body" id="${id}-b">${bodyHtml}</div>
      <div class="modal-actions">${actions.map((a) => `<button type="button" class="btn ${a.cls || 'btn-ghost'}" data-act="${a.id}">${escapeHtml(a.label)}</button>`).join('')}</div>
    </div>`;
    document.body.appendChild(back);
    const dlg = back.querySelector('.modal');
    const app = document.getElementById('app');
    app?.setAttribute('inert', '');
    const done = (val) => {
      document.removeEventListener('keydown', onKey, true);
      app?.removeAttribute('inert');
      back.remove();
      opener?.focus?.();
      resolve(val);
    };
    const value = () => dlg.querySelector('input')?.value ?? null;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        done({ act: 'cancel', value: null });
      } else if (e.key === 'Tab') {
        const f = [...dlg.querySelectorAll('button, input')].filter((x) => !x.disabled);
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
      } else if (e.key === 'Enter' && e.target.tagName === 'INPUT') {
        e.preventDefault();
        done({ act: 'ok', value: value() });
      }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) done({ act: 'cancel', value: null });
    });
    dlg.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => done({ act: b.dataset.act, value: value() })));
    (dlg.querySelector(initialFocus || 'input') || dlg.querySelector('[data-act="ok"]') || dlg.querySelector('button')).focus();
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
      <label class="modal-field">Admin token<input type="password" autocomplete="off" spellcheck="false" /></label>`,
    actions: [
      { id: 'cancel', label: 'Cancel', cls: 'btn-ghost' },
      { id: 'ok', label: 'Save & retry', cls: 'btn-accent' },
    ],
  });
  return r.act === 'ok' && r.value ? r.value.trim() : null;
}
