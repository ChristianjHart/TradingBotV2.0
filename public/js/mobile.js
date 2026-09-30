/* Phone/touch behaviour that CSS alone cannot do: header menu sheet, on-screen keyboard handling,
   nav fade affordance, expandable clamped text. Everything here is progressive enhancement. */

const root = document.documentElement;
const $ = (id) => document.getElementById(id);
const COMPACT = window.matchMedia('(max-width: 900px)');

/* ---------- visual viewport (keyboard) ---------- */

function syncViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  // How much of the layout viewport the on-screen keyboard (or pinch zoom) is covering at the bottom.
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  root.style.setProperty('--kb', `${vv.scale > 1.02 ? 0 : kb}px`);
  root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
  root.classList.toggle('kb-open', kb > 120 && vv.scale <= 1.02);
}

function keepFocusedFieldVisible(e) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches('input, select, textarea')) return;
  if (t.matches('[type=checkbox], [type=radio], [type=button], [type=submit]')) return;
  if (!window.matchMedia('(pointer: coarse)').matches) return;
  // wait for the keyboard animation, then centre the field (and its error line) in what is left
  setTimeout(() => {
    if (document.activeElement !== t) return;
    const modal = t.closest('.modal');
    t.scrollIntoView({ block: modal ? 'nearest' : 'center', inline: 'nearest', behavior: 'auto' });
  }, 320);
}

/* ---------- header menu (phones) ---------- */

function menuOpen() {
  return root.classList.contains('menu-open');
}
function setMenu(open, { restoreFocus = true } = {}) {
  const btn = $('btn-menu');
  const scrim = $('menu-scrim');
  if (!btn) return;
  if (open === menuOpen()) return;
  root.classList.toggle('menu-open', open);
  btn.setAttribute('aria-expanded', String(open));
  if (scrim) scrim.hidden = !open;
  const panel = $('topnav-right');
  if (open) {
    (panel?.querySelector('button:not([hidden])') || panel)?.focus?.({ preventScroll: true });
  } else if (restoreFocus && panel?.contains(document.activeElement)) {
    btn.focus({ preventScroll: true });
  }
}

function bindMenu() {
  const btn = $('btn-menu');
  const panel = $('topnav-right');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => setMenu(!menuOpen()));
  $('menu-scrim')?.addEventListener('pointerdown', () => setMenu(false));
  // any action inside the sheet dismisses it (the action itself still runs)
  panel.addEventListener('click', (e) => {
    if (e.target.closest('button')) setTimeout(() => setMenu(false, { restoreFocus: false }), 0);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menuOpen() && !document.querySelector('.modal-backdrop')) {
      e.preventDefault();
      setMenu(false);
    } else if (e.key === 'Tab' && menuOpen() && !document.querySelector('.modal-backdrop')) {
      const f = [btn, ...panel.querySelectorAll('button:not([hidden])')].filter((x) => !x.disabled && x.offsetParent !== null);
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
    }
  });
  window.addEventListener('hashchange', () => setMenu(false, { restoreFocus: false }));
  COMPACT.addEventListener?.('change', (m) => {
    if (!m.matches) setMenu(false, { restoreFocus: false });
  });
}

/* ---------- nav: fade edges + keep the active pill in view (landscape phones) ---------- */

export function revealActiveNav() {
  const nav = $('main-nav');
  if (!nav) return;
  const on = nav.querySelector('a.active');
  if (on && nav.scrollWidth > nav.clientWidth + 1) nav.scrollLeft = Math.max(0, on.offsetLeft - (nav.clientWidth - on.offsetWidth) / 2);
  updateNavFade();
}
function updateNavFade() {
  const nav = $('main-nav');
  if (!nav) return;
  const max = nav.scrollWidth - nav.clientWidth;
  nav.dataset.fadeL = String(nav.scrollLeft > 2);
  nav.dataset.fadeR = String(max > 2 && nav.scrollLeft < max - 2);
}

/* ---------- long text: line clamp with tap-to-expand ---------- */

let clampRaf = 0;
function refreshClamps() {
  clampRaf = 0;
  document.querySelectorAll('.clamp').forEach((el) => {
    const open = el.classList.contains('is-open');
    const over = open || el.scrollHeight > el.clientHeight + 1;
    if (over) {
      if (!el.hasAttribute('role')) {
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
      }
      el.classList.add('clamped');
      el.setAttribute('aria-expanded', String(open));
    } else if (el.classList.contains('clamped')) {
      el.classList.remove('clamped');
      el.removeAttribute('role');
      el.removeAttribute('aria-expanded');
      el.removeAttribute('tabindex');
    }
  });
}
function scheduleClamps() {
  if (!clampRaf) clampRaf = requestAnimationFrame(refreshClamps);
}
function toggleClamp(el) {
  if (!el.classList.contains('clamped')) return;
  el.classList.toggle('is-open');
  el.setAttribute('aria-expanded', String(el.classList.contains('is-open')));
}

/* ---------- boot ---------- */

export function initMobile() {
  bindMenu();
  syncViewport();
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  window.addEventListener('orientationchange', () => setTimeout(syncViewport, 200));
  document.addEventListener('focusin', keepFocusedFieldVisible);
  $('main-nav')?.addEventListener('scroll', updateNavFade, { passive: true });
  window.addEventListener('resize', () => {
    updateNavFade();
    scheduleClamps();
  });
  revealActiveNav();

  document.addEventListener('click', (e) => {
    const c = e.target.closest?.('.clamp.clamped');
    if (c && !e.target.closest('a, button')) toggleClamp(c);
  });
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('.clamp.clamped')) {
      e.preventDefault();
      toggleClamp(e.target);
    }
  });
  const view = $('view-root');
  if (view) new MutationObserver(scheduleClamps).observe(view, { childList: true, subtree: true });
  if (document.fonts?.ready) document.fonts.ready.then(scheduleClamps).catch(() => {});
  scheduleClamps();
}
