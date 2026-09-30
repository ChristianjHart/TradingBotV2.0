#!/usr/bin/env node
/* Mobile audit for the dashboard front end.
 *
 *   node scripts/mobile-audit.cjs [baseUrl] [--out DIR] [--vp 320x568,390x844] [--quick] [--no-shots] [--verbose]
 *
 * Needs a running server (mock mode is fine):  PORT=3100 USE_MOCK_DATA=true node server/index.js
 * Uses the global Playwright + a local chromium (PW_CHROMIUM overrides /opt/pw-browsers/chromium).
 * Creates the owner account itself (UI on the first run, API afterwards) with AUDIT_EMAIL / AUDIT_PASSWORD.
 *
 * Checks on every page/state at every viewport: no horizontal overflow, touch targets >= 44px, inputs >= 16px,
 * text >= 11px, contrast >= 4.5:1, no console/page errors, no CSP violations, canvases/images inside the viewport,
 * canvas backing store crisp for the DPR, sheets/toasts inside the viewport. Screenshots go to --out (default: OS temp dir).
 */
const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function loadPlaywright() {
  const tries = [() => require('playwright'), () => require(path.join(execSync('npm root -g').toString().trim(), 'playwright'))];
  for (const t of tries) {
    try {
      return t();
    } catch {
      /* next */
    }
  }
  throw new Error('Playwright not found (npm i -g playwright)');
}
const { chromium } = loadPlaywright();

/* ---------------- args ---------------- */
const argv = process.argv.slice(2);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const flag = (name) => argv.includes(`--${name}`);
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').match(/^--(out|vp)$/));
const BASE = (positional[0] || 'http://localhost:3100').replace(/\/$/, '');
const OUT = opt('out') || path.join(os.tmpdir(), `mobile-audit-${Date.now()}`);
const SHOTS = !flag('no-shots');
const VERBOSE = flag('verbose');
const EMAIL = process.env.AUDIT_EMAIL || 'audit@example.com';
const PASSWORD = process.env.AUDIT_PASSWORD || 'Correct-Horse-Battery-9';
const LONG_EMAIL = `${'very.long.mailbox.name.for.testing'}${'x'.repeat(24)}@subdomain.extremely-long-domain-name-example.co.uk`;

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const ALL_VPS = [
  { name: '320x568', w: 320, h: 568, dpr: 2, note: 'iPhone SE1' },
  { name: '360x740', w: 360, h: 740, dpr: 3, note: 'small Android' },
  { name: '375x667', w: 375, h: 667, dpr: 2, note: 'iPhone SE2/8' },
  { name: '390x844', w: 390, h: 844, dpr: 3, note: 'iPhone 14' },
  { name: '412x915', w: 412, h: 915, dpr: 2.625, note: 'Pixel 7' },
  { name: '430x932', w: 430, h: 932, dpr: 3, note: 'iPhone Pro Max' },
  { name: '844x390', w: 844, h: 390, dpr: 3, note: 'landscape' },
  { name: '667x375', w: 667, h: 375, dpr: 2, note: 'landscape' },
  { name: '768x1024', w: 768, h: 1024, dpr: 2, note: 'tablet' },
];
let VPS = ALL_VPS;
if (opt('vp')) VPS = ALL_VPS.filter((v) => opt('vp').split(',').includes(v.name));
else if (flag('quick')) VPS = ALL_VPS.filter((v) => ['320x568', '390x844', '844x390'].includes(v.name));
const isLandscape = (v) => v.w > v.h;

/* ---------------- results ---------------- */
const results = []; // {vp, scenario, fails:[msg], checks}
let current = null;
function fail(msg) {
  if (current && !current.fails.includes(msg)) current.fails.push(msg);
}

/* ---------------- in-page assertions ---------------- */
/* Runs inside the page. Returns a list of problem strings. */
function pageAudit(opts) {
  const problems = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const sel = (el) => {
    if (el.id) return `#${el.id}`;
    let s = el.tagName.toLowerCase();
    const c = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
    if (c) s += `.${c}`;
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24);
    return t ? `${s} "${t}"` : s;
  };
  const style = (el) => getComputedStyle(el);
  const visible = (el) => {
    const cs = style(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = style(p);
      if (ps.display === 'none' || ps.visibility === 'hidden') return false;
    }
    return true;
  };
  const inScrollRegion = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = style(p);
      if (/(auto|scroll)/.test(ps.overflowX)) return p;
    }
    return null;
  };
  // let off-screen cards render for measurement
  document.querySelectorAll('.table.cards tr, .log-row').forEach((n) => (n.style.contentVisibility = 'visible'));

  /* 1. horizontal overflow */
  const de = document.documentElement;
  if (de.scrollWidth > vw + 1) problems.push(`overflow: documentElement.scrollWidth ${de.scrollWidth} > ${vw}`);
  if (document.body.scrollWidth > vw + 1) problems.push(`overflow: body.scrollWidth ${document.body.scrollWidth} > ${vw}`);
  const offenders = [];
  document.querySelectorAll('body *').forEach((el) => {
    if (!visible(el)) return;
    if (el.closest('.sr-only, .vis-hidden-table, .skip-link')) return;
    const r = el.getBoundingClientRect();
    if (r.right <= vw + 1 && r.left >= -1) return;
    const cs = style(el);
    if (cs.position === 'fixed' && (el.closest('.topnav-right') || el.closest('.menu-scrim'))) return;
    const region = inScrollRegion(el);
    if (region) {
      const rr = region.getBoundingClientRect();
      if (rr.right <= vw + 1 && rr.left >= -1) return; // intentionally scrollable
    }
    // an element clipped by an ancestor (overflow hidden) is not visibly overflowing
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ps = style(p);
      if (/(hidden|clip)/.test(ps.overflowX)) {
        const pr = p.getBoundingClientRect();
        if (pr.right <= vw + 1 && pr.left >= -1) return;
      }
    }
    offenders.push(`${sel(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  });
  if (offenders.length) problems.push(`overflow: ${offenders.length} element(s) outside viewport, e.g. ${offenders.slice(0, 4).join('; ')}`);

  /* 2. touch targets */
  const interactive = document.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=switch], [tabindex]:not([tabindex="-1"]), [onclick]');
  const small = [];
  const rects = [];
  interactive.forEach((el) => {
    if (!visible(el)) return;
    if (el.closest('.skip-link, .sr-only') || el.matches('.skip-link')) return;
    if (el.closest('[inert]') && !opts.modalOpen) {
      /* still measured */
    }
    let target = el;
    if (el.matches('input[type=checkbox], input[type=radio]')) target = el.closest('label') || el;
    const cs = style(target);
    const r = target.getBoundingClientRect();
    // inline links inside a sentence are exempt (WCAG 2.5.8 inline exception)
    if (el.tagName === 'A' && cs.display === 'inline') return;
    if (el.matches('.scroll-y, [role=log], [role=region], main') ) return; // scroll containers focusable for keyboard scrolling
    // a role=tab with a single-line row etc still needs size
    if (r.width < 43.5 || r.height < 43.5) small.push(`${sel(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
    if (!el.closest('tr') || el.tagName === 'BUTTON') rects.push({ el, r });
  });
  if (small.length) problems.push(`touch target < 44px: ${small.length} e.g. ${small.slice(0, 6).join('; ')}`);
  // adjacent targets must not overlap
  const overlaps = [];
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const layer = (e) => (e.closest('.topnav, .modal, .toasts, .topnav-right') ? 1 : 0);
      if (layer(a.el) !== layer(b.el)) continue; // fixed chrome floats above scrolling content by design
      if (a.el.tagName === 'CANVAS' || b.el.tagName === 'CANVAS') continue;
      if (a.el.closest('.af-wrap') && a.el.closest('.af-wrap') === b.el.closest('.af-wrap')) continue; // show/hide button lives inside its field
      if (a.el.matches('input, select') && b.el.closest('label') === a.el.closest('label') && a.el.closest('label')) continue;
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (ox > 2 && oy > 2) overlaps.push(`${sel(a.el)} x ${sel(b.el)}`);
    }
  }
  if (overlaps.length) problems.push(`overlapping targets: ${overlaps.slice(0, 3).join('; ')}`);

  /* 3. inputs >= 16px */
  const tiny = [];
  document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]), select, textarea').forEach((el) => {
    if (!visible(el)) return;
    const fs = parseFloat(style(el).fontSize);
    if (fs < 16) tiny.push(`${sel(el)} ${fs}px`);
  });
  if (tiny.length) problems.push(`input font < 16px: ${tiny.slice(0, 5).join('; ')}`);

  /* 4. text >= 11px + 5. contrast */
  const smallText = new Set();
  const lowContrast = new Map();
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const layers = [];
    for (let p = el; p; p = p.parentElement) {
      const cs = style(p);
      if (cs.backgroundImage !== 'none' && !cs.backgroundImage.startsWith('linear-gradient(90deg, rgba(239')) return null; // gradients: skip
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 1) break;
      }
    }
    let base = { r: 11, g: 12, b: 14, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement;
    if (!el || el.closest('script, style, noscript, .sr-only, .vis-hidden-table, [aria-hidden=true] canvas') || !visible(el)) continue;
    if (el.closest('.skip-link')) continue;
    const cs = style(el);
    const fs = parseFloat(cs.fontSize);
    if (fs < 10.99) smallText.add(`${sel(el)} ${fs}px`);
    const fg = parse(cs.color);
    const bg = bgOf(el);
    if (!fg || !bg) continue;
    const op = Number(cs.opacity);
    const f2 = blend({ ...fg, a: fg.a * (op || 1) }, bg);
    const L1 = lum(f2);
    const L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = fs >= 24 || (fs >= 18.66 && parseInt(cs.fontWeight, 10) >= 700);
    const need = large ? 3 : 4.5;
    const disabled = el.closest(':disabled, [disabled]');
    if (ratio < need && !disabled) lowContrast.set(sel(el), ratio.toFixed(2));
  }
  if (smallText.size) problems.push(`text < 11px: ${[...smallText].slice(0, 5).join('; ')}`);
  if (lowContrast.size) problems.push(`contrast < 4.5: ${[...lowContrast].slice(0, 5).map(([k, v]) => `${k} ${v}`).join('; ')}`);

  /* 6. images / canvases / svg */
  const media = [];
  document.querySelectorAll('canvas, img, svg, iframe, video').forEach((el) => {
    if (!visible(el)) return;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) media.push(`${sel(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
    if (el.tagName === 'CANVAS') {
      if (r.height > vh * 0.9 && vw > vh) media.push(`${sel(el)} taller (${Math.round(r.height)}) than 90% of the landscape viewport`);
      if (el.width === 300 && el.height === 150) return; // never drawn (no data in this state)
      if (r.height < 150) media.push(`${sel(el)} too short (${Math.round(r.height)}px)`);
      const dpr = window.devicePixelRatio || 1;
      if (Math.abs(el.width - Math.round(r.width * dpr)) > 2) media.push(`${sel(el)} blurry: backing ${el.width}px vs ${Math.round(r.width * dpr)}px expected`);
    }
  });
  if (media.length) problems.push(`media: ${media.slice(0, 4).join('; ')}`);

  /* 7. dialogs / toasts / header */
  const modal = document.querySelector('.modal');
  if (modal && visible(modal)) {
    const r = modal.getBoundingClientRect();
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--kb')) || 0;
    if (r.left < -1 || r.right > vw + 1 || r.top < -1 || r.bottom > vh - kb + 1) problems.push(`modal outside viewport [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.right)},${Math.round(r.bottom)}] vs ${vw}x${vh}`);
    const bs = [...modal.querySelectorAll('button')].filter(visible);
    if (bs.some((b) => b.getBoundingClientRect().bottom > vh + 1)) problems.push('modal buttons pushed below the viewport');
  }
  document.querySelectorAll('.toast').forEach((t) => {
    if (!visible(t)) return;
    const r = t.getBoundingClientRect();
    if (r.left < -1 || r.right > vw + 1 || r.bottom > vh + 1) problems.push(`toast outside viewport [${Math.round(r.left)}..${Math.round(r.right)}, bottom ${Math.round(r.bottom)}]`);
    const nav = document.getElementById('main-nav');
    if (nav && style(nav).position === 'fixed') {
      const nr = nav.getBoundingClientRect();
      if (r.bottom > nr.top + 1) problems.push('toast overlaps the bottom tab bar');
    }
  });
  const head = document.querySelector('.topnav');
  if (head && visible(head) && !opts.skipHeader) {
    const hh = head.getBoundingClientRect().height;
    const max = vw > vh ? 60 : 72;
    if (vw <= 900 && hh > max + (opts.insetTop || 0)) problems.push(`header too tall: ${Math.round(hh)}px`);
    if (vw <= 900 && style(head).position !== 'sticky') problems.push('header is not sticky');
  }
  return problems;
}

/* ---------------- harness ---------------- */
async function newContext(browser, vp, extra = {}) {
  const ctx = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    deviceScaleFactor: vp.dpr,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILE_UA,
    baseURL: BASE,
    serviceWorkers: 'block',
    ...extra,
  });
  await ctx.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  return ctx;
}

async function newPage(ctx, vp, { expectErrors = false } = {}) {
  const page = await ctx.newPage();
  page.__errs = [];
  page.__expectErrors = expectErrors;
  page.on('pageerror', (e) => page.__errs.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const t = m.text();
    if (/Content Security Policy|Refused to/i.test(t)) page.__errs.push(`CSP: ${t.slice(0, 160)}`);
    else if (/Failed to load resource/i.test(t)) {
      const loc = m.location()?.url || '';
      if (loc.startsWith(BASE) && !page.__expectErrors) page.__errs.push(`console: ${t.slice(0, 160)} ${loc.replace(BASE, '')}`);
    } else if (!/Autofocus|DevTools|preload/i.test(t)) page.__errs.push(`console ${m.type()}: ${t.slice(0, 200)}`);
  });
  // third-party requests (fonts, tradingview) are not reachable in the sandbox: fail them quietly
  await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
  return page;
}

async function applySafeArea(ctx, page, vp) {
  try {
    const cdp = await ctx.newCDPSession(page);
    const land = isLandscape(vp);
    const insets = land ? { top: 0, bottom: 21, left: 47, right: 47 } : { top: 47, bottom: 34, left: 0, right: 0 };
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
    page.__insets = insets;
  } catch {
    page.__insets = null;
  }
}

let shotIndex = 0;
async function shot(page, vp, name, opts = {}) {
  if (!SHOTS) return;
  const dir = path.join(OUT, vp.name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(++shotIndex).padStart(3, '0')}-${name}.png`);
  try {
    await page.screenshot({ path: file, fullPage: !!opts.full });
  } catch (e) {
    if (VERBOSE) console.log('screenshot failed', e.message);
  }
}

/** Run all assertions for the current state of the page. */
async function check(page, vp, scenario, opts = {}) {
  current = { vp: vp.name, scenario, fails: [], checks: 0 };
  results.push(current);
  await page.waitForTimeout(opts.wait ?? 250);
  let problems = [];
  try {
    problems = await page.evaluate(pageAudit, { modalOpen: !!opts.modalOpen, skipHeader: !!opts.skipHeader, insetTop: page.__insets?.top || 0 });
  } catch (e) {
    problems = [`audit crashed: ${e.message}`];
  }
  problems.forEach((p) => fail(p));
  const csp = await page.evaluate(() => window.__csp || []).catch(() => []);
  if (csp.length) fail(`CSP violation: ${csp.join(', ')}`);
  if (page.__errs.length) {
    page.__errs.splice(0).forEach((e) => fail(e));
  }
  current.checks = 8;
  if (opts.extra) {
    try {
      const more = await opts.extra(page);
      (more || []).forEach((m) => fail(m));
    } catch (e) {
      fail(`extra check crashed: ${e.message}`);
    }
  }
  if (opts.shot !== false) await shot(page, vp, scenario, { full: opts.full });
  if (VERBOSE || current.fails.length) console.log(`  ${current.fails.length ? 'FAIL' : 'ok  '} ${vp.name} ${scenario}${current.fails.length ? `\n      - ${current.fails.join('\n      - ')}` : ''}`);
  return current;
}

async function step(vp, scenario, fn) {
  try {
    await fn();
  } catch (e) {
    current = { vp: vp.name, scenario, fails: [`scenario crashed: ${e.message.split('\n')[0]}`], checks: 0 };
    results.push(current);
    console.log(`  FAIL ${vp.name} ${scenario}: ${e.message.split('\n')[0]}`);
  }
}

/* ---------------- API stubs ---------------- */
const EMPTY_POS = { account: { startingEquity: 100000, realizedPnl: 0, unrealizedPnl: 0, equity: 100000, cash: 100000, allocated: 0, openCount: 0, closedCount: 0, wins: 0 }, open: [], closed: [] };
const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function stubEmpty(page) {
  await page.route('**/api/positions', (r) => (r.request().method() === 'GET' ? json(r, EMPTY_POS) : r.continue()));
  await page.route('**/api/ai/picks', (r) => json(r, { picks: [], updatedAt: null }));
  await page.route('**/api/ai/summary', (r) => json(r, {}));
  await page.route('**/api/runs*', (r) => json(r, { runs: [] }));
  await page.route('**/api/performance', (r) => json(r, { equityCurve: [{ t: new Date().toISOString(), equity: 100000 }], winRate: null, closed: 0, wins: 0, avgR: null, maxDrawdownPct: 0, realizedPnl: 0, calibration: [], pickAccuracy: { hits: 0, total: 0 }, byBot: { ai: { closed: 0, winRate: null, pnl: 0 }, rules: { closed: 0, winRate: null, pnl: 0 } } }));
}

/** Extreme data: 20 positions, 12-digit prices, 300-char reasons, long symbols, long email. */
async function stubExtreme(page) {
  const reason = 'AI says: ' + 'momentum is strong and volume confirms the breakout above resistance while the sector rotates into risk assets; '.repeat(3).slice(0, 291);
  const mk = (i) => {
    const long = i % 2 === 0;
    const entry = i === 0 ? 123456789012.34 : 100 + i * 37.123456;
    return {
      id: `pos_x${i}`, status: 'open', openedAt: new Date(Date.now() - 3600e3).toISOString(), expiresAt: new Date(Date.now() + 20e3 * 3600).toISOString(),
      symbol: i === 1 ? 'BERKSHIREHATHAWAY.B/USDT' : i === 0 ? 'BTC/USD' : `SYM${i}`, side: long ? 'long' : 'short', entry, stopLoss: entry * (long ? 0.97 : 1.03), takeProfit: entry * (long ? 1.06 : 0.94),
      allocation: 1234567.89, qty: 10, confidence: 0.91, reason, source: 'ai', price: entry * 1.004, pnl: i === 0 ? -98765432.1 : 123.45 * i, pnlPct: 1.2345, stale: false, expired: false,
    };
  };
  const open = Array.from({ length: 20 }, (_, i) => mk(i));
  const closed = Array.from({ length: 6 }, (_, i) => ({ ...mk(i), status: 'closed', closedAt: new Date().toISOString(), exitPrice: 99.5 + i, exitReason: ['stop-loss', 'take-profit', 'time-exit', 'manual', 'trailing-stop', 'stop-loss'][i], id: `pos_c${i}` }));
  await page.route('**/api/positions', (r) => (r.request().method() === 'GET' ? json(r, { account: { ...EMPTY_POS.account, equity: 987654321012, cash: 123456789012, openCount: 20, closedCount: 6, wins: 3, realizedPnl: -1234567.89, unrealizedPnl: 98765.43 }, open, closed }) : r.continue()));
  await page.route('**/api/ai/picks', (r) => json(r, { picks: Array.from({ length: 30 }, (_, i) => ({ symbol: i === 3 ? 'SUPERCALIFRAGILISTIC/USDT' : `S${i}`, direction: i % 2 ? 'short' : 'long', confidence: 0.55 + (i % 40) / 100, reason, price: 100 + i, atrPct: 1.2 })), source: 'ai', model: 'openai/some-really-long-model-name-with-suffix:extended', updatedAt: new Date().toISOString() }));
  await page.route('**/api/ai/summary', (r) => json(r, { runId: 'r1', at: new Date().toISOString(), picks: 30, scannerSource: 'ai', scannerModel: 'openai/some-really-long-model-name-with-suffix:extended', traderSource: 'ai', traderModel: 'anthropic/claude-with-a-really-long-name-v3.5-sonnet-20251022', note: reason, rejected: ['AAAA (cap)', 'BBBB (cap)', 'CCCC (exposure cap)'], trades: open.slice(0, 5).map((p) => ({ symbol: p.symbol, side: p.side, allocation: 12345678, reason })) }));
  await page.route('**/api/runs*', (r) => json(r, { runs: Array.from({ length: 6 }, (_, i) => ({ runId: `r${i}`, at: new Date(Date.now() - i * 3600e3).toISOString(), picks: 92, traderSource: 'ai', traderModel: 'anthropic/claude-with-a-really-long-name-v3.5-sonnet-20251022', trades: open.slice(0, 7).map((p) => ({ symbol: p.symbol })), note: reason })) }));
  await page.route('**/api/auth/status', async (r) => {
    const res = await r.fetch();
    const b = await res.json();
    if (b.user) b.user.email = LONG_EMAIL;
    await r.fulfill({ response: res, json: b });
  });
  await page.route('**/api/logs*', (r) => json(r, { logs: Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, ts: new Date(Date.now() - i * 1000).toISOString(), level: ['info', 'warn', 'error'][i % 3], message: `Something happened with ${'averyveryveryverylongtokenwithoutspaces'.repeat(3)} ${i % 2 ? reason : 'short'}` })) }));
}

/* ---------------- flows ---------------- */
async function waitLoaded(page) {
  await page.waitForFunction(() => document.querySelector('#view-root .page') && !document.querySelector('#view-root .skeleton'), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
}
async function go(page, hash) {
  await page.evaluate((h) => {
    location.hash = h;
  }, hash);
  await waitLoaded(page);
  await page.evaluate(() => window.scrollTo(0, 0));
}
async function openMenu(page) {
  await page.click('#btn-menu');
  await page.waitForTimeout(350);
}
async function closeMenu(page) {
  if (await page.evaluate(() => document.documentElement.classList.contains('menu-open'))) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
  }
}
async function scrollToEl(page, selector) {
  await page.evaluate((s) => {
    const e = document.querySelector(s);
    if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 70);
  }, selector);
  await page.waitForTimeout(200);
}

/** The create-account screen: shown at boot when the server enforces setup, else opened from the header button. */
async function openCreate(page) {
  await page.goto('/');
  if (await page.waitForSelector('#f-signup', { timeout: 3500 }).catch(() => null)) return;
  await page.waitForSelector('#btn-auth:not([hidden]), #btn-menu', { timeout: 10000 });
  if (await page.locator('#btn-menu').isVisible()) await page.click('#btn-menu');
  await page.waitForTimeout(350);
  await page.click('#btn-auth');
  await page.waitForSelector('#f-signup', { timeout: 8000 });
}

/* ---------------- main ---------------- */
async function main() {
  console.log(`Mobile audit  base=${BASE}  out=${SHOTS ? OUT : '(no screenshots)'}  viewports=${VPS.map((v) => v.name).join(',')}`);
  const exe = process.env.PW_CHROMIUM || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });

  let status;
  try {
    status = await (await fetch(`${BASE}/api/auth/status`)).json();
  } catch (e) {
    console.error(`Cannot reach ${BASE}: ${e.message}`);
    process.exit(2);
  }
  const needsCode = status.setupRequired && status.signupNeedsCode;
  let haveAccount = !status.setupRequired;

  /* Phase A: create-account screen (only possible while no account exists) */
  for (const vp of VPS) {
    await step(vp, 'auth-create-account', async () => {
      if (!status.setupRequired || haveAccount || needsCode) {
        current = { vp: vp.name, scenario: 'auth-create-account', fails: [], checks: 0, skipped: needsCode ? 'needs setup code' : 'account exists' };
        results.push(current);
        return;
      }
      const ctx = await newContext(browser, vp);
      const page = await newPage(ctx, vp);
      await applySafeArea(ctx, page, vp);
      await openCreate(page);
      await check(page, vp, 'auth-create-account', { skipHeader: true });
      // error + strength states
      await page.fill('#su-email', LONG_EMAIL);
      await page.fill('#su-pw', 'password1');
      await page.fill('#su-pw2', 'nope');
      await page.click('#f-signup .auth-submit');
      await page.waitForTimeout(200);
      await check(page, vp, 'auth-create-account-errors', { skipHeader: true });
      // keyboard-safe: focused field remains visible
      await page.focus('#su-pw2');
      await page.waitForTimeout(500);
      const vis = await page.evaluate(() => {
        const r = document.activeElement.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= window.innerHeight;
      });
      if (!vis) fail('focused field is outside the viewport');
      await ctx.close();
    });
  }
  if (status.setupRequired && !needsCode && !haveAccount) {
    // create the real account through the UI once (also exercises the submit flow)
    const vp = VPS[0];
    const ctx = await newContext(browser, vp);
    const page = await newPage(ctx, vp);
    await openCreate(page);
    await page.fill('#su-email', EMAIL);
    await page.fill('#su-pw', PASSWORD);
    await page.fill('#su-pw2', PASSWORD);
    await page.click('#f-signup .auth-submit');
    await page.waitForSelector('#view-root .page', { timeout: 15000 }).catch(() => {});
    haveAccount = true;
    await ctx.storageState({ path: path.join(os.tmpdir(), 'mobile-audit-state.json') });
    await ctx.close();
  }
  if (!haveAccount) {
    console.error('No account and signup needs a code: set AUDIT_EMAIL/AUDIT_PASSWORD for an existing account or run with an empty data dir.');
    process.exit(2);
  }
  // session for the signed-in phases
  const sctx = await browser.newContext({ baseURL: BASE });
  const lr = await sctx.request.post('/api/auth/login', { data: { email: EMAIL, password: PASSWORD } });
  if (!lr.ok()) {
    console.error(`Login as ${EMAIL} failed (${lr.status()}). Set AUDIT_EMAIL / AUDIT_PASSWORD, or delete data/*.json and restart the server.`);
    process.exit(2);
  }
  const storage = await sctx.storageState();
  await sctx.close();

  /* Phase B: sign-in screen */
  for (const vp of VPS) {
    await step(vp, 'auth-signin', async () => {
      const ctx = await newContext(browser, vp);
      const page = await newPage(ctx, vp, { expectErrors: true });
      await applySafeArea(ctx, page, vp);
      await page.goto('/');
      const shown = await page.waitForSelector('#f-signin', { timeout: 6000 }).catch(() => null);
      if (!shown) {
        current = { vp: vp.name, scenario: 'auth-signin', fails: [], checks: 0, skipped: 'server does not require login' };
        results.push(current);
        await ctx.close();
        return;
      }
      await check(page, vp, 'auth-signin', { skipHeader: true });
      await page.fill('#si-email', LONG_EMAIL);
      await page.fill('#si-pw', 'wrong-password-123');
      await page.click('#f-signin .auth-submit');
      await page.waitForSelector('#auth-msg:not(:empty)', { timeout: 8000 }).catch(() => {});
      await check(page, vp, 'auth-signin-error', { skipHeader: true });
      await page.click('.pw-toggle');
      await ctx.close();
    });
  }

  /* Phase C: signed-in pages */
  let ranOnce = false;
  for (const vp of VPS) {
    console.log(`\n== ${vp.name} (${vp.note}, dpr ${vp.dpr}) ==`);
    const ctx = await newContext(browser, vp, { storageState: storage });
    const page = await newPage(ctx, vp);
    await applySafeArea(ctx, page, vp);
    const land = isLandscape(vp);
    const phoneNav = vp.w <= 900;

    /* dashboard: empty state (stubbed, so every viewport sees it) */
    await step(vp, 'dashboard-empty', async () => {
      const p2 = await newPage(ctx, vp);
      await applySafeArea(ctx, p2, vp);
      await stubEmpty(p2);
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await check(p2, vp, 'dashboard-empty');
      await p2.close();
    });

    /* real RUN once (first viewport), else state already on the server */
    await step(vp, 'dashboard-after-run', async () => {
      await page.goto('/#dashboard');
      await waitLoaded(page);
      if (!ranOnce) {
        const open = await page.evaluate(() => document.querySelectorAll('#pos-open [data-pos]').length);
        if (!open) {
          await page.click('#btn-scan');
          await page.waitForFunction(() => document.querySelectorAll('#pos-open [data-pos]').length > 0, null, { timeout: 30000 }).catch(() => {});
        }
        ranOnce = true;
      }
      await waitLoaded(page);
      await check(page, vp, 'dashboard-after-run');
      await scrollToEl(page, '#pos-open');
      await check(page, vp, 'positions-cards', {
        extra: async (pg) => {
          const n = await pg.evaluate(() => document.querySelectorAll('#pos-open [data-pos]').length);
          return n >= 1 ? [] : ['no positions rendered after the run'];
        },
      });
      await scrollToEl(page, '#pos-chart-box');
      await check(page, vp, 'position-chart', {
        extra: async (pg) => {
          const ta = await pg.evaluate(() => getComputedStyle(document.getElementById('pos-chart')).touchAction);
          const out = [];
          if (!/pan-y/.test(ta)) out.push(`chart touch-action is "${ta}" (needs pan-y so vertical scroll works)`);
          return out;
        },
      });
      // touch scrub on the chart draws a tooltip and does not throw
      const box = await page.locator('#pos-chart').boundingBox();
      if (box) {
        await page.touchscreen.tap(box.x + box.width * 0.5, box.y + box.height * 0.5);
        await page.waitForTimeout(200);
        await check(page, vp, 'position-chart-touch');
      }
      // sort control
      const sortVisible = await page.locator('#pos-sort').isVisible().catch(() => false);
      if (phoneNav && !sortVisible) fail('compact sort control (#pos-sort) is not visible on phones');
      if (sortVisible) {
        await page.selectOption('#pos-sort', 'symbol');
        await page.waitForTimeout(200);
      }
      await scrollToEl(page, '#w-picks');
      await check(page, vp, 'picks-cards');
      await scrollToEl(page, '#h-perf');
      await check(page, vp, 'dashboard-performance-widget');
    });

    /* mid-run stepper + errors + banners (stubbed) */
    await step(vp, 'run-stepper', async () => {
      const p2 = await newPage(ctx, vp);
      await applySafeArea(ctx, p2, vp);
      await p2.route('**/api/run/status', (r) => json(r, { running: true, stage: 'scanning', runId: 'r', startedAt: new Date(Date.now() - 42e3).toISOString(), finishedAt: null, error: null, picks: 0, opened: 0 }));
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await p2.waitForSelector('.stepper', { timeout: 8000 });
      await check(p2, vp, 'run-stepper-midrun', {
        extra: async (pg) => {
          const r = await pg.evaluate(() => [...document.querySelectorAll('.step')].map((s) => { const b = s.getBoundingClientRect(); return [b.left, b.right]; }));
          return r.length === 3 && r.every(([l, rr]) => l >= 0 && rr <= vp.w) ? [] : ['not all 3 steps visible'];
        },
      });
      await p2.unroute('**/api/run/status');
      await p2.route('**/api/run/status', (r) => json(r, { running: false, stage: 'error', runId: 'r', startedAt: new Date(Date.now() - 42e3).toISOString(), finishedAt: new Date().toISOString(), error: 'OpenRouter request failed: 402 Payment Required — insufficient credits for model anthropic/claude-with-a-really-long-name-v3.5-sonnet-20251022 (' + 'x'.repeat(80) + ')', picks: 0, opened: 0 }));
      await p2.reload();
      await waitLoaded(p2);
      await p2.waitForSelector('.stepper', { timeout: 8000 });
      await check(p2, vp, 'run-stepper-error');
      await p2.close();
    });

    await step(vp, 'banners', async () => {
      const p2 = await newPage(ctx, vp, { expectErrors: true });
      await applySafeArea(ctx, p2, vp);
      await p2.route('**/api/status', async (r) => {
        const res = await r.fetch();
        const b = await res.json();
        Object.assign(b, { marketOpen: false, staleSymbols: ['AAPL', 'MSFT', 'BTC/USD'], mockData: true, openrouterConfigured: false, fallbacks: { count: 2, symbols: [{ symbol: 'TSLA', error: 'x' }, { symbol: 'NVDA', error: 'y' }] } });
        await r.fulfill({ response: res, json: b });
      });
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await check(p2, vp, 'banners-mock-stale-closed');
      await p2.close();
      const p3 = await newPage(ctx, vp, { expectErrors: true });
      await applySafeArea(ctx, p3, vp);
      await p3.route('**/api/status', (r) => r.abort());
      await p3.goto('/#dashboard');
      await p3.waitForSelector('#banners .notice', { timeout: 10000 }).catch(() => {});
      await check(p3, vp, 'banner-network-error');
      await p3.close();
    });

    /* other pages */
    await step(vp, 'performance', async () => {
      await go(page, 'performance');
      await check(page, vp, 'performance');
      await scrollToEl(page, '#runs');
      await check(page, vp, 'performance-run-history');
    });
    await step(vp, 'market', async () => {
      await go(page, 'market');
      await page.waitForTimeout(700);
      await check(page, vp, 'market', {
        extra: async (pg) => {
          const ta = await pg.evaluate(() => getComputedStyle(document.getElementById('mini-chart')).touchAction);
          return /pan-y/.test(ta) ? [] : [`market chart touch-action "${ta}"`];
        },
      });
      await page.click('#tf-market [data-tf="4H"]');
      await page.click('.ind-toggle[data-ind="vol"]');
      await page.click('.ind-toggle[data-ind="vol"]');
      await page.waitForTimeout(300);
      await check(page, vp, 'market-4h');
      await scrollToEl(page, '#h-watch');
      await check(page, vp, 'market-watchlist');
    });
    await step(vp, 'logs', async () => {
      await go(page, 'logs');
      await check(page, vp, 'logs');
    });
    await step(vp, 'settings', async () => {
      await go(page, 'settings');
      await page.waitForSelector('.acct-card, #account-root .widget', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(500);
      await check(page, vp, 'settings');
      await scrollToEl(page, '.acct-card');
      await check(page, vp, 'settings-account');
      await scrollToEl(page, '.keys-card');
      await check(page, vp, 'settings-api-keys');
      await scrollToEl(page, '.models-card');
      await check(page, vp, 'settings-models');
      // field focus keeps the input visible
      const f = page.locator('#m-scan');
      if (await f.count()) {
        await f.tap();
        await page.waitForTimeout(600);
        const ok = await page.evaluate(() => {
          const r = document.activeElement.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= innerHeight;
        });
        if (!ok) fail('focused Models input is not scrolled into view');
        await check(page, vp, 'settings-models-focused');
        await page.evaluate(() => document.activeElement.blur());
      }
    });

    /* header menu + dialogs + toasts */
    await step(vp, 'menu-and-dialogs', async () => {
      await go(page, 'dashboard');
      if (phoneNav) {
        await openMenu(page);
        await check(page, vp, 'header-menu-open', { skipHeader: true });
        // kill -> confirm dialog (thumb-friendly sheet)
        await page.click('#btn-kill');
        await page.waitForSelector('.modal');
        await check(page, vp, 'dialog-confirm-kill', { modalOpen: true, skipHeader: true });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
        const focusBack = await page.evaluate(() => !!document.activeElement && document.activeElement !== document.body);
        if (!focusBack) fail('focus was lost after closing a dialog opened from the menu');
        await closeMenu(page);
      } else {
        await page.click('#btn-kill');
        await page.waitForSelector('.modal');
        await check(page, vp, 'dialog-confirm-kill', { modalOpen: true });
        await page.keyboard.press('Escape');
      }
      // close position -> confirm; stale -> second dialog
      const p2 = await newPage(ctx, vp, { expectErrors: true });
      await applySafeArea(ctx, p2, vp);
      await p2.route(/\/api\/positions\/[^/]+\/close/, (r) => (r.request().url().includes('force=1') ? json(r, { error: 'nope', code: 'x' }, 500) : json(r, { error: 'The latest quote for AMD is 42 minutes old — it is stale and closing now would use an out-of-date price.', stale: true }, 409)));
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await scrollToEl(p2, '#pos-open');
      await p2.locator('#pos-open .btn-close').first().tap();
      await p2.waitForSelector('.modal');
      await check(p2, vp, 'dialog-confirm-close', { modalOpen: true });
      await p2.locator('.modal [data-act="ok"]').tap();
      await p2.waitForFunction(() => document.querySelector('.modal h2')?.textContent.includes('Stale'), null, { timeout: 8000 }).catch(() => {});
      await check(p2, vp, 'dialog-stale-close', { modalOpen: true });
      await p2.keyboard.press('Escape');
      await p2.waitForTimeout(300);
      await check(p2, vp, 'toast-after-cancel');
      // token dialog (with keyboard-safe input) + every toast kind, incl. a long one
      await p2.evaluate(async () => {
        const ui = await import('/js/ui.js');
        window.__tok = ui.tokenDialog('The saved admin token was rejected. Enter the correct token. ' + 'It is a long explanation. '.repeat(6));
      });
      await p2.waitForSelector('.modal input');
      await p2.waitForTimeout(400);
      await check(p2, vp, 'dialog-token', { modalOpen: true });
      await p2.keyboard.press('Escape');
      await p2.evaluate(async () => {
        const ui = await import('/js/ui.js');
        ui.toast('Run failed: OpenRouter request failed: 402 Payment Required — insufficient credits for model anthropic/claude-with-a-really-long-name-v3.5-sonnet ' + 'x'.repeat(60), 'error', 0);
        ui.toast('Closed AMD — P&L +$123.45', 'success', 0);
        ui.toast('Settings saved', 'info', 0);
      });
      await check(p2, vp, 'toasts');
      await p2.close();
    });

    /* extremes + zoom */
    await step(vp, 'extremes', async () => {
      const p2 = await newPage(ctx, vp);
      await applySafeArea(ctx, p2, vp);
      await stubExtreme(p2);
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await check(p2, vp, 'extreme-dashboard');
      await scrollToEl(p2, '#pos-open');
      await check(p2, vp, 'extreme-positions');
      await p2.locator('#tab-closed').tap();
      await p2.waitForTimeout(200);
      await scrollToEl(p2, '#tab-closed');
      await check(p2, vp, 'closed-trades-tab');
      await go(p2, 'performance');
      await check(p2, vp, 'extreme-performance');
      await go(p2, 'logs');
      await check(p2, vp, 'extreme-logs');
      await go(p2, 'settings');
      await p2.waitForTimeout(400);
      await check(p2, vp, 'extreme-settings');
      await p2.close();
    });

    /* 401 lock screen */
    await step(vp, '401-lock', async () => {
      const p2 = await newPage(ctx, vp, { expectErrors: true });
      await applySafeArea(ctx, p2, vp);
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await p2.route('**/api/status', (r) => json(r, { error: 'login required', code: 'login_required' }, 401));
      await p2.evaluate(async () => {
        const d = await import('/js/data.js');
        await d.refresh().catch(() => {});
      });
      await p2.waitForSelector('#f-signin', { timeout: 8000 }).catch(() => {});
      await check(p2, vp, '401-lock-screen', { skipHeader: true });
      await p2.close();
    });

    /* 200% zoom: the same layouts at half the CSS width */
    await step(vp, 'zoom-200', async () => {
      if (vp.w > 500) return;
      const p2 = await newPage(ctx, vp);
      await p2.setViewportSize({ width: Math.round(vp.w / 2), height: Math.round(vp.h / 2) });
      await p2.goto('/#dashboard');
      await waitLoaded(p2);
      await check(p2, vp, 'zoom200-dashboard', { skipHeader: true });
      await go(p2, 'settings');
      await p2.waitForTimeout(400);
      await check(p2, vp, 'zoom200-settings', { skipHeader: true });
      await p2.close();
    });

    // safe-area sanity: header content stays clear of the notch in landscape, tab bar clear of the home indicator
    await step(vp, 'safe-area', async () => {
      if (!page.__insets) return;
      await go(page, 'dashboard');
      const res = await page.evaluate((ins) => {
        const out = [];
        const b = document.querySelector('.brand').getBoundingClientRect();
        if (b.left < ins.left - 0.5) out.push(`brand at x=${Math.round(b.left)} is inside the left inset ${ins.left}`);
        const pg = document.querySelector('.page').getBoundingClientRect();
        if (pg.left + parseFloat(getComputedStyle(document.querySelector('.page')).paddingLeft) < ins.left - 0.5) out.push('page content inside left inset');
        const nav = document.getElementById('main-nav');
        if (getComputedStyle(nav).position === 'fixed') {
          const a = nav.querySelector('a').getBoundingClientRect();
          if (innerHeight - a.bottom < ins.bottom - 1) out.push(`tab bar labels sit inside the ${ins.bottom}px bottom inset`);
        }
        const h = document.querySelector('.topnav').getBoundingClientRect();
        if (ins.top && h.height < ins.top + 40) out.push('header does not add the top inset');
        return out;
      }, page.__insets);
      current = { vp: vp.name, scenario: 'safe-area-insets', fails: res, checks: 4 };
      results.push(current);
      if (res.length) console.log(`  FAIL ${vp.name} safe-area-insets\n      - ${res.join('\n      - ')}`);
    });

    // dashboard at the end: closed-trades tab with a real closed trade (close one through the UI)
    await step(vp, 'closed-real', async () => {
      await go(page, 'dashboard');
      if (!(await page.locator('#pos-open .btn-close').count())) return;
      await scrollToEl(page, '#pos-open');
      await page.locator('#pos-open .btn-close').first().tap();
      await page.waitForSelector('.modal');
      await page.locator('.modal [data-act="ok"]').tap();
      await page.waitForTimeout(1200);
      await page.locator('#tab-closed').tap();
      await page.waitForTimeout(300);
      await scrollToEl(page, '#tab-closed');
      await check(page, vp, 'closed-trades-real');
    });

    await ctx.close();
  }

  await browser.close();
  report();
}

function report() {
  const by = new Map();
  results.forEach((r) => {
    if (!by.has(r.vp)) by.set(r.vp, { pass: 0, fail: 0, skip: 0, failed: [] });
    const b = by.get(r.vp);
    if (r.skipped) b.skip++;
    else if (r.fails.length) {
      b.fail++;
      b.failed.push(r.scenario);
    } else b.pass++;
  });
  console.log('\n===================== MOBILE AUDIT =====================');
  console.log('viewport    | states | PASS | FAIL | SKIP | verdict');
  console.log('------------|--------|------|------|------|--------');
  let bad = 0;
  by.forEach((b, vp) => {
    bad += b.fail;
    console.log(`${vp.padEnd(11)} | ${String(b.pass + b.fail + b.skip).padStart(6)} | ${String(b.pass).padStart(4)} | ${String(b.fail).padStart(4)} | ${String(b.skip).padStart(4)} | ${b.fail ? 'FAIL' : 'PASS'}${b.fail ? `  (${b.failed.slice(0, 4).join(', ')}${b.failed.length > 4 ? ', …' : ''})` : ''}`);
  });
  const skipped = results.filter((r) => r.skipped).map((r) => `${r.scenario}@${r.vp}: ${r.skipped}`);
  if (skipped.length && VERBOSE) console.log(`skipped: ${skipped.join('; ')}`);
  if (SHOTS) console.log(`screenshots: ${OUT}`);
  console.log(bad ? `\nRESULT: FAIL (${bad} failing states)` : '\nRESULT: PASS');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
