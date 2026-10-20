import crypto from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import { env } from '../config/env.js';
import { AppError, badRequest } from '../utils/AppError.js';
import { allowedExtensions, extensionOf, hasValidSignature, isAllowedDeclaredType, mimeFor } from '../utils/fileTypes.js';
import { discardUnpersistedUpload, STORAGE_DIRS } from '../services/storage.service.js';

const UPLOAD_KINDS = {
  video: { category: 'video', maxBytes: () => env.uploads.maxVideoBytes },
  attachment: { category: 'document', maxBytes: () => env.uploads.maxDocumentBytes },
  submission: { category: 'document', maxBytes: () => env.uploads.maxDocumentBytes },
  payment_proof: { category: 'proof', maxBytes: () => env.uploads.maxDocumentBytes },
};

// Control characters, quotes and slashes are replaced in stored display names.
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f"\\/]/g;
const REPLACEMENT_CHAR = '�';

/** Busboy decodes multipart filenames as latin1; recover UTF-8 names and strip anything path-like. */
function safeOriginalName(name) {
  const utf8 = Buffer.from(name, 'latin1').toString('utf8');
  const decoded = utf8.includes(REPLACEMENT_CHAR) ? name : utf8;
  return path.basename(decoded).replace(UNSAFE_FILENAME_CHARS, '_').slice(0, 200) || 'file';
}

/**
 * Accept exactly one file in `field`, written to UPLOAD_DIR/<kind dir>/<uuid>.<ext>.
 * Checks extension + declared MIME before writing and magic bytes after writing.
 */
export function uploadSingle(field, kind, { required = true } = {}) {
  const { category, maxBytes } = UPLOAD_KINDS[kind];
  const subdir = STORAGE_DIRS[kind];
  const multerUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, path.join(env.uploads.dir, subdir)),
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.${extensionOf(file.originalname)}`),
    }),
    limits: { fileSize: maxBytes(), files: 1, fields: 30, fieldSize: 64 * 1024 },
    fileFilter: (_req, file, cb) => {
      if (isAllowedDeclaredType(category, file.originalname, file.mimetype)) return cb(null, true);
      cb(new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Allowed file types: ${allowedExtensions(category).join(', ')}`));
    },
  }).single(field);

  return (req, res, next) => {
    multerUpload(req, res, async (err) => {
      try {
        if (err) {
          await discardUnpersistedUpload(req.file);
          if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
              return next(new AppError(413, 'FILE_TOO_LARGE', `File must be ${Math.round(maxBytes() / 1048576)} MB or smaller`));
            }
            return next(badRequest(err.code === 'LIMIT_UNEXPECTED_FILE' ? `Upload the file in the "${field}" field` : err.message));
          }
          return next(err);
        }
        if (!req.file) {
          return required ? next(badRequest('A file is required', { [field]: 'Please choose a file' })) : next();
        }
        if (!(await hasValidSignature(category, req.file.originalname, req.file.path))) {
          await discardUnpersistedUpload(req.file);
          return next(new AppError(415, 'UNSUPPORTED_FILE_TYPE', 'The file content does not match its file type'));
        }
        req.file.storageKey = `${subdir}/${req.file.filename}`;
        req.file.safeName = safeOriginalName(req.file.originalname);
        req.file.canonicalMime = mimeFor(category, req.file.originalname);
        next();
      } catch (e) {
        await discardUnpersistedUpload(req.file);
        next(e);
      }
    });
  };
}
