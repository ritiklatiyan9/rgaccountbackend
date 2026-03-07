import asyncHandler from '../utils/asyncHandler.js';
import plotCommissionModel from '../models/PlotCommission.model.js';
import pool from '../config/db.js';

/**
 * POST /commissions
 * Create a new commission entry
 */
export const createCommission = asyncHandler(async (req, res) => {
  const { site_id, date, particular, father_name, plot_no, plot_size, plot_rate, amount, by_note, remarks } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!particular) return res.status(400).json({ message: 'Particular (person name) is required' });

  const data = {
    site_id: parseInt(site_id),
    date: date || new Date().toISOString().split('T')[0],
    particular: particular.trim().toUpperCase(),
    father_name: father_name ? father_name.trim().toUpperCase() : null,
    plot_no: plot_no ? plot_no.trim().toUpperCase() : null,
    plot_size: plot_size ? plot_size.trim().toUpperCase() : null,
    plot_rate: plot_rate ? plot_rate.trim().toUpperCase() : null,
    amount: parseFloat(amount) || 0,
    by_note: by_note ? by_note.trim() : null,
    remarks: remarks ? remarks.trim() : null,
    created_by: req.user.id,
  };

  const commission = await plotCommissionModel.create(data, pool);
  res.status(201).json({ commission });
});

/**
 * GET /commissions?site_id=X
 * List all commission entries for a site + summary
 */
export const listCommissions = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id query param is required' });

  const siteId = parseInt(site_id);
  const [commissions, summary, persons] = await Promise.all([
    plotCommissionModel.findBySiteId(siteId, pool),
    plotCommissionModel.getSummary(siteId, pool),
    plotCommissionModel.getPersonSummary(siteId, pool),
  ]);

  res.json({ commissions, summary, persons });
});

/**
 * GET /commissions/autocomplete?site_id=X
 * Get unique particulars and plots for autocomplete
 */
export const getAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const siteId = parseInt(site_id);
  const [particulars, plots] = await Promise.all([
    plotCommissionModel.getUniqueParticulars(siteId, pool),
    plotCommissionModel.getUniquePlots(siteId, pool),
  ]);

  res.json({ particulars, plots });
});

/**
 * GET /commissions/:id
 * Get single commission
 */
export const getCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const commission = await plotCommissionModel.findById(parseInt(id), pool);
  if (!commission) return res.status(404).json({ message: 'Commission entry not found' });
  res.json({ commission });
});

/**
 * PUT /commissions/:id
 * Update a commission entry
 */
export const updateCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { date, particular, father_name, plot_no, plot_size, plot_rate, amount, by_note, remarks } = req.body;

  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission entry not found' });

  const updateData = {};
  if (date !== undefined) updateData.date = date;
  if (particular !== undefined) updateData.particular = particular.trim().toUpperCase();
  if (father_name !== undefined) updateData.father_name = father_name ? father_name.trim().toUpperCase() : null;
  if (plot_no !== undefined) updateData.plot_no = plot_no ? plot_no.trim().toUpperCase() : null;
  if (plot_size !== undefined) updateData.plot_size = plot_size ? plot_size.trim().toUpperCase() : null;
  if (plot_rate !== undefined) updateData.plot_rate = plot_rate ? plot_rate.trim().toUpperCase() : null;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (by_note !== undefined) updateData.by_note = by_note ? by_note.trim() : null;
  if (remarks !== undefined) updateData.remarks = remarks ? remarks.trim() : null;

  const updated = await plotCommissionModel.update(parseInt(id), updateData, pool);
  res.json({ commission: updated });
});

/**
 * DELETE /commissions/:id
 * Delete a commission entry
 */
export const deleteCommission = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotCommissionModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Commission entry not found' });

  await plotCommissionModel.delete(parseInt(id), pool);
  res.json({ message: 'Commission entry deleted' });
});
