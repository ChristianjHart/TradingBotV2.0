// Import first: isolates the JSON store in a temp dir and forces mock, key-less mode.
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tradingbot-test-'));
process.env.USE_MOCK_DATA = 'true';
process.env.ADMIN_TOKEN = '';
for (const k of Object.keys(process.env)) if (/openrouter|supabase|alpaca/i.test(k)) delete process.env[k];
