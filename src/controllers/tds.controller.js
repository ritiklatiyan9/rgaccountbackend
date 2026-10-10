import { readTdsRegister } from '../services/tdsRegister.service.js';
import { TDS_SOURCES } from '../services/paymentTds.service.js';
// TDS register — who tax was deducted from, and when it reached the government.
// Source deductions are synchronized atomically from commission payments.
// A settlement owns its cash movement; CA challans and linked payments reuse it.
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { TDS_FIELDS, parseDeduction, validDate } from '../utils/tds.js';
import { resolveTdsDeductee } from '../services/tdsDeductee.service.js';
import { getTdsSummary, getTdsSettlements, getTdsPaymentCandidates, tdsSelection } from '../services/tdsAccounting.service.js';
import { settleTds, lockTdsDeductions } from '../services/tdsSettlement.service.js';
import { clearCacheByPrefixes } from '../config/cache.js';

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const fail = (statusCode, message) => { throw Object.assign(new Error(message), { statusCode }); };

const siteFor = async (user, value) => {
  const siteId = Number(value);
  if (!Number.isSafeInteger(siteId) || siteId < 1) fail(400, 'site_id is required.');
  if (user.organization_id != null) {
    const site = await pool.query('SELECT 1 FROM sites WHERE id=$1 AND organization_id=$2', [siteId,user.organization_id]);
    if (!site.rows.length) fail(403,'Access denied to this site');
  }
  if (!ADMIN_ROLES.has(user.role)) {
    const { rows } = await pool.query('SELECT 1 FROM user_sites WHERE user_id=$1 AND site_id=$2 LIMIT 1', [user.id, siteId]);
    if (!rows[0]) fail(403, 'Access denied to this site');
  }
  return siteId;
};

const findRow = async (user, value) => {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) fail(400, 'Invalid deduction.');
  const { rows } = await pool.query('SELECT id, site_id, commission_payment_id, source_table, source_id, deposit_date, ca_transfer_id, settlement_id FROM tds_deductions WHERE id=$1', [id]);
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
  res.json({ deductions: await readTdsRegister(siteId, { from, to }) });
});

export const createDeduction = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const body = req.body || {};
  if (body.deposit_date || body.challan_no) fail(400, 'Create the deduction first, then record its government payment from the TDS register.');
  const person = await resolveTdsDeductee({ tds_member_id: body.member_id, tds_deductee_name: body.deductee_name, tds_pan: body.pan, tds_aadhaar: body.aadhaar }, siteId);
  const data = parseDeduction({ ...body, member_id: person.tds_member_id, deductee_name: person.tds_deductee_name, pan: person.tds_pan, aadhaar: person.tds_aadhaar });
  await assertMember(data.member_id, siteId);
  const { rows } = await pool.query(
    `INSERT INTO tds_deductions (site_id, ${TDS_FIELDS.join(', ')}, created_by, updated_by)
     VALUES ($1, ${TDS_FIELDS.map((_, i) => `$${i + 2}`).join(', ')}, $${TDS_FIELDS.length + 2}, $${TDS_FIELDS.length + 2}) RETURNING id`,
    [siteId, ...TDS_FIELDS.map((key) => data[key]), req.user.id],
  );
  await clearCacheByPrefixes(['dashboard:', 'daybook', 'balance-sheet', 'tds']);
  res.status(201).json({ id: rows[0].id, message: 'Deduction recorded' });
});

export const updateDeduction = asyncHandler(async (req, res) => {
  const row = await findRow(req.user, req.params.id);
  if (row.commission_payment_id || row.source_id) fail(409, 'Edit deduction details from the source payment.');
  if (row.deposit_date || row.ca_transfer_id || row.settlement_id) fail(409, 'Funded or deposited deductions are locked.');
  const body = req.body || {};
  if (body.deposit_date || body.challan_no) fail(400, 'Record the government payment from the TDS register.');
  const person = await resolveTdsDeductee({ tds_member_id: body.member_id, tds_deductee_name: body.deductee_name, tds_pan: body.pan, tds_aadhaar: body.aadhaar }, row.site_id);
  const data = parseDeduction({ ...body, member_id: person.tds_member_id, deductee_name: person.tds_deductee_name, pan: person.tds_pan, aadhaar: person.tds_aadhaar });
  await assertMember(data.member_id, row.site_id);
  const updated = await pool.query(
    `UPDATE tds_deductions SET ${TDS_FIELDS.map((key, i) => `${key}=$${i + 2}`).join(', ')},
       updated_by=$${TDS_FIELDS.length + 2}, updated_at=NOW() WHERE id=$1 AND deposit_date IS NULL AND commission_payment_id IS NULL AND source_id IS NULL RETURNING id`,
    [row.id, ...TDS_FIELDS.map((key) => data[key]), req.user.id],
  );
  if (!updated.rows.length) fail(409, 'Deduction is locked or was changed. Reload the register.');
  await invalidateTds();
  res.json({ id: row.id, message: 'Deduction updated' });
});

export const deleteDeduction = asyncHandler(async (req, res) => {
  const row = await findRow(req.user, req.params.id);
  if (row.commission_payment_id || row.source_id) fail(409, 'Delete the source payment to remove its deduction.');
  if (row.deposit_date || row.ca_transfer_id || row.settlement_id) fail(409, 'Funded or deposited deductions cannot be deleted.');
  const deleted = await pool.query('DELETE FROM tds_deductions WHERE id=$1 AND commission_payment_id IS NULL AND source_id IS NULL AND deposit_date IS NULL RETURNING id', [row.id]);
  if (!deleted.rows.length) fail(409, 'Deduction is locked or was changed. Reload the register.');
  await invalidateTds();
  res.json({ id: row.id, message: 'Deduction deleted' });
});

// One event owns the ledger movement. An identical retry returns the same event.
const invalidateTds = () => clearCacheByPrefixes(['dashboard:', 'daybook', 'balance-sheet', 'tds']);
export const recordDeposit = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const result = await settleTds(req.user, siteId, req.body || {}, req.body?.payment_kind);
  await invalidateTds();
  res.json({ ...result, message: result.replayed ? 'Payment already recorded' : 'TDS payment recorded' });
});

export const transferToCa = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const result = await settleTds(req.user, siteId, req.body || {}, 'ca_transfer');
  await invalidateTds();
  res.json({ ...result, message: result.replayed ? 'CA transfer already recorded' : 'TDS funds transferred to CA; government deposit remains due' });
});

export const sendToCa = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.body?.site_id);
  const ids = tdsSelection(req.body?.ids);
  const caName = String(req.body?.ca_name ?? '').trim();
  if (!caName || caName.length > 200) fail(400, 'Enter a CA name of at most 200 characters.');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const rows = await lockTdsDeductions(db, siteId, ids);
    if (rows.length !== ids.length || rows.some(row => row.accounting_state !== 'active' || row.deposit_date || row.ca_transfer_id))
      fail(409, 'Select active, unpaid deductions whose funds have not already been transferred.');
    await db.query(`UPDATE tds_deductions SET ca_name=$3,ca_sent_at=COALESCE(ca_sent_at,NOW()),updated_by=$4,updated_at=NOW()
      WHERE site_id=$1 AND id=ANY($2::int[])`, [siteId, ids, caName, req.user.id]);
    await db.query('COMMIT');
    await invalidateTds();
    res.json({ updated: rows.length, message: 'CA handoff recorded. No cash or bank movement.' });
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
});

export const getAccountingSummary = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  res.json(await getTdsSummary(siteId, { ...(req.query.as_of ? { asOf: req.query.as_of } : {}) }));
});

export const listSettlements = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  res.json(await getTdsSettlements(siteId,req.query));
});

export const listPaymentCandidates = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  res.json(await getTdsPaymentCandidates(siteId,req.query));
});

// Deductee lookup scoped to this module, so TDS users need no Members grant.
export const listDeductees = asyncHandler(async (req, res) => {
  const siteId = await siteFor(req.user, req.query.site_id);
  const q = String(req.query.q ?? '').trim().slice(0, 100);
  const { rows } = await pool.query(
    `SELECT id, full_name, phone, to_jsonb(members)->>'alt_phone' AS alt_phone,
       to_jsonb(members)->>'whatsapp' AS whatsapp, UPPER(NULLIF(TRIM(pan_no), '')) AS pan,
       NULLIF(regexp_replace(COALESCE(aadhar_no, ''), '\\D', '', 'g'), '') AS aadhaar
     FROM members WHERE site_id=$1 AND UPPER(COALESCE(to_jsonb(members)->>'status','ACTIVE')) <> 'BLOCKED'
       AND ($2='%%' OR full_name ILIKE $2 OR phone ILIKE $2 OR pan_no ILIKE $2
         OR to_jsonb(members)->>'alt_phone' ILIKE $2 OR to_jsonb(members)->>'whatsapp' ILIKE $2
         OR ($3<>'' AND regexp_replace(CONCAT_WS(' ',phone,to_jsonb(members)->>'alt_phone',to_jsonb(members)->>'whatsapp'),'[^0-9]','','g') LIKE '%'||$3||'%'))
     ORDER BY full_name, id`,
    [siteId, `%${q.replace(/[\\%_]/g, '\\$&')}%`, /\d/.test(q) && !/\p{L}/u.test(q) ? q.replace(/\D/g, '').slice(-10) : ''],
  );
  res.json({ deductees: rows });
});
