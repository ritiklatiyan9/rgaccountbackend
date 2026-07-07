import asyncHandler from '../utils/asyncHandler.js';
import { plotRegistryModel, plotRegistryPaymentModel } from '../models/PlotRegistry.model.js';
import { plotModel } from '../models/Plot.model.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
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
          SET status = 'PENDING NOC', updated_at = NOW()
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
  // Plot becomes 'REGISTRY' only via NOC approval (approveRegistryNoc); here we
  // only move fresh BOOKED plots into the pending stage.
  const plotBumpPromise = resolvedPlotId
    ? pool.query(
        `UPDATE plots SET status = 'PENDING NOC', updated_at = NOW()
          WHERE id = $1 AND UPPER(COALESCE(status, '')) = 'BOOKED'
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

// ══════════════════════════════════════════════════
//  NOC (NO OBJECTION CERTIFICATE) ENDPOINTS
// ══════════════════════════════════════════════════

/** Aggregate payload for the NOC workspace + print page in one round trip:
 *  registry, resolved plot, site, letterhead (booking module's shared
 *  project_settings, if present), every plot payment with its NOC link
 *  state, and the NOC-only inline payments. */
const buildNocPayload = async (registryId) => {
  const registry = await plotRegistryModel.findByIdWithTotals(registryId, pool);
  if (!registry) return null;

  const plotPromise = registry.plot_id
    ? pool.query(`SELECT * FROM plots WHERE id = $1`, [registry.plot_id])
    : pool.query(
        `SELECT * FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id DESC LIMIT 1`,
        [registry.site_id, registry.plot_no]
      );
  const sitePromise = pool.query(
    `SELECT id, name, code, address, city, state FROM sites WHERE id = $1`,
    [registry.site_id]
  );
  // Letterhead comes from the booking module's project_settings table (same
  // DB). Optional — swallow errors so a missing table never breaks the NOC.
  const letterheadPromise = pool
    .query(
      `SELECT company_legal_name, company_brand_name, company_address, company_city,
              company_phone, company_email, company_gstin, company_website, logo_url
         FROM project_settings WHERE site_id = $1 LIMIT 1`,
      [registry.site_id]
    )
    .catch(() => ({ rows: [] }));
  const inlinePromise = pool.query(
    `SELECT prp.*, u.name AS created_by_name
       FROM plot_registry_payments prp
       LEFT JOIN users u ON u.id = prp.created_by
      WHERE prp.registry_id = $1 AND prp.source_plot_payment_id IS NULL
      ORDER BY prp.payment_date ASC, prp.created_at ASC`,
    [registryId]
  );

  const [plotRes, siteRes, letterheadRes, inlineRes] = await Promise.all([
    plotPromise, sitePromise, letterheadPromise, inlinePromise,
  ]);
  const plot = plotRes.rows[0] || null;
  const site = siteRes.rows[0] || null;

  let plotPayments = [];
  if (plot) {
    const payRes = await pool.query(
      `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.payment_from, pp.bank_name,
              pp.branch, pp.bank_details, pp.narration, pp.received_by, pp.cheque_status,
              pp.cheque_no, pp.created_at,
              prp.id AS registry_payment_id,
              prp.registry_id AS linked_registry_id,
              (prp.registry_id = $2 AND COALESCE(prp.include_in_noc, FALSE)) AS included
         FROM plot_payments pp
         LEFT JOIN plot_registry_payments prp ON prp.source_plot_payment_id = pp.id
        WHERE pp.plot_id = $1
        ORDER BY pp.date ASC, pp.created_at ASC`,
      [plot.id, registryId]
    );
    plotPayments = payRes.rows;
  }
  const inlinePayments = inlineRes.rows;

  const includedPlot = plotPayments.filter((p) => p.included);
  const includedInline = inlinePayments.filter((p) => p.include_in_noc);
  const includedAmount =
    includedPlot.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0) +
    includedInline.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);

  const suggestedNocNo =
    registry.noc_no ||
    `NOC/${String(site?.code || 'RG').toUpperCase()}/${new Date().getFullYear()}/${String(registry.id).padStart(4, '0')}`;

  // Signed verify QR target — same HMAC scheme/secret as the payment
  // receipts, so it validates on the public Defence Garden verify page.
  const verifyUrl = buildVerifyUrl({
    t: ReceiptType.NOC,
    i: registry.id,
    pn: registry.customer_name || plot?.buyer_name || null,
    pl: registry.plot_no || null,
    a: includedAmount,
    d: registry.noc_date || registry.registry_date || new Date().toISOString().split('T')[0],
    pm: 'NOC',
    sn: site?.name || null,
    sy: site?.city || null,
    ss: site?.state || null,
    rf: registry.noc_no || suggestedNocNo,
  });

  return {
    registry,
    plot,
    site,
    letterhead: letterheadRes.rows[0] || null,
    plotPayments,
    inlinePayments,
    suggested_noc_no: suggestedNocNo,
    verifyUrl,
    totals: {
      included_count: includedPlot.length + includedInline.length,
      included_amount: includedAmount,
    },
  };
};

/** PUT /registries/:id/noc/approve — approve a generated NOC.
 *  This is the ONLY place a plot is promoted to 'REGISTRY' status:
 *  registry created -> plot 'PENDING NOC' -> NOC generated -> approved here -> 'REGISTRY'. */
export const approveRegistryNoc = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const registry = await plotRegistryModel.findById(registryId, pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  if (!registry.noc_generated_at) {
    return res.status(400).json({ message: 'Generate the NOC first — approval comes after generation' });
  }
  if (registry.noc_approved_at) {
    return res.status(409).json({ message: 'NOC is already approved' });
  }

  await pool.query(
    `UPDATE plot_registries SET noc_approved_at = NOW(), noc_approved_by = $2, updated_at = NOW() WHERE id = $1`,
    [registryId, req.user.id]
  );
  let plotStatusUpdated = false;
  if (registry.plot_id) {
    const { rows } = await pool.query(
      `UPDATE plots SET status = 'REGISTRY', updated_at = NOW()
        WHERE id = $1 AND UPPER(COALESCE(status, '')) != 'REGISTRY'
        RETURNING id`,
      [registry.plot_id]
    );
    plotStatusUpdated = rows.length > 0;
  }
  const updated = await plotRegistryModel.findById(registryId, pool);
  res.json({ registry: updated, plot_status_updated: plotStatusUpdated });
});

/** GET /registries/:id/noc — one-shot NOC payload */
export const getRegistryNoc = asyncHandler(async (req, res) => {
  const payload = await buildNocPayload(parseInt(req.params.id));
  if (!payload) return res.status(404).json({ message: 'Registry not found' });
  res.json(payload);
});

/** PUT /registries/:id/noc — batch-save NOC meta + payment selections.
 *  Body: { noc_no, noc_date, noc_place, noc_notes,
 *          included_plot_payment_ids: [plotPaymentId, ...],
 *          inline_payments: [{ id?, payment_date, amount, payment_mode, notes, cheque_no, include_in_noc }] }
 *  Toggling a plot payment ON links it to the registry (reusing the
 *  payment-assign infra); toggling OFF keeps the link but flags it out of
 *  the NOC, so registry accounting is never silently deleted. */
export const saveRegistryNoc = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { noc_no, noc_date, noc_place, noc_notes, included_plot_payment_ids, inline_payments } = req.body;

  const registry = await plotRegistryModel.findById(registryId, pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });

  const includedIds = Array.isArray(included_plot_payment_ids)
    ? included_plot_payment_ids.map((n) => parseInt(n)).filter(Number.isFinite)
    : null;
  const today = new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── NOC meta on the registry ──
    const sets = [];
    const vals = [];
    const push = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
    if (noc_no !== undefined) push('noc_no', noc_no ? String(noc_no).trim().toUpperCase() : null);
    if (noc_date !== undefined) push('noc_date', noc_date || null);
    if (noc_place !== undefined) push('noc_place', noc_place ? String(noc_place).trim().toUpperCase() : null);
    if (noc_notes !== undefined) push('noc_notes', noc_notes ? String(noc_notes).trim() : null);
    sets.push('noc_generated_at = NOW()', 'updated_at = NOW()');
    vals.push(registryId);
    await client.query(`UPDATE plot_registries SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);

    // ── Sync plot-payment selections ──
    if (includedIds) {
      await client.query(
        `UPDATE plot_registry_payments SET include_in_noc = TRUE, updated_at = NOW()
          WHERE registry_id = $1 AND source_plot_payment_id = ANY($2::int[]) AND include_in_noc = FALSE`,
        [registryId, includedIds]
      );
      // Link payments that aren't assigned to any registry yet.
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, source_plot_payment_id, include_in_noc, cheque_no, created_by
         )
         SELECT $1, pp.site_id, COALESCE(pp.date, CURRENT_DATE), pp.amount,
                COALESCE(NULLIF(UPPER(TRIM(pp.payment_from)), ''), UPPER(COALESCE(pp.payment_type, ''))),
                pp.date, pp.amount,
                COALESCE(NULLIF(UPPER(TRIM(pp.narration)), ''), NULLIF(UPPER(TRIM(pp.bank_details)), ''), 'LINKED FROM PLOT PAYMENT'),
                pp.id, TRUE, pp.cheque_no, $3
           FROM plot_payments pp
          WHERE pp.id = ANY($2::int[])
            AND pp.site_id = $4
            AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id = pp.id)`,
        [registryId, includedIds, req.user.id, registry.site_id]
      );
      // Everything else linked to this registry drops off the NOC (link kept).
      await client.query(
        `UPDATE plot_registry_payments SET include_in_noc = FALSE, updated_at = NOW()
          WHERE registry_id = $1 AND source_plot_payment_id IS NOT NULL
            AND NOT (source_plot_payment_id = ANY($2::int[])) AND include_in_noc = TRUE`,
        [registryId, includedIds]
      );
    }

    // ── Inline (NOC-only) payments — upsert ──
    if (Array.isArray(inline_payments)) {
      for (const row of inline_payments) {
        const amount = parseFloat(row.amount) || 0;
        const include = row.include_in_noc === undefined ? true : !!row.include_in_noc;
        const mode = row.payment_mode ? String(row.payment_mode).trim().toUpperCase() : null;
        if (row.id) {
          await client.query(
            `UPDATE plot_registry_payments
                SET payment_date = $2, amount = $3, payment_mode = $4, notes = $5,
                    include_in_noc = $6, updated_at = NOW()
              WHERE id = $1 AND registry_id = $7 AND source_plot_payment_id IS NULL`,
            [
              parseInt(row.id), row.payment_date || today, amount, mode,
              row.notes ? String(row.notes).trim().toUpperCase() : null, include, registryId,
            ]
          );
        } else if (amount > 0) {
          await client.query(
            `INSERT INTO plot_registry_payments (
               registry_id, site_id, payment_date, amount, payment_mode, notes,
               include_in_noc, cheque_no, cheque_status, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              registryId, registry.site_id, row.payment_date || today, amount, mode,
              row.notes ? String(row.notes).trim().toUpperCase() : null, include,
              row.cheque_no ? String(row.cheque_no).trim() : null,
              mode === 'CHEQUE' ? 'PENDING' : null,
              req.user.id,
            ]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const payload = await buildNocPayload(registryId);
  res.json(payload);
});
