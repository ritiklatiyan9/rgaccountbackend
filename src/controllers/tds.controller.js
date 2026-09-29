// TDS register — who tax was deducted from, and when it reached the government.
// Record-only: rows never post to the ledger. The challan deposit is already the
// "TDS PAYMENT" expense, so nothing here can change a balance.
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { TDS_FIELDS, parseDeduction, tdsDueDate, validDate } from '../utils/tds.js';

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
  const { rows } = await pool.query('SELECT id, site_id FROM tds_deductions WHERE id=$1', [id]);
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
    `SELECT id, member_id, deductee_name, pan, aadhaar, section, deduction_date::text AS deduction_date,
       gross_amount, tds_rate, tds_amount, nature, deposit_date::text AS deposit_date, challan_no, notes
     FROM tds_deductions WHERE site_id=$1 AND deduction_date BETWEEN $2::date AND $3::date
     ORDER BY deduction_date DESC, id DESC`,
    [siteId, from, to],
  );
  res.json({ deductions: rows.map((row) => ({ ...row, due_date: tdsDueDate(row.deduction_date) })) });
});

export const createDeduction = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const data = parseDeduction(req.body || {});
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
  const data = parseDeduction(req.body || {});
  await assertMember(data.member_id, row.site_id);
  await pool.query(
    `UPDATE tds_deductions SET ${TDS_FIELDS.map((key, i) => `${key}=$${i + 2}`).join(', ')},
       updated_by=$${TDS_FIELDS.length + 2}, updated_at=NOW() WHERE id=$1`,
    [row.id, ...TDS_FIELDS.map((key) => data[key]), req.user.id],
  );
  res.json({ id: row.id, message: 'Deduction updated' });
});

export const deleteDeduction = asyncHandler(async (req, res) => {
  const row = await findRow(req.user, req.params.id);
  await pool.query('DELETE FROM tds_deductions WHERE id=$1', [row.id]);
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
  const { rows } = await pool.query(
    `UPDATE tds_deductions SET deposit_date=$3, challan_no=$4, updated_by=$5, updated_at=NOW()
     WHERE site_id=$1 AND id=ANY($2::int[])
       AND (SELECT COUNT(*) FROM tds_deductions x WHERE x.site_id=$1 AND x.id=ANY($2::int[]) AND x.deduction_date <= $3::date) = cardinality($2::int[])
     RETURNING id`,
    [siteId, ids, date, challan, req.user.id],
  );
  if (rows.length !== ids.length) fail(400, 'Nothing saved: a selected deduction is dated after the deposit date or is not in this site.');
  res.json({ updated: rows.length, message: 'Deposit recorded' });
});

// Deductee lookup scoped to this module, so TDS users need no Members grant.
export const listDeductees = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  if (q.length < 2) return res.json({ deductees: [] });
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, UPPER(NULLIF(TRIM(pan_no), '')) AS pan,
       NULLIF(regexp_replace(COALESCE(aadhar_no, ''), '\\D', '', 'g'), '') AS aadhaar
     FROM members WHERE site_id=$1 AND (full_name ILIKE $2 OR phone ILIKE $2 OR pan_no ILIKE $2)
     ORDER BY full_name LIMIT 20`,
    [siteId, `%${q.replace(/[\\%_]/g, '\\$&')}%`],
  );
  res.json({ deductees: rows });
});
