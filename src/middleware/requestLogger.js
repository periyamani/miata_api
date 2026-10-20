import { logger } from '../utils/logger.js';

/** One line per API request. Logs the path only — never query strings, bodies or headers (tokens). */
export function requestLogger(req, res, next) {
  if (!req.path.startsWith('/api')) return next();
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : 'info';
    logger[level](`${req.method} ${req.path} ${res.statusCode} ${ms.toFixed(0)}ms`, req.user ? { user: req.user.id } : undefined);
  });
  next();
}
