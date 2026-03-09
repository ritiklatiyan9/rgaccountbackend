import asyncHandler from '../utils/asyncHandler.js';
import { plotModel, plotPaymentModel } from '../models/Plot.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  PLOT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /plots — Create a new plot */
export const createPlot = asyncHandler(async (req, res) => {
  const { site_id, plot_no, block, buyer_name, plot_size, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team } = req.body;

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
    team: team ? team.trim().toUpperCase() : null,
    created_by: req.user.id,
  };

  const plot = await plotModel.create(data, pool);
  res.status(201).json({ plot });
});

/** GET /plots?site_id=X — List all plots for a site */
export const listPlots = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

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
  const { plot_no, block, buyer_name, plot_size, plot_rate, sale_price, registry_area, circle_rate, to_receive_bank, first_installment, booking_by, booking_date, status, notes, plc_charges, team } = req.body;

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
  if (team !== undefined) updateData.team = team ? team.trim().toUpperCase() : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotModel.update(parseInt(id), updateData, pool);
  res.json({ plot: updated });
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
  const { plot_id, date, payment_from, payment_type, bank_details, narration, received_by, amount, voucher_url } = req.body;

  if (!plot_id) return res.status(400).json({ message: 'Plot is required' });

  const plot = await plotModel.findById(parseInt(plot_id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const data = {
    plot_id: parseInt(plot_id),
    site_id: plot.site_id,
    date: date || new Date().toISOString().split('T')[0],
    payment_from: payment_from ? payment_from.trim().toUpperCase() : null,
    payment_type: payment_type === 'BANK' ? 'BANK' : 'CASH',
    bank_details: bank_details ? bank_details.trim().toUpperCase() : null,
    narration: narration ? narration.trim().toUpperCase() : null,
    received_by: received_by ? received_by.trim().toUpperCase() : null,
    amount: parseFloat(amount) || 0,
    created_by: req.user.id,
    voucher_url: voucher_url || null,
    status: 'pending',
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
  const { date, payment_from, payment_type, bank_details, narration, received_by, amount, voucher_url } = req.body;

  const existing = await plotPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (payment_from !== undefined) updateData.payment_from = payment_from ? payment_from.trim().toUpperCase() : null;
  if (payment_type !== undefined) updateData.payment_type = payment_type === 'BANK' ? 'BANK' : 'CASH';
  if (bank_details !== undefined) updateData.bank_details = bank_details ? bank_details.trim().toUpperCase() : null;
  if (narration !== undefined) updateData.narration = narration ? narration.trim().toUpperCase() : null;
  if (received_by !== undefined) updateData.received_by = received_by ? received_by.trim().toUpperCase() : null;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (voucher_url !== undefined) updateData.voucher_url = voucher_url || null;

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
