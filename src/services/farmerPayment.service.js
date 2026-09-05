export const FARMER_PAYMENT_MODES = Object.freeze(['CASH', 'BANK', 'CHEQUE', 'SPLIT']);
export const FARMER_PAYMENT_DAYBOOK_MODES = Object.freeze([
  ...FARMER_PAYMENT_MODES,
  'RTGS',
  'CASH PLOT PAYMENT',
  'CASH REFUND PLOT PAYMENT',
  'PAY ADVANCE',
  'NEFT',
  'UPI',
  'BANK TRANSFER',
]);

const PAYMENT_FIELDS = Object.freeze([
  'amount',
  'payment_mode',
  'cash_amount',
  'bank_amount',
  'transaction_type',
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key)
  && value[key] !== undefined;

const roundMoney = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

export class FarmerPaymentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FarmerPaymentValidationError';
    this.statusCode = 400;
    this.code = 'INVALID_FARMER_PAYMENT';
  }
}

const money = (value, label) => {
  if (value === '' || value === null || value === undefined) {
    throw new FarmerPaymentValidationError(`${label} is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new FarmerPaymentValidationError(`${label} must be a valid number`);
  }
  return roundMoney(parsed);
};

const optionalMoneyIsFinite = (input, key, label) => {
  if (!hasOwn(input, key)) return;
  money(input[key], label);
};

/**
 * True only when an update explicitly touches the coupled accounting tuple.
 * An unrelated edit must not force old negative correction rows through the
 * newer normal-payment validation rules.
 */
export const farmerPaymentFieldsTouched = (input = {}) => PAYMENT_FIELDS.some((key) => hasOwn(input, key));

/**
 * Day Book retains its detailed settlement label in `particular`, while the
 * farmer-payment owner stores one canonical accounting bucket. Per the shared
 * ledger rule, exact CASH is cash, CHEQUE keeps its clearance workflow, and
 * the remaining named Day Book methods settle through BANK.
 */
export const canonicalFarmerPaymentModeFromDayBook = (rawMode, fallback = null) => {
  const detailedMode = String(rawMode ?? '').trim().toUpperCase();
  if (!detailedMode) {
    if (fallback && FARMER_PAYMENT_MODES.includes(String(fallback).trim().toUpperCase())) {
      return String(fallback).trim().toUpperCase();
    }
    throw new FarmerPaymentValidationError('Payment mode is required');
  }
  if (!FARMER_PAYMENT_DAYBOOK_MODES.includes(detailedMode)) {
    throw new FarmerPaymentValidationError('Unsupported farmer payment mode');
  }
  if (FARMER_PAYMENT_MODES.includes(detailedMode)) return detailedMode;
  return 'BANK';
};

/**
 * Canonicalise the farmer payment accounting tuple.
 *
 * Normal payments are debit-only: a non-SPLIT amount is positive and SPLIT is
 * the exact sum of its non-negative cash and bank legs. The product also has an
 * explicit "credit / recovered" workflow. Only transaction_type=credit may
 * create a negative correction; its supplied magnitude is canonicalised to a
 * negative amount/leg and therefore never becomes an imprest debit.
 *
 * `existing` is used only to merge a partial update. Call this function for an
 * update only when farmerPaymentFieldsTouched(input) is true; doing so preserves
 * legitimate legacy negative rows during unrelated edits.
 */
export const normalizeFarmerPaymentInput = (input = {}, existing = null) => {
  const current = existing || {};
  const rawMode = hasOwn(input, 'payment_mode')
    ? input.payment_mode
    : (current.payment_mode ?? 'CASH');
  let mode = String(rawMode ?? '').trim().toUpperCase();
  // Untouched legacy Day Book owners can still carry RTGS/NEFT/etc. in the
  // payment_mode column. A later tuple edit safely migrates that old mode to
  // BANK; newly submitted owner modes remain strict.
  if (!hasOwn(input, 'payment_mode')
      && !FARMER_PAYMENT_MODES.includes(mode)
      && FARMER_PAYMENT_DAYBOOK_MODES.includes(mode)) {
    mode = canonicalFarmerPaymentModeFromDayBook(mode);
  }
  if (!FARMER_PAYMENT_MODES.includes(mode)) {
    throw new FarmerPaymentValidationError(
      `Payment mode must be one of ${FARMER_PAYMENT_MODES.join(', ')}`
    );
  }

  let transactionType = null;
  if (hasOwn(input, 'transaction_type')) {
    transactionType = String(input.transaction_type ?? '').trim().toLowerCase();
    if (!['debit', 'credit'].includes(transactionType)) {
      throw new FarmerPaymentValidationError('Transaction type must be debit or credit');
    }
  }
  const isExplicitReversal = transactionType === 'credit';

  // Even fields ignored by the selected mode must not carry malformed values.
  optionalMoneyIsFinite(input, 'amount', 'Amount');
  optionalMoneyIsFinite(input, 'cash_amount', 'Cash amount');
  optionalMoneyIsFinite(input, 'bank_amount', 'Bank amount');

  if (mode === 'SPLIT') {
    const switchingToSplit = String(current.payment_mode || '').trim().toUpperCase() !== 'SPLIT';
    const hasCash = hasOwn(input, 'cash_amount');
    const hasBank = hasOwn(input, 'bank_amount');
    if (switchingToSplit && (!hasCash || !hasBank)) {
      throw new FarmerPaymentValidationError(
        'Cash amount and bank amount are both required when selecting SPLIT'
      );
    }

    const rawCash = hasCash ? input.cash_amount : (current.cash_amount ?? 0);
    const rawBank = hasBank ? input.bank_amount : (current.bank_amount ?? 0);
    const parsedCash = money(rawCash, 'Cash amount');
    const parsedBank = money(rawBank, 'Bank amount');

    if (isExplicitReversal) {
      const cashMagnitude = roundMoney(Math.abs(parsedCash));
      const bankMagnitude = roundMoney(Math.abs(parsedBank));
      const totalMagnitude = roundMoney(cashMagnitude + bankMagnitude);
      if (totalMagnitude <= 0) {
        throw new FarmerPaymentValidationError('Recovered amount must be greater than zero');
      }
      return {
        payment_mode: mode,
        amount: -totalMagnitude,
        cash_amount: -cashMagnitude,
        bank_amount: -bankMagnitude,
      };
    }

    if (parsedCash < 0 || parsedBank < 0) {
      throw new FarmerPaymentValidationError(
        'Cash amount and bank amount cannot be negative for a farmer payment'
      );
    }
    const total = roundMoney(parsedCash + parsedBank);
    if (total <= 0) {
      throw new FarmerPaymentValidationError('Farmer payment amount must be greater than zero');
    }

    // A generic Day Book edit can carry the unchanged summary without the two
    // leg fields. Refuse only an attempted total change that cannot be allocated.
    if (!hasCash && !hasBank && hasOwn(input, 'amount')) {
      const submittedTotal = money(input.amount, 'Amount');
      if (Math.abs(submittedTotal - total) > 0.005) {
        throw new FarmerPaymentValidationError(
          'Cash amount and bank amount are required when changing a SPLIT total'
        );
      }
    }

    return {
      payment_mode: mode,
      amount: total,
      cash_amount: parsedCash,
      bank_amount: parsedBank,
    };
  }

  const rawAmount = hasOwn(input, 'amount') ? input.amount : current.amount;
  const parsedAmount = money(rawAmount, 'Amount');
  if (isExplicitReversal) {
    const magnitude = roundMoney(Math.abs(parsedAmount));
    if (magnitude <= 0) {
      throw new FarmerPaymentValidationError('Recovered amount must be greater than zero');
    }
    const signedAmount = -magnitude;
    return {
      payment_mode: mode,
      amount: signedAmount,
      cash_amount: mode === 'CASH' ? signedAmount : 0,
      bank_amount: mode === 'CASH' ? 0 : signedAmount,
    };
  }

  if (parsedAmount <= 0) {
    throw new FarmerPaymentValidationError('Farmer payment amount must be greater than zero');
  }
  return {
    payment_mode: mode,
    amount: parsedAmount,
    cash_amount: mode === 'CASH' ? parsedAmount : 0,
    bank_amount: mode === 'CASH' ? 0 : parsedAmount,
  };
};

export const farmerPaymentHasPositiveOutflow = (payment = {}) => {
  const mode = String(payment.payment_mode || '').trim().toUpperCase();
  if (mode === 'SPLIT') {
    return Math.max(Number(payment.cash_amount) || 0, 0)
      + Math.max(Number(payment.bank_amount) || 0, 0) > 0;
  }
  return (Number(payment.amount) || 0) > 0;
};

/**
 * Rebuild every linked Day Book presentation leg from the canonical owner.
 * The caller supplies a transaction-bound client; deleting stale legs and
 * inserting the new 0/1/2 legs therefore commits or rolls back with the owner.
 */
export const rebuildFarmerPaymentDayBook = async (db, paymentId) => {
  const result = await db.query(
    `WITH source AS (
       SELECT fp.*, f.site_id, f.name AS farmer_name
         FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
        WHERE fp.id = $1
     ), deleted AS (
       DELETE FROM day_book WHERE farmer_payment_id = $1
     ), legs AS (
       SELECT s.*, 'CASH'::text AS leg_type,
              CASE
                WHEN UPPER(COALESCE(s.payment_mode, '')) = 'SPLIT' THEN COALESCE(s.cash_amount, 0)
                WHEN UPPER(COALESCE(s.payment_mode, 'CASH')) = 'CASH' THEN COALESCE(s.amount, 0)
                ELSE 0::numeric
              END AS leg_amount
         FROM source s
       UNION ALL
       SELECT s.*, 'BANK'::text AS leg_type,
              CASE
                WHEN UPPER(COALESCE(s.payment_mode, '')) = 'SPLIT' THEN COALESCE(s.bank_amount, 0)
                WHEN UPPER(COALESCE(s.payment_mode, 'CASH')) IN ('BANK', 'CHEQUE') THEN COALESCE(s.amount, 0)
                ELSE 0::numeric
              END AS leg_amount
         FROM source s
     )
     INSERT INTO day_book (
       site_id, date, particular, entry_type, debit, credit, remarks,
       payment_mode, category, from_entity, to_entity, account_no, branch,
       voucher_url, status, approved_by, approved_at, cheque_no, cheque_status,
       created_by, assigned_admin_id, farmer_payment_id, transaction_time
     )
     SELECT
       l.site_id,
       l.date,
       UPPER(l.farmer_name) || ' - FARMER PAYMENT (' || l.leg_type || ')',
       'FARMER PAYMENT',
       l.leg_amount,
       0,
       CASE WHEN l.leg_type = 'BANK' THEN NULLIF(CONCAT_WS(' | ',
         NULLIF(TRIM(l.remarks), ''),
         CASE WHEN NULLIF(TRIM(l.bank_reference), '') IS NOT NULL THEN 'Ref: ' || TRIM(l.bank_reference) END,
         CASE WHEN NULLIF(TRIM(l.bank_name), '') IS NOT NULL THEN 'Bank: ' || TRIM(l.bank_name) END
       ), '') ELSE NULLIF(TRIM(l.remarks), '') END,
       CASE WHEN l.leg_type = 'CASH' THEN 'CASH'
            ELSE UPPER(COALESCE(NULLIF(TRIM(l.particular), ''), l.payment_mode, 'BANK')) END,
       'FARMER PAYMENT',
       CASE WHEN l.leg_type = 'BANK' THEN UPPER(NULLIF(TRIM(l.bank_name), '')) END,
       UPPER(l.farmer_name),
       CASE WHEN l.leg_type = 'BANK' THEN l.bank_account_no END,
       CASE WHEN l.leg_type = 'BANK' THEN l.bank_ifsc END,
       l.voucher_url,
       l.status,
       l.approved_by,
       l.approved_at,
       CASE WHEN UPPER(COALESCE(l.payment_mode, '')) = 'CHEQUE' THEN l.cheque_no END,
       CASE WHEN UPPER(COALESCE(l.payment_mode, '')) = 'CHEQUE' THEN l.cheque_status END,
       l.created_by,
       l.assigned_admin_id,
       l.id,
       l.transaction_time
     FROM legs l
     WHERE l.leg_amount > 0
     ORDER BY CASE WHEN l.leg_type = 'CASH' THEN 1 ELSE 2 END
     RETURNING *`,
    [Number(paymentId)]
  );
  return result.rows;
};
