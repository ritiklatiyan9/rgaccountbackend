import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const fallbackSecret = randomBytes(32);
const secret = () => process.env.HISTORY_CURSOR_SECRET || process.env.JWT_ACCESS_SECRET || fallbackSecret;
const invalid = message => Object.assign(new Error(message), { statusCode: 409, code: 'HISTORY_CURSOR_INVALID' });
export const historyFingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('base64url');
export function encodeHistoryCursor(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
export function decodeHistoryCursor(token) {
  if (typeof token !== 'string' || token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid('Refresh history to start a new page sequence.');
  const [body, signature] = token.split('.');
  const expected = createHmac('sha256', secret()).update(body).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw invalid('Refresh history to start a new page sequence.');
  let cursor;
  try { cursor = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid('Invalid history cursor.'); }
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(value) && Number.isFinite(Date.parse(value));
  if (cursor?.v !== 1 || typeof cursor.fingerprint !== 'string' || !timestamp(cursor.snapshot)
    || !Number.isSafeInteger(cursor.expires) || cursor.expires <= Date.now()
    || !cursor.key || cursor.key.time !== null && !timestamp(cursor.key.time)
    || !/^[a-z_]{1,60}$/.test(cursor.key.source || '')
    || !/^(?:[0-9]{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(cursor.key.id || '')) {
    throw invalid('History pages expired. Refresh history to continue.');
  }
  return cursor;
}

export function assertHistoryCursorScope(cursor, fingerprint) {
  if (cursor && cursor.fingerprint !== fingerprint) throw invalid('History access or filters changed. Refresh history to continue.');
}
