import { api, apiOptional } from './api.js';
import { setWorkerUI } from './chrome.js';
import { runTracking, trackRun } from './run.js';
import { state } from './state.js';

/* ---------- data ---------- */

export let refreshing = null;
export function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [status, dashboard, picks, positions, summary, perf, proposals, budget, schedule, research] = await Promise.all([
        api('/status'),
        apiOptional('/dashboard'),
        apiOptional('/ai/picks'),
        apiOptional('/positions'),
        apiOptional('/ai/summary'),
        apiOptional('/performance'),
        apiOptional('/proposals?status=pending&limit=50'),
        apiOptional('/budget'),
        apiOptional('/schedule'),
        apiOptional('/research/latest'),
      ]);
      Object.assign(state, { status, dashboard, picks, positions, summary, perf, proposals: proposals ?? state.proposals, budget: budget ?? state.budget, schedule: schedule ?? state.schedule, research: research ?? state.research, loaded: true, loadError: null, lastUpdate: new Date() });
      if (status.run) {
        state.run = { ...(state.run || {}), ...status.run };
        if (status.run.running && !runTracking) {
          if (state.runLocal == null) state.runLocal = false;
          trackRun();
        }
      }
      setWorkerUI(status.worker);
    } catch (e) {
      state.loadError = e.message;
      throw e;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
