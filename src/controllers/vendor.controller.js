import { attachModuleChequeDates } from '../services/chequeDates.service.js';
import { tdsInsertColumns, tdsInsertValues, tdsUpdateSet, withPaymentTds } from '../services/paymentTds.service.js';
import { transactionTimeForWrite } from '../services/transactionTime.service.js';
import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { canUserViewEntry, resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { transactionMovesMoney } from '../utils/transactionPosting.js';

import { assertVendorCommitmentAccess } from '../middlewares/vendorAccess.middleware.js';
import { validateConstructionAssignment, recordConstructionActivity, markProjectCommitted } from '../services/constructionWorkflow.service.js';
import { normalizeVendorPayment, vendorPaymentFingerprint, translateVendorIntegrityError, assertVendorPaymentEditable, vendorMoney, vendorDate } from '../services/vendorPaymentIntegrity.service.js';

const asInt = (v) => /^\d+$/.test(String(v ?? '')) && Number.isSafeInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN;
const projectScope = (req, alias, values) => {
  if (!req.vendorProjectIds) return '';
  values.push(req.vendorProjectIds);
  return ` AND (${alias}.project_id IS NULL OR ${alias}.project_id=ANY($${values.length}::int[]))`;
};

const getSiteId = (req) => {
  const siteId = asInt(req.query.site_id || req.body.site_id);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
};

const resolveProjectLocation = async (siteId, projectIdValue, locationIdValue, client = pool) => {
  const projectId = projectIdValue ? asInt(projectIdValue) : null;
  const locationId = locationIdValue ? asInt(locationIdValue) : null;
  if (!projectId && locationId) return { error: 'Select a project before selecting a location' };
  if (!projectId) return { projectId: null, locationId: null };
  const project = await client.query('SELECT 1 FROM construction_projects WHERE id = $1 AND site_id = $2', [projectId, siteId]);
  if (!project.rows[0]) return { error: 'Selected project is invalid for this site' };
  if (locationId) {
    const location = await client.query('SELECT 1 FROM construction_locations WHERE id = $1 AND project_id = $2', [locationId, projectId]);
    if (!location.rows[0]) return { error: 'Selected location is invalid for this project' };
  }
  return { projectId, locationId };
};

export const getVendorUsers = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT id, full_name, phone, business_name, service_type
     FROM members
     WHERE site_id = $1
       AND member_type = 'VENDOR'
       AND COALESCE(status, 'ACTIVE') != 'BLOCKED'
     ORDER BY full_name ASC`,
    [siteId]
  );

  res.json({ vendors: result.rows });
});

export const createVendorUser = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const fullName = (req.body.full_name || '').trim();
  const phone = (req.body.phone || '').trim() || null;
  const businessName = (req.body.business_name || '').trim() || null;
  const serviceType = (req.body.service_type || '').trim() || null;

  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!fullName) return res.status(400).json({ message: 'Vendor name is required' });

  const result = await pool.query(
    `INSERT INTO members (site_id, full_name, phone, business_name, service_type, member_type, status, created_by)
     VALUES ($1, $2, $3, $4, $5, 'VENDOR', 'ACTIVE', $6)
     RETURNING id, full_name, phone, business_name, service_type`,
    [siteId, fullName.toUpperCase(), phone, businessName, serviceType, req.user?.id || null]
  );

  res.status(201).json({ vendor: result.rows[0] });
});

// Vendor users need a small, read-only construction lookup without receiving
// broad Construction permissions. This keeps the modules separable while
// allowing a contract to be assigned to a project/location.
export const listConstructionProjectOptions = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const [projects, locations] = await Promise.all([
    pool.query(
      `SELECT id, name, code, project_type, status
         FROM construction_projects WHERE site_id = $1 AND status <> 'CANCELLED'
          ${req.vendorProjectIds ? `AND id=ANY(ARRAY[${req.vendorProjectIds.join(',')}]::int[])` : ''}
        ORDER BY status = 'ACTIVE' DESC, name`,
      [siteId]
    ),
    pool.query(
      `WITH RECURSIVE tree AS (
         SELECT l.id, l.project_id, l.parent_id, l.name, l.location_type, l.name::text AS path, 0 AS depth
           FROM construction_locations l JOIN construction_projects p ON p.id = l.project_id
          WHERE p.site_id = $1 AND l.parent_id IS NULL
            ${req.vendorProjectIds ? `AND p.id=ANY(ARRAY[${req.vendorProjectIds.join(',')}]::int[])` : ''}
         UNION ALL
         SELECT child.id, child.project_id, child.parent_id, child.name, child.location_type,
                (tree.path || ' / ' || child.name)::text, tree.depth + 1
           FROM construction_locations child JOIN tree ON tree.id = child.parent_id
       ) SELECT * FROM tree ORDER BY project_id, path`,
      [siteId]
    ),
  ]);
  res.json({ projects: projects.rows, locations: locations.rows });
});

export const listVendorHeads = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT vh.id, vh.site_id, vh.name, vh.is_active, vh.created_at,
            COALESCE(c.cnt, 0)::int AS commitment_count
     FROM vendor_heads vh
     LEFT JOIN (
       SELECT head_id, COUNT(*) AS cnt
       FROM vendor_commitments
       WHERE site_id=$1 ${req.vendorProjectIds ? `AND (project_id IS NULL OR project_id=ANY(ARRAY[${req.vendorProjectIds.join(',')}]::int[]))` : ''}
       GROUP BY head_id
     ) c ON c.head_id = vh.id
     WHERE vh.site_id = $1
     ORDER BY LOWER(vh.name) ASC`,
    [siteId]
  );

  res.json({ heads: result.rows });
});

export const createVendorHead = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const name = (req.body.name || '').trim();

  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!name) return res.status(400).json({ message: 'Head name is required' });

  const result = await pool.query(
    `INSERT INTO vendor_heads (site_id, name, created_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, name)
     DO UPDATE SET
       is_active = TRUE,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, site_id, name, is_active, created_at`,
    [siteId, name.toUpperCase(), req.user.id]
  );

  res.status(201).json({ head: result.rows[0] });
});

export const deleteVendorHead = asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  const siteId = getSiteId(req);

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid head id' });

  const existing = await pool.query(
    'SELECT id FROM vendor_heads WHERE id = $1 AND site_id = $2',
    [id, siteId]
  );
  if (!existing.rows[0]) return res.status(404).json({ message: 'Head not found' });

  await pool.query('DELETE FROM vendor_heads WHERE id = $1 AND site_id = $2', [id, siteId]);
  res.json({ message: 'Head deleted' });
});

export const updateVendorHead = asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  const name = (req.body.name || '').trim();
  const isActive = req.body.is_active;

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid head id' });

  const existing = await pool.query('SELECT id, site_id FROM vendor_heads WHERE id = $1', [id]);
  if (!existing.rows[0]) return res.status(404).json({ message: 'Head not found' });

  const fields = [];
  const values = [];

  if (name) {
    fields.push(`name = $${fields.length + 1}`);
    values.push(name.toUpperCase());
  }

  if (isActive !== undefined) {
    fields.push(`is_active = $${fields.length + 1}`);
    values.push(!!isActive);
  }

  if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  values.push(id);

  const result = await pool.query(
    `UPDATE vendor_heads
     SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${values.length}
     RETURNING id, site_id, name, is_active, created_at`,
    values
  );

  res.json({ head: result.rows[0] });
});

export const listVendorCommitments = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 15));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const statusFilter = (req.query.status || '').trim();
  const headIdFilter = parseInt(req.query.head_id) || null;
  const projectIdFilter = parseInt(req.query.project_id) || null;
  const { date_from: dateFrom, date_to: dateTo } = req.query;
  const validDate = (value) => value == null || /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!validDate(dateFrom) || !validDate(dateTo) || (dateFrom && dateTo && dateFrom > dateTo)) {
    return res.status(400).json({ message: 'Invalid start date range' });
  }

  // Build WHERE conditions
  const conditions = ['vc.site_id = $1'];
  const values = [siteId];
  let paramIdx = 2;
  if (req.query.record_ids !== undefined) {
    const raw = String(req.query.record_ids);
    const ids = raw ? raw.split(',').map(Number) : [];
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0)) return res.status(400).json({ message: 'Invalid linked record filter' });
    conditions.push(`vc.id = ANY($${paramIdx++}::int[])`);
    values.push(ids);
  }
  if (dateFrom) { conditions.push(`vc.start_date >= $${paramIdx}::date`); values.push(dateFrom); paramIdx++; }
  if (dateTo) { conditions.push(`vc.start_date <= $${paramIdx}::date`); values.push(dateTo); paramIdx++; }

  if (search) {
    conditions.push(
      `(LOWER(vc.vendor_name) LIKE $${paramIdx} OR LOWER(vc.head_name) LIKE $${paramIdx} OR LOWER(vc.work_title) LIKE $${paramIdx})`
    );
    values.push(`%${search.toLowerCase()}%`);
    paramIdx++;
  }

  if (statusFilter && statusFilter !== 'all') {
    conditions.push(`vc.status = $${paramIdx}`);
    values.push(statusFilter);
    paramIdx++;
  }

  if (headIdFilter) {
    conditions.push(`vc.head_id = $${paramIdx}`);
    values.push(headIdFilter);
    paramIdx++;
  }
  if (projectIdFilter) {
    conditions.push(`vc.project_id = $${paramIdx}`);
    values.push(projectIdFilter);
    paramIdx++;
  }

  const accessScope = projectScope(req, 'vc', values);
  if (accessScope) { conditions.push(accessScope.slice(5)); paramIdx++; }
  const whereClause = conditions.join(' AND ');

  // Run count + main list + summary IN PARALLEL (previously 3 serial round-trips).
  const countPromise = pool.query(
    `SELECT COUNT(DISTINCT vc.id)::int AS total
     FROM vendor_commitments vc
     WHERE ${whereClause}`,
    values
  );

  const commitmentsPromise = pool.query(
    `SELECT
      vc.id,
      vc.site_id,
      vc.vendor_member_id,
      vc.vendor_name,
      vc.head_id,
      vc.head_name,
      vc.work_title,
      vc.contract_amount,
      (SELECT COALESCE(SUM(p.amount+p.tds_amount),0)::numeric(14,2) FROM vendor_payments p WHERE p.commitment_id=vc.id AND p.cancelled_at IS NULL AND vendor_payment_reserved(p.status,p.cheque_status)) AS reserved_amount,
      (vc.contract_amount-(SELECT COALESCE(SUM(p.amount+p.tds_amount),0) FROM vendor_payments p WHERE p.commitment_id=vc.id AND p.cancelled_at IS NULL AND vendor_payment_reserved(p.status,p.cheque_status)))::numeric(14,2) AS available_amount,
      (SELECT COALESCE(SUM(le.debit-le.credit),0)::numeric(14,2) FROM ledger_entries le JOIN vendor_payments p ON p.id=le.source_id WHERE le.source_key='vendor_payments' AND p.commitment_id=vc.id AND le.site_id=vc.site_id AND le.ledger_type='site') AS cash_paid_amount,
      vc.terms,
      vc.start_date,
      vc.due_date,
      vc.note,
      vc.status,
      vc.project_id,
      vc.location_id,
      vc.assigned_admin_id,
      vc.created_by,
      vc.created_at,
      COALESCE(NULLIF(TRIM(cu.name), ''), cu.email) AS created_by_name,
      aa.name AS assigned_admin_name,
      COALESCE(SUM(vp.amount + vp.tds_amount), 0)::numeric(14,2) AS paid_amount,
      (vc.contract_amount - COALESCE(SUM(vp.amount + vp.tds_amount), 0))::numeric(14,2) AS remaining_amount,
      m.full_name AS vendor_member_name,
      COUNT(vp.id)::int AS payment_count,
      COALESCE(inv.item_count, 0)::int AS inventory_item_count,
      COALESCE(inv.inv_net_amount, 0)::numeric(14,2) AS inventory_net_amount,
      COALESCE(inv.inv_total_paid, 0)::numeric(14,2) AS inventory_total_paid,
      COALESCE(inv.inv_outstanding, 0)::numeric(14,2) AS inventory_outstanding
      ,cp.name AS project_name
      ,cp.project_type
      ,l.name AS location_name
      ,l.location_type
     FROM vendor_commitments vc
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
       AND financial_transaction_posts('debit', vp.status, vp.payment_mode, vp.cheque_status)
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     LEFT JOIN users cu ON cu.id = vc.created_by
     LEFT JOIN users aa ON aa.id = vc.assigned_admin_id
     LEFT JOIN construction_projects cp ON cp.id = vc.project_id
     LEFT JOIN construction_locations l ON l.id = vc.location_id
     LEFT JOIN (
       SELECT commitment_id,
              COUNT(*)::int AS item_count,
              SUM(ROUND(qty_ordered * rate
                - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                               ELSE discount_amount END, 0), 2))::numeric(14,2) AS inv_net_amount,
              SUM(total_paid)::numeric(14,2) AS inv_total_paid,
              SUM(ROUND(qty_ordered * rate
                - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                               ELSE discount_amount END, 0), 2) - total_paid)::numeric(14,2) AS inv_outstanding
       FROM vendor_inventory_orders
       WHERE site_id = $1
       GROUP BY commitment_id
     ) inv ON inv.commitment_id = vc.id
     WHERE ${whereClause}
     GROUP BY vc.id, m.full_name, cu.name, cu.email, aa.name, cp.name, cp.project_type,
              l.name, l.location_type, inv.item_count, inv.inv_net_amount, inv.inv_total_paid, inv.inv_outstanding
     ORDER BY vc.created_at DESC, vc.id DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );

  // Commitment totals share the visible list filters and project boundary.
  const summaryPromise = pool.query(
    `SELECT
      COUNT(*)::int AS total_contracts,
      COALESCE(SUM(vc.contract_amount), 0)::numeric(14,2) AS total_contract_amount,
      COALESCE(SUM(p.paid_amount), 0)::numeric(14,2) AS total_paid_amount,
      (COALESCE(SUM(vc.contract_amount), 0) - COALESCE(SUM(p.paid_amount), 0))::numeric(14,2) AS total_remaining_amount,
      COALESCE(MAX(inv.total_inv_items), 0)::int AS total_inventory_items,
      COALESCE(MAX(inv.total_inv_net), 0)::numeric(14,2) AS total_inventory_net,
      COALESCE(MAX(inv.total_inv_paid), 0)::numeric(14,2) AS total_inventory_paid,
      COALESCE(MAX(inv.total_inv_outstanding), 0)::numeric(14,2) AS total_inventory_outstanding
     FROM vendor_commitments vc
     LEFT JOIN (
      SELECT commitment_id, SUM(amount + tds_amount)::numeric(14,2) AS paid_amount
      FROM vendor_payments
      WHERE site_id = $1
        AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
      GROUP BY commitment_id
     ) p ON p.commitment_id = vc.id
     CROSS JOIN (
      SELECT
        COUNT(*)::int AS total_inv_items,
        COALESCE(SUM(ROUND(qty_ordered * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2)), 0)::numeric(14,2) AS total_inv_net,
        COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_inv_paid,
        COALESCE(SUM(ROUND(qty_ordered * rate
          - COALESCE(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
                         ELSE discount_amount END, 0), 2) - total_paid), 0)::numeric(14,2) AS total_inv_outstanding
      FROM vendor_inventory_orders
      WHERE site_id = $1
        ${req.vendorProjectIds ? `AND (project_id IS NULL OR project_id=ANY(ARRAY[${req.vendorProjectIds.join(',')}]::int[]))` : ''}
     ) inv
     WHERE ${whereClause}`,
    values
  );

  const [countResult, commitmentsResult, summaryResult] = await Promise.all([
    countPromise,
    commitmentsPromise,
    summaryPromise,
  ]);

  const total = countResult.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.json({
    commitments: commitmentsResult.rows,
    pagination: { page, limit, total, totalPages },
    summary: summaryResult.rows[0],
  });
});

export const getVendorCommitmentDetail = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const commitmentId = asInt(req.params.id);

  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(commitmentId)) return res.status(400).json({ message: 'Invalid commitment id' });
  const entryVisibility = await resolveEntryVisibility(req.user, 'vendors', req.query.created_by);

  // Run the four independent reads concurrently. The previous implementation
  // was 4–6 serial round-trips PLUS a serial loop fetching item-level payments
  // one item at a time (N+1). With a typical commitment of 5–10 items this
  // alone added 1–2s of latency.
  const commitmentPromise = pool.query(
    `SELECT
      vc.id,
      vc.site_id,
      vc.vendor_member_id,
      vc.vendor_name,
      vc.head_id,
      vc.head_name,
      vc.work_title,
      vc.contract_amount,
      (SELECT COALESCE(SUM(p.amount+p.tds_amount),0)::numeric(14,2) FROM vendor_payments p WHERE p.commitment_id=vc.id AND p.cancelled_at IS NULL AND vendor_payment_reserved(p.status,p.cheque_status)) AS reserved_amount,
      (vc.contract_amount-(SELECT COALESCE(SUM(p.amount+p.tds_amount),0) FROM vendor_payments p WHERE p.commitment_id=vc.id AND p.cancelled_at IS NULL AND vendor_payment_reserved(p.status,p.cheque_status)))::numeric(14,2) AS available_amount,
      (SELECT COALESCE(SUM(le.debit-le.credit),0)::numeric(14,2) FROM ledger_entries le JOIN vendor_payments p ON p.id=le.source_id WHERE le.source_key='vendor_payments' AND p.commitment_id=vc.id AND le.site_id=vc.site_id AND le.ledger_type='site') AS cash_paid_amount,
      vc.terms,
      vc.start_date,
      vc.due_date,
      vc.note,
      vc.status,
      vc.project_id,
      vc.location_id,
      vc.assigned_admin_id,
      vc.created_at,
      aa.name AS assigned_admin_name,
      COALESCE(SUM(vp.amount + vp.tds_amount), 0)::numeric(14,2) AS paid_amount,
      (vc.contract_amount - COALESCE(SUM(vp.amount + vp.tds_amount), 0))::numeric(14,2) AS remaining_amount,
      m.full_name AS vendor_member_name,
      cp.name AS project_name,
      cp.project_type,
      l.name AS location_name,
      l.location_type
     FROM vendor_commitments vc
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
       AND financial_transaction_posts('debit', vp.status, vp.payment_mode, vp.cheque_status)
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     LEFT JOIN users aa ON aa.id = vc.assigned_admin_id
     LEFT JOIN construction_projects cp ON cp.id = vc.project_id
     LEFT JOIN construction_locations l ON l.id = vc.location_id
     WHERE vc.id = $1 AND vc.site_id = $2
     GROUP BY vc.id, m.full_name, aa.name, cp.name, cp.project_type, l.name, l.location_type`,
    [commitmentId, siteId]
  );

  const paymentsPromise = pool.query(
    `SELECT vp.id, vp.commitment_id, vp.payment_date, vp.amount, vp.payment_mode, vp.reference_no, vp.note, vp.voucher_url, vp.customer_signature_url, vp.authority_signature_url, vp.status, vp.approved_by, vp.approved_at, vp.cheque_no, vp.cheque_status, vp.created_at, vp.updated_at, vp.assigned_admin_id, vp.created_by, vp.tds_amount, vp.cancelled_at, vp.cancelled_by,
            'vendor_payment'::text AS source_type,vp.id AS source_id,
            (SELECT le.id FROM ledger_entries le WHERE le.source_key='vendor_payments' AND le.source_id=vp.id AND le.ledger_type='site' LIMIT 1) AS ledger_entry_id,
            financial_transaction_posts('debit',vp.status,vp.payment_mode,vp.cheque_status) AS included_in_totals,
            u.name AS created_by_name, aa.name AS assigned_admin_name
     FROM vendor_payments vp
     LEFT JOIN users u ON u.id = vp.created_by
     LEFT JOIN users aa ON aa.id = vp.assigned_admin_id
     WHERE vp.commitment_id = $1 AND vp.site_id = $2
       AND ($3::text IS NULL OR vp.created_by = ANY(string_to_array($3::text, ',')::int[]))
     ORDER BY vp.payment_date DESC, vp.id DESC`,
    [commitmentId, siteId, entryVisibility.creatorId]
  );

  const inventoryPromise = pool.query(
    `SELECT
       o.id, o.vendor_member_id, o.vendor_name, o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.rate, o.discount_pct, o.discount_amount, o.total_paid,
       ROUND(o.qty_ordered * o.rate, 2) AS order_gross,
       ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) AS order_value,
       (ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) - o.total_paid) AS outstanding,
       o.order_date, o.expected_date, o.note, o.status, o.created_at
     FROM vendor_inventory_orders o
     WHERE o.commitment_id = $1 AND o.site_id = $2
     ORDER BY o.created_at DESC, o.id DESC`,
    [commitmentId, siteId]
  );

  const sitePromise = pool.query(
    'SELECT name, city, state FROM sites WHERE id = $1',
    [siteId]
  );

  const [commitmentResult, paymentsResult, inventoryResult, siteResult] = await Promise.all([
    commitmentPromise,
    paymentsPromise,
    inventoryPromise,
    sitePromise,
  ]);

  const commitment = commitmentResult.rows[0];
  if (!commitment) return res.status(404).json({ message: 'Commitment not found' });

  // Single batched query for ALL item payments in one shot, replacing the
  // previous N+1 serial loop.
  const orderIds = inventoryResult.rows.map((o) => o.id);
  let itemPaymentsByOrder = new Map();
  if (orderIds.length > 0) {
    const itemPaysResult = await pool.query(
      `SELECT p.id, p.site_id, p.source_vendor_payment_id, p.order_id, p.payment_date, p.amount, p.payment_mode, p.reference_no,
              p.cheque_no, p.cheque_status, p.status, p.note, p.voucher_url, p.created_at, p.updated_at,
              u.name AS created_by_name
       FROM vendor_inventory_payments p
       LEFT JOIN users u ON u.id = p.created_by
       WHERE p.order_id = ANY($1::int[])
         AND ($2::text IS NULL OR p.created_by = ANY(string_to_array($2::text, ',')::int[]))
       ORDER BY p.payment_date DESC, p.id DESC`,
      [orderIds, entryVisibility.creatorId]
    );
    await attachModuleChequeDates(itemPaysResult.rows, pool, 'vendor_inventory_payments', siteId);
    for (const row of itemPaysResult.rows) {
      const list = itemPaymentsByOrder.get(row.order_id);
      if (list) list.push(row);
      else itemPaymentsByOrder.set(row.order_id, [row]);
    }
  }
  const inventoryOrders = inventoryResult.rows.map((o) => {
    const payments = itemPaymentsByOrder.get(o.id) || [];
    const scopedPaid = payments.reduce((sum, payment) => {
      const posted = transactionMovesMoney({
        direction: 'debit',
        status: payment.status,
        paymentMode: payment.payment_mode,
        chequeStatus: payment.cheque_status,
      });
      return sum + (posted ? (parseFloat(payment.amount) || 0) : 0);
    }, 0);
    return {
      ...o,
      total_paid: scopedPaid,
      outstanding: (parseFloat(o.order_value) || 0) - scopedPaid,
      payments,
    };
  });

  const siteRow = siteResult.rows[0] || null;
  await attachModuleChequeDates(paymentsResult.rows, pool, 'vendor_payments', siteId);
  const payments = paymentsResult.rows.map((p) => ({
    ...p,
    verifyUrl: buildVerifyUrl({
      t: ReceiptType.VENDOR,
      i: p.id,
      pn: commitment.vendor_name || null,
      a: p.amount,
      d: p.payment_date,
      pm: p.payment_mode || null,
      rf: p.reference_no || null,
      sn: siteRow?.name || null,
      sy: siteRow?.city || null,
      ss: siteRow?.state || null,
    }),
  }));

  res.json({ commitment, payments, inventoryOrders, entryVisibility });
});

export const getVendorPaymentReceipt = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const paymentId = asInt(req.params.paymentId);

  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });

  const result = await pool.query(
    `SELECT
      vp.id,
      vp.site_id,
      vp.commitment_id,
      vp.payment_date,
      vp.amount,
      vp.payment_mode, vp.cheque_status, vp.cheque_no, cfe.cheque_transaction_date,
      cfe.bank_account_id,
      ba.name AS bank_account_name,
      vp.reference_no,
      vp.note,
      vp.voucher_url,
      vp.customer_signature_url,
      vp.authority_signature_url,
      vp.status,
      vp.assigned_admin_id,
      vp.approved_by,
      vp.approved_at,
      vp.created_at,
      vc.vendor_name,
      vc.head_name,
      vc.work_title,
      s.name AS site_name,
      s.address AS site_address,
      s.city AS site_city,
      s.state AS site_state,
      cu.name AS created_by_name,
      au.name AS approved_by_name,
      asg.name AS assigned_admin_name
     FROM vendor_payments vp
     INNER JOIN vendor_commitments vc ON vc.id = vp.commitment_id
     LEFT JOIN cash_flow_entries cfe
       ON cfe.source_module = 'vendor_payments' AND cfe.source_id = vp.id
     LEFT JOIN bank_accounts ba
       ON ba.id = cfe.bank_account_id AND ba.site_id = cfe.site_id
     LEFT JOIN sites s ON s.id = vp.site_id
     LEFT JOIN users cu ON cu.id = vp.created_by
     LEFT JOIN users au ON au.id = vp.approved_by
     LEFT JOIN users asg ON asg.id = vp.assigned_admin_id
     WHERE vp.id = $1 AND vp.site_id = $2
     LIMIT 1`,
    [paymentId, siteId]
  );

  const receipt = result.rows[0];
  if (!receipt) return res.status(404).json({ message: 'Payment not found' });
  const createdByResult = await pool.query('SELECT created_by FROM vendor_payments WHERE id = $1', [paymentId]);
  if (!(await canUserViewEntry(req.user, 'vendors', createdByResult.rows[0]?.created_by))) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  await attachModuleChequeDates([receipt], pool, 'vendor_payments', siteId);
  res.json({
    receipt: {
      ...receipt,
      verifyUrl: buildVerifyUrl({
        t: ReceiptType.VENDOR,
        i: receipt.id,
        pn: receipt.vendor_name || null,
        a: receipt.amount,
        dr: 'OUT',
        d: receipt.payment_date,
        pm: receipt.payment_mode || null,
        rf: receipt.reference_no || null,
        sn: receipt.site_name || null,
        sy: receipt.site_city || null,
        ss: receipt.site_state || null,
      }),
    },
  });
});

export const createVendorCommitment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const {
    vendor_member_id,
    vendor_name,
    head_id,
    head_name,
    work_title,
    contract_amount,
    start_date,
    due_date,
    note,
    assigned_admin_id,
    inventory_items,
    project_id,
    location_id,
  } = req.body;

  if(inventory_items!==undefined&&!Array.isArray(inventory_items))return res.status(400).json({message:'Inventory items must be an array'});
  for(const item of inventory_items||[]){
    if(!String(item.item_name||'').trim())return res.status(400).json({message:'Every inventory item requires a name'});
    if(!/^\d{1,10}(?:\.\d{1,3})?$/.test(String(item.qty_ordered??''))||Number(item.qty_ordered)<=0)return res.status(400).json({message:'Inventory quantity must be positive with at most three decimal places'});
    vendorMoney(item.rate,'Inventory rate',{zero:true});
    const discount=vendorMoney(item.discount_pct||0,'Discount percentage',{zero:true});
    if(Number(discount)>100)return res.status(400).json({message:'Discount percentage cannot exceed 100'});
    vendorMoney(item.discount_amount||0,'Discount amount',{zero:true});
    vendorDate(item.expected_date,'Expected delivery date',{optional:true});
  }
  const amount = vendorMoney(contract_amount,'Contract amount');
  const startDate=vendorDate(start_date,'Start date',{optional:true}),dueDate=vendorDate(due_date,'Due date',{optional:true});
  if(startDate&&dueDate&&startDate>dueDate)return res.status(400).json({message:'Due date must be on or after start date'});
  if (!work_title?.trim()) return res.status(400).json({ message: 'Work title is required' });

  let vendorMemberId = vendor_member_id ? asInt(vendor_member_id) : null;
  let resolvedVendorName = (vendor_name || '').trim().toUpperCase();

  if (vendorMemberId) {
    const vendorResult = await pool.query(
      `SELECT id, full_name
       FROM members
       WHERE id = $1 AND site_id = $2 AND member_type = 'VENDOR' AND COALESCE(status,'ACTIVE')<>'BLOCKED'`,
      [vendorMemberId, siteId]
    );
    const vendor = vendorResult.rows[0];
    if (!vendor) return res.status(400).json({ message: 'Selected vendor is invalid for this site' });
    resolvedVendorName = vendor.full_name;
  }

  if (!resolvedVendorName) return res.status(400).json({ message: 'Vendor name is required' });

  const resolvedHeadId = head_id ? asInt(head_id) : null;
  const resolvedHeadName = (head_name || '').trim().toUpperCase();

  let finalHeadName = resolvedHeadName || null;
  let finalHeadId = resolvedHeadId;

  if (resolvedHeadId) {
    const headResult = await pool.query(
      `SELECT id, name
       FROM vendor_heads
       WHERE id = $1 AND site_id = $2 AND is_active=TRUE`,
      [resolvedHeadId, siteId]
    );
    const head = headResult.rows[0];
    if (!head) return res.status(400).json({ message: 'Selected head is invalid for this site' });
    finalHeadName = head.name;
  }

  if (!finalHeadName) return res.status(400).json({ message: 'Head is required' });

  const scope = await resolveProjectLocation(siteId, project_id, location_id);
  if (scope.error) return res.status(400).json({ message: scope.error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const approver=await validateConstructionAssignment(client,siteId,assigned_admin_id,{approver:true});
    const result = await client.query(
      `INSERT INTO vendor_commitments (site_id, vendor_member_id, vendor_name, head_id, head_name, work_title, contract_amount, start_date, due_date, note, created_by, assigned_admin_id, project_id, location_id, terms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING *`,
      [
        siteId,
        vendorMemberId,
        resolvedVendorName,
        finalHeadId,
        finalHeadName,
        work_title.trim(),
        amount,
        startDate,
        dueDate,
        note?.trim() || null,
        req.user.id,
        approver,
        scope.projectId,
        scope.locationId,
        String(req.body.terms || '').trim() || null,
      ]
    );

    const commitment = result.rows[0];
    await markProjectCommitted(client,req.user,scope.projectId,siteId,commitment.id);

    // Insert inventory items in a SINGLE multi-row INSERT (previously one
    // round-trip per item inside the transaction).
    let createdItems = [];
    if (Array.isArray(inventory_items) && inventory_items.length > 0) {
      const COLS = 17;
      const values = [];
      const placeholders = [];
      const defaultOrderDate = start_date || new Date().toISOString().slice(0, 10);

      let idx = 0;
      for (const item of inventory_items) {
        const itemName = (item.item_name || '').trim();
        if (!itemName) continue;
        const qtyOrdered = String(item.qty_ordered);
        const rateVal = vendorMoney(item.rate,'Inventory rate',{zero:true});
        if (qtyOrdered <= 0) continue;

        const discountPct = vendorMoney(item.discount_pct||0,'Discount percentage',{zero:true});
        const discountAmount = vendorMoney(item.discount_amount||0,'Discount amount',{zero:true});

        const base = idx * COLS;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16},$${base + 17})`
        );
        values.push(
          siteId,
          commitment.id,
          vendorMemberId,
          resolvedVendorName,
          itemName,
          (item.item_category || '').trim().toUpperCase() || null,
          (item.unit || 'pcs').trim(),
          qtyOrdered,
          rateVal,
          discountPct,
          discountAmount,
          defaultOrderDate,
          item.expected_date || null,
          (item.note || '').trim() || null,
          req.user.id,
          scope.projectId,
          scope.locationId,
        );
        idx++;
      }

      if (placeholders.length > 0) {
        const itemRes = await client.query(
          `INSERT INTO vendor_inventory_orders
             (site_id, commitment_id, vendor_member_id, vendor_name, item_name, item_category, unit,
              qty_ordered, rate, discount_pct, discount_amount, order_date, expected_date, note, created_by,
              project_id, location_id)
           VALUES ${placeholders.join(',')}
           RETURNING *`,
          values
        );
        createdItems = itemRes.rows;
      }
    }

    await client.query('COMMIT');

    res.status(201).json({ commitment, inventory_items: createdItems });
  } catch (error) {
    await client.query('ROLLBACK');
    throw translateVendorIntegrityError(error);
  } finally {
    client.release();
  }
});

export const addVendorPayment = asyncHandler(async (req, res) => {
  const commitmentId = asInt(req.params.id), siteId = getSiteId(req);
  if (!Number.isInteger(commitmentId)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const key = req.body.idempotency_key || req.get?.('Idempotency-Key') || '';
  const draft = normalizeVendorPayment(req.body, key);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const commitment = await assertVendorCommitmentAccess(client, req.user, commitmentId, siteId, { lock: true });
    const assignedTo = await validateConstructionAssignment(client, siteId, req.body.assigned_admin_id ?? commitment.assigned_admin_id, { approver: true });
    const fingerprint = vendorPaymentFingerprint(draft, assignedTo, withPaymentTds('vendor_payments', {}));
    const previous = (await client.query('SELECT * FROM vendor_payments WHERE site_id=$1 AND created_by=$2 AND idempotency_key=$3', [siteId,req.user.id,key])).rows[0];
    if (previous) {
      if (previous.commitment_id !== commitmentId || previous.request_fingerprint !== fingerprint) {
        throw Object.assign(new Error('This payment request key was already used with different details'), { statusCode:409 });
      }
      await client.query('COMMIT');
      return res.status(200).json({ payment:previous,replayed:true });
    }
    const result = await client.query(
      `INSERT INTO vendor_payments (commitment_id,site_id,payment_date,amount,payment_mode,reference_no,note,voucher_url,status,created_by,assigned_admin_id,cheque_no,cheque_status,transaction_time,idempotency_key,request_fingerprint${tdsInsertColumns('vendor_payments')})
       VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13::time,$14,$15${tdsInsertValues('vendor_payments')}) RETURNING *`,
      [commitmentId,siteId,draft.payment_date,draft.amount,draft.payment_mode,draft.reference_no,draft.note,draft.voucher_url,req.user.id,assignedTo,draft.cheque_no,draft.payment_mode==='cheque'?'PENDING':null,transactionTimeForWrite(),key,fingerprint]
    );
    await client.query('UPDATE vendor_commitments SET updated_at=NOW() WHERE id=$1',[commitmentId]);
    if(commitment.project_id) await recordConstructionActivity(client,{projectId:commitment.project_id,actorId:req.user.id,action:'payment_recorded',entityType:'vendor_payment',entityId:result.rows[0].id,details:{amount:draft.amount,status:'pending'}});
    await client.query('COMMIT');
    res.status(201).json({payment:result.rows[0],replayed:false});
  }catch(error){await client.query('ROLLBACK');throw translateVendorIntegrityError(error);}
  finally{client.release();}
});

export const updateVendorPayment = asyncHandler(async (req,res) => {
  const paymentId=asInt(req.params.paymentId),siteId=getSiteId(req);
  if(!Number.isInteger(paymentId)||!siteId) return res.status(400).json({message:'Valid payment id and site_id are required'});
  const draft=normalizeVendorPayment(req.body);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const identity=(await client.query('SELECT * FROM vendor_payments WHERE id=$1 AND site_id=$2',[paymentId,siteId])).rows[0];
    if(!identity||!(await canUserViewEntry(req.user,'vendors',identity.created_by))) throw Object.assign(new Error('Payment not found'),{statusCode:404});
    const commitment=await assertVendorCommitmentAccess(client,req.user,identity.commitment_id,siteId,{lock:true});
    const existing=(await client.query('SELECT * FROM vendor_payments WHERE id=$1 FOR UPDATE',[paymentId])).rows[0];
    await assertVendorPaymentEditable(client,existing);
    const assignedTo=await validateConstructionAssignment(client,siteId,req.body.assigned_admin_id===undefined?existing.assigned_admin_id:req.body.assigned_admin_id,{approver:true});
    const result=await client.query(`UPDATE vendor_payments SET payment_date=$1,amount=$2::numeric,payment_mode=$3,reference_no=$4,note=$5,voucher_url=$6,assigned_admin_id=$7,
      cheque_no=$8,cheque_status=CASE WHEN $3='cheque' THEN CASE WHEN payment_mode='cheque' AND payment_date=$1::date AND amount=$2::numeric AND cheque_no IS NOT DISTINCT FROM $8::text THEN COALESCE(cheque_status,'PENDING') ELSE 'PENDING' END ELSE NULL END,
      transaction_time=$9::time,updated_at=NOW()${tdsUpdateSet('vendor_payments')} WHERE id=$10 RETURNING *`,
      [draft.payment_date,draft.amount,draft.payment_mode,draft.reference_no,draft.note,draft.voucher_url,assignedTo,draft.cheque_no,transactionTimeForWrite(existing.transaction_time??null),paymentId]);
    await client.query('UPDATE vendor_commitments SET updated_at=NOW() WHERE id=$1',[existing.commitment_id]);
    if(commitment.project_id) await recordConstructionActivity(client,{projectId:commitment.project_id,actorId:req.user.id,action:'payment_updated',entityType:'vendor_payment',entityId:paymentId,details:{amount:draft.amount}});
    await client.query('COMMIT');res.json({payment:result.rows[0]});
  }catch(error){await client.query('ROLLBACK');throw translateVendorIntegrityError(error);}
  finally{client.release();}
});

async function cancelVendorPayments(req,ids,siteId){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const identities=(await client.query('SELECT * FROM vendor_payments WHERE id=ANY($1::int[]) AND site_id=$2 ORDER BY commitment_id,id',[ids,siteId])).rows;
    if(identities.length!==ids.length) throw Object.assign(new Error('Payment not found'),{statusCode:404});
    const parents=new Map();
    for(const row of identities){
      if(!(await canUserViewEntry(req.user,'vendors',row.created_by))) throw Object.assign(new Error('Payment not found'),{statusCode:404});
      if(!parents.has(row.commitment_id)) parents.set(row.commitment_id,await assertVendorCommitmentAccess(client,req.user,row.commitment_id,siteId,{lock:true}));
    }
    const rows=(await client.query('SELECT * FROM vendor_payments WHERE id=ANY($1::int[]) ORDER BY id FOR UPDATE',[ids])).rows;
    for(const row of rows){
      if(row.status!=='pending'||row.approved_at||row.first_approved_at) throw Object.assign(new Error('Only undecided payments can be cancelled. Payment history is retained; approved payments use the existing rejection process.'),{statusCode:409});
      if(parents.get(row.commitment_id)?.project_id) await recordConstructionActivity(client,{projectId:parents.get(row.commitment_id).project_id,actorId:req.user.id,action:'payment_cancelled',entityType:'vendor_payment',entityId:row.id});
    }
    await client.query("UPDATE vendor_payments SET status='rejected',cancelled_at=NOW(),cancelled_by=$2,updated_at=NOW() WHERE id=ANY($1::int[])",[ids,req.user.id]);
    await client.query("UPDATE vendor_inventory_payments SET status='rejected',updated_at=NOW() WHERE source_vendor_payment_id=ANY($1::int[])",[ids]);
    await client.query('UPDATE vendor_commitments SET updated_at=NOW() WHERE id=ANY($1::int[])',[[...parents.keys()]]);
    await client.query('COMMIT');return ids;
  }catch(error){await client.query('ROLLBACK');throw translateVendorIntegrityError(error);}
  finally{client.release();}
}
export const deleteVendorPayment=asyncHandler(async(req,res)=>{
  const id=asInt(req.params.paymentId),siteId=getSiteId(req);
  if(!Number.isInteger(id)||!siteId)return res.status(400).json({message:'Valid payment id and site_id are required'});
  await cancelVendorPayments(req,[id],siteId);
  res.json({message:'Vendor payment cancelled; history retained',cancelled:[id]});
});
export const bulkDeleteVendorPayments=asyncHandler(async(req,res)=>{
  const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(asInt))]:[],siteId=getSiteId(req);
  if(!ids.length||ids.some(id=>!Number.isInteger(id))||!siteId)return res.status(400).json({message:'Valid ids and site_id are required'});
  await cancelVendorPayments(req,ids,siteId);
  res.json({message:`${ids.length} payment(s) cancelled; history retained`,cancelled:ids,deleted:[]});
});

// Distribute a commitment payment proportionally or manually to inventory items
export const distributePaymentToItems=asyncHandler(async(req,res)=>{
  const commitmentId=asInt(req.params.id),siteId=getSiteId(req),sourceId=asInt(req.body.source_vendor_payment_id);
  const raw=req.body.allocations;
  if(!Number.isInteger(commitmentId)||!siteId||!Number.isInteger(sourceId))return res.status(400).json({message:'Select an existing vendor payment to allocate; standalone item payments use the inventory payment workflow'});
  if(!Array.isArray(raw)||!raw.length)return res.status(400).json({message:'At least one allocation is required'});
  const allocations=raw.map(row=>({orderId:asInt(row.order_id),amount:vendorMoney(row.amount,'Allocation amount')}));
  if(allocations.some(row=>!Number.isInteger(row.orderId))||new Set(allocations.map(row=>row.orderId)).size!==allocations.length)return res.status(400).json({message:'Select valid, distinct inventory items'});
  const db=await pool.connect();
  try{
    await db.query('BEGIN');
    const commitment=await assertVendorCommitmentAccess(db,req.user,commitmentId,siteId,{lock:true});
    const source=(await db.query('SELECT * FROM vendor_payments WHERE id=$1 AND commitment_id=$2 AND site_id=$3 FOR UPDATE',[sourceId,commitmentId,siteId])).rows[0];
    if(!source||!(await canUserViewEntry(req.user,'vendors',source.created_by)))throw Object.assign(new Error('Source vendor payment not found'),{statusCode:404});
    if(!['pending','approved'].includes(source.status)||source.cancelled_at||['BOUNCED','RETURNED'].includes(source.cheque_status))throw Object.assign(new Error('Only active vendor payments can be allocated'),{statusCode:409});
    const orders=(await db.query('SELECT id FROM vendor_inventory_orders WHERE id=ANY($1::int[]) AND commitment_id=$2 AND site_id=$3',[allocations.map(row=>row.orderId),commitmentId,siteId])).rows;
    if(orders.length!==allocations.length)throw Object.assign(new Error('Every item must belong to this commitment and site'),{statusCode:400});
    const existing=(await db.query('SELECT * FROM vendor_inventory_payments WHERE source_vendor_payment_id=$1',[sourceId])).rows;
    const payments=[];
    for(const allocation of allocations){
      const previous=existing.filter(row=>row.order_id===allocation.orderId);
      if(previous.length){
        if(previous.length!==1||vendorMoney(previous[0].amount)!==allocation.amount)throw Object.assign(new Error('This payment has already been allocated to that item with different details'),{statusCode:409});
        payments.push(previous[0]);continue;
      }
      payments.push((await db.query(`INSERT INTO vendor_inventory_payments(order_id,site_id,payment_date,amount,payment_mode,reference_no,cheque_no,cheque_status,note,voucher_url,created_by,assigned_admin_id,source_vendor_payment_id,status,transaction_time,approved_by,approved_at)
        VALUES($1,$2,$3,$4::numeric,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::time,$16,$17) RETURNING *`,[allocation.orderId,siteId,source.payment_date,allocation.amount,source.payment_mode,source.reference_no,source.cheque_no,source.cheque_status,source.note,source.voucher_url,req.user.id,source.assigned_admin_id,sourceId,source.status,source.transaction_time,source.approved_by,source.approved_at])).rows[0]);
    }
    if(commitment.project_id&&payments.some(row=>!existing.some(old=>old.id===row.id)))await recordConstructionActivity(db,{projectId:commitment.project_id,actorId:req.user.id,action:'payment_allocated',entityType:'vendor_payment',entityId:sourceId,details:{item_count:allocations.length}});
    await db.query('COMMIT');res.status(201).json({payments,count:payments.length,replayed:payments.every(row=>existing.some(old=>old.id===row.id))});
  }catch(error){await db.query('ROLLBACK');throw translateVendorIntegrityError(error);}
  finally{db.release();}
});

export const listAllInventoryItems = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT
       o.id, o.commitment_id, o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.rate, o.total_paid,
       ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) AS order_value,
       (ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) - o.total_paid)::numeric(14,2) AS outstanding,
       o.status, o.order_date, o.created_at,
       vc.vendor_name, vc.work_title, vc.head_name
     FROM vendor_inventory_orders o
     INNER JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE o.site_id = $1
       ${req.vendorProjectIds ? `AND (o.project_id IS NULL OR o.project_id=ANY(ARRAY[${req.vendorProjectIds.join(',')}]::int[]))` : ''}
     ORDER BY o.created_at DESC, o.id DESC`,
    [siteId]
  );

  const summaryResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total_items,
       COALESCE(SUM(qty_ordered), 0)::numeric(14,2) AS total_qty_ordered,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_net,
       COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - total_paid), 0)::numeric(14,2) AS total_outstanding
     FROM vendor_inventory_orders
     WHERE site_id = $1
       AND ($2::int[] IS NULL OR project_id IS NULL OR project_id=ANY($2::int[]))`,
    [siteId,req.vendorProjectIds||null]
  );

  res.json({ items: result.rows, summary: summaryResult.rows[0] });
});

export const updateVendorCommitment = asyncHandler(async(req,res)=>{
  const id=asInt(req.params.id),siteId=getSiteId(req);
  if(!Number.isInteger(id)||!siteId)return res.status(400).json({message:'Valid commitment id and site_id are required'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const existing=await assertVendorCommitmentAccess(client,req.user,id,siteId,{lock:true});
    const body={...req.body};
    if(body.contract_amount!==undefined)body.contract_amount=vendorMoney(body.contract_amount,'Contract amount');
    const start=body.start_date===undefined?(existing.start_date instanceof Date?existing.start_date.toISOString().slice(0,10):String(existing.start_date||'').slice(0,10)):vendorDate(body.start_date,'Start date',{optional:true});
    const due=body.due_date===undefined?(existing.due_date instanceof Date?existing.due_date.toISOString().slice(0,10):String(existing.due_date||'').slice(0,10)):vendorDate(body.due_date,'Due date',{optional:true});
    if(start&&due&&start>due)throw Object.assign(new Error('Due date must be on or after start date'),{statusCode:400});
    if(body.start_date!==undefined)body.start_date=start;
    if(body.due_date!==undefined)body.due_date=due;
    if(body.status!==undefined&&!['open','closed','cancelled'].includes(body.status))throw Object.assign(new Error('Invalid commitment status'),{statusCode:400});
    if(existing.status==='cancelled'&&body.status&&body.status!=='cancelled')throw Object.assign(new Error('Cancelled commitments cannot be reopened'),{statusCode:409});
    if(body.assigned_admin_id!==undefined)body.assigned_admin_id=await validateConstructionAssignment(client,siteId,body.assigned_admin_id,{approver:true});
    if(body.head_id){
      const head=(await client.query('SELECT id,name FROM vendor_heads WHERE id=$1 AND site_id=$2 AND is_active=TRUE',[body.head_id,siteId])).rows[0];
      if(!head)throw Object.assign(new Error('Selected head is invalid for this site'),{statusCode:400});
      body.head_name=head.name;
    }
    if(body.project_id!==undefined||body.location_id!==undefined){
      const changed=body.project_id!==undefined&&String(body.project_id||'')!==String(existing.project_id||'');
      const scope=await resolveProjectLocation(siteId,body.project_id===undefined?existing.project_id:body.project_id,body.location_id===undefined?(changed?null:existing.location_id):body.location_id,client);
      if(scope.error)throw Object.assign(new Error(scope.error),{statusCode:400});
      body.project_id=scope.projectId;body.location_id=scope.locationId;
      if(changed&&scope.projectId)await markProjectCommitted(client,req.user,scope.projectId,siteId,id);
    }
    const fields=[],values=[];
    for(const key of ['vendor_name','head_id','head_name','work_title','start_date','due_date','note','terms','contract_amount','status','project_id','location_id','assigned_admin_id']){
      if(body[key]===undefined)continue;
      if(['vendor_name','work_title','head_name'].includes(key)&&!String(body[key]||'').trim())throw Object.assign(new Error(`${key} is required`),{statusCode:400});
      values.push(body[key]);fields.push(`${key}=$${values.length}`);
    }
    if(!fields.length)throw Object.assign(new Error('Nothing to update'),{statusCode:400});
    values.push(id,siteId);
    const result=await client.query(`UPDATE vendor_commitments SET ${fields.join(',')},updated_at=NOW() WHERE id=$${values.length-1} AND site_id=$${values.length} RETURNING *`,values);
    if(result.rows[0].project_id)await recordConstructionActivity(client,{projectId:result.rows[0].project_id,actorId:req.user.id,action:'commitment_updated',entityType:'commitment',entityId:id,details:{fields:Object.keys(body).filter(key=>key!=='site_id')}});
    await client.query('COMMIT');res.json({commitment:result.rows[0]});
  }catch(error){await client.query('ROLLBACK');throw translateVendorIntegrityError(error);}
  finally{client.release();}
});

export const deleteVendorCommitment = asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  const siteId = getSiteId(req);

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const existing = await pool.query(
    'SELECT id FROM vendor_commitments WHERE id = $1 AND site_id = $2',
    [id, siteId]
  );
  if (!existing.rows[0]) return res.status(404).json({ message: 'Commitment not found' });

  if((await pool.query('SELECT 1 FROM vendor_payments WHERE commitment_id=$1 LIMIT 1',[id])).rows.length)return res.status(409).json({message:'Commitments with payment history must be retained; close or cancel the commitment'});
  await pool.query('DELETE FROM vendor_commitments WHERE id = $1 AND site_id = $2', [id, siteId]);
  res.json({ message: 'Commitment deleted' });
});

/**
 * POST /vendors/commitments/bulk-delete
 * Body: { ids: number[], site_id }
 */
export const bulkDeleteVendorCommitments = asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((id) => asInt(id)).filter(Number.isInteger) : [];
  const siteId = getSiteId(req);
  if (ids.length === 0) return res.status(400).json({ message: 'ids array is required' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  if((await pool.query('SELECT 1 FROM vendor_payments WHERE commitment_id=ANY($1::int[]) LIMIT 1',[ids])).rows.length)return res.status(409).json({message:'Commitments with payment history must be retained; close or cancel the commitment'});
  const result = await pool.query(
    `DELETE FROM vendor_commitments WHERE id = ANY($1::int[]) AND site_id = $2 RETURNING id`,
    [ids, siteId]
  );
  res.json({ message: `${result.rows.length} commitment(s) deleted`, deleted: result.rows.map((r) => r.id) });
});

// Status updates use the same transition, date, assignment and audit guards.
export const updateVendorCommitmentStatus = updateVendorCommitment;

export const getVendorPaymentLedger=asyncHandler(async(req,res)=>{
  const paymentId=asInt(req.params.paymentId),siteId=getSiteId(req);
  if(!Number.isInteger(paymentId)||!siteId)return res.status(400).json({message:'Valid payment id and site_id are required'});
  const payment=(await pool.query('SELECT vp.*,vc.vendor_name,vc.work_title,vc.project_id,cp.name project_name FROM vendor_payments vp JOIN vendor_commitments vc ON vc.id=vp.commitment_id LEFT JOIN construction_projects cp ON cp.id=vc.project_id WHERE vp.id=$1 AND vp.site_id=$2',[paymentId,siteId])).rows[0];
  if(!payment||!(await canUserViewEntry(req.user,'vendors',payment.created_by)))return res.status(404).json({message:'Payment not found'});
  await assertVendorCommitmentAccess(pool,req.user,payment.commitment_id,siteId);
  const entries=(await pool.query("SELECT * FROM ledger_entries WHERE source_key='vendor_payments' AND source_id=$1 AND site_id=$2 AND ledger_type='site' ORDER BY entry_date,id",[paymentId,siteId])).rows;
  res.json({payment,entries});
});
