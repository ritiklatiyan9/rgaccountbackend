import { createHash } from 'node:crypto';

export class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const asId = (value, label = 'id') => {
  if (
    !/^[1-9]\d*$/.test(String(value)) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new TransferError(400, `A valid ${label} is required`);
  }
  return Number(value);
};
export const validDate = (value) => {
  const raw =
    value instanceof Date
      ? `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
      : String(value ?? '');
  const date = new Date(`${raw}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== raw ||
    raw < '1900-01-01' ||
    raw > '2100-12-31'
  ) {
    throw new TransferError(422, 'Enter a valid date between 1900 and 2100');
  }
  return raw;
};
export const versionOf = (row) =>
  createHash('sha256').update(JSON.stringify(row)).digest('hex');
export const normalizeEntries = (body) => {
  const entries = body.entries ?? [body];
  if (!Array.isArray(entries) || entries.length < 1 || entries.length > 100) {
    throw new TransferError(
      400,
      'Select between 1 and 100 entries per transfer',
    );
  }
  const seen = new Set();
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object')
      throw new TransferError(400, 'Invalid entry');
    if (typeof entry.source_type !== 'string' || !entry.source_type)
      throw new TransferError(400, 'Source module is required');
    const id = asId(entry.source_id, 'source id');
    const key = `${entry.source_type}:${id}`;
    if (seen.has(key))
      throw new TransferError(400, 'The same entry is selected more than once');
    seen.add(key);
    return { ...entry, source_id: id };
  });
};
const LIMITS = {
  particular: 255,
  remarks: 2000,
  payment_mode: 20,
  cheque_no: 50,
  bank_name: 100,
  bank_account_no: 50,
  bank_reference: 100,
  bank_ifsc: 20,
  from_entity: 255,
  to_entity: 255,
  category: 100,
};
export const editSource = (source, edits = {}) => {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits))
    throw new TransferError(422, 'Invalid entry fields');
  const result = { ...source, raw: { ...source.raw } };
  for (const [key, value] of Object.entries(edits)) {
    if (
      !['date', 'amount', 'direction', ...Object.keys(LIMITS)].includes(key)
    ) {
      throw new TransferError(
        422,
        `Field ${key} cannot be changed during a transfer`,
      );
    }
    if (key in LIMITS) {
      if (value != null && typeof value !== 'string')
        throw new TransferError(422, `Invalid ${key}`);
      const text = String(value ?? '').trim();
      if (text.length > LIMITS[key])
        throw new TransferError(
          422,
          `${key} is too long (maximum ${LIMITS[key]})`,
        );
      result[key] = text || null;
    } else result[key] = value;
  }
  result.date = validDate(result.date);
  if (
    !/^\d+(\.\d{1,2})?$/.test(String(result.amount)) ||
    !Number.isFinite(Number(result.amount)) ||
    Number(result.amount) <= 0 ||
    Number(result.amount) > 9999999999.99
  ) {
    throw new TransferError(
      422,
      'Amount must be positive, with at most two decimal places',
    );
  }
  result.amount = Number(result.amount);
  if (!['debit', 'credit'].includes(result.direction))
    throw new TransferError(422, 'Choose debit or credit');
  if (!result.particular)
    throw new TransferError(422, 'Particular / party is required');
  result.payment_mode = String(
    result.payment_mode || source.raw_mode || source.mode || 'CASH',
  ).toUpperCase();
  if (!/^[A-Z][A-Z /_-]{0,19}$/.test(result.payment_mode))
    throw new TransferError(422, 'Invalid payment mode');
  // A split payment has two instruments and cannot be collapsed into one silently.
  if (
    result.payment_mode === 'SPLIT' ||
    String(source.raw?.payment_mode).toUpperCase() === 'SPLIT'
  ) {
    throw new TransferError(
      422,
      'Separate the cash and bank portions of a split payment before transferring it',
    );
  }
  result.mode =
    result.payment_mode === 'CASH'
      ? 'cash'
      : /CHEQUE|CHECK|^DD$/.test(result.payment_mode)
        ? 'cheque'
        : 'bank';
  if (result.mode === 'cheque' && !result.cheque_no)
    throw new TransferError(422, 'Cheque number is required');
  const instrumentChanged =
    result.mode !== source.mode ||
    result.cheque_no !== source.cheque_no ||
    result.amount !== source.amount ||
    result.date !== source.date ||
    result.direction !== source.direction ||
    result.payment_mode !== String(source.payment_mode || '').toUpperCase() ||
    String(result.bank_account_no || '') !==
      String(source.bank_account_no || '') ||
    String(result.bank_name || '') !== String(source.bank_name || '');
  result.cheque_status =
    result.mode === 'cheque'
      ? instrumentChanged
        ? 'PENDING'
        : source.cheque_status || 'PENDING'
      : null;
  if (result.mode === 'cash') result.bank_account_id = null;
  // A new module must follow its approval workflow; old approval/signatures do
  // not authorize a different party, amount or accounting classification.
  result.status = 'pending';
  result.approved_by = null;
  result.approved_at = null;
  result.customer_signature_url = null;
  result.authority_signature_url = null;
  result.raw_mode = result.payment_mode;
  return result;
};
