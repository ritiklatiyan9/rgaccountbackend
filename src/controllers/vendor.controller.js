import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

const asInt = (v) => parseInt(v, 10);

const getSiteId = (req) => {
  const siteId = asInt(req.query.site_id || req.body.site_id);
  return Number.isInteger(siteId) && siteId > 0 ? siteId : null;
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

  // Build WHERE conditions
  const conditions = ['vc.site_id = $1'];
  const values = [siteId];
  let paramIdx = 2;

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

  const whereClause = conditions.join(' AND ');

  // Count total for pagination
  const countResult = await pool.query(
    `SELECT COUNT(DISTINCT vc.id)::int AS total
     FROM vendor_commitments vc
     WHERE ${whereClause}`,
    values
  );
  const total = countResult.rows[0]?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  // Fetch paginated commitments
  const commitmentsResult = await pool.query(
    `SELECT
      vc.id,
      vc.site_id,
      vc.vendor_member_id,
      vc.vendor_name,
      vc.head_id,
      vc.head_name,
      vc.work_title,
      vc.contract_amount,
      vc.start_date,
      vc.due_date,
      vc.note,
      vc.status,
      vc.assigned_admin_id,
      vc.created_at,
      COALESCE(SUM(vp.amount), 0)::numeric(14,2) AS paid_amount,
      (vc.contract_amount - COALESCE(SUM(vp.amount), 0))::numeric(14,2) AS remaining_amount,
      m.full_name AS vendor_member_name,
      COUNT(vp.id)::int AS payment_count,
      COALESCE(inv.item_count, 0)::int AS inventory_item_count,
      COALESCE(inv.inv_net_amount, 0)::numeric(14,2) AS inventory_net_amount,
      COALESCE(inv.inv_total_paid, 0)::numeric(14,2) AS inventory_total_paid,
      COALESCE(inv.inv_outstanding, 0)::numeric(14,2) AS inventory_outstanding
     FROM vendor_commitments vc
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id AND (vp.cheque_status IS NULL OR vp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     LEFT JOIN (
       SELECT commitment_id,
              COUNT(*)::int AS item_count,
              SUM(net_amount)::numeric(14,2) AS inv_net_amount,
              SUM(total_paid)::numeric(14,2) AS inv_total_paid,
              SUM(net_amount - total_paid)::numeric(14,2) AS inv_outstanding
       FROM vendor_inventory_orders
       WHERE site_id = $1
       GROUP BY commitment_id
     ) inv ON inv.commitment_id = vc.id
     WHERE ${whereClause}
     GROUP BY vc.id, m.full_name, inv.item_count, inv.inv_net_amount, inv.inv_total_paid, inv.inv_outstanding
     ORDER BY vc.created_at DESC, vc.id DESC
     LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
    [...values, limit, offset]
  );

  // Summary is always for the full site (not filtered)
  const summaryResult = await pool.query(
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
      SELECT commitment_id, SUM(amount)::numeric(14,2) AS paid_amount
      FROM vendor_payments
      WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY commitment_id
     ) p ON p.commitment_id = vc.id
     CROSS JOIN (
      SELECT
        COUNT(*)::int AS total_inv_items,
        COALESCE(SUM(net_amount), 0)::numeric(14,2) AS total_inv_net,
        COALESCE(SUM(total_paid), 0)::numeric(14,2) AS total_inv_paid,
        COALESCE(SUM(net_amount - total_paid), 0)::numeric(14,2) AS total_inv_outstanding
      FROM vendor_inventory_orders
      WHERE site_id = $1
     ) inv
     WHERE vc.site_id = $1`,
    [siteId]
  );

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

  const commitmentResult = await pool.query(
    `SELECT
      vc.id,
      vc.site_id,
      vc.vendor_member_id,
      vc.vendor_name,
      vc.head_id,
      vc.head_name,
      vc.work_title,
      vc.contract_amount,
      vc.start_date,
      vc.due_date,
      vc.note,
      vc.status,
      vc.assigned_admin_id,
      vc.created_at,
      COALESCE(SUM(vp.amount), 0)::numeric(14,2) AS paid_amount,
      (vc.contract_amount - COALESCE(SUM(vp.amount), 0))::numeric(14,2) AS remaining_amount,
      m.full_name AS vendor_member_name
     FROM vendor_commitments vc
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id AND (vp.cheque_status IS NULL OR vp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     WHERE vc.id = $1 AND vc.site_id = $2
     GROUP BY vc.id, m.full_name`,
    [commitmentId, siteId]
  );

  const commitment = commitmentResult.rows[0];
  if (!commitment) return res.status(404).json({ message: 'Commitment not found' });

  const paymentsResult = await pool.query(
    `SELECT vp.id, vp.commitment_id, vp.payment_date, vp.amount, vp.payment_mode, vp.reference_no, vp.note, vp.voucher_url, vp.status, vp.approved_by, vp.approved_at, vp.created_at, vp.assigned_admin_id,
            u.name AS created_by_name
     FROM vendor_payments vp
     LEFT JOIN users u ON u.id = vp.created_by
     WHERE vp.commitment_id = $1 AND vp.site_id = $2
     ORDER BY vp.payment_date DESC, vp.id DESC`,
    [commitmentId, siteId]
  );

  // Fetch inventory orders linked to this commitment
  const inventoryResult = await pool.query(
    `SELECT
       o.id, o.vendor_member_id, o.vendor_name, o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.qty_received, o.rate, o.discount_pct, o.discount_amount,
       o.gross_amount, o.net_amount, o.total_paid,
       -- order_value = what the order is WORTH based on qty_ordered (not qty_received)
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

  // For each inventory order, fetch deliveries and payments
  const inventoryOrders = [];
  for (const order of inventoryResult.rows) {
    const [delRes, payRes] = await Promise.all([
      pool.query(
        `SELECT d.id, d.delivery_date, d.qty, d.note, d.created_at, u.name AS created_by_name
         FROM vendor_inventory_deliveries d
         LEFT JOIN users u ON u.id = d.created_by
         WHERE d.order_id = $1 ORDER BY d.delivery_date DESC, d.id DESC`,
        [order.id]
      ),
      pool.query(
        `SELECT p.id, p.payment_date, p.amount, p.payment_mode, p.reference_no, p.note, p.voucher_url, p.created_at, u.name AS created_by_name
         FROM vendor_inventory_payments p
         LEFT JOIN users u ON u.id = p.created_by
         WHERE p.order_id = $1 ORDER BY p.payment_date DESC, p.id DESC`,
        [order.id]
      ),
    ]);
    inventoryOrders.push({
      ...order,
      deliveries: delRes.rows,
      payments: payRes.rows,
    });
  }

  res.json({ commitment, payments: paymentsResult.rows, inventoryOrders });
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
      vp.payment_mode,
      vp.reference_no,
      vp.note,
      vp.voucher_url,
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

  res.json({ receipt });
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
  } = req.body;

  const amount = parseFloat(contract_amount);
  if (!work_title?.trim()) return res.status(400).json({ message: 'Work title is required' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'Contract amount must be greater than 0' });

  let vendorMemberId = vendor_member_id ? asInt(vendor_member_id) : null;
  let resolvedVendorName = (vendor_name || '').trim().toUpperCase();

  if (vendorMemberId) {
    const vendorResult = await pool.query(
      `SELECT id, full_name
       FROM members
       WHERE id = $1 AND site_id = $2 AND member_type = 'VENDOR'`,
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
       WHERE id = $1 AND site_id = $2`,
      [resolvedHeadId, siteId]
    );
    const head = headResult.rows[0];
    if (!head) return res.status(400).json({ message: 'Selected head is invalid for this site' });
    finalHeadName = head.name;
  }

  if (!finalHeadName) return res.status(400).json({ message: 'Head is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const result = await client.query(
      `INSERT INTO vendor_commitments (site_id, vendor_member_id, vendor_name, head_id, head_name, work_title, contract_amount, start_date, due_date, note, created_by, assigned_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        siteId,
        vendorMemberId,
        resolvedVendorName,
        finalHeadId,
        finalHeadName,
        work_title.trim(),
        amount,
        start_date || null,
        due_date || null,
        note?.trim() || null,
        req.user.id,
        assigned_admin_id ? parseInt(assigned_admin_id) : null,
      ]
    );

    const commitment = result.rows[0];

    // Insert inventory items if provided
    const createdItems = [];
    if (Array.isArray(inventory_items) && inventory_items.length > 0) {
      for (const item of inventory_items) {
        const itemName = (item.item_name || '').trim();
        if (!itemName) continue;
        const qtyOrdered = parseFloat(item.qty_ordered) || 0;
        const rateVal = parseFloat(item.rate) || 0;
        if (qtyOrdered <= 0) continue;

        const discountPct = Math.min(100, Math.max(0, parseFloat(item.discount_pct) || 0));
        const discountAmount = Math.max(0, parseFloat(item.discount_amount) || 0);

        const itemRes = await client.query(
          `INSERT INTO vendor_inventory_orders
             (site_id, commitment_id, vendor_member_id, vendor_name, item_name, item_category, unit,
              qty_ordered, rate, discount_pct, discount_amount, order_date, expected_date, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING *`,
          [
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
            start_date || new Date().toISOString().slice(0, 10),
            item.expected_date || null,
            (item.note || '').trim() || null,
            req.user.id,
          ]
        );
        createdItems.push(itemRes.rows[0]);
      }
    }

    await client.query('COMMIT');

    res.status(201).json({ commitment, inventory_items: createdItems });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const addVendorPayment = asyncHandler(async (req, res) => {
  const commitmentId = asInt(req.params.id);
  const siteId = getSiteId(req);
  if (!Number.isInteger(commitmentId)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const {
    payment_date,
    amount,
    payment_mode,
    reference_no,
    note,
    voucher_url,
    assigned_admin_id,
  } = req.body;

  const paymentAmount = parseFloat(amount);
  if (!payment_date) return res.status(400).json({ message: 'Payment date is required' });
  if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) {
    return res.status(400).json({ message: 'Payment amount must be greater than 0' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const commitmentResult = await client.query(
      `SELECT id, contract_amount
       FROM vendor_commitments
       WHERE id = $1 AND site_id = $2
       FOR UPDATE`,
      [commitmentId, siteId]
    );

    const commitment = commitmentResult.rows[0];
    if (!commitment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Commitment not found' });
    }

    const paidResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS paid
       FROM vendor_payments
       WHERE commitment_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))`,
      [commitmentId]
    );

    const alreadyPaid = parseFloat(paidResult.rows[0].paid) || 0;
    const contractAmount = parseFloat(commitment.contract_amount) || 0;
    const remaining = contractAmount - alreadyPaid;

    const vendorPayMode = (payment_mode || 'cash').toLowerCase();
    const paymentResult = await client.query(
      `INSERT INTO vendor_payments (commitment_id, site_id, payment_date, amount, payment_mode, reference_no, note, voucher_url, status, created_by, assigned_admin_id, cheque_no, cheque_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [
        commitmentId,
        siteId,
        payment_date,
        paymentAmount,
        vendorPayMode,
        reference_no?.trim() || null,
        note?.trim() || null,
        voucher_url || null,
        'pending',
        req.user.id,
        assigned_admin_id ? parseInt(assigned_admin_id) : null,
        req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
        vendorPayMode === 'cheque' ? 'PENDING' : null,
      ]
    );

    await client.query(
      `UPDATE vendor_commitments
       SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [commitmentId]
    );

    await client.query('COMMIT');

    res.status(201).json({ payment: paymentResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const updateVendorPayment = asyncHandler(async (req, res) => {
  const paymentId = asInt(req.params.paymentId);
  const siteId = getSiteId(req);
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const {
    payment_date,
    amount,
    payment_mode,
    reference_no,
    note,
    voucher_url,
    assigned_admin_id,
  } = req.body;

  const nextAmount = parseFloat(amount);
  if (!payment_date) return res.status(400).json({ message: 'Payment date is required' });
  if (!Number.isFinite(nextAmount) || nextAmount <= 0) {
    return res.status(400).json({ message: 'Payment amount must be greater than 0' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT id, site_id, commitment_id, amount
       FROM vendor_payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentId]
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.site_id !== siteId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found' });
    }

    const commitmentResult = await client.query(
      `SELECT id, contract_amount
       FROM vendor_commitments
       WHERE id = $1 AND site_id = $2
       FOR UPDATE`,
      [existing.commitment_id, siteId]
    );
    const commitment = commitmentResult.rows[0];
    if (!commitment) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Commitment not found' });
    }

    const sumResult = await client.query(
      `SELECT COALESCE(SUM(amount), 0)::numeric(14,2) AS paid
       FROM vendor_payments
       WHERE commitment_id = $1 AND id <> $2 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))`,
      [existing.commitment_id, paymentId]
    );

    const paidExcludingCurrent = parseFloat(sumResult.rows[0].paid) || 0;
    const contractAmount = parseFloat(commitment.contract_amount) || 0;
    const remainingCapacity = contractAmount - paidExcludingCurrent;

    const updatedPaymentResult = await client.query(
      `UPDATE vendor_payments SET payment_date = $1, amount = $2, payment_mode = $3, reference_no = $4, note = $5, voucher_url = $6, assigned_admin_id = $7 WHERE id = $8 RETURNING *`,
      [
        payment_date,
        nextAmount,
        (payment_mode || 'cash').toLowerCase(),
        reference_no?.trim() || null,
        note?.trim() || null,
        voucher_url || null,
        assigned_admin_id !== undefined ? (assigned_admin_id ? parseInt(assigned_admin_id) : null) : existing.assigned_admin_id,
        paymentId,
      ]
    );

    await client.query(
      `UPDATE vendor_commitments
       SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [existing.commitment_id]
    );

    await client.query('COMMIT');
    res.json({ payment: updatedPaymentResult.rows[0] });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const deleteVendorPayment = asyncHandler(async (req, res) => {
  const paymentId = asInt(req.params.paymentId);
  const siteId = getSiteId(req);
  if (!Number.isInteger(paymentId)) return res.status(400).json({ message: 'Invalid payment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingResult = await client.query(
      `SELECT id, site_id, commitment_id
       FROM vendor_payments
       WHERE id = $1
       FOR UPDATE`,
      [paymentId]
    );
    const existing = existingResult.rows[0];
    if (!existing || existing.site_id !== siteId) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Payment not found' });
    }

    await client.query(`DELETE FROM vendor_payments WHERE id = $1`, [paymentId]);

    await client.query(
      `UPDATE vendor_commitments
       SET updated_at = CURRENT_TIMESTAMP
       WHERE id = $1`,
      [existing.commitment_id]
    );

    await client.query('COMMIT');
    res.json({ message: 'Vendor payment deleted' });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

// Distribute a commitment payment proportionally or manually to inventory items
export const distributePaymentToItems = asyncHandler(async (req, res) => {
  const commitmentId = asInt(req.params.id);
  const siteId = getSiteId(req);
  if (!Number.isInteger(commitmentId)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const { allocations, payment_date, payment_mode, reference_no, note } = req.body;

  // allocations = [{ order_id, amount }]
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return res.status(400).json({ message: 'At least one allocation is required' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify commitment belongs to site
    const comRes = await client.query(
      `SELECT id FROM vendor_commitments WHERE id = $1 AND site_id = $2`,
      [commitmentId, siteId]
    );
    if (!comRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Commitment not found' });
    }

    const created = [];
    for (const alloc of allocations) {
      const orderId = asInt(alloc.order_id);
      const amount = parseFloat(alloc.amount);
      if (!Number.isInteger(orderId) || !Number.isFinite(amount) || amount <= 0) continue;

      // Verify item belongs to this commitment
      const itemRes = await client.query(
        `SELECT id FROM vendor_inventory_orders WHERE id = $1 AND commitment_id = $2 AND site_id = $3`,
        [orderId, commitmentId, siteId]
      );
      if (!itemRes.rows[0]) continue;

      // Insert inventory payment
      const payRes = await client.query(
        `INSERT INTO vendor_inventory_payments (order_id, site_id, payment_date, amount, payment_mode, reference_no, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          orderId,
          siteId,
          payment_date || new Date().toISOString().split('T')[0],
          amount,
          (payment_mode || 'cash').toLowerCase(),
          reference_no?.trim() || null,
          note?.trim() || null,
          req.user.id,
        ]
      );
      created.push(payRes.rows[0]);
    }

    await client.query('COMMIT');
    res.status(201).json({ payments: created, count: created.length });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});

export const listAllInventoryItems = asyncHandler(async (req, res) => {
  const siteId = getSiteId(req);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const result = await pool.query(
    `SELECT
       o.id, o.commitment_id, o.item_name, o.item_category, o.unit,
       o.qty_ordered, o.qty_received, o.rate,
       o.gross_amount, o.net_amount, o.total_paid,
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
     ORDER BY o.created_at DESC, o.id DESC`,
    [siteId]
  );

  const summaryResult = await pool.query(
    `SELECT
       COUNT(*)::int AS total_items,
       COALESCE(SUM(qty_ordered), 0)::numeric(14,2) AS total_qty_ordered,
       COALESCE(SUM(qty_received), 0)::numeric(14,2) AS total_qty_received,
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
     WHERE site_id = $1`,
    [siteId]
  );

  res.json({ items: result.rows, summary: summaryResult.rows[0] });
});

export const updateVendorCommitment = asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  const siteId = getSiteId(req);

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });

  const existing = await pool.query(
    'SELECT id FROM vendor_commitments WHERE id = $1 AND site_id = $2',
    [id, siteId]
  );
  if (!existing.rows[0]) return res.status(404).json({ message: 'Commitment not found' });

  const fields = [];
  const values = [];

  const allowed = ['vendor_name', 'head_id', 'head_name', 'work_title', 'start_date', 'due_date', 'note', 'contract_amount', 'status'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      fields.push(`${key} = $${fields.length + 1}`);
      values.push(req.body[key]);
    }
  }

  if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  values.push(id, siteId);
  const result = await pool.query(
    `UPDATE vendor_commitments
     SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${values.length - 1} AND site_id = $${values.length}
     RETURNING *`,
    values
  );

  res.json({ commitment: result.rows[0] });
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

  await pool.query('DELETE FROM vendor_commitments WHERE id = $1 AND site_id = $2', [id, siteId]);
  res.json({ message: 'Commitment deleted' });
});

export const updateVendorCommitmentStatus = asyncHandler(async (req, res) => {
  const id = asInt(req.params.id);
  const status = (req.body.status || '').toLowerCase();
  const siteId = getSiteId(req);

  if (!Number.isInteger(id)) return res.status(400).json({ message: 'Invalid commitment id' });
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!['open', 'closed', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'Invalid status' });
  }

  const result = await pool.query(
    `UPDATE vendor_commitments
     SET status = $1,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND site_id = $3
     RETURNING *`,
    [status, id, siteId]
  );

  if (!result.rows[0]) return res.status(404).json({ message: 'Commitment not found' });

  res.json({ commitment: result.rows[0] });
});
