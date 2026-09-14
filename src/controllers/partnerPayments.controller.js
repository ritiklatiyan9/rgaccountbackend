import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { normalizeTransactionTime, transactionTimeForWrite } from '../services/transactionTime.service.js';
import { getPartnerProfitPaid, paymentPartners, validatePartnerPayment } from '../services/partnerPayments.service.js';

const siteIdOf = (req) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) { const error = new Error('A valid site is required.'); error.statusCode = 400; throw error; }
  return id;
};

const paymentIdOf = (req) => {
  const id = Number(req.params.paymentId);
  if (!Number.isSafeInteger(id) || id <= 0) { const error = new Error('A valid payment is required.'); error.statusCode = 400; throw error; }
  return id;
};

const assertActiveSiteBank = async (bankId, siteId, db) => {
  if (!bankId) return;
  const bank = await db.query('SELECT id FROM bank_accounts WHERE id=$1 AND site_id=$2 AND is_active=true FOR SHARE', [bankId, siteId]);
  if (!bank.rows[0]) { const error = new Error('Select an active bank account belonging to this site.'); error.statusCode = 400; throw error; }
};

export const listPaymentPartners = asyncHandler(async (req, res) => {
  res.json({ partners: await paymentPartners(siteIdOf(req)) });
});

export const getPartnerPaymentSummary = asyncHandler(async (req, res) => {
  const end = req.query.end;
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(end)) || new Date(end).toISOString().slice(0, 10) !== end) return res.status(400).json({ message: 'A valid cutoff date is required.' });
  res.json({ paid: await getPartnerProfitPaid(siteIdOf(req), end) });
});

export const listPartnerPayments = asyncHandler(async (req, res) => {
  const siteId = siteIdOf(req);
  const end = req.query.end || null;
  if (end && (!/^\d{4}-\d{2}-\d{2}$/.test(end) || !Number.isFinite(Date.parse(end)) || new Date(end).toISOString().slice(0, 10) !== end)) return res.status(400).json({ message: 'Invalid cutoff date.' });
  const { rows } = await pool.query(`SELECT p.*, p.date::text AS date, m.full_name, m.phone, m.photo, b.name AS bank_name, u.name AS created_by_name,
      COALESCE(le.debit, 0)::float AS posted_amount
    FROM partner_profit_payments p JOIN members m ON m.id = p.member_id
    LEFT JOIN bank_accounts b ON b.id = p.bank_account_id
    LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN ledger_entries le ON le.source_key = 'partner_profit_payments' AND le.source_id = p.id AND le.site_id = p.site_id
    WHERE p.site_id = $1 AND ($2::date IS NULL OR p.date < $2::date)
    ORDER BY p.date DESC, p.transaction_time DESC NULLS LAST, p.id DESC`, [siteId, end]);
  res.json({ entries: rows });
});

export const createPartnerPayment = asyncHandler(async (req, res) => {
  const siteId = siteIdOf(req);
  const data = validatePartnerPayment(req.body || {});
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock($1, $2)', [siteId, req.user.id]);
    const previous = await db.query('SELECT *, date::text AS date FROM partner_profit_payments WHERE site_id=$1 AND created_by=$2 AND request_id=$3', [siteId, req.user.id, data.requestId]);
    if (previous.rows[0]) {
      const row = previous.rows[0];
      if (row.status !== 'approved') {
        await db.query('ROLLBACK');
        return res.status(409).json({ message: 'This payment has been voided. Start a new entry to record another payment.' });
      }
      if (Number(row.member_id) !== data.memberId || Number(row.amount) !== Number(data.amount) || row.payment_mode !== data.mode || String(row.date).slice(0, 10) !== data.date || row.bank_account_id !== data.bankId) {
        await db.query('ROLLBACK');
        return res.status(409).json({ message: 'This request already recorded a different payment. Reopen the entry form.' });
      }
      await db.query('COMMIT');
      return res.json({ payment: row, message: 'Payment already recorded.' });
    }
    const partners = await paymentPartners(siteId, db);
    if (!partners.some((partner) => partner.id === data.memberId)) {
      await db.query('ROLLBACK');
      return res.status(400).json({ message: 'The selected partner does not belong to this site’s profit distribution.' });
    }
    await assertActiveSiteBank(data.bankId, siteId, db);
    const { rows } = await db.query(`INSERT INTO partner_profit_payments
      (site_id, member_id, date, transaction_time, amount, payment_mode, bank_account_id, bank_reference, remarks, voucher_url, request_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [siteId, data.memberId, data.date, transactionTimeForWrite(), data.amount, data.mode, data.bankId,
      String(req.body.bank_reference || '').trim().slice(0, 200) || null,
      String(req.body.remarks || '').trim().slice(0, 2000) || null,
      req.body.voucher_url || null, data.requestId, req.user.id]);
    await db.query('COMMIT');
    res.status(201).json({ payment: rows[0], message: 'Partner profit payment recorded.' });
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
});

export const updatePartnerPayment = asyncHandler(async (req, res) => {
  const siteId = siteIdOf(req);
  const paymentId = paymentIdOf(req);
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const current = (await db.query('SELECT *, date::text AS date FROM partner_profit_payments WHERE site_id=$1 AND id=$2 FOR UPDATE', [siteId, paymentId])).rows[0];
    if (!current) { await db.query('ROLLBACK'); return res.status(404).json({ message: 'Payment not found.' }); }
    if (current.entry_transfer_id) { await db.query('ROLLBACK'); return res.status(409).json({ message: 'This payment belongs to a balanced transfer and cannot be edited. Open the transfer history from its original entry.' }); }
    if (current.status !== 'approved') { await db.query('ROLLBACK'); return res.status(409).json({ message: 'A voided payment cannot be edited. Delete it or record a new payment.' }); }

    const data = validatePartnerPayment({
      member_id: current.member_id,
      amount: req.body.amount ?? current.amount,
      date: req.body.date ?? current.date,
      payment_mode: req.body.payment_mode ?? current.payment_mode,
      bank_account_id: Object.hasOwn(req.body, 'bank_account_id') ? req.body.bank_account_id : current.bank_account_id,
      request_id: current.request_id,
    });
    await assertActiveSiteBank(data.bankId, siteId, db);
    const transactionTime = Object.hasOwn(req.body, 'transaction_time')
      ? normalizeTransactionTime(req.body.transaction_time)
      : current.transaction_time;
    const { rows } = await db.query(`UPDATE partner_profit_payments SET
        date=$3, transaction_time=$4, amount=$5, payment_mode=$6, bank_account_id=$7,
        bank_reference=$8, remarks=$9
      WHERE site_id=$1 AND id=$2 RETURNING *, date::text AS date`, [
      siteId, paymentId, data.date, transactionTime, data.amount, data.mode, data.bankId,
      Object.hasOwn(req.body, 'bank_reference') ? String(req.body.bank_reference || '').trim().slice(0, 200) || null : current.bank_reference,
      Object.hasOwn(req.body, 'remarks') ? String(req.body.remarks || '').trim().slice(0, 2000) || null : current.remarks,
    ]);
    await db.query('COMMIT');
    res.json({ payment: rows[0], message: 'Partner profit payment updated.' });
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
});

export const deletePartnerPayment = asyncHandler(async (req, res) => {
  const siteId = siteIdOf(req);
  const paymentId = paymentIdOf(req);
  const { rows } = await pool.query(
    'DELETE FROM partner_profit_payments WHERE site_id=$1 AND id=$2 AND entry_transfer_id IS NULL RETURNING id',
    [siteId, paymentId]
  );
  if (!rows[0]) {
    const existing = await pool.query('SELECT entry_transfer_id FROM partner_profit_payments WHERE site_id=$1 AND id=$2', [siteId, paymentId]);
    if (existing.rows[0]?.entry_transfer_id) return res.status(409).json({ message: 'This payment belongs to a balanced transfer and cannot be deleted.' });
    return res.status(404).json({ message: 'Payment not found. Refresh the history.' });
  }
  res.json({ message: 'Partner profit payment deleted from profit history and the daybook.' });
});

export const voidPartnerPayment = asyncHandler(async (req, res) => {
  const reason = String(req.body?.reason || '').trim().slice(0, 2000);
  if (!reason) return res.status(400).json({ message: 'Enter a reason for voiding this payment.' });
  const paymentId = paymentIdOf(req);
  const siteId = siteIdOf(req);
  const { rows } = await pool.query(`UPDATE partner_profit_payments SET status='rejected', voided_by=$3, voided_at=NOW(), void_reason=$4
    WHERE site_id=$1 AND id=$2 AND status='approved' AND entry_transfer_id IS NULL RETURNING *`, [siteId, paymentId, req.user.id, reason]);
  if (!rows[0]) {
    const existing = await pool.query('SELECT entry_transfer_id FROM partner_profit_payments WHERE site_id=$1 AND id=$2', [siteId, paymentId]);
    if (existing.rows[0]?.entry_transfer_id) return res.status(409).json({ message: 'This payment belongs to a balanced transfer and cannot be voided.' });
    return res.status(409).json({ message: 'Payment was not found or has already been voided. Refresh the history.' });
  }
  res.json({ payment: rows[0], message: 'Payment voided; its ledger debit has been reversed.' });
});
