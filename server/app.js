import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { requestLogger } from './services/http.js';
import api from './routes/api.js';
import { errorHandler, rejectProtoKeys, securityHeaders } from './middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Build the Express app (no listening, no cron) so tests can start it on an ephemeral port. */
export function createApp() {
  const app = express();
  if (config.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('etag', false); // no weak ETags on dynamic (API) responses; static files keep serve-static's own validators
  app.use(securityHeaders);
  // Same-origin by default (no CORS headers); set CORS_ORIGIN to allow one external origin.
  if (config.corsOrigin) app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '20kb' }));
  app.use(rejectProtoKeys);
  // Page files must be re-validated on every load (cheap 304s via ETag): a browser or CDN that keeps an old app.js next to a
  // new charts.js crashes the whole SPA with 'module does not provide an export'.
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      etag: true,
      setHeaders: (res, file) => {
        if (/\.(html|js|css|json|map)$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );
  app.use('/api', requestLogger, api);
  app.get('*', (_req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  app.use(errorHandler);
  return app;
}
