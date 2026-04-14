import asyncHandler from '../utils/asyncHandler.js';
import { plotCommissionV2Model, plotCommissionPaymentModel } from '../models/PlotCommissionV2.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';

/**
 * Helper: Auto-update commission status based on payment completion
 * Called when a payment is approved or cheque status changes
 */
const autoUpdateCommissionStatus = async (commissionId, poolConn) => {
  try {
    // Get commission details including total and paid amounts
    const commRes = await poolConn.query(
      `SELECT pc.total_commission, 
              COALESCE(SUM(pcp.amount) FILTER (WHERE pcp.status = 'approved' AND (pcp.cheque_status IS NULL OR pcp.cheque_status NOT IN ('BOUNCED', 'RETURNED'))), 0) AS total_paid
       FROM plot_commissions_v2 pc
       LEFT JOIN plot_commission_payments pcp ON pc.id = pcp.plot_commission_id
       WHERE pc.id = $1
       GROUP BY pc.id`,
      [commissionId]
    );
    
    if (commRes.rows.length === 0) return;
    
    const { total_commission, total_paid } = commRes.rows[0];
    const numCommission = parseFloat(total_commission) || 0;
    const numPaid = parseFloat(total_paid) || 0;
    
    // Determine new status
    let newStatus = 'Pending';
    if (numPaid >= numCommission) {
      newStatus = 'Completed';
    } else if (numPaid > 0) {
      newStatus = 'Partial';
    }
    
    // Update commission status
    await poolConn.query(
      `UPDATE plot_commissions_v2 SET status = $1, updated_at = NOW() WHERE id = $2`,
      [newStatus, commissionId]
    );
  } catch (err) {
    console.error('Error auto-updating commission status:', err);
    // Non-critical, don't fail the request
  }
};

/**
 * GET /plot-commission/plots
 * Load plots from plot payments module that belong to the site.
 */
export const getPlotsForCommission = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  // Get active plots where there's no commission assigned yet, or you can allow multiple
  const query = `
    SELECT p.id, p.plot_no, p.plot_size, p.plot_rate, p.buyer_name, p.block
    FROM plots p
    WHERE p.site_id = $1
    ORDER BY p.plot_no ASC
  `;
  const result = await pool.query(query, [parseInt(site_id)]);
  
  res.json({ plots: result.rows });
});

/**
 * POST /plot-commission/create
 * Create new commission linked to a plot.
 */
export const createPlotCommission = asyncHandler(async (req, res) => {
  const { site_id, plot_id, agent_id, total_commission, remarks, assigned_admin_id } = req.body;

  if (!site_id || !plot_id || !agent_id || !total_commission) {
    return res.status(400).json({ message: 'site_id, plot_id, agent_id, total_commission are required' });
  }

  // Check if this plot already has a commission assigned to this agent
  const existing = await plotCommissionV2Model.findByPlotAndAgent(parseInt(plot_id), parseInt(agent_id), pool);
  if (existing) {
     return res.status(409).json({ message: 'This agent already has a commission assigned for this plot' });
  }

  const data = {
    site_id: parseInt(site_id),
    plot_id: parseInt(plot_id),
    agent_id: parseInt(agent_id),
    total_commission: parseFloat(total_commission),
    remarks: remarks ? remarks.trim() : null,
    status: 'Pending',
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    created_by: req.user.id
  };

  const master = await plotCommissionV2Model.create(data, pool);
  res.status(201).json({ master, message: 'Plot commission created successfully' });
});

/**
 * GET /plot-commission/list
 * List commissions grouped by plot (one row per plot).
 */
export const listPlotCommissions = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const commissions = await plotCommissionV2Model.findBySiteIdGroupedByPlot(parseInt(site_id), pool);
  res.json({ commissions });
});

/**
 * GET /plot-commission/:id
 * Get single commission details and its payments.
 */
export const getPlotCommissionDetail = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid commission ID' });
  
  const [master, payments] = await Promise.all([
    plotCommissionV2Model.findByIdWithDetails(numId, pool),
    plotCommissionPaymentModel.findByCommissionId(numId, pool)
  ]);

  if (!master) return res.status(404).json({ message: 'Commission not found' });

  res.json({ master, payments });
});

/**
 * GET /plot-commission/plot/:plotId
 * Get all commissions for a plot (agent history) with all their payments.
 * Used by the new detail page that groups by plot.
 */
export const getPlotCommissionByPlot = asyncHandler(async (req, res) => {
  const { plotId } = req.params;
  const { site_id } = req.query;
  const numPlotId = parseInt(plotId);
  if (isNaN(numPlotId)) return res.status(400).json({ message: 'Invalid plot ID' });
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const commissions = await plotCommissionV2Model.findAllCommissionsByPlotId(numPlotId, parseInt(site_id), pool);
  if (!commissions || commissions.length === 0) {
    return res.status(404).json({ message: 'No commissions found for this plot' });
  }

  // Get all payments for each commission
  const commissionIds = commissions.map(c => c.id);
  const allPaymentsQuery = `
    SELECT pcp.*, u.name AS created_by_name, a.name AS approved_by_name
    FROM plot_commission_payments pcp
    LEFT JOIN users u ON pcp.created_by = u.id
    LEFT JOIN users a ON pcp.approved_by = a.id
    WHERE pcp.plot_commission_id = ANY($1)
    ORDER BY pcp.date DESC, pcp.created_at DESC
  `;
  const paymentsResult = await pool.query(allPaymentsQuery, [commissionIds]);
  const allPayments = paymentsResult.rows;

  // Group payments by commission_id
  const paymentsByCommission = {};
  for (const p of allPayments) {
    if (!paymentsByCommission[p.plot_commission_id]) {
      paymentsByCommission[p.plot_commission_id] = [];
    }
    paymentsByCommission[p.plot_commission_id].push(p);
  }

  // Plot-level info from first commission (all share the same plot)
  const plotInfo = {
    plot_id: commissions[0].plot_id,
    plot_no: commissions[0].plot_no,
    plot_size: commissions[0].plot_size,
    plot_rate: commissions[0].plot_rate,
    buyer_name: commissions[0].buyer_name,
    commission_rate: commissions[0].commission_rate,
    plot_tag: commissions[0].plot_tag,
    plot_commission: parseFloat(commissions[0].plot_commission) || 0,
    site_name: commissions[0].site_name,
    site_id: commissions[0].site_id,
  };

  // Build agent sections
  const agents = commissions.map(c => ({
    commission_id: c.id,
    agent_id: c.agent_id,
    agent_name: c.agent_name,
    agent_phone: c.agent_phone,
    total_commission: c.total_commission,
    total_paid: parseFloat(c.total_paid) || 0,
    total_paid_all: parseFloat(c.total_paid_all) || 0,
    balance: parseFloat(c.balance) || 0,
    status: c.status,
    remarks: c.remarks,
    created_at: c.created_at,
    payments: paymentsByCommission[c.id] || [],
    payment_count: (paymentsByCommission[c.id] || []).length,
  }));

  // Plot-level totals — use fixed plot commission instead of summing per-agent amounts
  const fixedCommission = parseFloat(commissions[0].plot_commission) || 0;
  const totalCommission = fixedCommission > 0 ? fixedCommission : agents.reduce((s, a) => s + parseFloat(a.total_commission), 0);
  const totalPaid = agents.reduce((s, a) => s + a.total_paid, 0);
  const totalPaidAll = agents.reduce((s, a) => s + a.total_paid_all, 0);

  // Find related plots with same plot_no (history timeline) — includes per-agent breakdown
  const timelineQuery = `
    SELECT
      p.id AS plot_id, p.plot_no, p.buyer_name, p.plot_size, p.plot_rate,
      COALESCE(p.plot_commission, 0) AS plot_commission,
      STRING_AGG(DISTINCT m.full_name, ', ' ORDER BY m.full_name) AS agent_names,
      COALESCE(NULLIF(COALESCE(p.plot_commission, 0), 0), MAX(pc.total_commission)) AS total_commission,
      COALESCE(SUM(paid_agg.total_paid), 0) AS total_paid,
      COALESCE(SUM(paid_agg.payment_count), 0) AS payment_count,
      MIN(pc.created_at) AS first_created,
      MAX(pc.created_at) AS last_created,
      MAX(pc.status) AS latest_status,
      JSON_AGG(JSON_BUILD_OBJECT(
        'commission_id', pc.id,
        'agent_name', m.full_name,
        'agent_phone', m.phone,
        'total_commission', pc.total_commission,
        'status', pc.status,
        'total_paid', COALESCE(paid_agg.total_paid, 0),
        'payment_count', COALESCE(paid_agg.payment_count, 0)
      ) ORDER BY pc.created_at ASC) AS agents_detail
    FROM plots p
    JOIN plot_commissions_v2 pc ON pc.plot_id = p.id AND pc.site_id = $2
    JOIN members m ON pc.agent_id = m.id
    LEFT JOIN (
      SELECT plot_commission_id, SUM(amount) AS total_paid, COUNT(*) AS payment_count
      FROM plot_commission_payments
      WHERE status = 'approved' AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
      GROUP BY plot_commission_id
    ) paid_agg ON paid_agg.plot_commission_id = pc.id
    WHERE p.plot_no = $1 AND pc.site_id = $2
    GROUP BY p.id, p.plot_no, p.buyer_name, p.plot_size, p.plot_rate, p.plot_commission
    ORDER BY MAX(pc.created_at) DESC
  `;
  const timelineResult = await pool.query(timelineQuery, [plotInfo.plot_no, parseInt(site_id)]);
  const timeline = timelineResult.rows.map(r => ({
    ...r,
    total_commission: parseFloat(r.total_commission) || 0,
    total_paid: parseFloat(r.total_paid) || 0,
    payment_count: parseInt(r.payment_count) || 0,
    balance: (parseFloat(r.total_commission) || 0) - (parseFloat(r.total_paid) || 0),
    is_current: r.plot_id === numPlotId,
    agents_detail: (r.agents_detail || []).map(a => ({
      ...a,
      total_commission: parseFloat(a.total_commission) || 0,
      total_paid: parseFloat(a.total_paid) || 0,
      payment_count: parseInt(a.payment_count) || 0,
    })),
  }));

  res.json({
    plot: plotInfo,
    agents,
    totals: { total_commission: totalCommission, total_paid: totalPaid, total_paid_all: totalPaidAll, balance: totalCommission - totalPaidAll },
    is_resale: commissions.length > 1,
    timeline,
  });
});

/**
 * POST /plot-commission/payment
 * Record an installment payment.
 */
export const createPlotCommissionPayment = asyncHandler(async (req, res) => {
  const { master_id, date, amount, payment_mode, bank_name, transaction_id, remarks, voucher_number, voucher_url, assigned_admin_id, cheque_no } = req.body;

  if (!master_id || !amount) {
    return res.status(400).json({ message: 'master_id and amount are required' });
  }

  const master = await plotCommissionV2Model.findByIdWithDetails(parseInt(master_id), pool);
  if (!master) return res.status(404).json({ message: 'Commission master not found' });

  // Calculate projected balance after this payment
  const numericAmount = parseFloat(amount);
  const currentPaid = parseFloat(master.total_paid) || 0;
  // Though approval happens later, we estimate the balance. Actually "balance_after_payment" 
  // might be calculated strictly at approval, but we can set an initial projected value.
  const newBalance = parseFloat(master.total_commission) - (currentPaid + numericAmount);

  const data = {
    site_id: master.site_id,
    plot_commission_id: parseInt(master_id),
    date: date || new Date().toISOString().split('T')[0],
    amount: numericAmount,
    balance_after_payment: newBalance,
    payment_mode: payment_mode || 'CASH',
    bank_name: bank_name ? bank_name.trim() : null,
    transaction_id: transaction_id ? transaction_id.trim() : null,
    remarks: remarks ? remarks.trim() : null,
    status: 'pending', // Requires approval
    voucher_number: voucher_number ? voucher_number.trim() : null,
    voucher_url: voucher_url || null,
    assigned_admin_id: assigned_admin_id ? parseInt(assigned_admin_id) : null,
    created_by: req.user.id,
    cheque_no: cheque_no ? cheque_no.trim() : null,
    cheque_status: (payment_mode || 'CASH').toUpperCase() === 'CHEQUE' ? 'PENDING' : null,
  };

  const payment = await plotCommissionPaymentModel.create(data, pool);
  
  // Auto-update commission status based on payment aggregates
  await autoUpdateCommissionStatus(parseInt(master_id), pool);
  
  res.status(201).json({ payment, message: 'Payment recorded and is pending approval' });
});

/**
 * GET /plot-commission/analytics/:id
 * Get analytics for a specific commission.
 */
export const getPlotCommissionAnalytics = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid commission ID' });
  
  const master = await plotCommissionV2Model.findByIdWithDetails(numId, pool);
  if (!master) return res.status(404).json({ message: 'Commission not found' });

  const payments = await plotCommissionPaymentModel.findByCommissionId(numId, pool);

  // Analytics calculations
  let cashPaid = 0;
  let bankPaid = 0;
  
  payments.forEach(p => {
    if (p.status === 'approved') {
      if (p.payment_mode === 'CASH') cashPaid += parseFloat(p.amount);
      if (p.payment_mode === 'BANK') bankPaid += parseFloat(p.amount);
    }
  });

  const analytics = {
    total_commission: parseFloat(master.total_commission),
    total_paid: parseFloat(master.total_paid),
    total_pending: parseFloat(master.balance),
    cash_paid: cashPaid,
    bank_paid: bankPaid,
    payment_timeline: payments.filter(p => p.status === 'approved').map(p => ({
      date: p.date,
      amount: parseFloat(p.amount)
    })).reverse() // Chronological order
  };

  res.json({ analytics });
});

/**
 * PUT /plot-commission/:id
 * Update commission master details.
 */
export const updatePlotCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { total_commission, remarks } = req.body;

  const master = await plotCommissionV2Model.findById(parseInt(id), pool);
  if (!master) return res.status(404).json({ message: 'Commission not found' });

  const updated = await plotCommissionV2Model.update(parseInt(id), {
    total_commission: parseFloat(total_commission),
    remarks: remarks ? remarks.trim() : null,
    updated_at: new Date()
  }, pool);

  res.json({ master: updated, message: 'Commission updated successfully' });
});

/**
 * DELETE /plot-commission/:id
 * Delete commission and all associated payments.
 */
export const deletePlotCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;

  // Since we have ON DELETE CASCADE in the schema for plot_commission_payments, 
  // deleting the master will automatically delete payments.
  const deleted = await plotCommissionV2Model.delete(parseInt(id), pool);
  if (!deleted) return res.status(404).json({ message: 'Commission not found' });

  res.json({ message: 'Commission and all associated payments deleted' });
});

/**
 * PUT /plot-commission/payment/:id
 * Update an individual commission payment.
 */
export const updatePlotCommissionPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid payment ID' });

  const existing = await plotCommissionPaymentModel.findById(numId, pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const { date, amount, payment_mode, bank_name, transaction_id, cheque_no, remarks, voucher_url, assigned_admin_id } = req.body;

  const data = {};
  if (date !== undefined) data.date = date;
  if (amount !== undefined) data.amount = parseFloat(amount);
  if (payment_mode !== undefined) data.payment_mode = payment_mode;
  if (bank_name !== undefined) data.bank_name = bank_name ? bank_name.trim() : null;
  if (transaction_id !== undefined) data.transaction_id = transaction_id ? transaction_id.trim() : null;
  if (cheque_no !== undefined) data.cheque_no = cheque_no ? cheque_no.trim() : null;
  if (remarks !== undefined) data.remarks = remarks ? remarks.trim() : null;
  if (voucher_url !== undefined) data.voucher_url = voucher_url || null;
  if (assigned_admin_id !== undefined) data.assigned_admin_id = assigned_admin_id ? parseInt(assigned_admin_id) : null;
  if (payment_mode !== undefined) {
    data.cheque_status = payment_mode.toUpperCase() === 'CHEQUE' ? (existing.cheque_status || 'PENDING') : null;
  }
  data.updated_at = new Date();

  const updated = await plotCommissionPaymentModel.update(numId, data, pool);
  
  // Auto-update commission status based on payment aggregates
  await autoUpdateCommissionStatus(existing.plot_commission_id, pool);
  
  res.json({ payment: updated, message: 'Payment updated successfully' });
});

/**
 * DELETE /plot-commission/payment/:id
 * Delete an individual commission payment.
 */
export const deletePlotCommissionPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid payment ID' });

  const deleted = await plotCommissionPaymentModel.delete(numId, pool);
  if (!deleted) return res.status(404).json({ message: 'Payment not found' });

  res.json({ message: 'Payment deleted successfully' });
});
