import fs from 'node:fs/promises';

/**
 * Allowed upload types. A file must match on extension, declared MIME type AND magic bytes,
 * so renaming `evil.exe` to `report.pdf` is rejected.
 */
const SIGNATURES = {
  pdf: (b) => b.subarray(0, 4).toString('latin1') === '%PDF',
  zip: (b) => b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05) && (b[3] === 0x04 || b[3] === 0x06),
  ole: (b) => b.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])),
  png: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  mp4: (b) => b.subarray(4, 8).toString('latin1') === 'ftyp',
  webm: (b) => b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])),
  ogg: (b) => b.subarray(0, 4).toString('latin1') === 'OggS',
  webp: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  text: (b) => !b.includes(0x00),
};

const DOCUMENT_TYPES = {
  pdf: { mimes: ['application/pdf'], sig: 'pdf' },
  doc: { mimes: ['application/msword'], sig: 'ole' },
  docx: { mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'], sig: 'zip' },
  ppt: { mimes: ['application/vnd.ms-powerpoint'], sig: 'ole' },
  pptx: { mimes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'], sig: 'zip' },
  xls: { mimes: ['application/vnd.ms-excel'], sig: 'ole' },
  xlsx: { mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], sig: 'zip' },
  zip: { mimes: ['application/zip', 'application/x-zip-compressed'], sig: 'zip' },
  txt: { mimes: ['text/plain'], sig: 'text' },
  jpg: { mimes: ['image/jpeg'], sig: 'jpg' },
  jpeg: { mimes: ['image/jpeg'], sig: 'jpg' },
  png: { mimes: ['image/png'], sig: 'png' },
};

const VIDEO_TYPES = {
  mp4: { mimes: ['video/mp4'], sig: 'mp4' },
  m4v: { mimes: ['video/mp4', 'video/x-m4v'], sig: 'mp4' },
  webm: { mimes: ['video/webm'], sig: 'webm' },
  ogv: { mimes: ['video/ogg'], sig: 'ogg' },
};

// Payment proofs: a screenshot or a receipt.
const PROOF_TYPES = {
  jpg: DOCUMENT_TYPES.jpg,
  jpeg: DOCUMENT_TYPES.jpeg,
  png: DOCUMENT_TYPES.png,
  webp: { mimes: ['image/webp'], sig: 'webp' },
  pdf: DOCUMENT_TYPES.pdf,
};

export const FILE_CATEGORIES = {
  document: DOCUMENT_TYPES,
  video: VIDEO_TYPES,
  proof: PROOF_TYPES,
};

export const extensionOf = (filename) => (filename.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

/** Cheap pre-check on what the client claims (runs before the bytes are written). */
export function isAllowedDeclaredType(category, filename, mimetype) {
  const rule = FILE_CATEGORIES[category][extensionOf(filename)];
  return Boolean(rule && rule.mimes.includes(mimetype));
}

/** Authoritative check on the stored bytes. */
export async function hasValidSignature(category, filename, filePath) {
  const rule = FILE_CATEGORIES[category][extensionOf(filename)];
  if (!rule) return false;
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await handle.read(buffer, 0, 512, 0);
    if (bytesRead === 0) return false;
    return SIGNATURES[rule.sig](buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

export const allowedExtensions = (category) => Object.keys(FILE_CATEGORIES[category]);

/** Canonical MIME type for an extension (used when serving, never the client-declared value). */
export const mimeFor = (category, filename) => FILE_CATEGORIES[category][extensionOf(filename)]?.mimes[0];
