import { escapeHtml as esc } from './api.js';
import { BADGES_SEEN_KEY, gamifySummary, newlyEarned, nextBadge, parseSeen, progressText, streakText } from './fun-logic.js';
import { $, empty, setHtml, skeleton, state } from './state.js';
import { toast } from './ui.js';

/* Streaks & badges widget + the "badge unlocked" toast. */

let seen; // undefined = not loaded yet; null = first visit; array = ids already announced
function loadSeen() {
  if (seen !== undefined) return seen;
  try {
    seen = parseSeen(localStorage.getItem(BADGES_SEEN_KEY));
  } catch {
    seen = null; // storage unavailable: announce nothing now, remember in memory only
  }
  return seen;
}
function saveSeen(ids) {
  seen = ids;
  try {
    localStorage.setItem(BADGES_SEEN_KEY, JSON.stringify(ids));
  } catch {
    /* in-memory only */
  }
}

/** Toast for badges earned since last time (never on the very first visit: that just records what is already earned). */
export function announceBadges() {
  const g = state.gamify;
  if (!g?.badges) return [];
  const fresh = newlyEarned(loadSeen(), g.badges);
  const earned = g.badges.filter((b) => b.earned).map((b) => b.id);
  const had = loadSeen();
  if (had === null || fresh.length || earned.length !== had.length) saveSeen(earned);
  for (const b of fresh.slice(0, 3)) toast(`🏆 Badge unlocked: ${b.emoji} ${b.name}. ${b.desc}.`, 'success', 9000);
  if (fresh.length > 3) toast(`🏆 …and ${fresh.length - 3} more badges unlocked. See Achievements on the dashboard.`, 'success', 9000);
  return fresh;
}

function dots(calls) {
  if (!calls?.length) return '<p class="dim gm-note">A good call is approving a winner or rejecting a loser. The app judges each decision after the trade or what-if ends.</p>';
  return `<ul class="gm-dots" aria-label="Your last ${calls.length} judged decisions, oldest first">${calls
    .map((c) => `<li class="gm-dot ${c.good ? 'gm-good' : 'gm-bad'}" title="${esc(`${c.kind === 'approved' ? 'Approved' : 'Rejected'} ${c.symbol}: ${c.good ? 'good call' : 'bad call'}`)}"><span aria-hidden="true">${c.good ? '✓' : '✗'}</span><span class="sr-only">${esc(`${c.kind} ${c.symbol}, ${c.good ? 'good call' : 'bad call'}`)}</span></li>`)
    .join('')}</ul>`;
}

export function gamifyHtml() {
  if (!state.loaded) return skeleton(3);
  const g = state.gamify;
  if (!g) return empty('No achievement data yet.');
  const w = g.streaks.win;
  const c = g.streaks.calls;
  const next = nextBadge(g.badges);
  const badge = (b) => {
    const label = b.earned ? `Earned: ${b.name}. ${b.desc}` : `Locked: ${b.name}. ${b.desc}. Progress ${progressText(b)}`;
    return `<li class="gm-badge ${b.earned ? 'is-earned' : 'is-locked'}" title="${esc(label)}" aria-label="${esc(label)}"><span class="gm-emoji" aria-hidden="true">${b.emoji}</span><span class="gm-name">${esc(b.name)}</span><small class="gm-prog">${b.earned ? 'Earned' : esc(progressText(b))}</small></li>`;
  };
  const sorted = [...g.badges].sort((a, b) => Number(b.earned) - Number(a.earned));
  return `<div class="gm-streaks">
      <div class="gm-streak"><span class="lbl">WIN STREAK</span><strong class="mono">🔥 ${w.current}</strong><small class="dim">${esc(streakText(w.current))} · best ${w.best}</small></div>
      <div class="gm-streak"><span class="lbl">GOOD CALLS</span><strong class="mono">🧠 ${c.current}</strong><small class="dim">${esc(streakText(c.current))} · best ${c.best} · ${c.judged} judged</small></div>
    </div>
    ${dots(g.recentCalls)}
    ${next ? `<div class="gm-next"><span class="lbl">NEXT UP</span> <strong>${next.emoji} ${esc(next.name)}</strong> <span class="dim">${esc(next.desc)}</span><div class="gm-bar" role="img" aria-label="${esc(`${next.name}: ${progressText(next)}`)}"><span style="width:${Math.round((next.progress.value / next.progress.target) * 100)}%"></span></div></div>` : '<div class="gm-next"><strong>🎉 Every badge earned. Legend.</strong></div>'}
    <ul class="gm-badges">${sorted.map(badge).join('')}</ul>`;
}

export function patchGamify() {
  setHtml($('w-gamify'), gamifyHtml());
  announceBadges();
}

export const gamifySectionSummary = () => gamifySummary(state.gamify);
