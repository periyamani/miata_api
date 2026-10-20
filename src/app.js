import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimiters.js';
import { requestLogger } from './middleware/requestLogger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import apiRouter from './routes.js';

/** The REST API only — the website and dashboards are served separately by miata-web. */
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.trustProxy ? 1 : false);

  // same-site lets miata-web on another port/subdomain load API resources; media routes widen this for <video>.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(requestLogger);

  app.use(
    '/api',
    cors({
      origin: (origin, cb) => cb(null, !origin || env.corsOrigins.includes(origin)),
      credentials: true,
    }),
    apiLimiter,
    express.json({ limit: '100kb' }),
    cookieParser(),
    apiRouter,
  );

  app.get('/', (_req, res) => res.json({ name: 'MIATA API', docs: 'See miata-api/docs/api.md', health: '/api/health' }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
