import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

const asInt = (v) => parseInt(v, 10);

const getSiteId = (req) => {
  const siteId = asInt(req.query.site_id || req.body.site_id);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
};

// ─────────────────────────────────────────────────────────────
// LIST  GET /vendors/inventory?site_id=&page=&limit=&search=&status=&vendor_id=
// ─────────────────────────────────────────────────────────────
export const listInventoryOrders = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

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

  const countRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM vendor_inventory_orders o WHERE ${where}`,
    values
  );
  const total = countRes.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const ordersRes = await pool.query(
    `SELECT
       o.id,
       o.site_id,
       o.vendor_member_id,
       o.vendor_name,
       o.item_name,
       o.item_category,
       o.unit,
       o.qty_ordered,
       o.qty_received,
       o.rate,
       o.discount_pct,
       o.discount_amount,
       o.gross_amount,
       o.net_amount,
       o.total_paid,
       o.commitment_id,
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
       o.order_date,
       o.expected_date,
       o.note,
       o.status,
       o.created_at,
       m.full_name AS vendor_member_name,
       vc.head_name, vc.work_title
     FROM vendor_inventory_orders o
     LEFT JOIN members m ON m.id = o.vendor_member_id
     LEFT JOIN vendor_commitments vc ON vc.id = o.commitment_id
     WHERE ${where}
     ORDER BY o.order_date DESC, o.id DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...values, limit, offset]
  );

  // site-wide summary (unfiltered) – use qty_ordered-based amounts
  const sumRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total_orders,
       COALESCE(SUM(qty_ordered), 0)  AS total_qty_ordered,
       COALESCE(SUM(qty_received), 0) AS total_qty_received,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0) AS total_net_amount,
       COALESCE(SUM(total_paid), 0)   AS total_paid,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2) - total_paid), 0) AS total_outstanding,
       COALESCE(SUM(discount_amount + CASE WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2) ELSE 0 END), 0) AS total_discount
     FROM vendor_inventory_orders
     WHERE site_id = $1`,
    [siteId]
  );

  res.json({
    orders: ordersRes.rows,
    pagination: { page, limit, total, totalPages },
    summary: sumRes.rows[0],
  });
});

// ─────────────────────────────────────────────────────────────
// DETAIL  GET /vendors/inventory/:id?site_id=
// ─────────────────────────────────────────────────────────────
export const getInventoryOrderDetail = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const orderRes = await pool.query(
    `SELECT o.*,
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

  const deliveriesRes = await pool.query(
    `SELECT d.*, u.name AS created_by_name
     FROM vendor_inventory_deliveries d
     LEFT JOIN users u ON u.id = d.created_by
     WHERE d.order_id = $1
     ORDER BY d.delivery_date DESC, d.id DESC`,
    [orderId]
  );

  const paymentsRes = await pool.query(
    `SELECT p.*, u.name AS created_by_name
     FROM vendor_inventory_payments p
     LEFT JOIN users u ON u.id = p.created_by
     WHERE p.order_id = $1
     ORDER BY p.payment_date DESC, p.id DESC`,
    [orderId]
  );

  res.json({ order, deliveries: deliveriesRes.rows, payments: paymentsRes.rows });
});

// ─────────────────────────────────────────────────────────────
// CREATE ORDER  POST /vendors/inventory
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// UPDATE ORDER  PUT /vendors/inventory/:id
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// DELETE ORDER  DELETE /vendors/inventory/:id
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// ADD DELIVERY  POST /vendors/inventory/:id/deliveries
// ─────────────────────────────────────────────────────────────
export const addDelivery = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const orderId = asInt(req.params.id);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(orderId)) return res.status(400).json({ message: 'Invalid order id' });

  const qty = parseFloat(req.body.qty);
  if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ message: 'qty must be > 0' });

  const orderCheck = await pool.query(
    `SELECT id FROM vendor_inventory_orders WHERE id = $1 AND site_id = $2`,
    [orderId, siteId]
  );
  if (!orderCheck.rows[0]) return res.status(404).json({ message: 'Order not found' });

  const result = await pool.query(
    `INSERT INTO vendor_inventory_deliveries (order_id, site_id, delivery_date, qty, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      orderId,
      siteId,
      req.body.delivery_date || new Date().toISOString().slice(0, 10),
      qty,
      (req.body.note || '').trim() || null,
      req.user.id,
    ]
  );

  res.status(201).json({ delivery: result.rows[0] });
});

// ─────────────────────────────────────────────────────────────
// DELETE DELIVERY  DELETE /vendors/inventory/deliveries/:deliveryId
// ─────────────────────────────────────────────────────────────
export const deleteDelivery = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const deliveryId = asInt(req.params.deliveryId);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(deliveryId)) return res.status(400).json({ message: 'Invalid delivery id' });

  const result = await pool.query(
    `DELETE FROM vendor_inventory_deliveries d
     USING vendor_inventory_orders o
     WHERE d.id = $1 AND d.order_id = o.id AND o.site_id = $2
     RETURNING d.id`,
    [deliveryId, siteId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Delivery not found' });

  res.json({ message: 'Delivery deleted' });
});

// ─────────────────────────────────────────────────────────────
// ADD PAYMENT  POST /vendors/inventory/:id/payments
// ─────────────────────────────────────────────────────────────
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

  const { payment_date, payment_mode, reference_no, note, voucher_url } = req.body;

  const result = await pool.query(
    `INSERT INTO vendor_inventory_payments
       (order_id, site_id, payment_date, amount, payment_mode, reference_no, cheque_no, note, voucher_url, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [
      orderId,
      siteId,
      payment_date || new Date().toISOString().slice(0, 10),
      amount,
      payment_mode || 'cash',
      (reference_no || '').trim() || null,
      payment_mode === 'cheque' ? ((reference_no || '').trim() || null) : null,
      (note || '').trim() || null,
      (voucher_url || '').trim() || null,
      req.user.id,
    ]
  );

  res.status(201).json({ payment: result.rows[0] });
});

// ─────────────────────────────────────────────────────────────
// DELETE PAYMENT  DELETE /vendors/inventory/payments/:paymentId
// ─────────────────────────────────────────────────────────────
export const deleteInventoryPayment = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  const paymentId = asInt(req.params.paymentId);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });

  const result = await pool.query(
    `DELETE FROM vendor_inventory_payments p
     USING vendor_inventory_orders o
     WHERE p.id = $1 AND p.order_id = o.id AND o.site_id = $2
     RETURNING p.id`,
    [paymentId, siteId]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });

  res.json({ message: 'Payment deleted' });
});

// ─────────────────────────────────────────────────────────────
// GET ITEM CATEGORIES  GET /vendors/inventory/categories?site_id=
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// STOCK SUMMARY  GET /vendors/inventory/stock-summary?site_id=
// Per-category aggregated stock: ordered, received, remaining, value, paid
// ─────────────────────────────────────────────────────────────
export const getInventoryStockSummary = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  // Per-category breakdown
  const catRes = await pool.query(
    `SELECT
       COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED') AS category,
       COUNT(*)::int AS item_count,
       COALESCE(SUM(o.qty_ordered), 0)::numeric(14,3) AS total_ordered,
       COALESCE(SUM(o.qty_received), 0)::numeric(14,3) AS total_received,
       COALESCE(SUM(o.qty_ordered - o.qty_received), 0)::numeric(14,3) AS remaining,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(o.total_paid), 0)::numeric(14,2) AS total_paid,
       COALESCE(SUM(ROUND(o.qty_ordered * o.rate
         - COALESCE(CASE
           WHEN o.discount_pct > 0 THEN ROUND(o.qty_ordered * o.rate * o.discount_pct / 100, 2)
           ELSE o.discount_amount
         END, 0), 2) - o.total_paid), 0)::numeric(14,2) AS outstanding,
       COUNT(*) FILTER (WHERE o.status = 'open')::int AS open_count,
       COUNT(*) FILTER (WHERE o.status = 'partial')::int AS partial_count,
       COUNT(*) FILTER (WHERE o.status = 'completed')::int AS completed_count,
       MODE() WITHIN GROUP (ORDER BY o.unit) AS common_unit
     FROM vendor_inventory_orders o
     WHERE o.site_id = $1 AND o.status != 'cancelled'
     GROUP BY COALESCE(NULLIF(o.item_category, ''), 'UNCATEGORIZED')
     ORDER BY total_value DESC`,
    [siteId]
  );

  // Recent activity (last 10 deliveries + last 10 inventory payments)
  const recentInRes = await pool.query(
    `SELECT d.id, d.delivery_date AS date, d.qty, o.item_name, o.unit, o.item_category, 'delivery' AS type
     FROM vendor_inventory_deliveries d
     INNER JOIN vendor_inventory_orders o ON o.id = d.order_id
     WHERE d.site_id = $1
     ORDER BY d.delivery_date DESC, d.id DESC
     LIMIT 10`,
    [siteId]
  );

  const recentOutRes = await pool.query(
    `SELECT p.id, p.payment_date AS date, p.amount, o.item_name, o.item_category, 'payment' AS type
     FROM vendor_inventory_payments p
     INNER JOIN vendor_inventory_orders o ON o.id = p.order_id
     WHERE p.site_id = $1
     ORDER BY p.payment_date DESC, p.id DESC
     LIMIT 10`,
    [siteId]
  );

  // Site-wide totals
  const totalRes = await pool.query(
    `SELECT
       COUNT(*)::int AS total_items,
       COALESCE(SUM(qty_ordered), 0)::numeric(14,3) AS total_ordered,
       COALESCE(SUM(qty_received), 0)::numeric(14,3) AS total_received,
       COALESCE(SUM(ROUND(qty_ordered * rate
         - COALESCE(CASE
           WHEN discount_pct > 0 THEN ROUND(qty_ordered * rate * discount_pct / 100, 2)
           ELSE discount_amount
         END, 0), 2)), 0)::numeric(14,2) AS total_value,
       COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_paid
     FROM vendor_inventory_orders
     WHERE site_id = $1 AND status != 'cancelled'`,
    [siteId]
  );

  res.json({
    categories: catRes.rows,
    recentIn: recentInRes.rows,
    recentOut: recentOutRes.rows,
    totals: totalRes.rows[0],
  });
});
