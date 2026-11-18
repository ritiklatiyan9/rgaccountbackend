import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { memberDocumentStorage, readMemberDocumentObject } from './memberDocumentUrls.js';

const PREVIEW_TYPES = new Map([
  ['.pdf', 'application/pdf'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'],
]);
const PREVIEW_MIMES = new Set(PREVIEW_TYPES.values());

export function requestAttachmentStorage(url, env = process.env) {
  const storage = memberDocumentStorage(url, env);
  return storage && /^(vouchers|seek-permissions)\/.+/.test(storage.Key) ? storage : null;
}

// Only call with an attachment from an authorized record. The browser reads
// through the API so PDFs don't depend on CORS on private or older buckets.
export async function sendRequestAttachment(res, file, { read = readMemberDocumentObject, env = process.env } = {}) {
  const storage = requestAttachmentStorage(file.url, env);
  if (!storage) throw Object.assign(new Error('Attachment not found'), { statusCode: 404 });
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once('close', abort);
  try {
    const object = await read(storage, AbortSignal.any([controller.signal, AbortSignal.timeout(30000)]));
    if (controller.signal.aborted) { object.Body?.destroy?.(); return; }
    const objectType = object.ContentType?.split(';')[0].toLowerCase();
    const type = PREVIEW_TYPES.get(extname(storage.Key).toLowerCase()) || PREVIEW_TYPES.get(extname(file.name || '').toLowerCase())
      || (PREVIEW_MIMES.has(objectType) && objectType) || 'application/octet-stream';
    res.set({ 'Cache-Control': 'private, no-store', 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
    if (Number.isSafeInteger(object.ContentLength)) res.set('Content-Length', String(object.ContentLength));
    await pipeline(object.Body, res, { signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || res.destroyed) return;
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
      throw Object.assign(new Error('The attachment is no longer in storage.'), { statusCode: 404 });
    }
    throw error;
  } finally {
    res.off('close', abort);
  }
}
