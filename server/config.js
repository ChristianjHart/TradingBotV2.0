import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

/** Env lookup tolerant of case (e.g. `OpenRouter_API_KEY` vs `OPENROUTER_API_KEY`). */
export function envAny(name) {
  if (process.env[name]) return process.env[name];
  const hit = Object.keys(process.env).find((k) => k.toUpperCase() === name.toUpperCase());
  return hit ? process.env[hit] : '';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// ---- Runtime credentials -------------------------------------------------------------------------------------
// Env values are the fallback; the account-attached keys (applyCredentials) override them at call time.
const envCred = {
  alpacaKey: process.env.ALPACA_API_KEY || '',
  alpacaSecret: process.env.ALPACA_API_SECRET || '',
  openrouterKey: envAny('OPENROUTER_API_KEY'),
  scannerModel: process.env.SCANNER_MODEL || 'deepseek/deepseek-v3.1-terminus',
  traderModel: process.env.TRADER_MODEL || 'deepseek/deepseek-chat-v3.1',
};
const acctCred = { alpacaKey: '', alpacaSecret: '', openrouterKey: '', scannerModel: '', traderModel: '' };
const credListeners = new Set();
let mockOverride = null; // test hook / explicit override; null = read USE_MOCK_DATA at call time

const acctAlpaca = () => Boolean(acctCred.alpacaKey && acctCred.alpacaSecret);

/** Set (or clear, with '') the account-attached credentials/models. Omitted fields are left unchanged. */
export function applyCredentials(next = {}) {
  for (const k of Object.keys(acctCred)) if (k in next) acctCred[k] = String(next[k] || '');
  for (const fn of credListeners) {
    try {
      fn();
    } catch {
      /* listeners must not break credential updates */
    }
  }
}

/** Register a callback fired after credentials change (e.g. alpaca cache reset). */
export function onCredentialsChange(fn) {
  credListeners.add(fn);
}

export const getAccountCredentials = () => ({ ...acctCred });
export const getEnvDefaults = () => ({ scannerModel: envCred.scannerModel, traderModel: envCred.traderModel });

/** Where the active credential comes from: 'account' | 'env' | 'none'. */
export function credentialSource() {
  const envAlpaca = Boolean(envCred.alpacaKey && envCred.alpacaSecret);
  return {
    openrouter: acctCred.openrouterKey ? 'account' : envCred.openrouterKey ? 'env' : 'none',
    alpaca: acctAlpaca() ? 'account' : envAlpaca ? 'env' : 'none',
  };
}

/** Remove every active secret from a string (error text from upstream must never reach logs verbatim). */
export function scrubSecrets(text) {
  let out = String(text ?? '');
  for (const v of [acctCred.alpacaKey, acctCred.alpacaSecret, acctCred.openrouterKey, envCred.alpacaKey, envCred.alpacaSecret, envCred.openrouterKey]) {
    if (v && v.length >= 6) out = out.split(v).join('[redacted]');
  }
  return out;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  adminToken: process.env.ADMIN_TOKEN || '',
  corsOrigin: process.env.CORS_ORIGIN || '', // empty = same-origin only
  trustProxy: process.env.TRUST_PROXY === 'true',
  // Auth settings are read at call time so they can be changed (and tested) without re-importing.
  get appSecret() {
    return process.env.APP_SECRET || '';
  },
  get signupCode() {
    return process.env.SIGNUP_CODE || '';
  },
  /** Deployed (NODE_ENV=production or Render): cookies are always Secure, HSTS is sent, setup fails closed. Read at call time. */
  get isProduction() {
    return process.env.NODE_ENV === 'production' || Boolean(process.env.RENDER);
  },
  /** Fail closed while no account exists: production, Render, or REQUIRE_SETUP=true. */
  get requireSetup() {
    return this.isProduction || process.env.REQUIRE_SETUP === 'true';
  },
  get allowSignup() {
    return process.env.ALLOW_SIGNUP === 'true';
  },
  alpaca: {
    get key() {
      return acctAlpaca() ? acctCred.alpacaKey : envCred.alpacaKey;
    },
    set key(v) {
      envCred.alpacaKey = v; // sets the ENV-level fallback (tests / scripts)
    },
    get secret() {
      return acctAlpaca() ? acctCred.alpacaSecret : envCred.alpacaSecret;
    },
    set secret(v) {
      envCred.alpacaSecret = v;
    },
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  },
  openrouter: {
    get key() {
      return acctCred.openrouterKey || envCred.openrouterKey;
    },
    set key(v) {
      envCred.openrouterKey = v;
    },
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    get scannerModel() {
      return acctCred.scannerModel || envCred.scannerModel;
    },
    set scannerModel(v) {
      envCred.scannerModel = v;
    },
    get traderModel() {
      return acctCred.traderModel || envCred.traderModel;
    },
    set traderModel(v) {
      envCred.traderModel = v;
    },
  },
  paperEquity: Number(process.env.PAPER_EQUITY || 100000),
  maxOpenPositions: Number(process.env.MAX_OPEN_POSITIONS || 10),
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 30),
  watchlistSize: Number(process.env.WATCHLIST_SIZE || 12),
  predictionHorizonHours: Number(process.env.PREDICTION_HORIZON_HOURS || 24),
  trading: {
    slippageBps: Number(process.env.SLIPPAGE_BPS ?? 5),
    feeBps: Number(process.env.FEE_BPS ?? 5),
    maxGrossPct: Number(process.env.MAX_GROSS_PCT ?? 80), // % of equity allocated across open positions
    maxClassPct: Number(process.env.MAX_CLASS_PCT ?? 60), // % of equity per asset class
    maxPerGroup: Number(process.env.MAX_PER_GROUP ?? 3), // open positions per sector/group
    dailyLossHaltPct: Number(process.env.DAILY_LOSS_HALT_PCT ?? 3),
  },
  /**
   * Evaluated at call time: mock when USE_MOCK_DATA=true or there are no Alpaca credentials (account or env).
   * Attaching Alpaca keys to the account overrides USE_MOCK_DATA=true (the owner explicitly chose live data).
   */
  get useMockData() {
    const flag = mockOverride ?? process.env.USE_MOCK_DATA === 'true';
    return (flag && !acctAlpaca()) || !hasAlpacaCredentials();
  },
  set useMockData(v) {
    mockOverride = Boolean(v);
  },
};

export function hasAlpacaCredentials() {
  return Boolean(config.alpaca.key && config.alpaca.secret);
}

export function hasOpenRouterKey() {
  return Boolean(config.openrouter.key);
}
