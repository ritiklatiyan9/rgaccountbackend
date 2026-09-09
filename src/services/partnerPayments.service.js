import pool from '../config/db.js';

export const PAYMENT_MODES = ['CASH', 'BANK', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER'];
const invalid = (message) => { const error = new Error(message); error.statusCode = 400; throw error; };

export function validatePartnerPayment(body) {
  const memberId = Number(body.member_id);
  if (!Number.isSafeInteger(memberId) || memberId <= 0) invalid('Select a valid partner.');
  const amount = String(body.amount ?? '').trim();
  if (!/^\d{1,13}(\.\d{1,2})?$/.test(amount) || !(Number(amount) > 0)) invalid('Enter a positive amount with at most two decimal places.');
  const date = String(body.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) invalid('Enter a valid payment date.');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  if (date < '1900-01-01') invalid('Payment date must be on or after 1900-01-01.');
  if (date > today) invalid('Paid transactions cannot have a future date.');
  if (!PAYMENT_MODES.includes(body.payment_mode)) invalid('Select a supported payment mode. Record cheques only after clearance as a bank payment.');
  const bankId = body.payment_mode === 'CASH' ? null : Number(body.bank_account_id);
  if (bankId !== null && (!Number.isSafeInteger(bankId) || bankId <= 0)) invalid('Select the paying bank account.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(body.request_id || ''))) invalid('A payment request ID is required. Reopen the entry form.');
  return { memberId, amount, date, mode: body.payment_mode, bankId, requestId: body.request_id };
}

// Includes land-only partners and historical recipients even after a share is removed.
export async function paymentPartners(siteId, db = pool) {
  const { rows } = await db.query(`SELECT m.id, m.id AS member_id, m.full_name, m.phone, m.photo, COALESCE(sps.share_pct, 0)::float AS share_pct FROM members m
    LEFT JOIN site_partner_shares sps ON sps.member_id = m.id AND sps.site_id = $1
    WHERE m.id IN (
      SELECT member_id FROM site_partner_shares WHERE site_id = $1
      UNION SELECT lps.member_id FROM land_partner_shares lps JOIN farmers f ON f.id = lps.farmer_id WHERE f.site_id = $1
      UNION SELECT member_id FROM partner_profit_payments WHERE site_id = $1
    ) ORDER BY m.full_name, m.id`, [siteId]);
  return rows;
}

export async function partnerPaidByMember(siteId, end, db = pool) {
  const { rows } = await db.query(`SELECT p.member_id, m.full_name, m.phone, m.photo,
      COALESCE(SUM(le.debit), 0)::float AS paid, COUNT(le.id)::int AS payment_count
    FROM partner_profit_payments p JOIN members m ON m.id = p.member_id
    LEFT JOIN ledger_entries le ON le.source_key = 'partner_profit_payments' AND le.source_id = p.id
      AND le.site_id = p.site_id AND le.entry_date < $2::date
    WHERE p.site_id = $1 AND p.date < $2::date
    GROUP BY p.member_id, m.full_name, m.phone, m.photo`, [siteId, end]);
  return rows;
}

export async function getPartnerProfitPaid(siteId, end, db = pool) {
  const { rows } = await db.query(`SELECT COALESCE(SUM(debit), 0)::float AS paid FROM ledger_entries
    WHERE site_id = $1 AND entry_date < $2::date AND source_key = 'partner_profit_payments'`, [siteId, end]);
  return Number(rows[0].paid);
}
