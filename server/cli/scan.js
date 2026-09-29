import { runMarketScan } from '../services/scanner.js';

const result = await runMarketScan({ force: true });
console.log(JSON.stringify(result.watchlist, null, 2));
process.exit(0);
