import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

export const config = {
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dataDir: path.join(root, 'data'),
  alpaca: {
    key: process.env.ALPACA_API_KEY || '',
    secret: process.env.ALPACA_API_SECRET || '',
    baseUrl: process.env.ALPACA_BASE_URL || 'https://paper-api.alpaca.markets',
    dataUrl: process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets',
  },
  scanIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 30),
  watchlistSize: Number(process.env.WATCHLIST_SIZE || 12),
  predictionHorizonHours: Number(process.env.PREDICTION_HORIZON_HOURS || 24),
  useMockData:
    process.env.USE_MOCK_DATA === 'true' ||
    !process.env.ALPACA_API_KEY ||
    !process.env.ALPACA_API_SECRET,
};

export function hasAlpacaCredentials() {
  return Boolean(config.alpaca.key && config.alpaca.secret);
}
