import { TDS_SOURCES } from '../services/paymentTds.service.js';
// TDS register — who tax was deducted from, and when it reached the government.
// Source deductions are synchronized atomically from commission payments.
// The register and deposit references never post a second cash/bank movement.
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { TDS_FIELDS, parseDeduction, tdsDueDate, validDate } from '../utils/tds.js';
import { resolveTdsDeductee } from '../services/tdsDeductee.service.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

const siteFor = async (user, value) => {
  const siteId = Number(value);
  if (!Number.isSafeInteger(siteId) || siteId < 1) fail(400, 'site_id is required.');
  if (!ADMIN_ROLES.has(user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2 LIMIT 1', [user.id, siteId]);
    if (!rows[0]) fail(403, 'Access denied to this site');
  }
  return siteId;
};

const findRow = async (user, value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid deduction.');
  const { rows } = await pool.query('SELECT id, site_id, commission_payment_id, source_table, source_id, deposit_date FROM tds_deductions WHERE id=$1', [id]);
  if (!rows[0]) fail(404, 'Deduction not found.');
  await siteFor(user, rows[0].site_id);
  return rows[0];
};

const assertMember = async (memberId, siteId) => {
  if (memberId === null) return;
  const { rows } = await pool.query('SELECT 1 FROM members WHERE id=$1 AND site_id=$2', [memberId, siteId]);
  if (!rows[0]) fail(400, 'The selected member does not belong to this site.');
};

export const listDeductions = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  const hasDateRange = Boolean(req.query.date_from || req.query.date_to);
  const year = Number(req.query.financial_year);
  if (!hasDateRange && (!/^\d{4}$/.test(String(req.query.financial_year)) || year < 1900 || year > 2099)) fail(400, 'financial_year must be the starting year.');
  const from = hasDateRange ? (req.query.date_from ? validDate(req.query.date_from) : '1900-01-01') : `${year}-04-01`;
  const to = hasDateRange ? (req.query.date_to ? validDate(req.query.date_to) : '2100-12-31') : `${year + 1}-03-31`;
  if (!from || !to || from > to) fail(400, 'Choose a valid date range.');
  const { rows } = await pool.query(
    `SELECT t.id, t.member_id, t.deductee_name, t.pan, t.aadhaar, t.section,
       t.deduction_date::text AS deduction_date, t.gross_amount, t.tds_rate, t.tds_amount,
       (t.gross_amount-t.tds_amount) AS net_amount, t.nature, t.deposit_date::text AS deposit_date,
       t.challan_no, t.notes, t.commission_payment_id, t.source_table, t.source_id, t.source_details, COALESCE(t.source_module,'manual') AS source_module,
       COALESCE(t.calculation_mode,'manual') AS calculation_mode,
       pc.plot_id, pc.farmer_id, pc.land_deal_id, pc.id AS commission_id,
       COALESCE(t.source_label, 'Plot '||p.plot_no, 'Land purchase #'||pc.farmer_id, 'Land sale #'||pc.land_deal_id, 'Manual entry') AS source_label,
       COALESCE(pay.payment_mode,t.source_details->>'payment_mode') AS payment_mode, COALESCE(pay.transaction_id,t.source_details->>'transaction_id') AS transaction_id, COALESCE(pay.cheque_no,t.source_details->>'cheque_no') AS cheque_no, COALESCE(pay.cheque_status,t.source_details->>'cheque_status') AS cheque_status,
       COALESCE(u.name,'—') AS created_by_name, t.created_at, t.updated_at,
       CASE WHEN t.source_id IS NOT NULL THEN t.payment_state WHEN t.commission_payment_id IS NULL THEN 'active'
         WHEN lower(COALESCE(pay.status,'approved'))='rejected' OR COALESCE(pay.cheque_status,'') IN ('BOUNCED','RETURNED') THEN 'reversed'
         WHEN financial_transaction_posts(CASE WHEN pay.amount<0 THEN 'credit' ELSE 'debit' END,pay.status,pay.payment_mode,pay.cheque_status) THEN 'active'
         ELSE 'pending' END AS payment_state
     FROM tds_deductions t
     LEFT JOIN plot_commission_payments pay ON pay.id=t.commission_payment_id
     LEFT JOIN plot_commissions_v2 pc ON pc.id=pay.plot_commission_id
     LEFT JOIN plots p ON p.id=pc.plot_id
     LEFT JOIN users u ON u.id=t.created_by
     WHERE t.site_id=$1 AND t.deduction_date BETWEEN $2::date AND $3::date
     ORDER BY t.deduction_date DESC, t.id DESC`,
    [siteId, from, to],
  );
  res.json({ deductions: rows.map((row) => ({ ...row, due_date: tdsDueDate(row.deduction_date) })) });
});

export const createDeduction = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const body = req.body || {};
  const person = await resolveTdsDeductee({ tds_member_id: body.member_id, tds_deductee_name: body.deductee_name, tds_pan: body.pan, tds_aadhaar: body.aadhaar }, siteId);
  const data = parseDeduction({ ...body, member_id: person.tds_member_id, deductee_name: person.tds_deductee_name, pan: person.tds_pan, aadhaar: person.tds_aadhaar });
  await assertMember(data.member_id, siteId);
  const { rows } = await pool.query(
    `INSERT INTO tds_deductions (site_id, ${TDS_FIELDS.join(', ')}, created_by, updated_by)
     VALUES ($1, ${TDS_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, $${TDS_FIELDS.length + 2}, $${TDS_FIELDS.length + 2}) RETURNING id`,
    [siteId, ...TDS_FIELDS.map((key) => data[key]), req.user.id],
  );
  res.status(201).json({ id: rows[0].id, message: 'Deduction recorded' });
});

export const updateDeduction = asyncHandler(async (req, res) => {
  const row = await findRow(req.user, req.params.id);
  if (row.commission_payment_id || row.source_id) fail(409, 'Edit deduction details from the source payment.');
  if (row.deposit_date) fail(409, 'Deposited deductions are locked.');
  const body = req.body || {};
  const person = await resolveTdsDeductee({ tds_member_id: body.member_id, tds_deductee_name: body.deductee_name, tds_pan: body.pan, tds_aadhaar: body.aadhaar }, row.site_id);
  const data = parseDeduction({ ...body, member_id: person.tds_member_id, deductee_name: person.tds_deductee_name, pan: person.tds_pan, aadhaar: person.tds_aadhaar });
  await assertMember(data.member_id, row.site_id);
  const updated = await pool.query(
    `UPDATE tds_deductions SET ${TDS_FIELDS.map((key, i) => `${key}=$${i + 2}`).join(', ')},
       updated_by=$${TDS_FIELDS.length + 2}, updated_at=NOW() WHERE id=$1 AND deposit_date IS NULL AND commission_payment_id IS NULL AND source_id IS NULL RETURNING id`,
    [row.id, ...TDS_FIELDS.map((key) => data[key]), req.user.id],
  );
  if (!updated.rows.length) fail(409, 'Deduction is locked or was changed. Reload the register.');
  res.json({ id: row.id, message: 'Deduction updated' });
});

export const deleteDeduction = asyncHandler(async (req, res) => {
  const row = await findRow(req.user, req.params.id);
  if (row.commission_payment_id || row.source_id) fail(409, 'Delete the source payment to remove its deduction.');
  if (row.deposit_date) fail(409, 'Deposited deductions cannot be deleted.');
  const deleted = await pool.query('DELETE FROM tds_deductions WHERE id=$1 AND commission_payment_id IS NULL AND source_id IS NULL AND deposit_date IS NULL RETURNING id', [row.id]);
  if (!deleted.rows.length) fail(409, 'Deduction is locked or was changed. Reload the register.');
  res.json({ id: row.id, message: 'Deduction deleted' });
});

// One challan usually covers many deductions of a month. All-or-nothing.
export const recordDeposit = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const ids = Array.isArray(req.body?.ids) ? [...new Set(req.body.ids.map(Number))] : [];
  if (!ids.length || ids.length > 500 || ids.some((id) => !Number.isSafeInteger(id) || id < 1)) fail(400, 'Select up to 500 deductions.');
  const date = validDate(req.body.deposit_date);
  if (!date) fail(400, 'Enter a valid deposit date.');
  const challan = String(req.body.challan_no ?? '').trim().slice(0, 40);
  if (!challan) fail(400, 'Challan number is required.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Match source-write lock order: source payment, then deduction. A deposit
    // and a rejection/edit cannot both pass using stale payment state.
    await client.query(`SELECT p.id FROM plot_commission_payments p JOIN tds_deductions t ON t.commission_payment_id=p.id
      WHERE t.site_id=$1 AND t.id=ANY($2::int[]) ORDER BY p.id FOR UPDATE OF p`, [siteId, ids]);
    for (const table of [...new Set(Object.values(TDS_SOURCES).map(source => source.table))].sort()) {
      await client.query(`SELECT p.id FROM ${table} p JOIN tds_deductions t ON t.source_table=$3 AND t.source_id=p.id
        WHERE t.site_id=$1 AND t.id=ANY($2::int[]) ORDER BY p.id FOR UPDATE OF p`, [siteId, ids, table]);
    }
    const { rows } = await client.query(`SELECT t.id, t.deduction_date::text AS deduction_date, t.deposit_date,
      (CASE WHEN t.source_id IS NOT NULL THEN t.payment_state='active' ELSE t.commission_payment_id IS NULL OR financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status) END) AS active
      FROM tds_deductions t LEFT JOIN plot_commission_payments p ON p.id=t.commission_payment_id
      WHERE t.site_id=$1 AND t.id=ANY($2::int[]) ORDER BY t.id FOR UPDATE OF t`, [siteId, ids]);
    if (rows.length !== ids.length || rows.some(row => !row.active || row.deposit_date || row.deduction_date > date))
      fail(409, 'Nothing saved: a selected deduction is pending, reversed, already deposited, dated after the deposit, or outside this site.');
    await client.query(`UPDATE tds_deductions SET deposit_date=$3, challan_no=$4, updated_by=$5, updated_at=NOW()
      WHERE site_id=$1 AND id=ANY($2::int[])`, [siteId, ids, date, challan, req.user.id]);
    await client.query('COMMIT');
    res.json({ updated: rows.length, message: 'Deposit recorded' });
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
});

// Deductee lookup scoped to this module, so TDS users need no Members grant.
export const listDeductees = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, UPPER(NULLIF(TRIM(pan_no), '')) AS pan,
       NULLIF(regexp_replace(COALESCE(aadhar_no, ''), '\\D', '', 'g'), '') AS aadhaar
     FROM members WHERE site_id=$1 AND UPPER(COALESCE(to_jsonb(members)->>'status','ACTIVE')) <> 'BLOCKED'
       AND ($2='%%' OR full_name ILIKE $2 OR phone ILIKE $2 OR pan_no ILIKE $2)
     ORDER BY full_name, id`,
    [siteId, `%${q.replace(/[\\%_]/g, '\\$&')}%`],
  );
  res.json({ deductees: rows });
});
