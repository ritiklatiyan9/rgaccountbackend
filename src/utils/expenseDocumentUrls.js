import { memberDocumentStorage, signMemberDocumentUrl } from './memberDocumentUrls.js';

// Expense evidence lives under vouchers/. Never use an expense field to sign
// keys belonging to KYC or other private document collections.
const storageFor = (value) => {
  const storage = memberDocumentStorage(value);
  return storage?.Key.startsWith('vouchers/') ? storage : null;
};

export function durableExpenseDocumentUrl(value) {
  const trimmed = value.trim();
  if (!storageFor(trimmed)) return trimmed;
  const url = new URL(trimmed);
  url.search = '';
  url.hash = '';
  return url.href;
}

export function expenseDocumentColumns(listKey, urlKey, list, single) {
  const urls = (Array.isArray(list) ? list : [single])
    .filter((value) => typeof value === 'string' && value.trim())
    .map(durableExpenseDocumentUrl);
  return { [listKey]: urls, [urlKey]: urls[0] || null };
}

export async function signExpenseDocumentUrl(value) {
  if (typeof value !== 'string' || !storageFor(value)) return value;
  return signMemberDocumentUrl(durableExpenseDocumentUrl(value));
}

// Call at the response boundary, after record visibility has been checked.
// Only durable URLs are stored; each authorized read receives fresh links.
export async function signExpenseDocuments(expense, sign = signExpenseDocumentUrl) {
  const result = { ...expense };
  const pending = new Map();
  const signed = (value) => {
    if (!value) return value;
    if (!pending.has(value)) pending.set(value, Promise.resolve().then(() => sign(value)));
    return pending.get(value);
  };
  await Promise.all(['voucher', 'bill'].map(async (kind) => {
    const single = `${kind}_url`;
    const list = `${kind}_urls`;
    if (Array.isArray(expense[list])) result[list] = await Promise.all(expense[list].map(signed));
    if (expense[single]) result[single] = await signed(expense[single]);
  }));
  return result;
}
