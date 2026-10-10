import path from 'node:path';

const MIME_BY_EXTENSION = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.pdf', 'application/pdf'],
]);

export function evidenceMime(file) {
  const expected = MIME_BY_EXTENSION.get(path.extname(file.originalname || '').toLowerCase());
  const supplied = String(file.mimetype || '').toLowerCase();
  if (!expected) return null;
  if (!supplied || supplied === 'application/octet-stream' || supplied === expected
    || (expected === 'image/jpeg' && supplied === 'image/jpg')
    || (expected === 'application/pdf' && supplied === 'application/x-pdf')) return expected;
  return null;
}
