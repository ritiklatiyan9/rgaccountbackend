import asyncHandler from '../utils/asyncHandler.js';
import { plotCommissionV2Model, plotCommissionPaymentModel } from '../models/PlotCommissionV2.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';

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
 * List all commissions with aggregated payment data.
 */
export const listPlotCommissions = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const commissions = await plotCommissionV2Model.findBySiteIdWithDetails(parseInt(site_id), pool);
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
