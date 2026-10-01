import { escapeHtml as esc, fmtDateTime } from './api.js';
import { ruler, shareLines, signedMoney } from './fun-logic.js';
import { $, empty, setHtml, skeleton, state } from './state.js';
import { toast } from './ui.js';

/* Trade of the week card + a share-as-image button (drawn on a canvas, so no server round trip and no data leaves the browser). */

export function totwHtml() {
  if (!state.loaded) return skeleton(3);
  const r = state.totw;
  if (!r) return empty('No data yet.');
  const t = r.trade;
  if (!t) return empty(r.candidates ? 'No winning closed trade in the last 7 days.' : 'No closed trades in the last 7 days.');
  const rl = ruler(t);
  const mark = (cls, at, label) => (at == null ? '' : `<span class="tw-mark ${cls}" style="left:${at}%" title="${esc(label)}"><span class="tw-tag">${esc(label)}</span></span>`);
  const long = t.side !== 'short';
  return `<article class="totw" aria-label="Trade of the week: ${esc(t.symbol)}">
    <div class="tw-head"><div class="tw-id"><span class="sym tw-sym">${esc(t.symbol)}</span><span class="pill pill-${long ? 'long' : 'short'}">${long ? 'long' : 'short'}</span>${t.source === 'demo' ? '<span class="badge-demo">DEMO DATA</span>' : ''}</div>
      <div class="tw-pnl"><strong class="mono pos">${esc(signedMoney(t.pnl, 2))}</strong><small class="mono pos">+${esc(Math.abs(t.pnlPct).toFixed(2))}%${t.r != null ? ` · ${esc(t.r.toFixed(1))}R` : ''}</small></div></div>
    ${rl ? `<div class="tw-ruler" role="img" aria-label="${esc(`Entry ${t.entry}, exit ${t.exitPrice}${t.stopLoss ? `, stop ${t.stopLoss}` : ''}${t.takeProfit ? `, target ${t.takeProfit}` : ''}`)}"><span class="tw-rail"></span>${mark('tw-stop', rl.stop, 'stop')}${mark('tw-entry', rl.entry, 'entry')}${mark('tw-target', rl.target, 'target')}${mark('tw-exit', rl.exit, 'exit')}</div>` : ''}
    <p class="tw-cap">${esc(t.caption)}</p>
    <div class="tw-foot"><span class="dim">Closed ${esc(fmtDateTime(t.closedAt))}</span><button type="button" class="btn-ghost" id="btn-share-totw">Share image</button></div>
  </article>`;
}

export function patchTotw() {
  setHtml($('w-totw'), totwHtml());
}

/** 1200x630 share card on a canvas. */
export function drawShareCard(t, canvas = document.createElement('canvas')) {
  const W = 1200;
  const H = 630;
  canvas.width = W;
  canvas.height = H;
  const c = canvas.getContext('2d');
  const L = shareLines(t);
  const font = (w, px) => `${w} ${px}px "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif`;
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0b0c0e');
  bg.addColorStop(1, '#10261a');
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);
  c.fillStyle = '#22c55e';
  c.fillRect(0, 0, 14, H);
  c.fillStyle = '#a9afba';
  c.font = font(600, 28);
  c.fillText('TRADE OF THE WEEK', 70, 90);
  c.fillStyle = '#e8eaed';
  c.font = font(700, 84);
  c.fillText(L.title, 70, 205);
  c.fillStyle = '#4ade80';
  c.font = `700 150px "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace`;
  c.fillText(L.big, 70, 400);
  c.fillStyle = '#e8eaed';
  c.font = font(500, 40);
  c.fillText(L.sub, 70, 470);
  c.fillStyle = '#a9afba';
  c.font = font(400, 34);
  c.fillText(L.levels, 70, 525);
  c.font = font(400, 24);
  c.fillStyle = '#8d94a1';
  c.fillText(L.footer, 70, 590);
  return canvas;
}

async function shareTotw() {
  const t = state.totw?.trade;
  if (!t) return;
  const btn = $('btn-share-totw');
  if (btn) btn.disabled = true;
  try {
    const canvas = drawShareCard(t);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('could not render the image');
    const file = new File([blob], `trade-of-the-week-${t.symbol.replace('/', '')}.png`, { type: 'image/png' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], text: t.caption });
        return;
      } catch (e) {
        if (e?.name === 'AbortError') return; // the owner closed the share sheet
        /* fall through to a download */
      }
    }
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Image saved to your downloads.', 'success');
  } catch (e) {
    toast(`Could not make the image: ${e.message}`, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export function bindTotw() {
  $('w-totw')?.addEventListener('click', (e) => {
    if (e.target.closest('#btn-share-totw')) shareTotw();
  });
}
