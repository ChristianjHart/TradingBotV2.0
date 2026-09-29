import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { requestLogger } from './services/http.js';
import api from './routes/api.js';
import { errorHandler, securityHeaders } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the Express app (no listening, no cron) so tests can start it on an ephemeral port. */
export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(securityHeaders);
  // Same-origin by default (no CORS headers); set CORS_ORIGIN to allow one external origin.
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', requestLogger, api);
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  app.use(errorHandler);
  return app;
}
