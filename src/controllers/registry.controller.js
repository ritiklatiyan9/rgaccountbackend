import asyncHandler from '../utils/asyncHandler.js';
import { plotRegistryModel, plotRegistryPaymentModel } from '../models/PlotRegistry.model.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';
import { withRegistryPaymentVerifyUrl } from '../utils/registryPaymentReceipt.js';
import pool from '../config/db.js';
import applicationSettingModel, { FEATURE_KEYS } from '../models/ApplicationSetting.model.js';
import { canUserViewEntry, resolveEntryVisibility } from '../services/entryVisibility.service.js';

// ══════════════════════════════════════════════════
//  REGISTRY ENDPOINTS
// ══════════════════════════════════════════════════

const isAdminRole = (role) => role === 'admin' || role === 'super_admin';
const isRegistryWorkflowUnlocked = (siteId) => applicationSettingModel.isFeatureEnabled(
  siteId,
  FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED
);
const readRegistryWorkflowUnlocked = async (db, siteId) => {
  const { rows } = await db.query(
    `SELECT setting_value
       FROM application_settings
      WHERE site_id = $1 AND setting_key = $2
      LIMIT 1`,
    [siteId, FEATURE_KEYS.PLOT_REGISTRY_WORKFLOW_UNLOCKED]
  );
  const value = rows[0]?.setting_value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (value && typeof value === 'object' && 'enabled' in value) return Boolean(value.enabled);
  return false;
};
/** Settings → Control panel → "Require KYC before a NOC". Defaults to ON when unset. */
const readNocKycRequired = async (db, siteId) => {
  const { rows } = await db.query(
    `SELECT setting_value
       FROM application_settings
      WHERE site_id = $1 AND setting_key = $2
      LIMIT 1`,
    [siteId, FEATURE_KEYS.NOC_KYC_REQUIRED]
  );
  const value = rows[0]?.setting_value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() !== 'false';
  if (value && typeof value === 'object' && 'enabled' in value) return Boolean(value.enabled);
  return true;
};

/** Bank-clearance snapshot for a plot: what the plot expects in bank
 *  (plots.to_receive_bank) vs what has actually landed — bank/cheque plot
 *  payments + bank-mode installment payments, bounced/returned excluded.
 *  Same maths as plotPayments.service getPlotsWithTotals. */
export async function getPlotBankClearance(plotId) {
  const { rows } = await pool.query(
    `SELECT p.id, p.plot_no, COALESCE(p.to_receive_bank, 0)::numeric AS to_receive_bank,
            COALESCE((
              SELECT SUM(pp.amount) FROM plot_payments pp
               WHERE pp.plot_id = p.id
                 AND pp.payment_type IN ('BANK', 'CHEQUE')
                 AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
            ), 0)::numeric
          + COALESCE((
              SELECT SUM(pip.amount) FROM plot_installment_payments pip
               WHERE pip.plot_id = p.id
                 AND UPPER(COALESCE(pip.payment_mode, '')) IN ('BANK', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'TRANSFER')
                 AND financial_transaction_posts('credit', pip.status, pip.payment_mode, pip.cheque_status)
            ), 0)::numeric AS received_bank
       FROM plots p WHERE p.id = $1`,
    [plotId]
  );
  const row = rows[0];
  if (!row) return null;
  const toReceive = parseFloat(row.to_receive_bank) || 0;
  const received = parseFloat(row.received_bank) || 0;
  return {
    plot_id: row.id,
    plot_no: row.plot_no,
    to_receive_bank: toReceive,
    received_bank: received,
    pending_bank: Math.max(0, toReceive - received),
    clear: toReceive - received <= 0.005,
  };
}

/** GET /registries/plot-clearance?plot_id= — payments-clear check used by the
 *  create-registry form to decide direct-create vs admin-approval path. */
export const getRegistryPlotClearance = asyncHandler(async (req, res) => {
  const plotId = parseInt(req.query.plot_id);
  if (!Number.isFinite(plotId)) return res.status(400).json({ message: 'plot_id is required' });
  const clearance = await getPlotBankClearance(plotId);
  if (!clearance) return res.status(404).json({ message: 'Plot not found' });
  res.json({ clearance });
});

/** POST /registries — Create a new registry.
 *  Business rules:
 *  1. Money-mapped: the payload must carry `payments` totalling > 0 (see
 *     createRegistryRecord).
 *  2. Payments-clear: the linked plot's bank money must be fully received
 *     (up to plots.to_receive_bank). Admins may create anyway; sub-admins
 *     are routed to the admin-approval flow (POST /edit-requests, module
 *     'plot_registry_create') and blocked here. */
export const createRegistry = asyncHandler(async (req, res) => {
  const requestedSiteId = parseInt(req.body.site_id);
  const requestedPlotId = parseInt(req.body.plot_id);
  if (Number.isFinite(requestedPlotId)) {
    const { rows } = await pool.query('SELECT site_id FROM plots WHERE id = $1 LIMIT 1', [requestedPlotId]);
    if (!rows[0]) return res.status(404).json({ message: 'Plot not found' });
    if (Number.isFinite(requestedSiteId) && parseInt(rows[0].site_id) !== requestedSiteId) {
      return res.status(400).json({ message: 'Selected plot does not belong to the registry site' });
    }
  }

  if (!isAdminRole(req.user.role)) {
    // Resolve the gate plot by FK or (site, plot_no) fallback — omitting
    // plot_id must not skip the clearance check.
    let gatePlotId = parseInt(req.body.plot_id);
    if (!Number.isFinite(gatePlotId) && req.body.site_id && req.body.plot_no) {
      const { rows } = await pool.query(
        `SELECT id FROM plots WHERE site_id = $1 AND UPPER(plot_no) = UPPER($2) ORDER BY id DESC LIMIT 1`,
        [parseInt(req.body.site_id), String(req.body.plot_no).trim()]
      );
      gatePlotId = rows[0]?.id;
    }
    if (gatePlotId) {
      const clearance = await getPlotBankClearance(gatePlotId);
      if (clearance && !clearance.clear) {
        return res.status(403).json({
          code: 'PAYMENTS_NOT_CLEAR',
          clearance,
          message: `Payments are not clear — ₹${clearance.pending_bank.toLocaleString('en-IN')} is still to be received in bank. Submit the registry for admin approval.`,
        });
      }
    }
  }
  const out = await createRegistryRecord(req.body, req.user.id);
  res.status(out.status).json(out.body);
});

/** Core create logic, callable outside the HTTP handler (admin-approval flow
 *  applies an approved 'plot_registry_create' edit request through this).
 *  A registry can only be created with money mapped to it — `payments` is an
 *  array of either
 *    { source_plot_payment_id }                              (link a bank/cheque plot payment)
 *    { payment_date, amount, payment_mode, tally_date, tally_amount, notes, cheque_no }  (manual)
 *  totalling > 0. Registry + payments are created in ONE transaction, so a
 *  registry can never exist without its money. An optional transaction client
 *  lets the edit-request approval commit the registry and approval state as one
 *  unit. Returns { status, body }. */
export async function createRegistryRecord(body, userId, transactionClient = null) {
  const {
    site_id, plot_no, customer_name, size_meter, size_sqyard, registry_date, farmer_name,
    registry_payment, notes, plot_id, circle_rate, firm_name, seller_name, created_entry_date, bank_amount,
    payments,
  } = body;

  if (!site_id) return { status: 400, body: { message: 'Site is required' } };
  if (!plot_id) return { status: 400, body: { message: 'A valid plot is required' } };
  if (!String(plot_no || '').trim()) {
    return { status: 400, body: { message: 'Plot number is required' } };
  }

  const trimmed = String(plot_no).trim().toUpperCase();
  const siteIdInt = parseInt(site_id);
  const plotIdInt = parseInt(plot_id);
  const db = transactionClient || pool;
  if (!Number.isInteger(siteIdInt) || siteIdInt <= 0) {
    return { status: 400, body: { message: 'A valid site is required' } };
  }
  if (!Number.isInteger(plotIdInt) || plotIdInt <= 0) {
    return { status: 400, body: { message: 'A valid plot is required' } };
  }
  const { rows: plotRows } = await db.query(
    'SELECT site_id, plot_no, plot_tag FROM plots WHERE id = $1 LIMIT 1',
    [plotIdInt]
  );
  if (!plotRows[0]) return { status: 404, body: { message: 'Plot not found' } };
  if (String(plotRows[0].plot_tag || '').trim().toUpperCase() === 'OLD') {
    return { status: 400, body: { message: 'Resold (OLD) plots stay out of the registry flow — select the current plot record instead' } };
  }
  if (parseInt(plotRows[0].site_id) !== siteIdInt) {
    return { status: 400, body: { message: 'Selected plot does not belong to the registry site' } };
  }
  if (String(plotRows[0].plot_no || '').trim().toUpperCase() !== trimmed) {
    return { status: 400, body: { message: 'Registry plot number does not match the selected plot' } };
  }

  // ── Money-mapped gate ──
  const paymentRows = Array.isArray(payments) ? payments : [];
  const linkedIds = paymentRows
    .filter((p) => p && p.source_plot_payment_id)
    .map((p) => parseInt(p.source_plot_payment_id))
    .filter(Number.isFinite);
  const manualRows = paymentRows.filter((p) => p && !p.source_plot_payment_id && (parseFloat(p.amount) || 0) > 0);

  let linkedTotal = 0;
  let linkable = [];
  if (linkedIds.length) {
    // A source payment belongs to one exact plot. Site equality alone is not
    // sufficient: otherwise receipts from another plot could satisfy this
    // registry's NOC payment gate.
    const { rows } = await db.query(
      `SELECT pp.id, pp.site_id, pp.date, pp.amount, pp.payment_from, pp.payment_type,
              pp.bank_details, pp.narration, pp.cheque_no, pp.cheque_status,
              pp.status, pp.approved_by, pp.approved_at
         FROM plot_payments pp
        WHERE pp.id = ANY($1::int[])
          AND pp.site_id = $2
          AND pp.plot_id = $3
          AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id = pp.id)`,
      [linkedIds, siteIdInt, plotIdInt]
    );
    linkable = rows;
    linkedTotal = rows.reduce((n, r) => n + (parseFloat(r.amount) || 0), 0);
  }
  const manualTotal = manualRows.reduce((n, r) => n + (parseFloat(r.amount) || 0), 0);
  if (linkable.length + manualRows.length === 0 || linkedTotal + manualTotal <= 0) {
    return { status: 400, body: {
      message: 'Map at least one payment before creating a registry — a registry cannot be created without money mapped to it',
    } };
  }

  const today = new Date().toISOString().split('T')[0];
  const ownsTransaction = !transactionClient;
  const client = transactionClient || await pool.connect();
  let row;
  try {
    if (ownsTransaction) await client.query('BEGIN');

    // Single CTE: dup-check + INSERT + plot-status auto-bump in ONE round-trip.
    const result = await client.query(
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
        created_entry_date || today,                                            // $12
        bank_amount !== undefined && bank_amount !== '' ? (parseFloat(bank_amount) || 0) : null, // $13
        parseFloat(registry_payment) || 0,                                      // $14
        notes ? notes.trim() : null,                                            // $15
        body.assigned_admin_id ? parseInt(body.assigned_admin_id) : null,       // $16
        userId,                                                                 // $17
      ]
    );

    row = result.rows[0];
    if (row.is_dup) {
      if (ownsTransaction) await client.query('ROLLBACK');
      return { status: 409, body: { message: `Registry for plot "${trimmed}" already exists` } };
    }
    const registryId = row.registry.id;

    // ── Linked bank/cheque plot payments (same shape saveRegistryNoc uses) ──
    for (const pp of linkable) {
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, source_plot_payment_id, cheque_no, cheque_status, status,
           approved_by, approved_at, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
        [
          registryId, siteIdInt, pp.date || today, parseFloat(pp.amount) || 0,
          (pp.payment_from || pp.payment_type || '').trim().toUpperCase() || null,
          pp.date || null, parseFloat(pp.amount) || 0,
          (pp.narration || pp.bank_details || 'LINKED FROM PLOT PAYMENT').trim().toUpperCase(),
          pp.id, pp.cheque_no || null, pp.cheque_status || null,
          pp.status || 'approved', pp.approved_by || null, pp.approved_at || null, userId,
        ]
      );
    }

    // ── Manual payments ──
    for (const m of manualRows) {
      const mode = m.payment_mode ? String(m.payment_mode).trim().toUpperCase() : null;
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, cheque_no, cheque_status, created_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          registryId, siteIdInt, m.payment_date || today, parseFloat(m.amount) || 0, mode,
          m.tally_date || null,
          m.tally_amount !== undefined && m.tally_amount !== '' ? parseFloat(m.tally_amount) : null,
          m.notes ? String(m.notes).trim().toUpperCase() : null,
          m.cheque_no ? String(m.cheque_no).trim() : null,
          mode === 'CHEQUE' ? 'PENDING' : null,
          userId,
        ]
      );
    }

    if (ownsTransaction) await client.query('COMMIT');
  } catch (err) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }

  return { status: 201, body: {
    registry: row.registry,
    plot_status_updated: row.plot_status_updated,
    payments_created: linkable.length + manualRows.length,
    payments_skipped: linkedIds.length - linkable.length,
  } };
}

/** GET /registries?site_id=X — List all registries for a site */
export const listRegistries = asyncHandler(async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const entryVisibility = await resolveEntryVisibility(req.user, 'plot_registry', req.query.created_by);
  const registries = await plotRegistryModel.findBySiteId(parseInt(site_id), pool, entryVisibility.creatorId);
  res.json({ registries, entryVisibility });
});

/** GET /registries/:id — Get single registry with totals */
export const getRegistry = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const entryVisibility = await resolveEntryVisibility(req.user, 'plot_registry', req.query.created_by);
  const registry = await plotRegistryModel.findByIdWithTotals(parseInt(id), pool, entryVisibility.creatorId);
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
  // Co-applicant lives on the plot; the registry modal edits it in place (may be the only change).
  const coApplicantPatch = cleanCoApplicant(req.body);

  const existing = await plotRegistryModel.findById(registryId, pool);
  if (!existing) return res.status(404).json({ message: 'Registry not found' });

  const updateData = {};
  if (plot_no !== undefined) {
    const trimmed = String(plot_no || '').trim().toUpperCase();
    if (!trimmed) return res.status(400).json({ message: 'Plot number is required' });
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
  if (plot_id !== undefined) {
    const parsedPlotId = parseInt(plot_id);
    if (!Number.isInteger(parsedPlotId) || parsedPlotId <= 0) {
      return res.status(400).json({ message: 'A valid plot is required' });
    }
    updateData.plot_id = parsedPlotId;
  }
  if (circle_rate !== undefined) updateData.circle_rate = circle_rate === '' ? null : (parseFloat(circle_rate) || 0);
  if (firm_name !== undefined) updateData.firm_name = firm_name ? firm_name.trim().toUpperCase() : null;
  if (seller_name !== undefined) updateData.seller_name = seller_name ? seller_name.trim().toUpperCase() : null;
  if (created_entry_date !== undefined) updateData.created_entry_date = created_entry_date || null;
  if (bank_amount !== undefined) updateData.bank_amount = bank_amount === '' ? null : (parseFloat(bank_amount) || 0);
  // Registry Value RO (manual, rounded, cash + bank). Empty string clears; negatives rejected.
  for (const f of ['ro_cash_amount', 'ro_bank_amount']) {
    if (req.body[f] === undefined) continue;
    if (req.body[f] === '' || req.body[f] === null) { updateData[f] = null; continue; }
    const v = Number(req.body[f]);
    if (!Number.isFinite(v) || v < 0) return res.status(400).json({ message: 'Registry Value RO must be zero or more' });
    updateData[f] = Math.round(v * 100) / 100;
  }
  if (updateData.ro_cash_amount !== undefined || updateData.ro_bank_amount !== undefined) {
    updateData.ro_updated_at = new Date();
    updateData.ro_updated_by = req.user.id;
  }
  if (registry_payment !== undefined) updateData.registry_payment = parseFloat(registry_payment) || 0;
  if (notes !== undefined) updateData.notes = notes ? notes.trim() : null;
  if (req.body.assigned_admin_id !== undefined) updateData.assigned_admin_id = req.body.assigned_admin_id ? parseInt(req.body.assigned_admin_id) : null;

  if (Object.keys(updateData).length === 0) {
    if (!Object.keys(coApplicantPatch).length) return res.status(400).json({ message: 'Nothing to update' });
    updateData.updated_at = new Date();
  }

  const prospectivePlotId = updateData.plot_id !== undefined ? updateData.plot_id : existing.plot_id;
  const prospectivePlotNo = updateData.plot_no !== undefined ? updateData.plot_no : existing.plot_no;
  const normalizedProspectivePlotId = Number.isInteger(parseInt(prospectivePlotId)) ? parseInt(prospectivePlotId) : null;
  const normalizedExistingPlotId = Number.isInteger(parseInt(existing.plot_id)) ? parseInt(existing.plot_id) : null;
  const plotIdentityChanging = normalizedProspectivePlotId !== normalizedExistingPlotId
    || String(prospectivePlotNo || '').trim().toUpperCase()
       !== String(existing.plot_no || '').trim().toUpperCase();
  if (plotIdentityChanging && (existing.noc_generated_at || existing.noc_approved_at)) {
    return res.status(409).json({
      message: 'The registry plot cannot be changed after its NOC has been generated.',
    });
  }
  if (prospectivePlotId) {
    const { rows } = await pool.query('SELECT site_id, plot_no FROM plots WHERE id = $1 LIMIT 1', [prospectivePlotId]);
    if (!rows[0]) return res.status(404).json({ message: 'Plot not found' });
    if (parseInt(rows[0].site_id) !== parseInt(existing.site_id)) {
      return res.status(400).json({ message: 'Selected plot does not belong to the registry site' });
    }
    if (String(rows[0].plot_no || '').trim().toUpperCase() !== String(prospectivePlotNo || '').trim().toUpperCase()) {
      return res.status(400).json({ message: 'Registry plot number does not match the selected plot' });
    }
  }

  if (updateData.plot_id !== undefined && parseInt(existing.plot_id) !== prospectivePlotId) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count
         FROM plot_registry_payments
        WHERE registry_id = $1 AND source_plot_payment_id IS NOT NULL`,
      [registryId]
    );
    if ((rows[0]?.count || 0) > 0) {
      return res.status(409).json({
        message: 'Remove linked plot payments before changing the registry plot',
      });
    }
  }

  // Keep the registry edit and its plot status transition atomic. Running
  // these against separate pool connections could leave a plot in PENDING NOC
  // even when the registry update failed a constraint or concurrency check.
  const resolvedPlotId = updateData.plot_id !== undefined ? updateData.plot_id : existing.plot_id;
  const client = await pool.connect();
  let updated;
  let plotBumpRes = { rows: [] };
  try {
    await client.query('BEGIN');
    updated = await plotRegistryModel.update(registryId, updateData, client);
    // Plot becomes 'REGISTRY' only via NOC approval (approveRegistryNoc); here
    // we only move a fresh BOOKED plot into the pending stage.
    if (resolvedPlotId) {
      plotBumpRes = await client.query(
        `UPDATE plots SET status = 'PENDING NOC', updated_at = NOW()
          WHERE id = $1 AND UPPER(COALESCE(status, '')) = 'BOOKED'
          RETURNING id`,
        [resolvedPlotId]
      );
    }
    if (plotIdentityChanging && existing.plot_id) {
      await client.query(
        `UPDATE plots p
            SET status = 'BOOKED', updated_at = NOW()
          WHERE p.id = $1
            AND UPPER(COALESCE(p.status, '')) = 'PENDING NOC'
            AND NOT EXISTS (
              SELECT 1 FROM plot_registries pr WHERE pr.plot_id = p.id
            )`,
        [existing.plot_id]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (Object.keys(coApplicantPatch).length && (updateData.plot_id || existing.plot_id)) {
    await applyCoApplicantToPlot(pool, updateData.plot_id || existing.plot_id, coApplicantPatch);
  }
  res.json({ registry: updated, plot_status_updated: (plotBumpRes.rows?.length || 0) > 0 });
});

/** DELETE /registries/:id */
export const deleteRegistry = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT id, plot_id, site_id, plot_no, noc_generated_at, noc_approved_at
         FROM plot_registries
        WHERE id = $1
        FOR UPDATE`,
      [registryId]
    );
    const registry = rows[0];
    if (!registry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Registry not found' });
    }
    if (registry.noc_generated_at || registry.noc_approved_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        message: 'A registry with an issued NOC cannot be deleted. Keep the revision history and use the relevant cancellation workflow.',
      });
    }

    await client.query('DELETE FROM plot_registries WHERE id = $1', [registryId]);
    // A deleted draft must not leave its plot stranded in PENDING NOC. Legacy
    // registries without plot_id use the same site + plot-number resolution as
    // the rest of this module.
    await client.query(
      `UPDATE plots p
          SET status = 'BOOKED', updated_at = NOW()
        WHERE (
          ($1::integer IS NOT NULL AND p.id = $1)
          OR ($1::integer IS NULL AND p.site_id = $2 AND UPPER(p.plot_no) = UPPER($3))
        )
          AND UPPER(COALESCE(p.status, '')) = 'PENDING NOC'
          AND NOT EXISTS (
            SELECT 1
              FROM plot_registries remaining
             WHERE remaining.plot_id = p.id
                OR (remaining.plot_id IS NULL
                    AND remaining.site_id = p.site_id
                    AND UPPER(remaining.plot_no) = UPPER(p.plot_no))
          )`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    if (!Number.isInteger(sourceId) || sourceId <= 0) {
      return res.status(400).json({ message: 'A valid source plot payment is required' });
    }

    // Run all 3 lookups (registry, dup mapping, source payment) IN PARALLEL.
    // Was 4 serial RTTs (registry SELECT + col check + dup SELECT + source SELECT).
    const [registryRes, dupRes, sourceRes] = await Promise.all([
      pool.query(
        `SELECT id, site_id, plot_id, plot_no FROM plot_registries WHERE id = $1`,
        [registryIdInt]
      ),
      pool.query(`SELECT id FROM plot_registry_payments WHERE source_plot_payment_id = $1 LIMIT 1`, [sourceId]),
      pool.query(
        `SELECT pp.id, pp.site_id, pp.plot_id, p.plot_no, pp.date, pp.amount,
                pp.payment_from, pp.payment_type, pp.bank_details, pp.narration,
                pp.cheque_no, pp.cheque_status, pp.status, pp.approved_by, pp.approved_at
           FROM plot_payments pp
           LEFT JOIN plots p ON p.id = pp.plot_id
          WHERE pp.id = $1
          LIMIT 1`,
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
    const sourceMatchesPlot = registry.plot_id
      ? parseInt(sourcePayment.plot_id) === parseInt(registry.plot_id)
      : String(sourcePayment.plot_no || '').trim().toUpperCase()
        === String(registry.plot_no || '').trim().toUpperCase();
    if (!sourceMatchesPlot) {
      return res.status(400).json({ message: 'Selected payment belongs to a different plot' });
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
      status: sourcePayment.status || 'approved',
      approved_by: sourcePayment.approved_by || null,
      approved_at: sourcePayment.approved_at || null,
      cheque_no: sourcePayment.cheque_no || null,
      cheque_status: sourcePayment.cheque_status || null,
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
    status: 'pending',
  };
  if (hasSourcePlotPaymentCol) data.source_plot_payment_id = null;

  const payment = await plotRegistryPaymentModel.create(data, pool);
  res.status(201).json({ payment });
});

/** GET /registries/payments/list?registry_id=X */
export const listRegistryPayments = asyncHandler(async (req, res) => {
  const { registry_id } = req.query;
  if (!registry_id) return res.status(400).json({ message: 'registry_id is required' });
  const entryVisibility = await resolveEntryVisibility(req.user, 'plot_registry', req.query.created_by);
  const registryId = parseInt(registry_id);

  const [payments, registry, contextResult] = await Promise.all([
    plotRegistryPaymentModel.findByRegistryId(registryId, pool, entryVisibility.creatorId),
    plotRegistryModel.findByIdWithTotals(registryId, pool, entryVisibility.creatorId),
    pool.query(
      `SELECT pr.customer_name, pr.plot_no, p.buyer_name,
              s.name AS site_name, s.city AS site_city, s.state AS site_state
         FROM plot_registries pr
         LEFT JOIN plots p ON p.id = pr.plot_id
         LEFT JOIN sites s ON s.id = pr.site_id
        WHERE pr.id = $1`,
      [registryId]
    ),
  ]);

  const receiptContext = contextResult.rows[0] || registry || {};
  res.json({
    payments: payments.map((payment) => withRegistryPaymentVerifyUrl(payment, receiptContext)),
    registry,
    entryVisibility,
  });
});

/** GET /registries/payments/:id */
export const getRegistryPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payment = await plotRegistryPaymentModel.findById(parseInt(id), pool);
  if (!payment) return res.status(404).json({ message: 'Payment not found' });
  if (!(await canUserViewEntry(req.user, 'plot_registry', payment.created_by))) {
    return res.status(404).json({ message: 'Payment not found' });
  }
  const { rows } = await pool.query(
    `SELECT pr.customer_name, pr.plot_no, p.buyer_name,
            s.name AS site_name, s.city AS site_city, s.state AS site_state
       FROM plot_registries pr
       LEFT JOIN plots p ON p.id = pr.plot_id
       LEFT JOIN sites s ON s.id = pr.site_id
      WHERE pr.id = $1`,
    [payment.registry_id]
  );
  res.json({ payment: withRegistryPaymentVerifyUrl(payment, rows[0] || {}) });
});

/** PUT /registries/payments/:id */
export const updateRegistryPayment = asyncHandler(async (req, res) => {
  const paymentId = parseInt(req.params.id);
  const existing = await plotRegistryPaymentModel.findById(paymentId, pool);
  if (!existing || !(await canUserViewEntry(req.user, 'plot_registry', existing.created_by))) {
    return res.status(404).json({ message: 'Payment not found' });
  }
  if (existing.source_plot_payment_id) {
    return res.status(409).json({ message: 'Linked registry payments must be edited from the source Plot Payment entry' });
  }
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

  updateData.status = 'pending';
  updateData.approved_by = null;
  updateData.approved_at = null;
  const finalMode = String(payment_mode !== undefined ? payment_mode : existing.payment_mode || '').trim().toUpperCase();
  updateData.cheque_status = finalMode === 'CHEQUE' ? 'PENDING' : null;

  // Atomic UPDATE — saves a SELECT round-trip.
  const updated = await plotRegistryPaymentModel.update(paymentId, updateData, pool);
  if (!updated) return res.status(404).json({ message: 'Payment not found' });
  res.json({ payment: updated });
});

/** DELETE /registries/payments/:id */
export const deleteRegistryPayment = asyncHandler(async (req, res) => {
  const entryVisibility = await resolveEntryVisibility(req.user, 'plot_registry', null);
  // Atomic DELETE — saves a SELECT round-trip.
  const result = await pool.query(
    `DELETE FROM plot_registry_payments
      WHERE id = $1 AND ($2::int IS NULL OR created_by = $2::int)
      RETURNING id`,
    [parseInt(req.params.id), entryVisibility.creatorId]
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
/**
 * Who signs the NOC and whether their KYC is done. The purchaser is resolved from the
 * plot's booking (client member) or, for legacy plots without a booking, by an exact
 * name match on the site's clients. KYC = a VERIFIED kyc_case (or the booking's own
 * VERIFIED flag). The co-applicant comes from the client's profile; when the NOC is
 * set to include them, their Aadhaar or PAN must be on record.
 */
const CO_APPLICANT_FIELDS = ['co_applicant_name', 'co_applicant_relation', 'co_applicant_phone', 'co_applicant_aadhar', 'co_applicant_pan'];
const cleanCoApplicant = (body) => {
  const out = {};
  for (const f of CO_APPLICANT_FIELDS) {
    if (body[f] === undefined) continue;
    const v = body[f] === null ? '' : String(body[f]).trim();
    out[f] = v ? (f === 'co_applicant_name' || f === 'co_applicant_pan' ? v.toUpperCase() : v).slice(0, f === 'co_applicant_name' ? 255 : f === 'co_applicant_relation' ? 100 : 20) : null;
  }
  return out;
};
/** The plot row is the one home of the co-applicant; both edit modals write here. */
const applyCoApplicantToPlot = async (db, plotId, body) => {
  const data = cleanCoApplicant(body);
  const keys = Object.keys(data);
  if (!plotId || !keys.length) return;
  await db.query(`UPDATE plots SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = NOW() WHERE id = $1`, [plotId, ...keys.map((k) => data[k])]);
};

// Client types that may sign a NOC on the company's behalf.
const COMPANY_MEMBER_TYPES = ['PARTNER', 'EMPLOYEE', 'MEMBER'];

const resolveNocPeople = async (db, registry, plot) => {
  const siteId = registry.site_id;
  const plotId = plot?.id || registry.plot_id || null;
  const buyerName = String(registry.customer_name || plot?.buyer_name || '').trim().toUpperCase();
  const memberCols = `m.id, m.full_name, m.phone, m.co_applicant_name, m.co_applicant_relation, m.co_applicant_phone,
              NULLIF(BTRIM(COALESCE(m.co_applicant_aadhar, '')), '') AS co_aadhar,
              NULLIF(BTRIM(COALESCE(m.co_applicant_pan, '')), '') AS co_pan`;
  let row = null;
  if (plotId) {
    const r = await db.query(
      `SELECT ${memberCols}, b.id AS booking_id, b.booking_no, b.kyc_status AS booking_kyc_status, 'booking'::text AS source
         FROM bookings b JOIN members m ON m.id = b.client_member_id
        WHERE b.plot_id = $1 AND COALESCE(b.status, '') NOT ILIKE 'cancel%'
        ORDER BY b.created_at DESC NULLS LAST, b.id DESC LIMIT 1`,
      [plotId]
    );
    row = r.rows[0] || null;
  }
  if (!row && buyerName) {
    const r = await db.query(
      `SELECT ${memberCols}, NULL::int AS booking_id, NULL::text AS booking_no, NULL::text AS booking_kyc_status, 'name_match'::text AS source
         FROM members m
        WHERE m.site_id = $1 AND UPPER(BTRIM(COALESCE(m.full_name, ''))) = $2
        ORDER BY m.id DESC LIMIT 1`,
      [siteId, buyerName]
    );
    row = r.rows[0] || null;
  }
  let kyc = { status: 'NONE', verified: false, case_id: null, verified_at: null };
  if (row) {
    const k = await db.query(
      `SELECT id, status, verified_at FROM kyc_cases WHERE client_member_id = $1
        ORDER BY CASE WHEN status = 'VERIFIED' THEN 0 ELSE 1 END, updated_at DESC NULLS LAST, id DESC LIMIT 1`,
      [row.id]
    );
    const c = k.rows[0];
    const verified = c?.status === 'VERIFIED' || String(row.booking_kyc_status || '').toUpperCase() === 'VERIFIED';
    kyc = { status: verified ? 'VERIFIED' : (c?.status || row.booking_kyc_status || 'NOT_STARTED'), verified, case_id: c?.id || null, verified_at: c?.verified_at || null };
  }
  // Co-applicant: the plot record first (unified across booking → plot → NOC → registry), the client profile as fallback.
  let plotCo = null;
  if (plotId) {
    const pr = await db.query('SELECT co_applicant_name, co_applicant_relation, co_applicant_phone, co_applicant_aadhar, co_applicant_pan FROM plots WHERE id = $1', [plotId]);
    plotCo = pr.rows[0] || null;
  }
  const coApplicant = plotCo?.co_applicant_name
    ? { name: plotCo.co_applicant_name, relation: plotCo.co_applicant_relation || null, phone: plotCo.co_applicant_phone || null, id_ready: Boolean((plotCo.co_applicant_aadhar || '').trim() || (plotCo.co_applicant_pan || '').trim()), source: 'plot' }
    : row?.co_applicant_name
      ? { name: row.co_applicant_name, relation: row.co_applicant_relation || null, phone: row.co_applicant_phone || null, id_ready: Boolean(row.co_aadhar || row.co_pan), source: 'client' }
      : null;
  // Tri-state toggle: NULL = include automatically whenever a co-applicant exists.
  const includeCo = registry.noc_include_co_applicant === null || registry.noc_include_co_applicant === undefined
    ? Boolean(coApplicant)
    : Boolean(registry.noc_include_co_applicant);
  const blockers = [];
  if (!row) blockers.push(`No client record found for "${buyerName || 'the purchaser'}" — link the buyer to a client whose KYC is complete`);
  else if (!kyc.verified) blockers.push(`${row.full_name}: KYC not verified (${kyc.status})`);
  if (includeCo && !coApplicant) blockers.push('Co-applicant is switched on, but there is no co-applicant on the plot or client record');
  if (includeCo && coApplicant && !coApplicant.id_ready) blockers.push(`${coApplicant.name}: add the co-applicant's Aadhaar or PAN in the client profile`);
  return {
    member: row ? {
      id: row.id, full_name: row.full_name, phone: row.phone, source: row.source,
      booking_id: row.booking_id, booking_no: row.booking_no,
      kyc_status: kyc.status, kyc_verified: kyc.verified, kyc_case_id: kyc.case_id, kyc_verified_at: kyc.verified_at,
    } : null,
    co_applicant: coApplicant,
    include_co_applicant: includeCo,
    kyc_ready: blockers.length === 0,
    blockers,
  };
};

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
  const historyPromise = pool.query(
    `SELECT h.id, h.revision_no, h.ref_no, h.ack_no, h.event_type,
            h.change_note, h.show_payments, h.included_payment_count,
            h.included_amount, h.snapshot, h.generated_by, h.generated_at,
            COALESCE(u.name, u.email, 'System') AS generated_by_name
       FROM plot_registry_noc_history h
       LEFT JOIN users u ON u.id = h.generated_by
      WHERE h.registry_id = $1
      ORDER BY h.revision_no DESC`,
    [registryId]
  ).catch(() => ({ rows: [] }));
  const workflowOverridePromise = isRegistryWorkflowUnlocked(registry.site_id);

  const [plotRes, siteRes, letterheadRes, inlineRes, historyRes, workflowUnlocked] = await Promise.all([
    plotPromise, sitePromise, letterheadPromise, inlinePromise, historyPromise, workflowOverridePromise,
  ]);
  const plot = plotRes.rows[0] || null;
  const site = siteRes.rows[0] || null;

  let plotPayments = [];
  if (plot) {
    const payRes = await pool.query(
      `SELECT pp.id, pp.date, pp.amount, pp.payment_type, pp.payment_from, pp.bank_name,
              pp.branch, pp.bank_details, pp.narration, pp.received_by, pp.cheque_status,
              pp.cheque_no, pp.status, pp.created_at,
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
  const people = await resolveNocPeople(pool, registry, plot);
  // People picked from Clients for this certificate: the seller/farmer, and the
  // company member who signs it. One query — both are optional.
  const nocMemberRes = await pool.query(
    `SELECT id, member_type, COALESCE(member_types, ARRAY[member_type]) AS member_types,
            full_name, father_name, phone, aadhar_no, pan_no,
            designation, department, employee_id, village, district, city, state, address
       FROM members WHERE id = ANY($1::int[])`,
    [[registry.noc_farmer_member_id, registry.noc_authorized_member_id].filter(Boolean)]
  );
  const nocMemberById = (memberId) => nocMemberRes.rows.find((row) => row.id === memberId) || null;
  const farmer = registry.noc_farmer_member_id ? nocMemberById(registry.noc_farmer_member_id) : null;
  const authorizedSignatory = registry.noc_authorized_member_id ? nocMemberById(registry.noc_authorized_member_id) : null;
  people.kyc_required = await readNocKycRequired(pool, registry.site_id);
  // Gate is bypassed when KYC is not required for this site, or the workflow override is on.
  people.kyc_gate_active = people.kyc_required && !workflowUnlocked;

  const includedPlot = plotPayments.filter((p) => p.included
    && String(p.status || 'approved').toLowerCase() === 'approved'
    && !['BOUNCED', 'RETURNED', 'PENDING'].includes(String(p.cheque_status || '').toUpperCase()));
  const includedInline = inlinePayments.filter((p) => p.include_in_noc
    && String(p.status || 'approved').toLowerCase() === 'approved'
    && !['BOUNCED', 'RETURNED', 'PENDING'].includes(String(p.cheque_status || '').toUpperCase()));
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
    rf: registry.noc_ack_no || registry.noc_no || suggestedNocNo,
  });

  return {
    registry,
    plot,
    site,
    letterhead: letterheadRes.rows[0] || null,
    plotPayments,
    inlinePayments,
    nocHistory: historyRes.rows,
    people,
    farmer,
    authorized_signatory: authorizedSignatory,
    workflow_unlocked: workflowUnlocked,
    suggested_noc_no: suggestedNocNo,
    verifyUrl,
    totals: {
      included_count: includedPlot.length + includedInline.length,
      included_amount: includedAmount,
    },
  };
};

/** PUT /registries/:id/noc/approve — optional administrative sign-off.
 *  NOC generation is the primary transition to REGISTRY. This endpoint keeps
 *  the legacy approval stamp and defensively promotes older generated NOCs. */
export const approveRegistryNoc = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const client = await pool.connect();
  let updated;
  let plotStatusUpdated = false;
  let workflowUnlocked = false;

  try {
    await client.query('BEGIN');

    // Lock the registry row so two approval requests cannot both pass the
    // preconditions. Registry approval and plot promotion then commit or roll
    // back together.
    const { rows } = await client.query(
      `SELECT pr.*,
              COALESCE((
                SELECT SUM(prp.amount)
                  FROM plot_registry_payments prp
                  LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
                 WHERE prp.registry_id = pr.id
                   AND (
                     (prp.source_plot_payment_id IS NULL
                       AND financial_transaction_posts('credit', prp.status, prp.payment_mode, prp.cheque_status))
                     OR
                     (prp.source_plot_payment_id IS NOT NULL
                       AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status))
                   )
                   AND (
                     prp.source_plot_payment_id IS NULL
                     OR (pr.plot_id IS NOT NULL AND pp.plot_id = pr.plot_id)
                     OR (
                       pr.plot_id IS NULL
                       AND EXISTS (
                         SELECT 1 FROM plots target
                          WHERE target.id = pp.plot_id
                            AND target.site_id = pr.site_id
                            AND UPPER(target.plot_no) = UPPER(pr.plot_no)
                       )
                     )
                   )
              ), 0)::numeric AS total_paid
         FROM plot_registries pr
        WHERE pr.id = $1
        FOR UPDATE OF pr`,
      [registryId]
    );
    const registry = rows[0];
    if (!registry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Registry not found' });
    }
    if (!registry.noc_generated_at) {
      await client.query('ROLLBACK');
      return res.status(400).json({ message: 'Generate the NOC first — approval comes after generation' });
    }
    if (registry.noc_approved_at) {
      await client.query('ROLLBACK');
      return res.status(409).json({ message: 'NOC is already approved' });
    }

    workflowUnlocked = await readRegistryWorkflowUnlocked(client, registry.site_id);
    // Payment-clear gate (defense in depth — generation is gated the same way).
    const approveDue = (parseFloat(registry.registry_payment) || 0) - (parseFloat(registry.total_paid) || 0);
    if (!workflowUnlocked && approveDue > 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `NOC can only be approved after full payment — ₹${approveDue.toLocaleString('en-IN')} is still due`,
      });
    }

    const approvalResult = await client.query(
      `UPDATE plot_registries
          SET noc_approved_at = NOW(), noc_approved_by = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [registryId, req.user.id]
    );
    updated = approvalResult.rows[0];

    // Defensive backfill for NOCs generated before generation itself became
    // the REGISTRY transition. Older registries may not carry plot_id.
    const plotResult = await client.query(
      `WITH target_plot AS (
         SELECT id
           FROM plots
          WHERE ($1::integer IS NOT NULL AND id = $1)
             OR ($1::integer IS NULL AND site_id = $2 AND UPPER(plot_no) = UPPER($3))
          ORDER BY id DESC
          LIMIT 1
       )
       UPDATE plots p
          SET status = 'REGISTRY', updated_at = NOW()
         FROM target_plot target
        WHERE p.id = target.id
          AND UPPER(COALESCE(p.status, '')) != 'REGISTRY'
        RETURNING p.id`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    plotStatusUpdated = plotResult.rows.length > 0;

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  res.json({ registry: updated, plot_status_updated: plotStatusUpdated, workflow_unlocked: workflowUnlocked });
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
  const {
    noc_no, noc_date, noc_place, noc_notes, noc_show_payments, noc_include_co_applicant,
    noc_farmer_member_id, noc_authorized_member_id, included_plot_payment_ids, inline_payments, change_note,
  } = req.body;

  const includedIds = Array.isArray(included_plot_payment_ids)
    ? [...new Set(included_plot_payment_ids.map((n) => parseInt(n)).filter(Number.isFinite))]
    : null;
  const today = new Date().toISOString().split('T')[0];

  const client = await pool.connect();
  let plotStatusUpdated = false;
  let workflowUnlocked = false;
  try {
    await client.query('BEGIN');

    // Serialize revisions for one registry. Two users regenerating at the
    // same time must receive R02 and R03, never duplicate ACK numbers.
    const lockedResult = await client.query(
      `SELECT * FROM plot_registries WHERE id = $1 FOR UPDATE`,
      [registryId]
    );
    const registry = lockedResult.rows[0];
    if (!registry) {
      await client.query('ROLLBACK');
      return res.status(404).json({ message: 'Registry not found' });
    }
    workflowUnlocked = await readRegistryWorkflowUnlocked(client, registry.site_id);

    // KYC gate: every person named on the NOC must have KYC done (override in Settings bypasses).
    const includeCo = noc_include_co_applicant === undefined || noc_include_co_applicant === null
      ? (registry.noc_include_co_applicant === null || registry.noc_include_co_applicant === undefined ? null : Boolean(registry.noc_include_co_applicant))
      : Boolean(noc_include_co_applicant);
    const kycRequired = await readNocKycRequired(client, registry.site_id);
    if (!workflowUnlocked && kycRequired) {
      const plotRow = registry.plot_id ? (await client.query('SELECT id, buyer_name FROM plots WHERE id = $1', [registry.plot_id])).rows[0] : null;
      const people = await resolveNocPeople(client, { ...registry, noc_include_co_applicant: includeCo }, plotRow);
      if (!people.kyc_ready) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          code: 'KYC_REQUIRED',
          message: `KYC must be complete before the NOC is generated — ${people.blockers.join('; ')}`,
          blockers: people.blockers,
          people,
        });
      }
    }

    const wasGenerated = Boolean(registry.noc_generated_at);
    const requestedRef = noc_no === undefined || noc_no === null
      ? ''
      : String(noc_no).trim().toUpperCase();
    const existingRef = String(registry.noc_no || '').trim().toUpperCase();
    if (wasGenerated && requestedRef && existingRef && requestedRef !== existingRef) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        code: 'NOC_REF_IMMUTABLE',
        message: `REF number ${existingRef} is permanent. Regenerate the NOC to receive a new ACK number.`,
      });
    }

    const refNo = existingRef || requestedRef
      || `NOC/RG/${new Date().getFullYear()}/${String(registryId).padStart(4, '0')}`;
    const revisionNo = Math.max(parseInt(registry.noc_revision) || (wasGenerated ? 1 : 0), 0) + 1;
    const ackNo = `ACK/NOC/${String(registryId).padStart(4, '0')}/R${String(revisionNo).padStart(2, '0')}`;
    const changeNote = change_note ? String(change_note).trim() : null;
    if (wasGenerated && (!changeNote || changeNote.length < 3)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        code: 'NOC_REVISION_REASON_REQUIRED',
        message: 'Enter a reason for regenerating the NOC so the revision history remains clear.',
      });
    }
    const showPayments = noc_show_payments === undefined
      ? registry.noc_show_payments !== false
      : noc_show_payments !== false;

    // The people named on the certificate are optional, but each must be a client
    // of this registry's own site and of the type the role allows.
    const resolveNocMember = async (incoming, current, types, label) => {
      if (incoming === undefined) return current || null;
      const wanted = parseInt(incoming);
      if (!Number.isFinite(wanted)) return null;
      const ok = await client.query(
        `SELECT id FROM members
          WHERE id = $1 AND site_id = $2
            AND COALESCE(member_types, ARRAY[member_type]) && $3::text[]`,
        [wanted, registry.site_id, types]
      );
      if (!ok.rows[0]) {
        const error = new Error(`Pick a ${label} from this site's clients`);
        error.status = 400;
        throw error;
      }
      return wanted;
    };
    let farmerMemberId;
    let authorizedMemberId;
    try {
      farmerMemberId = await resolveNocMember(noc_farmer_member_id, registry.noc_farmer_member_id, ['FARMER'], 'farmer');
      authorizedMemberId = await resolveNocMember(noc_authorized_member_id, registry.noc_authorized_member_id, COMPANY_MEMBER_TYPES, 'company member');
    } catch (selectionError) {
      if (!selectionError.status) throw selectionError;
      await client.query('ROLLBACK');
      return res.status(400).json({ message: selectionError.message });
    }

    // ── NOC meta on the registry ──
    await client.query(
      `UPDATE plot_registries
          SET noc_no = $2,
              noc_date = $3,
              noc_place = $4,
              noc_notes = $5,
              noc_show_payments = $6,
              noc_ack_no = $7,
              noc_revision = $8,
              noc_generated_by = $9,
              noc_include_co_applicant = $11::boolean,
              noc_farmer_member_id = $12::integer,
              noc_authorized_member_id = $13::integer,
              noc_generated_at = NOW(),
              noc_approved_at = CASE WHEN $10::boolean THEN NULL ELSE noc_approved_at END,
              noc_approved_by = CASE WHEN $10::boolean THEN NULL ELSE noc_approved_by END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        registryId,
        refNo,
        noc_date !== undefined ? (noc_date || null) : registry.noc_date,
        noc_place !== undefined ? (noc_place ? String(noc_place).trim().toUpperCase() : null) : registry.noc_place,
        noc_notes !== undefined ? (noc_notes ? String(noc_notes).trim() : null) : registry.noc_notes,
        showPayments,
        ackNo,
        revisionNo,
        req.user.id,
        wasGenerated,
        includeCo,
        farmerMemberId,
        authorizedMemberId,
      ]
    );

    // ── Sync plot-payment selections ──
    if (includedIds) {
      // Reset source-linked selections first. Only receipts belonging to this
      // registry's plot are allowed to be switched back on below.
      await client.query(
        `UPDATE plot_registry_payments
            SET include_in_noc = FALSE, updated_at = NOW()
          WHERE registry_id = $1
            AND source_plot_payment_id IS NOT NULL
            AND include_in_noc = TRUE`,
        [registryId]
      );
      await client.query(
        `UPDATE plot_registry_payments prp
            SET include_in_noc = TRUE, updated_at = NOW()
           FROM plot_payments pp
          WHERE prp.registry_id = $1
            AND prp.source_plot_payment_id = pp.id
            AND prp.source_plot_payment_id = ANY($2::int[])
            AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
            AND (
              ($3::integer IS NOT NULL AND pp.plot_id = $3)
              OR (
                $3::integer IS NULL
                AND EXISTS (
                  SELECT 1 FROM plots target
                   WHERE target.id = pp.plot_id
                     AND target.site_id = $4
                     AND UPPER(target.plot_no) = UPPER($5)
                )
              )
            )`,
        [registryId, includedIds, registry.plot_id || null, registry.site_id, registry.plot_no]
      );
      // Link payments that aren't assigned to any registry yet.
      await client.query(
        `INSERT INTO plot_registry_payments (
           registry_id, site_id, payment_date, amount, payment_mode, tally_date, tally_amount,
           notes, source_plot_payment_id, include_in_noc, cheque_no, cheque_status,
           status, approved_by, approved_at, created_by
         )
         SELECT $1, pp.site_id, COALESCE(pp.date, CURRENT_DATE), pp.amount,
                COALESCE(NULLIF(UPPER(TRIM(pp.payment_from)), ''), UPPER(COALESCE(pp.payment_type, ''))),
                pp.date, pp.amount,
                COALESCE(NULLIF(UPPER(TRIM(pp.narration)), ''), NULLIF(UPPER(TRIM(pp.bank_details)), ''), 'LINKED FROM PLOT PAYMENT'),
                pp.id, TRUE, pp.cheque_no, pp.cheque_status,
                COALESCE(pp.status, 'approved'), pp.approved_by, pp.approved_at, $3
           FROM plot_payments pp
          WHERE pp.id = ANY($2::int[])
            AND pp.site_id = $4
            AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
            AND (
              ($5::integer IS NOT NULL AND pp.plot_id = $5)
              OR (
                $5::integer IS NULL
                AND EXISTS (
                  SELECT 1 FROM plots target
                   WHERE target.id = pp.plot_id
                     AND target.site_id = $4
                     AND UPPER(target.plot_no) = UPPER($6)
                )
              )
            )
            AND NOT EXISTS (SELECT 1 FROM plot_registry_payments x WHERE x.source_plot_payment_id = pp.id)`,
        [
          registryId,
          includedIds,
          req.user.id,
          registry.site_id,
          registry.plot_id || null,
          registry.plot_no,
        ]
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
               include_in_noc, cheque_no, cheque_status, status, approved_by,
               approved_at, created_by
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'approved', $10, NOW(), $10)`,
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

    // ── Payment-clear gate: the NOC may only be generated once the registry is
    // fully paid. Evaluated INSIDE the transaction, after the payment syncs
    // above, so payments added in this very save count toward the total. ──
    const totalRes = await client.query(
      `SELECT COALESCE(SUM(prp.amount), 0)::numeric AS total_paid
         FROM plot_registry_payments prp
         LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
        WHERE prp.registry_id = $1
          AND (
            (prp.source_plot_payment_id IS NULL
              AND financial_transaction_posts('credit', prp.status, prp.payment_mode, prp.cheque_status))
            OR
            (prp.source_plot_payment_id IS NOT NULL
              AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status))
          )
          AND (
            prp.source_plot_payment_id IS NULL
            OR ($2::integer IS NOT NULL AND pp.plot_id = $2)
            OR (
              $2::integer IS NULL
              AND EXISTS (
                SELECT 1 FROM plots target
                 WHERE target.id = pp.plot_id
                   AND target.site_id = $3
                   AND UPPER(target.plot_no) = UPPER($4)
              )
            )
          )`,
      [registryId, registry.plot_id || null, registry.site_id, registry.plot_no]
    );
    const totalPaid = parseFloat(totalRes.rows[0]?.total_paid) || 0;
    const due = (parseFloat(registry.registry_payment) || 0) - totalPaid;
    if (!workflowUnlocked && due > 0.005) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        message: `NOC can only be generated after full payment — ₹${due.toLocaleString('en-IN')} is still due against this registry`,
        due,
      });
    }

    // Snapshot exactly what was issued. Future payment edits do not rewrite
    // an old NOC revision, and the user/date/reason remain attributable.
    const snapshotResult = await client.query(
      `SELECT
         COALESCE(jsonb_agg(x.payment ORDER BY x.payment_date, x.payment_id), '[]'::jsonb) AS payments,
         COUNT(*)::integer AS included_count,
         COALESCE(SUM(x.amount), 0)::numeric AS included_amount
       FROM (
         SELECT
           prp.id AS payment_id,
           pp.date AS payment_date,
           pp.amount,
           jsonb_build_object(
             'id', prp.id,
             'source', 'plot',
             'source_plot_payment_id', pp.id,
             'date', pp.date,
             'amount', pp.amount,
             'mode', COALESCE(NULLIF(UPPER(TRIM(pp.payment_from)), ''), UPPER(COALESCE(pp.payment_type, ''))),
             'notes', COALESCE(pp.narration, pp.bank_details),
             'cheque_no', pp.cheque_no
           ) AS payment
         FROM plot_registry_payments prp
         JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
         WHERE prp.registry_id = $1
           AND COALESCE(prp.include_in_noc, FALSE)
           AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
         UNION ALL
         SELECT
           prp.id AS payment_id,
           prp.payment_date,
           prp.amount,
           jsonb_build_object(
             'id', prp.id,
             'source', 'manual',
             'date', prp.payment_date,
             'amount', prp.amount,
             'mode', prp.payment_mode,
             'notes', prp.notes,
             'cheque_no', prp.cheque_no
           ) AS payment
         FROM plot_registry_payments prp
         WHERE prp.registry_id = $1
           AND prp.source_plot_payment_id IS NULL
           AND COALESCE(prp.include_in_noc, FALSE)
           AND financial_transaction_posts('credit', prp.status, prp.payment_mode, prp.cheque_status)
       ) x`,
      [registryId]
    );
    const issuedPayments = snapshotResult.rows[0]?.payments || [];
    const includedCount = parseInt(snapshotResult.rows[0]?.included_count) || 0;
    const includedAmount = parseFloat(snapshotResult.rows[0]?.included_amount) || 0;
    // Names of the people this revision was issued with, for the audit snapshot.
    const namedRes = await client.query(
      `SELECT id, full_name FROM members WHERE id = ANY($1::int[])`,
      [[farmerMemberId, authorizedMemberId].filter(Boolean)]
    );
    const namedMember = (memberId) => {
      if (!memberId) return null;
      const row = namedRes.rows.find((r) => r.id === memberId);
      return { id: memberId, name: row?.full_name || null };
    };
    const snapshot = {
      noc: {
        ref_no: refNo,
        ack_no: ackNo,
        revision_no: revisionNo,
        noc_date: noc_date !== undefined ? (noc_date || null) : registry.noc_date,
        noc_place: noc_place !== undefined ? (noc_place ? String(noc_place).trim().toUpperCase() : null) : registry.noc_place,
        noc_notes: noc_notes !== undefined ? (noc_notes ? String(noc_notes).trim() : null) : registry.noc_notes,
        show_payments: showPayments,
      },
      plot: {
        id: registry.plot_id,
        plot_no: registry.plot_no,
        customer_name: registry.customer_name,
        farmer: namedMember(farmerMemberId),
        authorized_signatory: namedMember(authorizedMemberId),
      },
      payments: issuedPayments,
      totals: { included_count: includedCount, included_amount: includedAmount },
    };
    await client.query(
      `INSERT INTO plot_registry_noc_history (
         registry_id, revision_no, ref_no, ack_no, event_type, change_note,
         show_payments, included_payment_count, included_amount, snapshot,
         generated_by, generated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, NOW())`,
      [
        registryId, revisionNo, refNo, ackNo,
        wasGenerated ? 'REGENERATED' : 'GENERATED',
        changeNote, showPayments, includedCount, includedAmount,
        JSON.stringify(snapshot), req.user.id,
      ]
    );

    // Generating the NOC is the business transition requested by the plot
    // workflow: BOOKED/PENDING NOC -> REGISTRY. The deed upload gate reads the
    // same noc_generated_at value, so status and document readiness commit
    // atomically.
    const plotResult = await client.query(
      `WITH target_plot AS (
         SELECT id
           FROM plots
          WHERE ($1::integer IS NOT NULL AND id = $1)
             OR ($1::integer IS NULL AND site_id = $2 AND UPPER(plot_no) = UPPER($3))
          ORDER BY id DESC
          LIMIT 1
       )
       UPDATE plots p
          SET status = 'REGISTRY', updated_at = NOW()
         FROM target_plot target
        WHERE p.id = target.id
          AND UPPER(COALESCE(p.status, '')) != 'REGISTRY'
          AND UPPER(COALESCE(p.status, '')) NOT IN (
            'CANCELLED', 'CANCEL', 'CANCELLATION', 'UNDER CANCELLATION',
            'RESALE', 'TRANSFERRED', 'COMPANY'
          )
        RETURNING p.id`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    plotStatusUpdated = plotResult.rows.length > 0;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  const payload = await buildNocPayload(registryId);
  payload.plot_status_updated = plotStatusUpdated;
  payload.registry_deed_unlocked = Boolean(payload.registry?.noc_generated_at);
  res.json(payload);
});

// ══════════════════════════════════════════════════
//  DOCUMENT HANDOVER ENDPOINTS
// ══════════════════════════════════════════════════

/** GET /registries/:id/handovers — handover timeline (newest first) */
export const listRegistryHandovers = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { rows } = await pool.query(
    `SELECT h.*, COALESCE(u.name, u.email) AS given_by_name
       FROM registry_document_handovers h
       LEFT JOIN users u ON u.id = h.given_by
      WHERE h.registry_id = $1
      ORDER BY h.given_at DESC, h.id DESC`,
    [registryId]
  );
  res.json({ handovers: rows });
});

/** POST /registries/:id/handovers — record an (offline) handover of the
 *  registry documents to the customer. Gated: the registry document must be
 *  uploaded first. Body: { given_to, notes, photo_url, given_at } —
 *  photo_url comes from the client-side /upload/single?provider=s3 flow. */
export const createRegistryHandover = asyncHandler(async (req, res) => {
  const registryId = parseInt(req.params.id);
  const { given_to, notes, photo_url, signature_url, receiver_phone, given_at } = req.body;

  if (!given_to || !String(given_to).trim()) {
    return res.status(400).json({ message: 'Recipient name is required' });
  }
  // A handover is proof of delivery: the photo taken at the moment of handover and the
  // client's signature are both mandatory (captured in the handover dialog).
  if (!photo_url || !String(photo_url).trim()) {
    return res.status(400).json({ code: 'HANDOVER_PHOTO_REQUIRED', message: 'Capture a photo at the moment of handover' });
  }
  if (!signature_url || !String(signature_url).trim()) {
    return res.status(400).json({ code: 'HANDOVER_SIGNATURE_REQUIRED', message: "Capture the client's signature to record the handover" });
  }

  const registry = await plotRegistryModel.findById(registryId, pool);
  if (!registry) return res.status(404).json({ message: 'Registry not found' });
  const workflowUnlocked = await isRegistryWorkflowUnlocked(registry.site_id);

  // Match by FK or (site, plot_no) fallback — same resolution as the
  // REGISTRY doc-upload gate, so null-plot_id registries aren't blocked.
  if (!workflowUnlocked) {
    const docRes = await pool.query(
      `SELECT 1 FROM documents d
         JOIN plots p ON p.id = d.plot_id
        WHERE UPPER(COALESCE(d.category, '')) = 'REGISTRY'
          AND COALESCE(d.uploaded_source, 'BOOKING') <> 'DMS'
          AND (p.id = $1 OR (p.site_id = $2 AND UPPER(p.plot_no) = UPPER($3)))
        LIMIT 1`,
      [registry.plot_id, registry.site_id, registry.plot_no]
    );
    if (!docRes.rows.length) {
      return res.status(409).json({
        code: 'REGISTRY_DOCUMENT_REQUIRED',
        message: 'Upload the registry deed before recording a handover, or enable the workflow override in Settings',
      });
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO registry_document_handovers (registry_id, site_id, given_to, notes, photo_url, given_by, given_at, signature_url, receiver_phone)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamp, NOW()), $8, $9)
     RETURNING *`,
    [
      registryId, registry.site_id,
      String(given_to).trim().toUpperCase(),
      notes ? String(notes).trim() : null,
      String(photo_url).trim(),
      req.user.id,
      given_at || null,
      String(signature_url).trim(),
      receiver_phone ? String(receiver_phone).trim().slice(0, 20) : null,
    ]
  );
  const handover = rows[0];
  handover.given_by_name = req.user.name || req.user.email || null;
  res.status(201).json({ handover, workflow_unlocked: workflowUnlocked });
});
