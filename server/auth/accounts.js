// Account-attached credentials: encrypted at rest on the OWNER account, applied to the runtime config.
import { applyCredentials, getAccountCredentials, getEnvDefaults, credentialSource, config } from '../config.js';
import { usersRepo } from '../db/users.js';
import { encryptValue, decryptValue, encryptionReady } from './crypto.js';
import { store } from '../db/store.js';
import { signupState } from './policy.js';
import { peekCatalog, FREE_MODEL_NOTES } from '../services/catalog.js';

const state = { unreadable: false };
const FIELDS = ['openrouterKey', 'alpacaKey', 'alpacaSecret', 'finnhubKey'];

/** Decrypt the owner's stored keys/models and make them the active credentials (env vars remain the fallback). */
export function applyOwnerCredentials() {
  const owner = usersRepo.owner();
  const next = { openrouterKey: '', alpacaKey: '', alpacaSecret: '', finnhubKey: '', scannerModel: '', traderModel: '', newsModel: '' };
  state.unreadable = false;
  if (owner) {
    next.scannerModel = owner.models?.scannerModel || '';
    next.traderModel = owner.models?.traderModel || '';
    next.newsModel = owner.models?.newsModel || '';
    for (const f of FIELDS) {
      const blob = owner.keys_enc?.[f];
      if (!blob) continue;
      try {
        next[f] = decryptValue(blob);
      } catch {
        state.unreadable = true;
      }
    }
    if (state.unreadable) {
      store.addLog({ level: 'warn', message: 'stored API keys could not be decrypted (APP_SECRET missing or changed): re-enter them under Settings → Account' });
    }
  }
  applyCredentials(next);
  return { unreadable: state.unreadable };
}

const last4 = (v) => (v ? String(v).slice(-4) : null);

export function accountSummary(user) {
  const owner = usersRepo.owner();
  const shown = user || owner;
  const c = config;
  const src = credentialSource();
  const defaults = getEnvDefaults();
  return {
    email: shown?.email ?? null,
    createdAt: shown?.created_at ?? null,
    keys: {
      openrouter: { set: src.openrouter !== 'none', source: src.openrouter, last4: last4(c.openrouter.key) },
      finnhub: { set: src.finnhub !== 'none', source: src.finnhub, last4: last4(c.finnhub.key) },
      alpaca: { set: src.alpaca !== 'none', source: src.alpaca, keyLast4: last4(c.alpaca.key), secretSet: Boolean(c.alpaca.secret) },
    },
    models: { scanner: c.openrouter.scannerModel, trader: c.openrouter.traderModel, news: c.openrouter.newsModel, defaults: { scanner: defaults.scannerModel, trader: defaults.traderModel, news: defaults.newsModel } },
    encryptionReady: encryptionReady(),
    signupOpen: signupState().policyOpen,
    ...(state.unreadable ? { keysUnreadable: true } : {}),
  };
}

const KEY_RE = /^[\x21-\x7e]{8,256}$/; // printable ASCII, no spaces/control characters

function cleanKey(name, v) {
  if (typeof v !== 'string') return { error: `${name} must be a string` };
  const t = v.trim();
  if (!KEY_RE.test(t)) return { error: `${name} must be 8-256 printable characters with no spaces or control characters` };
  return { value: t };
}

/** Body: {openrouterKey?, alpacaKey?, alpacaSecret?, finnhubKey?, clear?:['openrouter'|'alpaca'|'finnhub']}. Returns {error,status,code} or {ok}. */
export async function saveKeys(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'body must be a JSON object' };
  const owner = usersRepo.owner();
  if (!owner) return { status: 409, code: 'no_account', error: 'create an account first' };
  const clear = body.clear ?? [];
  if (!Array.isArray(clear) || clear.some((c) => c !== 'openrouter' && c !== 'alpaca' && c !== 'finnhub')) return { status: 400, error: "clear must be an array of 'openrouter', 'alpaca' and/or 'finnhub'" };
  const incoming = {};
  for (const f of FIELDS) {
    if (body[f] === undefined || body[f] === null || body[f] === '') continue;
    const r = cleanKey(f, body[f]);
    if (r.error) return { status: 400, error: r.error };
    incoming[f] = r.value;
  }
  const clearing = clear.length > 0;
  if (Object.keys(incoming).length && !encryptionReady()) {
    return { status: 409, code: 'encryption_not_configured', error: 'APP_SECRET is not configured on the server, so API keys cannot be stored. Set APP_SECRET (a long random string) and restart.' };
  }
  const cur = getAccountCredentials();
  const next = { openrouterKey: cur.openrouterKey, alpacaKey: cur.alpacaKey, alpacaSecret: cur.alpacaSecret, finnhubKey: cur.finnhubKey };
  if (clear.includes('openrouter')) next.openrouterKey = '';
  if (clear.includes('finnhub')) next.finnhubKey = '';
  if (clear.includes('alpaca')) Object.assign(next, { alpacaKey: '', alpacaSecret: '' });
  Object.assign(next, incoming);
  if (!Object.keys(incoming).length && !clearing) return { status: 400, error: 'nothing to save' };
  if (Boolean(next.alpacaKey) !== Boolean(next.alpacaSecret)) return { status: 400, error: 'alpacaKey and alpacaSecret must be saved together' };
  const keys_enc = {};
  for (const f of FIELDS) if (next[f]) keys_enc[f] = encryptValue(next[f]);
  await usersRepo.update(owner.id, { keys_enc: Object.keys(keys_enc).length ? keys_enc : null });
  state.unreadable = false;
  applyCredentials(next);
  store.addLog({ level: 'info', message: `account API keys updated (${[...Object.keys(incoming), ...clear.map((c) => `cleared ${c}`)].join(', ')})` });
  return { ok: true };
}

const MODEL_RE = /^[\w.\-:/]{1,100}$/;

/**
 * Body: {scannerModel?, traderModel?, newsModel?} ('' resets to the env default). Ids are validated by regex and, when the model
 * catalog is already loaded, against it: an unknown id is ALLOWED but reported in `warnings`. `notes` carry the free-model caveats.
 */
export async function saveModels(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'body must be a JSON object' };
  const owner = usersRepo.owner();
  if (!owner) return { status: 409, code: 'no_account', error: 'create an account first' };
  const models = { ...(owner.models || {}) };
  const warnings = [];
  const notes = [];
  const catalog = peekCatalog();
  for (const field of ['scannerModel', 'traderModel', 'newsModel']) {
    if (body[field] === undefined) continue;
    const v = typeof body[field] === 'string' ? body[field].trim() : null;
    if (v === null || (v !== '' && !MODEL_RE.test(v))) return { status: 400, error: `${field} must match [A-Za-z0-9_.-:/] (max 100 chars)` };
    if (v) {
      models[field] = v;
      if (catalog && !catalog.some((m) => m.id === v)) warnings.push(`${field}: "${v}" is not in the OpenRouter catalog (saved anyway; a run will fail with model_unavailable if it does not exist)`);
      if (!catalog) warnings.push(`${field}: the model catalog is not loaded, so "${v}" could not be checked (open the model picker / GET /api/models first)`);
      if (v.endsWith(':free') || catalog?.find((m) => m.id === v)?.isFree) notes.push(...FREE_MODEL_NOTES);
    } else delete models[field]; // empty = back to the env/default model
  }
  await usersRepo.update(owner.id, { models: Object.keys(models).length ? models : null });
  applyCredentials({ scannerModel: models.scannerModel || '', traderModel: models.traderModel || '', newsModel: models.newsModel || '' });
  store.addLog({ level: 'info', message: 'account model names updated' });
  return { ok: true, warnings, notes: [...new Set(notes)] };
}
