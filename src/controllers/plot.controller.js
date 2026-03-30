import asyncHandler from '../utils/asyncHandler.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import pool from '../config/db.js';

/**
 * Auto-check BOOKED plots with free_to_sale_days set.
 * If any installment is overdue beyond grace_period + free_to_sale_days,
 * move the plot to UNDER CANCELLATION.
 */
const checkFreeToSaleStatus = async (siteId) => {
  try {
    // Dynamically check if grace_period_days column exists
    const { rows: colCheck } = await pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'plots' AND column_name = 'grace_period_days'
      ) AS has_col`
    );
    const hasGracePeriod = !!colCheck[0]?.has_col;

    const selectCols = hasGracePeriod
      ? `p.id, p.status, p.grace_period_days, p.free_to_sale_days`
      : `p.id, p.status, p.free_to_sale_days`;

    const { rows: candidates } = await pool.query(`
      SELECT ${selectCols}
      FROM plots p
      WHERE p.site_id = $1
        AND p.installments_enabled = true
        AND p.free_to_sale_days > 0
        AND p.status NOT IN ('UNDER CANCELLATION', 'CANCELLED', 'RESALE', 'TRANSFERRED', 'COMPANY')
    `, [siteId]);

    if (candidates.length === 0) return;

    const today = new Date();

    for (const plot of candidates) {
      const graceDays = parseInt(plot.grace_period_days) || 15;
      const ftsThreshold = graceDays + (parseInt(plot.free_to_sale_days) || 0);

      // Get installments + distributed payments
      const { rows: installments } = await pool.query(
        `SELECT amount, due_date FROM plot_installments WHERE plot_id = $1 ORDER BY sort_order ASC, due_date ASC`,
        [plot.id]
      );
      if (installments.length === 0) continue;

      const totalRes = await pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS total_received FROM plot_payments WHERE plot_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))`,
        [plot.id]
      );
      let remainingPool = parseFloat(totalRes.rows[0].total_received) || 0;

      let shouldCancel = false;
      for (const inst of installments) {
        const instAmt = parseFloat(inst.amount) || 0;
        const canApply = Math.min(remainingPool, instAmt);
        remainingPool -= canApply;
        const remaining = instAmt - canApply;
        if (remaining <= 0) continue;

        const dueDt = new Date(inst.due_date);
        const daysOverdue = dueDt < today ? Math.floor((today - dueDt) / (1000 * 60 * 60 * 24)) : 0;
        if (daysOverdue > ftsThreshold) { shouldCancel = true; break; }
      }

      if (shouldCancel) {
        await plotModel.update(plot.id, { status: 'UNDER CANCELLATION' }, pool);
      }
    }
  } catch (err) {
    // Non-critical — log and continue
    console.error('checkFreeToSaleStatus error:', err.message);
  }
};

let plotCommissionColumnsCache = null;
const getPlotCommissionColumns = async () => {
  if (plotCommissionColumnsCache) return plotCommissionColumnsCache;
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'plots'
       AND column_name IN ('commission_enabled', 'commission_type', 'commission_value')`
  );
  plotCommissionColumnsCache = new Set(rows.map((r) => r.column_name));
  return plotCommissionColumnsCache;
};

let plotCommissionMasterColumnsCache = null;
const getPlotCommissionMasterColumns = async () => {
  if (plotCommissionMasterColumnsCache) return plotCommissionMasterColumnsCache;
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'plot_commissions_v2'`
  );
  plotCommissionMasterColumnsCache = new Set(rows.map((r) => r.column_name));
  return plotCommissionMasterColumnsCache;
};

const maybeAutoCreatePlotCommission = async ({ plot, createdBy, fallbackAssignedAdminId = null }) => {
  if (!plot) return null;
  const bookingBy = String(plot.booking_by || '').trim();
  if (!bookingBy) return null;

  // Use plot_commission (Size × Commission Rate) if available, else fall back to old commission_enabled logic
  let totalCommission = parseFloat(plot.plot_commission) || 0;

  if (totalCommission <= 0) {
    // Fallback to old commission_enabled / commission_type / commission_value
    const commissionEnabled = !!plot.commission_enabled;
    if (!commissionEnabled) return null;
    const salePrice = parseFloat(plot.sale_price) || 0;
    const commissionType = String(plot.commission_type || 'PERCENTAGE').toUpperCase();
    const commissionValue = parseFloat(plot.commission_value) || 0;
    totalCommission = commissionType === 'FIXED'
      ? commissionValue
      : Math.round((salePrice * commissionValue / 100) * 100) / 100;
  }

  if (totalCommission <= 0) return null;

  // Resolve selected booking member as commission receiver (agent).
  const memberResult = await pool.query(
    `SELECT id, full_name
     FROM members
     WHERE site_id = $1
       AND UPPER(full_name) = UPPER($2)
     ORDER BY id ASC
     LIMIT 1`,
    [parseInt(plot.site_id), bookingBy]
  );
  const member = memberResult.rows[0];
  if (!member) return null;

  // Skip if commission already exists for this plot-agent pair.
  const existingResult = await pool.query(
    `SELECT id FROM plot_commissions_v2 WHERE plot_id = $1 AND agent_id = $2 LIMIT 1`,
    [parseInt(plot.id), parseInt(member.id)]
  );
  if (existingResult.rows[0]) return existingResult.rows[0];

  const assignedAdmin = plot.assigned_admin_id || fallbackAssignedAdminId || null;
  const masterCols = await getPlotCommissionMasterColumns();
  const hasAssignedAdminColumn = masterCols.has('assigned_admin_id');

  const insertColumns = [
    'site_id',
    'plot_id',
    'agent_id',
    'total_commission',
    'remarks',
    'status',
    ...(hasAssignedAdminColumn ? ['assigned_admin_id'] : []),
    'created_by',
  ];

  const insertValues = [
    parseInt(plot.site_id),
    parseInt(plot.id),
    parseInt(member.id),
    totalCommission,
    'Auto-created from Plot Payments booking',
    'Pending',
    ...(hasAssignedAdminColumn ? [assignedAdmin ? parseInt(assignedAdmin) : null] : []),
    createdBy ? parseInt(createdBy) : null,
  ];

  const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
  const insertResult = await pool.query(
    `INSERT INTO plot_commissions_v2 (${insertColumns.join(', ')})
     VALUES (${placeholders})
     RETURNING id`,
    insertValues
  );

  return insertResult.rows[0] || null;
};

// ══════════════════════════════════════════════════
//  PLOT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /plots — Create a new plot */
export const createPlot = asyncHandler(async (req, res) => {
  const { site_id, plot_no, block, buyer_name, plot_size, plot_size_mtr, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team, assigned_admin_id, commission_enabled, commission_type, commission_value, commission_rate, plot_commission } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!plot_no || !plot_no.trim()) return res.status(400).json({ message: 'Plot number is required' });
  if (!plot_size && plot_size !== 0) return res.status(400).json({ message: 'Plot size is required' });

  const trimmedPlotNo = plot_no.trim().toUpperCase();

  // Duplicate check
  const existing = await plotModel.findByPlotNo(parseInt(site_id), trimmedPlotNo, pool);
  if (existing) return res.status(409).json({ message: `Plot "${trimmedPlotNo}" already exists for this site` });

  const data = {
    site_id: parseInt(site_id),
    plot_no: trimmedPlotNo,
    block: block ? block.trim().toUpperCase() : null,
    buyer_name: buyer_name ? buyer_name.trim().toUpperCase() : null,
    plot_size: parseFloat(plot_size) || null,
    plot_size_mtr: parseFloat(plot_size_mtr) || null,
    plot_rate: parseFloat(plot_rate) || null,
    sale_price: parseFloat(sale_price) || 0,
    registry_area: parseFloat(registry_area) || 0,
    circle_rate: parseFloat(circle_rate) || 0,
    to_receive_bank: parseFloat(to_receive_bank) || 0,
    first_installment: parseFloat(first_installment) || 0,
    booking_by: booking_by ? booking_by.trim().toUpperCase() : null,
    booking_date: booking_date || null,
    status: status || 'BOOKED',
    notes: notes ? notes.trim() : null,
    plc_charges: parseFloat(plc_charges) || 0,
    commission_rate: parseFloat(commission_rate) || 0,
    plot_commission: parseFloat(plot_commission) || 0,
    team: team ? team.trim().toUpperCase() : null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    created_by: req.user.id,
  };

  const columns = await getPlotCommissionColumns();
  if (columns.has('commission_enabled')) data.commission_enabled = !!commission_enabled;
  if (columns.has('commission_type')) {
    const validTypes = ['PERCENTAGE', 'FIXED'];
    const normalizedType = String(commission_type || 'PERCENTAGE').toUpperCase();
    data.commission_type = validTypes.includes(normalizedType) ? normalizedType : 'PERCENTAGE';
  }
  if (columns.has('commission_value')) data.commission_value = parseFloat(commission_value) || 0;

  const plot = await plotModel.create(data, pool);

  let autoCommission = null;
  try {
    autoCommission = await maybeAutoCreatePlotCommission({
      plot,
      createdBy: req.user?.id,
      fallbackAssignedAdminId: data.assigned_admin_id,
    });
  } catch (err) {
    // Ignore if commission tables are not present yet.
    if (err?.code !== '42P01') throw err;
  }

  res.status(201).json({ plot, auto_commission: autoCommission });
});

/** GET /plots?site_id=X — List all plots for a site */
export const listPlots = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  // Auto-update status for plots past free-to-sale threshold
  await checkFreeToSaleStatus(parseInt(site_id));

  const plots = await plotModel.findBySiteId(parseInt(site_id), pool);
  res.json({ plots });
});

/** GET /plots/:id — Get single plot with totals */
export const getPlot = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const plot = await plotModel.findByIdWithTotals(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });
  res.json({ plot });
});

/** PUT /plots/:id — Update plot details */
export const updatePlot = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { plot_no, block, buyer_name, plot_size, plot_size_mtr, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team, assigned_admin_id, commission_enabled, commission_type, commission_value, commission_rate, plot_commission, original_plot_rate, discount_rate } = req.body;

  const existing = await plotModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Plot not found' });

  const updateData = {};
  if (plot_no !== undefined) {
    const trimmed = plot_no.trim().toUpperCase();
    if (trimmed !== existing.plot_no) {
      const dup = await plotModel.findByPlotNo(existing.site_id, trimmed, pool);
      if (dup) return res.status(409).json({ message: `Plot "${trimmed}" already exists` });
    }
    updateData.plot_no = trimmed;
  }
  if (block !== undefined) updateData.block = block ? block.trim().toUpperCase() : null;
  if (buyer_name !== undefined) updateData.buyer_name = buyer_name ? buyer_name.trim().toUpperCase() : null;
  if (plot_size !== undefined) updateData.plot_size = parseFloat(plot_size) || null;
  if (plot_size_mtr !== undefined) updateData.plot_size_mtr = parseFloat(plot_size_mtr) || null;
  if (plot_rate !== undefined) updateData.plot_rate = parseFloat(plot_rate) || null;
  if (sale_price !== undefined) updateData.sale_price = parseFloat(sale_price) || 0;
  if (registry_area !== undefined) updateData.registry_area = parseFloat(registry_area) || 0;
  if (circle_rate !== undefined) updateData.circle_rate = parseFloat(circle_rate) || 0;
  if (to_receive_bank !== undefined) updateData.to_receive_bank = parseFloat(to_receive_bank) || 0;
  if (first_installment !== undefined) updateData.first_installment = parseFloat(first_installment) || 0;
  if (booking_by !== undefined) updateData.booking_by = booking_by ? booking_by.trim().toUpperCase() : null;
  if (booking_date !== undefined) updateData.booking_date = booking_date || null;
  if (status !== undefined) updateData.status = status;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (plc_charges !== undefined) updateData.plc_charges = parseFloat(plc_charges) || 0;
  if (commission_rate !== undefined) updateData.commission_rate = parseFloat(commission_rate) || 0;
  if (plot_commission !== undefined) updateData.plot_commission = parseFloat(plot_commission) || 0;
  if (original_plot_rate !== undefined) updateData.original_plot_rate = parseFloat(original_plot_rate) || 0;
  if (discount_rate !== undefined) updateData.discount_rate = parseFloat(discount_rate) || 0;
  if (team !== undefined) updateData.team = team ? team.trim().toUpperCase() : null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;

  const columns = await getPlotCommissionColumns();
  if (columns.has('commission_enabled') && commission_enabled !== undefined) updateData.commission_enabled = !!commission_enabled;
  if (columns.has('commission_type') && commission_type !== undefined) {
    const validTypes = ['PERCENTAGE', 'FIXED'];
    const normalizedType = String(commission_type || 'PERCENTAGE').toUpperCase();
    updateData.commission_type = validTypes.includes(normalizedType) ? normalizedType : 'PERCENTAGE';
  }
  if (columns.has('commission_value') && commission_value !== undefined) updateData.commission_value = parseFloat(commission_value) || 0;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotModel.update(parseInt(id), updateData, pool);

  // Persist circle rate change history (backward-compatible if table does not exist yet).
  if (circle_rate !== undefined) {
    const prevRate = parseFloat(existing.circle_rate) || 0;
    const nextRate = parseFloat(updateData.circle_rate) || 0;
    if (prevRate !== nextRate) {
      try {
        await pool.query(
          `INSERT INTO plot_circle_rate_history (plot_id, previous_circle_rate, new_circle_rate, changed_by)
           VALUES ($1, $2, $3, $4)`,
          [parseInt(id), prevRate, nextRate, req.user?.id || null]
        );
      } catch (err) {
        // Ignore if migration table is not present yet.
        if (err?.code !== '42P01') throw err;
      }
    }
  }

  let autoCommission = null;
  try {
    autoCommission = await maybeAutoCreatePlotCommission({
      plot: updated,
      createdBy: req.user?.id,
      fallbackAssignedAdminId: updateData.assigned_admin_id,
    });
  } catch (err) {
    // Ignore if commission tables are not present yet.
    if (err?.code !== '42P01') throw err;
  }

  res.json({ plot: updated, auto_commission: autoCommission });
});

/** DELETE /plots/:id — Delete a plot and all its payments */
export const deletePlot = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Plot not found' });

  await plotModel.delete(parseInt(id), pool);
  res.json({ message: 'Plot deleted' });
});

// ══════════════════════════════════════════════════
//  PLOT PAYMENT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /plots/payments — Create a payment */
export const createPayment = asyncHandler(async (req, res) => {
  const { plot_id, date, payment_from, payment_type, bank_details, bank_name, branch, narration, received_by, amount, voucher_url, assigned_admin_id } = req.body;

  if (!plot_id) return res.status(400).json({ message: 'Plot is required' });

  const plot = await plotModel.findById(parseInt(plot_id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const normalizedPaymentType = ['BANK', 'CHEQUE'].includes(payment_type) ? payment_type : 'CASH';

  const data = {
    plot_id: parseInt(plot_id),
    site_id: plot.site_id,
    date: date || new Date().toISOString().split('T')[0],
    payment_from: payment_from ? payment_from.trim().toUpperCase() : null,
    payment_type: normalizedPaymentType,
    bank_details: bank_details ? bank_details.trim().toUpperCase() : null,
    bank_name: ['BANK', 'CHEQUE'].includes(normalizedPaymentType) ? (bank_name ? bank_name.trim().toUpperCase() : null) : null,
    branch: ['BANK', 'CHEQUE'].includes(normalizedPaymentType) ? (branch ? branch.trim().toUpperCase() : null) : null,
    narration: narration ? narration.trim().toUpperCase() : null,
    received_by: received_by ? received_by.trim().toUpperCase() : null,
    amount: parseFloat(amount) || 0,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    status: 'pending',
    cheque_no: req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
    cheque_status: normalizedPaymentType === 'CHEQUE' ? 'PENDING' : null,
  };

  const payment = await plotPaymentModel.create(data, pool);
  res.status(201).json({ payment });
});

/** GET /plots/payments/list?plot_id=X — List payments for a plot */
export const listPayments = asyncHandler(async (req, res) => {
  const { plot_id } = req.query;
  if (!plot_id) return res.status(400).json({ message: 'plot_id is required' });

  const [payments, plot, fromBreakdown, receivedByBreakdown] = await Promise.all([
    plotPaymentModel.findByPlotId(parseInt(plot_id), pool),
    plotModel.findByIdWithTotals(parseInt(plot_id), pool),
    plotPaymentModel.getFromBreakdown(parseInt(plot_id), pool),
    plotPaymentModel.getReceivedByBreakdown(parseInt(plot_id), pool),
  ]);

  res.json({ payments, plot, fromBreakdown, receivedByBreakdown });
});

/** GET /plots/payments/:id — Get a single payment */
export const getPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payment = await plotPaymentModel.findById(parseInt(id), pool);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment });
});

/** PUT /plots/payments/:id — Update a payment */
export const updatePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, payment_from, payment_type, bank_details, bank_name, branch, narration, received_by, amount, voucher_url, assigned_admin_id } = req.body;

  const existing = await plotPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const updateData = {};
  const normalizedPaymentType = payment_type !== undefined ? (payment_type === 'BANK' ? 'BANK' : 'CASH') : undefined;
  if (date !== undefined) updateData.date = date;
  if (payment_from !== undefined) updateData.payment_from = payment_from ? payment_from.trim().toUpperCase() : null;
  if (normalizedPaymentType !== undefined) updateData.payment_type = normalizedPaymentType;
  if (bank_details !== undefined) updateData.bank_details = bank_details ? bank_details.trim().toUpperCase() : null;
  if (bank_name !== undefined) updateData.bank_name = bank_name ? bank_name.trim().toUpperCase() : null;
  if (branch !== undefined) updateData.branch = branch ? branch.trim().toUpperCase() : null;
  if (narration !== undefined) updateData.narration = narration ? narration.trim().toUpperCase() : null;
  if (received_by !== undefined) updateData.received_by = received_by ? received_by.trim().toUpperCase() : null;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;
  if (assigned_admin_id !== undefined) updateData.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;

  if (normalizedPaymentType === 'CASH') {
    updateData.bank_name = null;
    updateData.branch = null;
  }

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotPaymentModel.update(parseInt(id), updateData, pool);
  res.json({ payment: updated });
});

/** DELETE /plots/payments/:id — Delete a payment */
export const deletePayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  await plotPaymentModel.delete(parseInt(id), pool);
  res.json({ message: 'Payment deleted' });
});

/** GET /plots/autocomplete?site_id=X — Autocomplete values */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const [data, membersResult] = await Promise.all([
    plotPaymentModel.getAutocomplete(parseInt(site_id), pool),
    pool.query(
      `SELECT full_name, phone FROM members WHERE site_id = $1 AND full_name IS NOT NULL AND full_name != '' ORDER BY full_name ASC`,
      [parseInt(site_id)]
    ),
  ]);
  data.members = membersResult.rows.map(r => ({ name: r.full_name, phone: r.phone || '' }));
  res.json(data);
});
