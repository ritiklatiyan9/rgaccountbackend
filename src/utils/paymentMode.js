// Canonical payment-mode bucketing used by Day Book aggregates.
// Keeps classification consistent across backend (getModeBalance,
// listDayBookEntries) and mirrors what the frontend filter expects.

const BUCKETS = ['cash', 'bank', 'cheque', 'upi', 'other'];

// Normalise an arbitrary mode string to a canonical bucket key.
// Returns one of: 'cash' | 'bank' | 'cheque' | 'upi' | 'other'.
export function classifyPaymentMode(raw) {
  if (raw === null || raw === undefined) return 'other';
  const s = String(raw).trim().toUpperCase();
  if (!s) return 'other';
  if (s === 'CASH') return 'cash';
  if (s === 'CHEQUE' || s === 'CHQ') return 'cheque';
  if (s === 'UPI' || s === 'GPAY' || s === 'PHONEPE' || s === 'PAYTM') return 'upi';
  if (s === 'BANK' || s === 'NEFT' || s === 'RTGS' || s === 'IMPS' || s === 'ONLINE' || s === 'TRANSFER' || s === 'NET BANKING' || s === 'NETBANKING') return 'bank';
  // Default: any unrecognised non-empty mode is treated as "other" so it
  // does not silently get pooled into Bank.
  return 'other';
}

export function emptyBucketMap() {
  const m = {};
  for (const k of BUCKETS) m[k] = { credit: 0, debit: 0 };
  return m;
}

export { BUCKETS };
