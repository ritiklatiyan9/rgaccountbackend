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
    `SELECT id, site_id, name, is_active, created_at
     FROM vendor_heads
     WHERE site_id = $1
     ORDER BY LOWER(name) ASC`,
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
      COUNT(vp.id)::int AS payment_count
     FROM vendor_commitments vc
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     WHERE ${whereClause}
     GROUP BY vc.id, m.full_name
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
      (COALESCE(SUM(vc.contract_amount), 0) - COALESCE(SUM(p.paid_amount), 0))::numeric(14,2) AS total_remaining_amount
     FROM vendor_commitments vc
     LEFT JOIN (
      SELECT commitment_id, SUM(amount)::numeric(14,2) AS paid_amount
      FROM vendor_payments
      WHERE site_id = $1
      GROUP BY commitment_id
     ) p ON p.commitment_id = vc.id
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
     LEFT JOIN vendor_payments vp ON vp.commitment_id = vc.id
     LEFT JOIN members m ON m.id = vc.vendor_member_id
     WHERE vc.id = $1 AND vc.site_id = $2
     GROUP BY vc.id, m.full_name`,
    [commitmentId, siteId]
  );

  const commitment = commitmentResult.rows[0];
  if (!commitment) return res.status(404).json({ message: 'Commitment not found' });

  const paymentsResult = await pool.query(
    `SELECT id, commitment_id, payment_date, amount, payment_mode, reference_no, note, voucher_url, status, approved_by, approved_at, created_at, assigned_admin_id
     FROM vendor_payments
     WHERE commitment_id = $1 AND site_id = $2
     ORDER BY payment_date DESC, id DESC`,
    [commitmentId, siteId]
  );

  res.json({ commitment, payments: paymentsResult.rows });
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

  const result = await pool.query(
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

  res.status(201).json({ commitment: result.rows[0] });
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
       WHERE commitment_id = $1`,
      [commitmentId]
    );

    const alreadyPaid = parseFloat(paidResult.rows[0].paid) || 0;
    const contractAmount = parseFloat(commitment.contract_amount) || 0;
    const remaining = contractAmount - alreadyPaid;

    const paymentResult = await client.query(
      `INSERT INTO vendor_payments (commitment_id, site_id, payment_date, amount, payment_mode, reference_no, note, voucher_url, status, created_by, assigned_admin_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        commitmentId,
        siteId,
        payment_date,
        paymentAmount,
        (payment_mode || 'cash').toLowerCase(),
        reference_no?.trim() || null,
        note?.trim() || null,
        voucher_url || null,
        'pending',
        req.user.id,
        assigned_admin_id ? parseInt(assigned_admin_id) : null,
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
       WHERE commitment_id = $1 AND id <> $2`,
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
