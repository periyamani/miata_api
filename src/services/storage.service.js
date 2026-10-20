import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { pool } from '../config/db.js';
import { logger } from '../utils/logger.js';

/**
 * Local-disk file storage. Only metadata is stored in PostgreSQL (`files` table).
 * To move to S3/Azure later, re-implement these functions; callers only use storage keys.
 */
export const STORAGE_DIRS = { video: 'videos', attachment: 'attachments', submission: 'submissions', payment_proof: 'payment-proofs' };

export async function ensureUploadDirs() {
  await Promise.all(Object.values(STORAGE_DIRS).map((d) => fs.mkdir(path.join(env.uploads.dir, d), { recursive: true })));
}

export function resolveStoragePath(storageKey) {
  const root = path.resolve(env.uploads.dir);
  const full = path.resolve(root, storageKey);
  if (!full.startsWith(root + path.sep)) throw new Error('Invalid storage key');
  return full;
}

/** Persist metadata for a file multer has just written. Marks it so the error handler will not delete it. */
export async function recordUpload(file, kind, userId, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO files (storage_key, original_name, mime_type, size_bytes, kind, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [file.storageKey, file.safeName, file.canonicalMime, file.size, kind, userId],
  );
  file.persisted = true;
  return rows[0];
}

export async function deleteStoredFile(storageKey) {
  try {
    await fs.unlink(resolveStoragePath(storageKey));
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('Could not delete stored file', { storageKey, error: err.message });
  }
}

/** Remove the bytes of an upload that never made it into the database (validation or DB failure). */
export async function discardUnpersistedUpload(file) {
  if (file?.path && !file.persisted) await fs.unlink(file.path).catch(() => {});
}

/** Send a stored file. Documents download as attachments; videos stream inline with Range support. */
export function sendStoredFile(res, fileRow, { inline = false } = {}) {
  const disposition = inline ? 'inline' : 'attachment';
  const encoded = encodeURIComponent(fileRow.original_name);
  res.setHeader('Content-Type', fileRow.mime_type);
  res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encoded}`);
  res.setHeader('Cache-Control', 'private, no-store');
  return new Promise((resolve, reject) => {
    res.sendFile(resolveStoragePath(fileRow.storage_key), { dotfiles: 'deny', acceptRanges: true }, (err) => {
      if (err && !res.headersSent) reject(err);
      else resolve();
    });
  });
}
