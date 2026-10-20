import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { discardUnpersistedUpload } from '../services/storage.service.js';

const PG_ERRORS = {
  23505: [409, 'CONFLICT', 'A record with these details already exists'],
  23503: [409, 'CONFLICT', 'This record is linked to other records and cannot be changed this way'],
  23514: [422, 'VALIDATION_ERROR', 'Some values are not allowed'],
  '22P02': [400, 'BAD_REQUEST', 'Invalid value supplied'],
};

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` } });
}

export async function errorHandler(err, req, res, _next) {
  // An upload that reached the handler but was never recorded must not linger on disk.
  await discardUnpersistedUpload(req.file);

  if (res.headersSent) return;

  if (err instanceof AppError) {
    const body = { code: err.code, message: err.message };
    if (err.details) body.details = err.details;
    return res.status(err.status).json({ error: body });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Request body is not valid JSON' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
  }

  const pg = PG_ERRORS[err.code];
  if (pg) {
    logger.warn('Database constraint error', { code: err.code, constraint: err.constraint, path: req.path });
    return res.status(pg[0]).json({ error: { code: pg[1], message: pg[2] } });
  }

  logger.error('Unhandled error', { method: req.method, path: req.path, error: err.message, stack: err.stack });
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again.' } });
}
