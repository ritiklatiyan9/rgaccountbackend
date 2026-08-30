import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType, verifyReceiptToken } from '../utils/receiptToken.js';

/**
 * Public half of the receipt QR flow. The token contains only display fields
 * and is HMAC signed, so verification does not expose any account data or
 * require a signed-in user.
 */
export const verifyPublicReceipt = (req, res) => {
  const result = verifyReceiptToken(req.query?.token);
  if (!result.valid) {
    return res.status(400).json({ valid: false, message: result.reason });
  }

  return res.json({ valid: true, receipt: result.payload });
};

/**
 * Mints the signed verify URL behind a receipt QR for a record that was just
 * created. The module list endpoints already attach `verifyUrl` to every row,
 * but the create endpoints don't return one — so a receipt printed straight
 * after saving (Quick Entry) had no QR to embed.
 *
 * The token is display-only and HMAC-signed; every field is read from the
 * stored row here, so a caller can't mint a receipt for data that isn't real.
 */
const MODULES = {
  expense: {
    type: ReceiptType.EXPENSE,
    query: `SELECT e.id, e.date, e.debit, e.credit, e.payment_mode,
                   COALESCE(e.to_entity, e.from_entity) AS party, e.category AS detail,
                   e.site_id
              FROM expenses e WHERE e.id = $1`,
  },
  farmer_payment: {
    type: ReceiptType.FARMER,
    query: `SELECT fp.id, fp.date, ABS(fp.amount) AS debit, 0 AS credit, fp.payment_mode,
                   f.name AS party, fp.particular AS detail, f.site_id
              FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id
             WHERE fp.id = $1`,
  },
  cashflow_entry: {
    type: ReceiptType.DAYBOOK,
    query: `SELECT c.id, c.date, c.debit, c.credit, c.cash_type AS payment_mode,
                   c.particular AS party, NULL::text AS detail, c.site_id
              FROM cash_flow_entries c WHERE c.id = $1`,
  },
  daybook: {
    type: ReceiptType.DAYBOOK,
    query: `SELECT d.id, d.date, d.debit, d.credit, d.payment_mode,
                   COALESCE(d.to_entity, d.from_entity, d.particular) AS party,
                   d.entry_type AS detail, d.site_id
              FROM day_book d WHERE d.id = $1`,
  },
  firm_transaction: {
    type: ReceiptType.DAYBOOK,
    query: `SELECT t.id, t.date, t.debit, t.credit, t.payment_mode,
                   f.name AS party, t.description AS detail, t.site_id
              FROM firm_transactions t LEFT JOIN firms f ON f.id = t.firm_id
             WHERE t.id = $1`,
  },
  plot_payment: {
    type: ReceiptType.PLOT,
    query: `SELECT p.id, p.date, 0 AS debit, ABS(p.amount) AS credit,
                   p.payment_type AS payment_mode, p.buyer_name AS party,
                   pl.plot_no AS detail, p.site_id
              FROM plot_payments p LEFT JOIN plots pl ON pl.id = p.plot_id
             WHERE p.id = $1`,
  },
  commission_payment: {
    type: ReceiptType.COMMISSION,
    query: `SELECT pcp.id, pcp.date, ABS(pcp.amount) AS debit, 0 AS credit, pcp.payment_mode,
                   m.full_name AS party, pl.plot_no AS detail, pcp.site_id
              FROM plot_commission_payments pcp
              LEFT JOIN plot_commissions_v2 pcm ON pcm.id = pcp.plot_commission_id
              LEFT JOIN plots pl ON pl.id = pcm.plot_id
              LEFT JOIN members m ON m.id = pcm.agent_id
             WHERE pcp.id = $1`,
  },
};

/** GET /receipts/verify-url?module=expense&id=123 */
export const getReceiptVerifyUrl = asyncHandler(async (req, res) => {
  const config = MODULES[req.query.module];
  if (!config) return res.status(400).json({ message: 'Unknown receipt module' });

  const id = parseInt(req.query.id, 10);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Invalid id' });

  const { rows } = await pool.query(config.query, [id]);
  const row = rows[0];
  if (!row) return res.status(404).json({ message: 'Record not found' });

  // Admins print for any assigned site; others must hold the site.
  if (req.user.role !== 'admin' && req.user.role !== 'super_admin' && row.site_id) {
    const access = await pool.query(
      'SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1',
      [req.user.id, row.site_id]
    );
    if (!access.rows[0]) return res.status(403).json({ message: 'Access denied to this site' });
  }

  const siteRes = await pool.query('SELECT name, city, state FROM sites WHERE id = $1', [row.site_id]);
  const site = siteRes.rows[0] || null;
  const debit = parseFloat(row.debit) || 0;
  const credit = parseFloat(row.credit) || 0;

  res.json({
    verifyUrl: buildVerifyUrl({
      t: config.type,
      i: `${req.query.module}_${row.id}`,
      a: Math.abs(debit || credit),
      dr: debit > 0 ? 'OUT' : 'IN',
      d: row.date,
      pm: row.payment_mode || null,
      pn: row.party || null,
      pl: row.detail || null,
      sn: site?.name || null,
      sy: site?.city || null,
      ss: site?.state || null,
    }),
  });
});
