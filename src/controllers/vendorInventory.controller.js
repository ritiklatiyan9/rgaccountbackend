import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';
import { resolveEntryVisibility } from '../services/entryVisibility.service.js';
import { reverseApprovedImprestDebit } from '../services/imprestPosting.service.js';

// Vendor inventory module — transactions-only (no deliveries / stock-in/out).
// An "order" is: item + qty_ordered * rate - discount = net value.
// Against that net value, each payment is a transaction that reduces outstanding.

const asInt = (v) => parseInt(v, 10);

const getSiteId = (req) => {
  const siteId = asInt(req.query.site_id || req.body.site_id);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
};

// Reusable SQL fragment computing order_value (net) and outstanding
const ORDER_VALUE_SQL = `ROUND(o.qty_ordered * o.rate
  - COALESCE(CASE
      WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
      ELSE o.discount_amount
    END, 0), 2)`;

// Qty already pulled into the inventory ledger against this order (the
// procurement → stock link). Receipts are tagged ref_type = 'VENDOR_ORDER'.
const RECEIVED_QTY_SQL = `COALESCE((
  SELECT SUM(mv.qty) FROM inventory_movements mv
   WHERE mv.ref_type = 'VENDOR_ORDER' AND mv.ref_id = o.id AND mv.movement_type = 'RECEIPT'
), 0)`;
const POSTED_INVENTORY_PAYMENT_SQL = (alias) => `LOWER(COALESCE(${alias}.status, 'approved')) = 'approved'
  AND UPPER(COALESCE(${alias}.cheque_status, '')) NOT IN ('BOUNCED', 'RETURNED')`;

export const listInventoryOrders = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const visibility = await resolveEntryVisibility(req.user, 'vendors', req.query.created_by);

  const page   = Math.max(1, parseInt(req.query.page) || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const search = (req.query.search || '').trim();
  const status = (req.query.status || '').trim();
  const vendorId = parseInt(req.query.vendor_id) || null;
  const category = (req.query.category || '').trim();

  const conditions = ['o.site_id = $1'];
  const values = [siteId];
  let idx = 2;

  if (search) {
    conditions.push(
      `(LOWER(o.item_name) LIKE $${idx} OR LOWER(o.vendor_name) LIKE $${idx} OR LOWER(o.item_category) LIKE $${idx})`
    );
    values.push(`%${search.toLowerCase()}%`);
    idx++;
  }
  if (status && status !== 'all') {
    conditions.push(`o.status = $${idx}`);
    values.push(status);
    idx++;
  }
  if (vendorId) {
    conditions.push(`o.vendor_member_id = $${idx}`);
    values.push(vendorId);
    idx++;
  }
  if (category) {
    conditions.push(`LOWER(o.item_category) = $${idx}`);
    values.push(category.toLowerCase());
    idx++;
  }

  const where = conditions.join(' AND ');
  const creatorIdx = idx;

  // Run count + paged list + global summary IN PARALLEL (was 3 serial round-trips).
  const countPromise = pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_inventory_orders o WHERE ${where}`,
    values
  );
  const ordersPromise = pool.query(
    `SELECT
       o.id, o.site_id, o.vendor_member_id, o.vendor_name,
       o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.rate, o.discount_pct, o.discount_amount,
       COALESCE((
         SELECT SUM(vip.amount) FROM vendor_inventory_payments vip
         WHERE vip.order_id = o.id
           AND ${POSTED_INVENTORY_PAYMENT_SQL('vip')}
           AND ($${creatorIdx}::int IS NULL OR vip.created_by = $${creatorIdx}::int)
       ), 0) AS total_paid,
       o.commitment_id,
       ${ORDER_VALUE_SQL} AS order_value,
       (${ORDER_VALUE_SQL} - COALESCE((
         SELECT SUM(vip.amount) FROM vendor_inventory_payments vip
         WHERE vip.order_id = o.id
           AND ${POSTED_INVENTORY_PAYMENT_SQL('vip')}
           AND ($${creatorIdx}::int IS NULL OR vip.created_by = $${creatorIdx}::int)
       ), 0)) AS outstanding,
       ${RECEIVED_QTY_SQL} AS received_qty,
       (o.qty_ordered - ${RECEIVED_QTY_SQL}) AS pending_qty,
       o.order_date, o.expected_date, o.note, o.status, o.created_at,
       m.full_name AS vendor_member_name,
       vc.head_name, vc.work_title
     FROM vendor_inventory_orders o
     LEFT JOIN members m ON m.id = o.vendor_member_id
     LEFT JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE ${where}
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT $${creatorIdx + 1} OFFSET $${creatorIdx + 2}`,
    [...values, visibility.creatorId, limit, offset]
  );
  const sumPromise = pool.query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(vp.total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - vp.total_paid), 0)::numeric(14,2) AS total_outstanding,
       COALESCE(SUM(CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2) ELSE discount_amount END), 0)::numeric(14,2) AS total_discount
     FROM vendor_inventory_orders o
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(vip.amount), 0) AS total_paid
       FROM vendor_inventory_payments vip
       WHERE vip.order_id = o.id
         AND ${POSTED_INVENTORY_PAYMENT_SQL('vip')}
         AND ($2::int IS NULL OR vip.created_by = $2::int)
     ) vp ON true
     WHERE o.site_id = $1`,
    [siteId, visibility.creatorId]
  );

  const [countRes, ordersRes, sumRes] = await Promise.all([countPromise, ordersPromise, sumPromise]);
  const total = countRes.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  res.json({
    orders: ordersRes.rows,
    pagination: { page, limit, total, totalPages },
    summary: sumRes.rows[0],
  });
});

export const getInventoryOrderDetail = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });
  const visibility = await resolveEntryVisibility(req.user, 'vendors', req.query.created_by);

  const orderRes = await pool.query(
    `SELECT o.*,
       ${ORDER_VALUE_SQL} AS order_value,
       (${ORDER_VALUE_SQL} - o.total_paid) AS outstanding,
       ${RECEIVED_QTY_SQL} AS received_qty,
       (o.qty_ordered - ${RECEIVED_QTY_SQL}) AS pending_qty,
       m.full_name AS vendor_member_name,
       vc.head_name, vc.work_title
     FROM vendor_inventory_orders o
     LEFT JOIN members m ON m.id = o.vendor_member_id
     LEFT JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE o.id = $1 AND o.site_id = $2`,
    [orderId, siteId]
  );
  const order = orderRes.rows[0];
  if (!order) return res.status(404).json({ message: 'Order not found' });

  const paymentsRes = await pool.query(
    `SELECT p.*, u.name AS created_by_name
     FROM vendor_inventory_payments p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.order_id = $1
       AND ($2::int IS NULL OR p.created_by = $2::int)
     ORDER BY p.payment_date DESC, p.id DESC`,
    [orderId, visibility.creatorId]
  );

  const visiblePaid = paymentsRes.rows.reduce((sum, payment) => {
    const posted = String(payment.status || 'approved').toLowerCase() === 'approved'
      && !['BOUNCED', 'RETURNED'].includes(String(payment.cheque_status || '').toUpperCase());
    return sum + (posted ? (Number(payment.amount) || 0) : 0);
  }, 0);
  order.total_paid = visiblePaid;
  order.outstanding = Math.max((Number(order.order_value) || 0) - visiblePaid, 0);

  res.json({ order, payments: paymentsRes.rows, entryVisibility: visibility });
});

export const createInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const {
    vendor_member_id,
    vendor_name,
    item_name,
    item_category,
    unit,
    qty_ordered,
    rate,
    discount_pct,
    discount_amount,
    order_date,
    expected_date,
    note,
    commitment_id,
  } = req.body;

  if (!(item_name || '').trim()) return res.status(400).json({ message: 'item_name is required' });
  if (!(unit || '').trim())      return res.status(400).json({ message: 'unit is required' });

  const qtyOrdered     = parseFloat(qty_ordered) || 0;
  const rateVal        = parseFloat(rate) || 0;
  const discountPct    = Math.min(100, Math.max(0, parseFloat(discount_pct) || 0));
  const discountAmount = Math.max(0, parseFloat(discount_amount) || 0);

  if (qtyOrdered <= 0) return res.status(400).json({ message: 'qty_ordered must be greater than 0' });
  if (rateVal < 0)     return res.status(400).json({ message: 'rate cannot be negative' });

  let vendorMemberId = vendor_member_id ? asInt(vendor_member_id) : null;
  let resolvedVendorName = (vendor_name || '').trim().toUpperCase();

  if (vendorMemberId) {
    const vRes = await pool.query(
      `SELECT full_name FROM members WHERE id = $1 AND site_id = $2 AND member_type = 'VENDOR'`,
      [vendorMemberId, siteId]
    );
    if (!vRes.rows[0]) return res.status(400).json({ message: 'Vendor not found for this site' });
    resolvedVendorName = vRes.rows[0].full_name;
  }
  if (!resolvedVendorName) return res.status(400).json({ message: 'vendor_name is required' });

  const commitmentIdVal = commitment_id ? asInt(commitment_id) : null;

  const result = await pool.query(
    `INSERT INTO vendor_inventory_orders
       (site_id, vendor_member_id, vendor_name, item_name, item_category, unit,
        qty_ordered, rate, discount_pct, discount_amount, order_date, expected_date, note, created_by, commitment_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING *`,
    [
      siteId,
      vendorMemberId,
      resolvedVendorName,
      item_name.trim(),
      (item_category || '').trim().toUpperCase() || null,
      (unit || '').trim(),
      qtyOrdered,
      rateVal,
      discountPct,
      discountAmount,
      order_date || new Date().toISOString().slice(0, 10),
      expected_date || null,
      (note || '').trim() || null,
      req.user.id,
      commitmentIdVal,
    ]
  );

  res.status(201).json({ order: result.rows[0] });
});

export const updateInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const existing = await pool.query(
    `SELECT id FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2`,
    [orderId, siteId]
  );
  if (!existing.rows[0]) return res.status(404).json({ message: 'Order not found' });

  const {
    item_name, item_category, unit,
    qty_ordered, rate, discount_pct, discount_amount,
    order_date, expected_date, note, status,
    vendor_name, vendor_member_id,
  } = req.body;

  const fields = [];
  const vals   = [];
  let p = 1;

  const setField = (col, val) => { fields.push(`${col} = $${p++}`); vals.push(val); };

  if (item_name     !== undefined) setField('item_name',     item_name.trim());
  if (item_category !== undefined) setField('item_category', (item_category || '').trim().toUpperCase() || null);
  if (unit          !== undefined) setField('unit',          unit.trim());
  if (qty_ordered   !== undefined) setField('qty_ordered',   parseFloat(qty_ordered) || 0);
  if (rate          !== undefined) setField('rate',          parseFloat(rate) || 0);
  if (discount_pct  !== undefined) setField('discount_pct',  Math.min(100, Math.max(0, parseFloat(discount_pct) || 0)));
  if (discount_amount !== undefined) setField('discount_amount', Math.max(0, parseFloat(discount_amount) || 0));
  if (order_date    !== undefined) setField('order_date',    order_date);
  if (expected_date !== undefined) setField('expected_date', expected_date || null);
  if (note          !== undefined) setField('note',          (note || '').trim() || null);
  if (status        !== undefined) setField('status',        status);
  if (vendor_name   !== undefined) setField('vendor_name',   (vendor_name || '').trim().toUpperCase());
  if (vendor_member_id !== undefined) setField('vendor_member_id', vendor_member_id ? asInt(vendor_member_id) : null);

  if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  vals.push(orderId, siteId);

  const result = await pool.query(
    `UPDATE vendor_inventory_orders SET ${fields.join(', ')}
     WHERE id = $${p} AND site_id = $${p + 1}
     RETURNING *`,
    vals
  );

  res.json({ order: result.rows[0] });
});

export const deleteInventoryOrder = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const result = await pool.query(
    `DELETE FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2 RETURNING id`,
    [orderId, siteId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Order not found' });

  res.json({ message: 'Order deleted' });
});

export const addInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const amount = parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'amount must be > 0' });

  const orderCheck = await pool.query(
    `SELECT id FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2`,
    [orderId, siteId]
  );
  if (!orderCheck.rows[0]) return res.status(404).json({ message: 'Order not found' });

  const { payment_date, payment_mode, reference_no, note, voucher_url, assigned_admin_id } = req.body;
  const normalizedMode = (payment_mode || 'cash').toLowerCase();

  const result = await pool.query(
    `INSERT INTO vendor_inventory_payments
       (order_id, site_id, payment_date, amount, payment_mode, reference_no, cheque_no,
        cheque_status, note, voucher_url, created_by, assigned_admin_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
     RETURNING *`,
    [
      orderId,
      siteId,
      payment_date || new Date().toISOString().slice(0, 10),
      amount,
      normalizedMode,
      (reference_no || '').trim() || null,
      normalizedMode === 'cheque' ? ((reference_no || '').trim() || null) : null,
      normalizedMode === 'cheque' ? 'PENDING' : null,
      (note || '').trim() || null,
      (voucher_url || '').trim() || null,
      req.user.id,
      assigned_admin_id ? parseInt(assigned_admin_id, 10) : null,
    ]
  );

  res.status(201).json({ payment: result.rows[0] });
});

export const updateInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const paymentId = asInt(req.params.paymentId);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });
  const visibility = await resolveEntryVisibility(req.user, 'vendors', null);
  const existingRes = await pool.query(
    `SELECT id, site_id, status, amount, created_by
       FROM vendor_inventory_payments
      WHERE id = $1 AND site_id = $2
        AND ($3::int IS NULL OR created_by = $3::int)`,
    [paymentId, siteId, visibility.creatorId]
  );
  const existing = existingRes.rows[0];
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const amount = parseFloat(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'amount must be > 0' });

  const { payment_date, payment_mode, reference_no, note, voucher_url, assigned_admin_id } = req.body;
  const normalizedMode = payment_mode || 'cash';
  const normalizedReference = (reference_no || '').trim() || null;

  const result = await pool.query(
    `UPDATE vendor_inventory_payments p
     SET payment_date = $3,
         amount = $4,
         payment_mode = $5,
         reference_no = $6,
         cheque_no = $7,
         note = $8,
         voucher_url = $9,
         assigned_admin_id = $10,
         status = 'pending',
         approved_by = NULL,
         approved_at = NULL,
         cheque_status = CASE WHEN $5 = 'cheque' THEN 'PENDING' ELSE NULL END,
         updated_at = NOW()
     FROM vendor_inventory_orders o
     WHERE p.id = $1
       AND p.order_id = o.id
       AND o.site_id = $2
       AND ($11::int IS NULL OR p.created_by = $11::int)
     RETURNING p.*`,
    [
      paymentId,
      siteId,
      payment_date || new Date().toISOString().slice(0, 10),
      amount,
      normalizedMode,
      normalizedReference,
      normalizedMode === 'cheque' ? normalizedReference : null,
      (note || '').trim() || null,
      (voucher_url || '').trim() || null,
      assigned_admin_id ? parseInt(assigned_admin_id, 10) : null,
      visibility.creatorId,
    ]
  );

  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });
  if (existing.status === 'approved') {
    await reverseApprovedImprestDebit({
      createdBy: existing.created_by,
      amount: parseFloat(existing.amount) || 0,
      referenceId: existing.id,
      sourceModule: 'vendor_inventory_payment',
      remarks: `VENDOR INVENTORY PAYMENT #${existing.id}: EDITED AND RETURNED TO APPROVAL`,
      reversedBy: req.user.id,
      siteId: existing.site_id,
    });
  }
  res.json({ payment: result.rows[0] });
});

export const deleteInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const paymentId = asInt(req.params.paymentId);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });
  const visibility = await resolveEntryVisibility(req.user, 'vendors', null);

  const result = await pool.query(
    `DELETE FROM vendor_inventory_payments p
     USING vendor_inventory_orders o
     WHERE p.id = $1 AND p.order_id = o.id AND o.site_id = $2
       AND ($3::int IS NULL OR p.created_by = $3::int)
     RETURNING p.id`,
    [paymentId, siteId, visibility.creatorId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });

  res.json({ message: 'Payment deleted' });
});

export const listInventoryCategories = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT DISTINCT item_category
     FROM vendor_inventory_orders
     WHERE site_id = $1 AND item_category IS NOT NULL AND item_category <> ''
     ORDER BY item_category ASC`,
    [siteId]
  );

  res.json({ categories: result.rows.map((r) => r.item_category) });
});

// Per-category aggregated summary (no in/out — just item count, value, paid, outstanding)
export const getInventoryStockSummary = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const visibility = await resolveEntryVisibility(req.user, 'vendors', req.query.created_by);

  // 3 independent reads in parallel — was 3 serial round-trips.
  const catPromise = pool.query(
    `SELECT
       COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED') AS category,
       COUNT(*)::int AS item_count,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(vp.total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) - vp.total_paid), 0)::numeric(14,2) AS outstanding,
       COUNT(*) FILTER (WHERE o.status = 'open')::int AS open_count,
       COUNT(*) FILTER (WHERE o.status = 'partial')::int AS partial_count,
       COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed_count
     FROM vendor_inventory_orders o
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(vip.amount), 0) AS total_paid
       FROM vendor_inventory_payments vip
       WHERE vip.order_id = o.id
         AND ${POSTED_INVENTORY_PAYMENT_SQL('vip')}
         AND ($2::int IS NULL OR vip.created_by = $2::int)
     ) vp ON true
     WHERE o.site_id = $1 AND o.status != 'cancelled'
     GROUP BY COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED')
     ORDER BY total_value DESC`,
    [siteId, visibility.creatorId]
  );

  const recentTxPromise = pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, p.payment_mode,
            o.item_name, o.item_category, o.unit
     FROM vendor_inventory_payments p
     INNER JOIN vendor_inventory_orders o ON o.id = p.order_id
     WHERE p.site_id = $1
       AND ($2::int IS NULL OR p.created_by = $2::int)
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT 10`,
    [siteId, visibility.creatorId]
  );

  const totalPromise = pool.query(
    `SELECT
       COUNT(*)::int AS total_items,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(vp.total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - vp.total_paid), 0)::numeric(14,2) AS total_outstanding
     FROM vendor_inventory_orders o
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(vip.amount), 0) AS total_paid
       FROM vendor_inventory_payments vip
       WHERE vip.order_id = o.id
         AND ${POSTED_INVENTORY_PAYMENT_SQL('vip')}
         AND ($2::int IS NULL OR vip.created_by = $2::int)
     ) vp ON true
     WHERE o.site_id = $1 AND o.status != 'cancelled'`,
    [siteId, visibility.creatorId]
  );

  const [catRes, recentTxRes, totalRes] = await Promise.all([
    catPromise, recentTxPromise, totalPromise,
  ]);

  res.json({
    categories: catRes.rows,
    recentTransactions: recentTxRes.rows,
    totals: totalRes.rows[0],
  });
});
