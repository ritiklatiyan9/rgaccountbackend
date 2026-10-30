import sharp from 'sharp';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Compress only evidence images, before controllers calculate hashes and sizes.
// Keep the original encoding and filename so document metadata and consumers
// (including the Booking app) continue to describe the actual bytes.
const MAX_EDGE = 2400;
const ALREADY_COMPACT_BYTES = 1536 * 1024;
const FORMATS = new Map([['.jpg', 'jpeg'], ['.jpeg', 'jpeg'], ['.png', 'png'], ['.webp', 'webp']]);

export async function optimizeEvidenceImage(file) {
  const name = String(file?.originalname || '');
  const format = FORMATS.get(path.extname(name).toLowerCase());
  // Signature bitmaps are generated at print resolution and must stay exact.
  if (!format || /-signature\.png$/i.test(name)) return file;
  try {
    const bytes = file.buffer || await readFile(file.path);
    const input = sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'error' });
    const metadata = await input.metadata();
    if (metadata.format !== format || (metadata.pages || 1) > 1) return file;
    if (Math.max(metadata.width || 0, metadata.height || 0) <= MAX_EDGE && bytes.length <= ALREADY_COMPACT_BYTES) return file;
    let pipeline = input.rotate().resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
    if (format === 'jpeg') pipeline = pipeline.jpeg({ quality: 84, mozjpeg: true });
    else if (format === 'webp') pipeline = pipeline.webp({ quality: 84 });
    else pipeline = pipeline.png({ compressionLevel: 9 });
    const output = await pipeline.toBuffer();
    if (output.length >= bytes.length) return file;
    if (file.buffer) file.buffer = output;
    else {
      // Atomic replacement avoids leaving a truncated upload if writing fails.
      const temporaryPath = `${file.path}.${randomUUID()}.optimized`;
      try {
        await writeFile(temporaryPath, output, { flag: 'wx' });
        await rename(temporaryPath, file.path);
      } catch (error) {
        await unlink(temporaryPath).catch(() => {});
        throw error;
      }
    }
    file.size = output.length;
  } catch {
    // Unsupported or malformed images retain the existing upload behavior.
    // Optimization must never prevent a valid document from being saved.
  }
  return file;
}

export default function optimizeEvidenceImages(req, _res, next) {
  const files = req.file ? [req.file] : Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat();
  // Sequential processing bounds memory when a request contains several photos.
  files.reduce((pending, file) => pending.then(() => optimizeEvidenceImage(file)), Promise.resolve()).then(() => next(), next);
}
