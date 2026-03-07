import asyncHandler from '../utils/asyncHandler.js';
import { plotRegistryModel, plotRegistryPaymentModel } from '../models/PlotRegistry.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  REGISTRY ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /registries — Create a new registry */
export const createRegistry = asyncHandler(async (req, res) => {
  const { site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name, registry_payment, notes } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!plot_no || !plot_no.trim()) return res.status(400).json({ message: 'Plot number is required' });

  const trimmed = plot_no.trim().toUpperCase();

  const existing = await plotRegistryModel.findByPlotNo(parseInt(site_id), trimmed, pool);
  if (existing) return res.status(409).json({ message: `Registry for plot "${trimmed}" already exists` });

  const data = {
    site_id: parseInt(site_id),
    plot_no: trimmed,
    customer_name: customer_name ? customer_name.trim().toUpperCase() : null,
    size_meter: parseFloat(size_meter) || null,
    size_sqyard: parseFloat(size_sqyard) || null,
    registry_date: registry_date || null,
    farmer_name: farmer_name ? farmer_name.trim().toUpperCase() : null,
    registry_payment: parseFloat(registry_payment) || 0,
    notes: notes ? notes.trim() : null,
    created_by: req.user.id,
  };

  const registry = await plotRegistryModel.create(data, pool);
  res.status(201).json({ registry });
});

/** GET /registries?site_id=X — List all registries for a site */
export const listRegistries = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const registries = await plotRegistryModel.findBySiteId(parseInt(site_id), pool);
  res.json({ registries });
});

/** GET /registries/:id — Get single registry with totals */
export const getRegistry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const registry = await plotRegistryModel.findByIdWithTotals(parseInt(id), pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  res.json({ registry });
});

/** PUT /registries/:id — Update registry details */
export const updateRegistry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name, registry_payment, notes } = req.body;

  const existing = await plotRegistryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Registry not found' });

  const updateData = {};
  if (plot_no !== undefined) {
    const trimmed = plot_no.trim().toUpperCase();
    if (trimmed !== existing.plot_no) {
      const dup = await plotRegistryModel.findByPlotNo(existing.site_id, trimmed, pool);
      if (dup) return res.status(409).json({ message: `Registry for plot "${trimmed}" already exists` });
    }
    updateData.plot_no = trimmed;
  }
  if (customer_name !== undefined) updateData.customer_name = customer_name ? customer_name.trim().toUpperCase() : null;
  if (size_meter !== undefined) updateData.size_meter = parseFloat(size_meter) || null;
  if (size_sqyard !== undefined) updateData.size_sqyard = parseFloat(size_sqyard) || null;
  if (registry_date !== undefined) updateData.registry_date = registry_date || null;
  if (farmer_name !== undefined) updateData.farmer_name = farmer_name ? farmer_name.trim().toUpperCase() : null;
  if (registry_payment !== undefined) updateData.registry_payment = parseFloat(registry_payment) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotRegistryModel.update(parseInt(id), updateData, pool);
  res.json({ registry: updated });
});

/** DELETE /registries/:id */
export const deleteRegistry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotRegistryModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Registry not found' });

  await plotRegistryModel.delete(parseInt(id), pool);
  res.json({ message: 'Registry deleted' });
});

// ══════════════════════════════════════════════════
//  REGISTRY PAYMENT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /registries/payments — Create a payment */
export const createRegistryPayment = asyncHandler(async (req, res) => {
  const { registry_id, payment_date, amount, payment_mode, tally_date, tally_amount, notes } = req.body;

  if (!registry_id) return res.status(400).json({ message: 'Registry is required' });

  const registry = await plotRegistryModel.findById(parseInt(registry_id), pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });

  const data = {
    registry_id: parseInt(registry_id),
    site_id: registry.site_id,
    payment_date: payment_date || null,
    amount: parseFloat(amount) || 0,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    tally_date: tally_date || null,
    tally_amount: tally_amount !== undefined && tally_amount !== '' ? parseFloat(tally_amount) : null,
    notes: notes ? notes.trim().toUpperCase() : null,
    created_by: req.user.id,
  };

  const payment = await plotRegistryPaymentModel.create(data, pool);
  res.status(201).json({ payment });
});

/** GET /registries/payments/list?registry_id=X */
export const listRegistryPayments = asyncHandler(async (req, res) => {
  const { registry_id } = req.query;
  if (!registry_id) return res.status(400).json({ message: 'registry_id is required' });

  const [payments, registry] = await Promise.all([
    plotRegistryPaymentModel.findByRegistryId(parseInt(registry_id), pool),
    plotRegistryModel.findByIdWithTotals(parseInt(registry_id), pool),
  ]);

  res.json({ payments, registry });
});

/** GET /registries/payments/:id */
export const getRegistryPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payment = await plotRegistryPaymentModel.findById(parseInt(id), pool);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment });
});

/** PUT /registries/payments/:id */
export const updateRegistryPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { payment_date, amount, payment_mode, tally_date, tally_amount, notes } = req.body;

  const existing = await plotRegistryPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  const updateData = {};
  if (payment_date !== undefined) updateData.payment_date = payment_date;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (payment_mode !== undefined) updateData.payment_mode = payment_mode ? payment_mode.trim().toUpperCase() : null;
  if (tally_date !== undefined) updateData.tally_date = tally_date || null;
  if (tally_amount !== undefined) updateData.tally_amount = tally_amount !== '' ? parseFloat(tally_amount) : null;
  if (notes !== undefined) updateData.notes = notes ? notes.trim().toUpperCase() : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotRegistryPaymentModel.update(parseInt(id), updateData, pool);
  res.json({ payment: updated });
});

/** DELETE /registries/payments/:id */
export const deleteRegistryPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const existing = await plotRegistryPaymentModel.findById(parseInt(id), pool);
  if (!existing) return res.status(404).json({ message: 'Payment not found' });

  await plotRegistryPaymentModel.delete(parseInt(id), pool);
  res.json({ message: 'Payment deleted' });
});

/** GET /registries/autocomplete?site_id=X */
export const getRegistryAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const data = await plotRegistryPaymentModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});
