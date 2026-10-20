import fs from 'node:fs/promises';

const MAX_MOOV_BYTES = 16 * 1024 * 1024;

function readBoxHeader(buf, offset) {
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  }
  return { size, type, headerSize };
}

function durationFromMvhd(moov) {
  let o = 0;
  while (o + 8 <= moov.length) {
    const { size, type } = readBoxHeader(moov, o);
    if (type === 'mvhd') {
      const version = moov[o + 8];
      const timescale = version === 1 ? moov.readUInt32BE(o + 28) : moov.readUInt32BE(o + 20);
      const duration = version === 1 ? Number(moov.readBigUInt64BE(o + 32)) : moov.readUInt32BE(o + 24);
      return timescale ? duration / timescale : null;
    }
    if (size < 8) return null;
    o += size;
  }
  return null;
}

/**
 * Read the movie duration (seconds) from an MP4/M4V file's `moov/mvhd` box.
 * Returns null when the file cannot be parsed; callers then fall back to the admin-supplied value.
 */
export async function readMp4Duration(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size: fileSize } = await handle.stat();
    const header = Buffer.alloc(16);
    let offset = 0;
    while (offset + 8 <= fileSize) {
      await handle.read(header, 0, 16, offset);
      const box = readBoxHeader(header, 0);
      const size = box.size === 0 ? fileSize - offset : box.size;
      if (size < box.headerSize) return null;
      if (box.type === 'moov') {
        const length = Math.min(size - box.headerSize, MAX_MOOV_BYTES);
        const moov = Buffer.alloc(length);
        await handle.read(moov, 0, length, offset + box.headerSize);
        return durationFromMvhd(moov);
      }
      offset += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}
