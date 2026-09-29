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

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: process.env.DATA_DIR || path.join(root, 'data'),
  adminToken: process.env.ADMIN_TOKEN || '',
  corsOrigin: process.env.CORS_ORIGIN || '', // empty = same-origin only
  trustProxy: process.env.TRUST_PROXY === 'true',
  alpaca: {
    key: process.env.ALPACA_API_KEY || '',
    secret: process.env.ALPACA_API_SECRET || '',
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  },
  openrouter: {
    key: envAny('OPENROUTER_API_KEY'),
    baseUrl: process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    scannerModel: process.env.SCANNER_MODEL || 'deepseek/deepseek-v3.1-terminus',
    traderModel: process.env.TRADER_MODEL || 'deepseek/deepseek-chat-v3.1',
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
  useMockData:
    process.env.USE_MOCK_DATA === 'true' ||
    !process.env.ALPACA_API_KEY ||
    !process.env.ALPACA_API_SECRET,
};

export function hasAlpacaCredentials() {
  return Boolean(config.alpaca.key && config.alpaca.secret);
}

export function hasOpenRouterKey() {
  return Boolean(config.openrouter.key);
}
