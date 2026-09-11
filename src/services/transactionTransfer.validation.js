import { createHash } from 'node:crypto';

export class TransferError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.statusCode = status;
  }
}
export const asId = (value, label = 'id') => {
  if (
    !/^[1-9]\d*$/.test(String(value)) ||
    (!Number.isSafeInteger(Number(value)) || Number(value)>2147483647)
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

// All arithmetic uses integer minor units, including partial-transfer limits.
export const moneyCents = value => {
  const n = Number(value);
  const cents = Math.round(n * 100);
  if (!Number.isFinite(n) || !Number.isSafeInteger(cents)) throw new TransferError(422, 'Invalid monetary amount');
  return cents;
};
export const buildTransferLegs = (source, edited, { date, userId, reason }) => {
  if (moneyCents(edited.amount) > moneyCents(source.remaining_amount ?? source.amount))
    throw new TransferError(409, 'Transfer exceeds the amount remaining on the original entry');
  if ((source.mode === 'cash') !== (edited.mode === 'cash'))
    throw new TransferError(422, 'Keep both transfer entries in the original cash or bank balance');
  if (edited.mode === 'cheque') throw new TransferError(422, 'Use BANK for an internal transfer of a cleared cheque; a transfer does not issue a new cheque');
  const shared = {
    date, amount: edited.amount, payment_mode: edited.payment_mode,
    raw_mode: edited.payment_mode, mode: edited.mode,
    bank_account_id: edited.mode==='cash' ? null : source.bank_account_id || null,
    status: 'approved', approved_by: userId, approved_at: new Date().toISOString(),
    cheque_status: null, cheque_no: null, created_by: userId,
    customer_signature_url: null, authority_signature_url: null,
    // These paired internal postings must not create an admin's cash expense
    // or reuse the original customer's signed authorization.
    assigned_admin_id: null,
    raw: { ...source.raw, mapped_member_id: null, mapped_user_id: null, interest_rate: 0, interest_amount: 0 },
  };
  const destination = { ...edited, ...shared, remarks: [edited.remarks, `TRANSFER: ${reason}`].filter(Boolean).join(' · ') };
  const offset = { ...source, ...shared, direction: edited.direction === 'credit' ? 'debit' : 'credit',
    remarks: `TRANSFER OFFSET: ${reason}`, is_source_offset: true };
  return { destination, offset };
};

// Canonicalize the plan before it is previewed. Several modules intentionally
// have a single narrative column instead of separate party/bank-detail fields.
// Preserve every entered value there and make that storage mapping explicit.
export const normalizeTransferFields = (type, entry) => {
  const result = { ...entry };
  const textParts = [];
  const moved = [];
  const moveToNarrative = (key, label) => {
    if (result[key]) { textParts.push(`${label}: ${result[key]}`); moved.push(label.toLowerCase()); }
    result[key] = null;
  };
  const vendor = ['vendor_payment','vendor_inventory_payment'].includes(type);
  if (vendor && !['CASH','BANK','UPI','NEFT','RTGS','IMPS'].includes(result.payment_mode)) {
    result.payment_mode = result.raw_mode = 'BANK';
  }
  if (['plot_payment','plot_commission','vendor_payment','vendor_inventory_payment','land_sale'].includes(type)) moveToNarrative('particular','PARTY');
  if (!['expense','daybook'].includes(type)) {
    moveToNarrative('category','CATEGORY');
    moveToNarrative('from_entity','FROM');
    moveToNarrative('to_entity','TO');
  }
  const bankFields = {
    personal_ledger: [], expense: ['bank_account_no','bank_ifsc'],
    farmer_payment: ['bank_name','bank_account_no','bank_ifsc','bank_reference'],
    plot_payment: ['bank_name','bank_account_no','bank_ifsc'],
    plot_commission: ['bank_name','bank_reference'],
    vendor_payment: ['bank_reference'], vendor_inventory_payment: ['bank_reference'],
    misc_income: ['bank_name','bank_account_no','bank_ifsc','bank_reference'],
    land_sale: ['bank_name','bank_account_no','bank_ifsc','bank_reference'],
    daybook: ['bank_account_no','bank_ifsc'],
  }[type] || [];
  for (const [key,label] of Object.entries({bank_name:'BANK',bank_account_no:'ACCOUNT',bank_ifsc:'IFSC',bank_reference:'REFERENCE'}))
    if (!bankFields.includes(key)) moveToNarrative(key,label);
  if (type==='personal_ledger') {
    const instrument = String(result.payment_mode || result.mode || 'CASH').toUpperCase().replace(/^TRANSFER$/,'BANK TRANSFER');
    if (String(result.particular || '').toUpperCase() !== instrument) moveToNarrative('particular','PARTY');
    result.particular=instrument;
  }
  if (type==='expense') {
    const party=entry.parent_name || entry.particular || 'TRANSFERRED ENTRY';
    result.from_entity=result.from_entity || (result.direction==='credit'?party:null);
    result.to_entity=result.to_entity || (result.direction==='debit'?party:null);
    result.category=String(result.category || 'TRANSFERRED ENTRY').toUpperCase();
    result.particular=[result.particular,result.remarks,...textParts].filter(Boolean).join(' · ').toUpperCase();
    result.remarks=null;
    result.field_storage_note='The expense Remark contains the party, remarks and additional bank details.';
  } else {
    result.remarks=[result.remarks,...textParts].filter(Boolean).join(' · ');
    if(type==='daybook') result.category=result.category || 'TRANSFERRED ENTRY';
    if(moved.length) result.field_storage_note=`Additional ${[...new Set(moved)].join(', ')} details are saved in ${vendor?'Note':type==='plot_payment'?'Narration':'Remarks'}.`;
  }
  // Narrative columns are TEXT. Enforce each dedicated column's native limit
  // after defaults/case conversion, before issuing a reviewable preview.
  const nativeLimits = {
    personal_ledger: { particular: 500 },
    expense: { from_entity: 255, to_entity: 255, category: 100, bank_account_no: 100, bank_ifsc: 255 },
    farmer_payment: { particular: 255, bank_name: 255, bank_account_no: 100, bank_reference: 255, bank_ifsc: 20 },
    plot_payment: { bank_name: 150, bank_account_no: 255, bank_ifsc: 150 },
    plot_commission: { bank_name: 100, bank_reference: 100 },
    vendor_payment: { bank_reference: 120 }, vendor_inventory_payment: { bank_reference: 120 },
    misc_income: { particular: 255, bank_name: 150, bank_account_no: 50, bank_reference: 120, bank_ifsc: 20 },
    land_sale: { bank_name: 150, bank_account_no: 50, bank_reference: 120, bank_ifsc: 20 },
    daybook: { particular: 500, from_entity: 255, to_entity: 255, category: 100, bank_account_no: 100, bank_ifsc: 255 },
  }[type] || {};
  for(const [key,limit] of Object.entries(nativeLimits)) if(result[key] && Array.from(String(result[key])).length>limit)
    throw new TransferError(422,`${key.replaceAll('_',' ')} exceeds this destination's ${limit}-character limit. Shorten it before previewing`);
  return result;
};
