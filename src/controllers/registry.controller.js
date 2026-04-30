import asyncHandler from '../utils/asyncHandler.js';
import { plotRegistryModel, plotRegistryPaymentModel } from '../models/PlotRegistry.model.js';
import { plotModel } from '../models/Plot.model.js';
import pool from '../config/db.js';

// ══════════════════════════════════════════════════
//  REGISTRY ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /registries — Create a new registry */
export const createRegistry = asyncHandler(async (req, res) => {
  const {
    site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name,
    registry_payment, notes, plot_id, circle_rate, firm_name, seller_name, created_entry_date, bank_amount,
  } = req.body;

  if (!site_id) return res.status(400).json({ message: 'Site is required' });
  if (!plot_no || !plot_no.trim()) return res.status(400).json({ message: 'Plot number is required' });

  const trimmed = plot_no.trim().toUpperCase();
  const siteIdInt = parseInt(site_id);
  const plotIdInt = plot_id ? parseInt(plot_id) : null;

  // Single CTE: dup-check + INSERT + plot-status auto-bump in ONE round-trip.
  // Was: dup SELECT + INSERT + plot SELECT + plot UPDATE = 4 RTTs.
  const result = await pool.query(
    `WITH dup AS (
       SELECT 1 FROM plot_registries
        WHERE site_id = $1 AND UPPER(plot_no) = $2
        LIMIT 1
     ),
     ins AS (
       INSERT INTO plot_registries (
         site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date,
         farmer_name, plot_id, circle_rate, firm_name, seller_name, created_entry_date,
         bank_amount, registry_payment, notes, assigned_admin_id, created_by
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
       WHERE NOT EXISTS (SELECT 1 FROM dup)
       RETURNING *
     ),
     plot_bump AS (
       UPDATE plots
          SET status = 'REGISTRY', updated_at = NOW()
        WHERE id = $8
          AND UPPER(COALESCE(status, '')) = 'BOOKED'
          AND EXISTS (SELECT 1 FROM ins)
        RETURNING id
     )
     SELECT
       (SELECT row_to_json(ins) FROM ins) AS registry,
       EXISTS (SELECT 1 FROM dup) AS is_dup,
       EXISTS (SELECT 1 FROM plot_bump) AS plot_status_updated`,
    [
      siteIdInt,                                                              // $1
      trimmed,                                                                // $2
      customer_name ? customer_name.trim().toUpperCase() : null,              // $3
      parseFloat(size_meter) || null,                                         // $4
      parseFloat(size_sqyard) || null,                                        // $5
      registry_date || null,                                                  // $6
      farmer_name ? farmer_name.trim().toUpperCase() : null,                  // $7
      plotIdInt,                                                              // $8
      circle_rate !== undefined && circle_rate !== '' ? (parseFloat(circle_rate) || 0) : null, // $9
      firm_name ? firm_name.trim().toUpperCase() : null,                      // $10
      seller_name ? seller_name.trim().toUpperCase() : null,                  // $11
      created_entry_date || new Date().toISOString().split('T')[0],           // $12
      bank_amount !== undefined && bank_amount !== '' ? (parseFloat(bank_amount) || 0) : null, // $13
      parseFloat(registry_payment) || 0,                                      // $14
      notes ? notes.trim() : null,                                            // $15
      req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null, // $16
      req.user.id,                                                            // $17
    ]
  );

  const row = result.rows[0];
  if (row.is_dup) return res.status(409).json({ message: `Registry for plot "${trimmed}" already exists` });
  res.status(201).json({ registry: row.registry, plot_status_updated: row.plot_status_updated });
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
  const registryId = parseInt(req.params.id);
  const {
    plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name,
    registry_payment, notes, plot_id, circle_rate, firm_name, seller_name, created_entry_date, bank_amount,
  } = req.body;

  const existing = await plotRegistryModel.findById(registryId, pool);
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
  if (plot_id !== undefined) updateData.plot_id = plot_id ? parseInt(plot_id) : null;
  if (circle_rate !== undefined) updateData.circle_rate = circle_rate === '' ? null : (parseFloat(circle_rate) || 0);
  if (firm_name !== undefined) updateData.firm_name = firm_name ? firm_name.trim().toUpperCase() : null;
  if (seller_name !== undefined) updateData.seller_name = seller_name ? seller_name.trim().toUpperCase() : null;
  if (created_entry_date !== undefined) updateData.created_entry_date = created_entry_date || null;
  if (bank_amount !== undefined) updateData.bank_amount = bank_amount === '' ? null : (parseFloat(bank_amount) || 0);
  if (registry_payment !== undefined) updateData.registry_payment = parseFloat(registry_payment) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (req.body.assigned_admin_id !== undefined) updateData.assigned_admin_id = req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  // ── Run main UPDATE + plot-status auto-bump IN PARALLEL. ──
  // Was 4 serial RTTs (UPDATE + plot SELECT + plot UPDATE).
  const resolvedPlotId = updateData.plot_id !== undefined ? updateData.plot_id : existing.plot_id;

  const updatePromise = plotRegistryModel.update(registryId, updateData, pool);
  const plotBumpPromise = resolvedPlotId
    ? pool.query(
        `UPDATE plots SET status = 'REGISTRY', updated_at = NOW()
          WHERE id = $1 AND UPPER(COALESCE(status, '')) != 'REGISTRY'
          RETURNING id`,
        [resolvedPlotId]
      )
    : Promise.resolve({ rows: [] });

  const [updated, plotBumpRes] = await Promise.all([updatePromise, plotBumpPromise]);
  res.json({ registry: updated, plot_status_updated: (plotBumpRes.rows?.length || 0) > 0 });
});

/** DELETE /registries/:id */
export const deleteRegistry = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM plot_registries WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Registry not found' });
  res.json({ message: 'Registry deleted' });
});

// ══════════════════════════════════════════════════
//  REGISTRY PAYMENT ENDPOINTS
// ══════════════════════════════════════════════════

/** POST /registries/payments — Create a payment */
export const createRegistryPayment = asyncHandler(async (req, res) => {
  const { registry_id, payment_date, amount, payment_mode, tally_date, tally_amount, notes, source_plot_payment_id } = req.body;

  if (!registry_id) return res.status(400).json({ message: 'Registry is required' });

  const registryIdInt = parseInt(registry_id);
  // Schema check is now memoized at module load — no per-request RTT.
  const hasSourcePlotPaymentCol = await plotRegistryPaymentModel.hasSourcePlotPaymentCol(pool);

  if (source_plot_payment_id && hasSourcePlotPaymentCol) {
    const sourceId = parseInt(source_plot_payment_id);

    // Run all 3 lookups (registry, dup mapping, source payment) IN PARALLEL.
    // Was 4 serial RTTs (registry SELECT + col check + dup SELECT + source SELECT).
    const [registryRes, dupRes, sourceRes] = await Promise.all([
      pool.query(`SELECT id, site_id FROM plot_registries WHERE id = $1`, [registryIdInt]),
      pool.query(`SELECT id FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1`, [sourceId]),
      pool.query(
        `SELECT id, site_id, date, amount, payment_from, payment_type, bank_details, narration
           FROM plot_payments WHERE id = $1 LIMIT 1`,
        [sourceId]
      ),
    ]);

    const registry = registryRes.rows[0];
    if (!registry) return res.status(404).json({ message: 'Registry not found' });
    if (dupRes.rows.length > 0) {
      return res.status(200).json({ skipped: true, message: 'Plot payment is already linked in registry', payment: null });
    }
    const sourcePayment = sourceRes.rows[0];
    if (!sourcePayment) return res.status(404).json({ message: 'Selected plot payment not found' });
    if (parseInt(sourcePayment.site_id) !== parseInt(registry.site_id)) {
      return res.status(400).json({ message: 'Selected plot payment does not belong to same site' });
    }

    const linkedData = {
      registry_id: registryIdInt,
      site_id: registry.site_id,
      payment_date: sourcePayment.date || null,
      amount: parseFloat(sourcePayment.amount) || 0,
      payment_mode: sourcePayment.payment_from ? sourcePayment.payment_from.trim().toUpperCase() : (sourcePayment.payment_type ? sourcePayment.payment_type.trim().toUpperCase() : null),
      tally_date: sourcePayment.date || null,
      tally_amount: parseFloat(sourcePayment.amount) || 0,
      notes: sourcePayment.narration ? sourcePayment.narration.trim().toUpperCase() : (sourcePayment.bank_details ? sourcePayment.bank_details.trim().toUpperCase() : 'LINKED FROM PLOT PAYMENT'),
      source_plot_payment_id: sourceId,
      created_by: req.user.id,
      assigned_admin_id: req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null,
    };
    const linkedPayment = await plotRegistryPaymentModel.create(linkedData, pool);
    return res.status(201).json({ payment: linkedPayment, linked: true });
  }

  // ── Non-linked payment: registry lookup + INSERT in parallel(ish). ──
  const registryRes = await pool.query(
    `SELECT id, site_id FROM plot_registries WHERE id = $1`,
    [registryIdInt]
  );
  const registry = registryRes.rows[0];
  if (!registry) return res.status(404).json({ message: 'Registry not found' });

  const data = {
    registry_id: registryIdInt,
    site_id: registry.site_id,
    payment_date: payment_date || null,
    amount: parseFloat(amount) || 0,
    payment_mode: payment_mode ? payment_mode.trim().toUpperCase() : null,
    tally_date: tally_date || null,
    tally_amount: tally_amount !== undefined && tally_amount !== '' ? parseFloat(tally_amount) : null,
    notes: notes ? notes.trim().toUpperCase() : null,
    assigned_admin_id: req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null,
    created_by: req.user.id,
    cheque_no: req.body.cheque_no ? String(req.body.cheque_no).trim() : null,
    cheque_status: (payment_mode || '').trim().toUpperCase() === 'CHEQUE' ? 'PENDING' : null,
  };
  if (hasSourcePlotPaymentCol) data.source_plot_payment_id = null;

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
  const paymentId = parseInt(req.params.id);
  const { payment_date, amount, payment_mode, tally_date, tally_amount, notes } = req.body;

  const updateData = {};
  if (payment_date !== undefined) updateData.payment_date = payment_date;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (payment_mode !== undefined) updateData.payment_mode = payment_mode ? payment_mode.trim().toUpperCase() : null;
  if (tally_date !== undefined) updateData.tally_date = tally_date || null;
  if (tally_amount !== undefined) updateData.tally_amount = tally_amount !== '' ? parseFloat(tally_amount) : null;
  if (notes !== undefined) updateData.notes = notes ? notes.trim().toUpperCase() : null;
  if (req.body.assigned_admin_id !== undefined) updateData.assigned_admin_id = req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null;

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  // Atomic UPDATE — saves a SELECT round-trip.
  const updated = await plotRegistryPaymentModel.update(paymentId, updateData, pool);
  if (!updated) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment: updated });
});

/** DELETE /registries/payments/:id */
export const deleteRegistryPayment = asyncHandler(async (req, res) => {
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM plot_registry_payments WHERE id = $1 RETURNING id`,
    [parseInt(req.params.id)]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Payment not found' });
  res.json({ message: 'Payment deleted' });
});

/** GET /registries/autocomplete?site_id=X */
export const getRegistryAutocomplete = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const data = await plotRegistryPaymentModel.getAutocomplete(parseInt(site_id), pool);
  res.json(data);
});
