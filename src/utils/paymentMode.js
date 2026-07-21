// Canonical payment-mode bucketing used by Day Book aggregates.
// Must mirror rgaccount/src/utils/paymentMode.js and the SQL ledger_bucket()
// function (migration 079) — all three implement the same rule.
//
// Two buckets only, by owner mandate (2026-07-21): CASH is cash; every other
// mode — cheque, UPI, IMPS, NEFT, RTGS, transfer — settles through a bank
// account and is therefore Bank. Blank/unknown falls to cash, matching how
// the modules that leave the field empty actually record their entries.

const BUCKETS = ['cash', 'bank'];

// Normalise an arbitrary mode string to a canonical bucket key.
// Returns 'cash' | 'bank'.
export function classifyPaymentMode(raw) {
  const s = String(raw ?? '').trim().toUpperCase();
  return !s || s === 'CASH' ? 'cash' : 'bank';
}

export function emptyBucketMap() {
  const m = {};
  for (const k of BUCKETS) m[k] = { credit: 0, debit: 0 };
  return m;
}

export { BUCKETS };
