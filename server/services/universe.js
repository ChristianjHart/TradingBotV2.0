// Candidate universe the scanner bot screens (≈120 liquid symbols).
export const STOCKS = [
  'SPY', 'QQQ', 'IWM', 'DIA', 'XLF', 'XLE', 'XLK', 'XLV', 'ARKK', 'SMH',
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD', 'NFLX', 'COIN',
  'PLTR', 'CRM', 'AVGO', 'JPM', 'BAC', 'XOM', 'UNH', 'COST', 'DIS', 'BA',
  'UBER', 'SHOP', 'XYZ', 'SOFI', 'RIVN', 'SMCI', 'ARM', 'INTC', 'MU', 'QCOM',
  'ORCL', 'ADBE', 'NOW', 'SNOW', 'PANW', 'CRWD', 'DDOG', 'NET', 'ABNB', 'PYPL',
  'V', 'MA', 'GS', 'MS', 'WFC', 'C', 'BRK.B', 'LLY', 'JNJ', 'PFE',
  'MRK', 'ABBV', 'TMO', 'CVX', 'COP', 'OXY', 'SLB', 'CAT', 'DE', 'GE',
  'HON', 'LMT', 'RTX', 'WMT', 'TGT', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD',
  'KO', 'PEP', 'PG', 'T', 'VZ', 'CMCSA', 'F', 'GM', 'LCID', 'NIO',
  'HOOD', 'MARA', 'RIOT', 'MSTR', 'RBLX', 'SPOT', 'ROKU', 'DKNG', 'AFRM', 'UPST',
];

export const CRYPTO = [
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD', 'DOGE/USD',
  'DOT/USD', 'LTC/USD', 'UNI/USD', 'AAVE/USD', 'XRP/USD', 'BCH/USD',
  'SHIB/USD', 'ETC/USD', 'CRV/USD', 'GRT/USD', 'BAT/USD', 'SUSHI/USD',
  'YFI/USD', 'XTZ/USD',
];

export const UNIVERSE = [...STOCKS, ...CRYPTO];
