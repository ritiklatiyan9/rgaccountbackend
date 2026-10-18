import { createHash } from 'node:crypto';

const fail = (message, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export const vendorPaymentModes = new Set(['cash', 'bank', 'upi', 'cheque', 'neft', 'rtgs', 'imps', 'other']);

// Keep money as decimal strings all the way into PostgreSQL numeric. Reject
// partial numbers, excess precision and values beyond numeric(14,2).
export function vendorMoney(value, label = 'Payment amount', { zero = false } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(text)) fail(`${label} must be a valid amount with at most two decimal places`);
  const [whole, fraction = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents === 0n && !zero) fail(`${label} must be greater than 0`);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
}

export function vendorDate(value, label = 'Payment date', { optional = false } = {}) {
  if (optional && (value == null || value === '')) return null;
  const text = String(value ?? '');
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00.000Z`);
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text
      || text < '1900-01-01' || text > '2100-12-31') fail(`${label} must be a valid date between 1900 and 2100`);
  return text;
}

export function normalizeVendorPayment(body, key) {
  const paymentMode = String(body.payment_mode || 'cash').trim().toLowerCase();
  if (!vendorPaymentModes.has(paymentMode)) fail('Invalid payment mode');
  const reference = String(body.reference_no ?? '').trim() || null;
  if (reference?.length > 120) fail('Payment reference cannot exceed 120 characters');
  const chequeNo = paymentMode === 'cheque' ? String(body.cheque_no || reference || '').trim() : null;
  if (paymentMode === 'cheque' && (!chequeNo || chequeNo.length > 50)) fail('A cheque number of at most 50 characters is required');
  if (key !== undefined && !/^[A-Za-z0-9._:-]{8,128}$/.test(String(key || ''))) fail('A valid idempotency_key is required to record a payment');
  return {
    amount: vendorMoney(body.amount), payment_date: vendorDate(body.payment_date), payment_mode: paymentMode,
    reference_no: reference, cheque_no: chequeNo,
    note: String(body.note ?? '').trim() || null, voucher_url: body.voucher_url || null,
    idempotency_key: key === undefined ? undefined : String(key),
  };
}

export function vendorPaymentFingerprint(payment, assignment, tds = {}) {
  return createHash('sha256').update(JSON.stringify({
    ...payment, assigned_admin_id: assignment,
    tds_amount: vendorMoney(tds.tds_amount || 0, 'TDS', { zero: true }),
    tds_rate: tds.tds_rate || 0, tds_mode: tds.tds_mode || null, tds_section: tds.tds_section || null,
    tds_deductee_member_id: tds.tds_deductee_member_id || null,
    tds_deductee_name: tds.tds_deductee_name || null, tds_pan: tds.tds_pan || null,
    loyalty_vault_holder_type: tds.loyalty_vault_holder_type || null,
    loyalty_vault_holder_id: tds.loyalty_vault_holder_id || null,
    cash_deposit_holder_type: tds.cash_deposit_holder_type || null,
    cash_deposit_holder_id: tds.cash_deposit_holder_id || null,
  })).digest('hex');
}

export function translateVendorIntegrityError(error) {
  if (String(error.constraint || '').startsWith('vendor_')) error.statusCode = 409;
  return error;
}

export async function assertVendorPaymentEditable(db, payment) {
  if (payment.status !== 'pending' || payment.approved_at || payment.first_approved_at || payment.cancelled_at) {
    fail('Decided payments are retained for audit. Record a new payment or use the existing approval rejection process.', 409);
  }
  // Allocations are immutable once distributed; changing their source amount
  // would otherwise silently make the item history disagree with the payment.
  const allocated = await db.query('SELECT 1 FROM vendor_inventory_payments WHERE source_vendor_payment_id=$1 LIMIT 1', [payment.id]);
  if (allocated.rows.length) fail('This payment has inventory allocations. Retain it and record a new payment instead.', 409);
}
