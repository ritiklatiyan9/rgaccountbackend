import asyncHandler from '../utils/asyncHandler.js';
import { plotCommissionV2Model, plotCommissionPaymentModel } from '../models/PlotCommissionV2.model.js';
import { dayBookModel } from '../models/DayBook.model.js';
import pool from '../config/db.js';
import { buildVerifyUrl, ReceiptType } from '../utils/receiptToken.js';

/**
 * Helper: Auto-update commission status based on payment completion.
 * Single round-trip — derives the new status from the live SUM(amount) and
 * UPDATEs in one statement. Previously this was SELECT + UPDATE (2 RTTs).
 */
const autoUpdateCommissionStatus = async (commissionId, poolConn) => {
  try {
    await poolConn.query(
      `UPDATE plot_commissions_v2 pc
          SET status = CASE
                WHEN agg.total_paid >= pc.total_commission THEN 'Completed'
                WHEN agg.total_paid > 0 THEN 'Partial'
                ELSE 'Pending'
              END,
              updated_at = NOW()
        FROM (
          SELECT COALESCE(SUM(amount), 0) AS total_paid
          FROM plot_commission_payments
          WHERE plot_commission_id = $1
            AND status = 'approved'
            AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
        ) agg
        WHERE pc.id = $1`,
      [commissionId]
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
  const { site_id, plot_id, agent_id, total_commission, remarks } = req.body;

  if (!site_id || !plot_id || !agent_id || !total_commission) {
    return res.status(400).json({ message: 'site_id, plot_id, agent_id, total_commission are required' });
  }

  const plotIdInt = parseInt(plot_id);
  const agentIdInt = parseInt(agent_id);

  // Single-round-trip duplicate check: try the INSERT optimistically inside
  // a CTE and let it return 0 rows if the (plot_id, agent_id) pair already
  // exists. Saves one round-trip vs the previous SELECT-then-INSERT.
  const result = await pool.query(
    `WITH existing AS (
       SELECT 1 FROM plot_commissions_v2
        WHERE plot_id = $1 AND agent_id = $2
        LIMIT 1
     ),
     ins AS (
       INSERT INTO plot_commissions_v2 (
         site_id, plot_id, agent_id, total_commission, remarks, status, created_by
       )
       SELECT $3, $1, $2, $4, $5, 'Pending', $6
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING *
     )
     SELECT
       (SELECT row_to_json(ins) FROM ins) AS master,
       EXISTS (SELECT 1 FROM existing) AS dup`,
    [
      plotIdInt,
      agentIdInt,
      parseInt(site_id),
      parseFloat(total_commission),
      remarks ? remarks.trim() : null,
      req.user.id,
    ]
  );

  const row = result.rows[0];
  if (row.dup) {
    return res.status(409).json({ message: 'This agent already has a commission assigned for this plot' });
  }
  res.status(201).json({ master: row.master, message: 'Plot commission created successfully' });
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
  const numSiteId = parseInt(site_id);
  if (isNaN(numPlotId)) return res.status(400).json({ message: 'Invalid plot ID' });
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  // Step 1: load commissions (we need the IDs to fetch payments).
  const commissions = await plotCommissionV2Model.findAllCommissionsByPlotId(numPlotId, numSiteId, pool);
  if (!commissions || commissions.length === 0) {
    return res.status(404).json({ message: 'No commissions found for this plot' });
  }

  // Step 2: fire payments + site + timeline IN PARALLEL (was serial — 3 RTTs).
  const commissionIds = commissions.map(c => c.id);

  const allPaymentsPromise = pool.query(
    `SELECT pcp.*, u.name AS created_by_name, a.name AS approved_by_name
       FROM plot_commission_payments pcp
       LEFT JOIN users u ON pcp.created_by = u.id
       LEFT JOIN users a ON pcp.approved_by = a.id
      WHERE pcp.plot_commission_id = ANY($1)
      ORDER BY pcp.date DESC, pcp.created_at DESC`,
    [commissionIds]
  );

  const sitePromise = pool.query(
    'SELECT name, city, state FROM sites WHERE id = $1',
    [numSiteId]
  );

  // We'll also kick off the timeline query in parallel using the plot_no
  // we already have on the first commission row.
  const plotNoForTimeline = commissions[0].plot_no;
  const timelinePromise = pool.query(
    `SELECT
       p.id AS plot_id, p.plot_no, p.buyer_name, p.plot_size, p.plot_rate,
       COALESCE(p.plot_commission, 0) AS plot_commission,
       STRING_AGG(DISTINCT m.full_name, ', ' ORDER BY m.full_name) AS agent_names,
       COALESCE(NULLIF(COALESCE(p.plot_commission, 0), 0), MAX(pc.total_commission)) AS total_commission,
       COALESCE(SUM(paid_agg.total_paid), 0) AS total_paid,
       COALESCE(SUM(paid_agg.total_paid_all), 0) AS total_paid_all,
       COALESCE(SUM(paid_agg.payment_count), 0) AS payment_count,
       MIN(pc.created_at) AS first_created,
       MAX(pc.created_at) AS last_created,
       MAX(pc.status) AS latest_status,
       JSON_AGG(JSON_BUILD_OBJECT(
         'commission_id', pc.id,
         'plot_id', p.id,
         'agent_id', pc.agent_id,
         'agent_name', m.full_name,
         'agent_phone', m.phone,
         'total_commission', pc.total_commission,
         'status', pc.status,
         'total_paid', COALESCE(paid_agg.total_paid, 0),
         'total_paid_all', COALESCE(paid_agg.total_paid_all, 0),
         'balance', pc.total_commission - COALESCE(paid_agg.total_paid_all, 0),
         'payment_count', COALESCE(paid_agg.payment_count, 0)
       ) ORDER BY pc.created_at ASC) AS agents_detail
     FROM plots p
     JOIN plot_commissions_v2 pc ON pc.plot_id = p.id AND pc.site_id = $2
     JOIN members m ON pc.agent_id = m.id
     LEFT JOIN (
       SELECT plot_commission_id,
              SUM(amount) FILTER (WHERE status = 'approved') AS total_paid,
              SUM(amount) FILTER (WHERE status IN ('approved', 'pending')) AS total_paid_all,
              COUNT(*) AS payment_count
       FROM plot_commission_payments
       WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
       GROUP BY plot_commission_id
     ) paid_agg ON paid_agg.plot_commission_id = pc.id
     WHERE p.plot_no = $1 AND pc.site_id = $2
     GROUP BY p.id, p.plot_no, p.buyer_name, p.plot_size, p.plot_rate, p.plot_commission
     ORDER BY MIN(pc.created_at) ASC`,
    [plotNoForTimeline, numSiteId]
  );

  const [paymentsResult, siteResult, timelineResult] = await Promise.all([
    allPaymentsPromise,
    sitePromise,
    timelinePromise,
  ]);

  const allPayments = paymentsResult.rows;
  const siteRow = siteResult.rows[0] || null;

  // Group payments by commission_id and attach a signed verifyUrl to each.
  const paymentsByCommission = {};
  for (const p of allPayments) {
    if (!paymentsByCommission[p.plot_commission_id]) {
      paymentsByCommission[p.plot_commission_id] = [];
    }
    // Find the agent name on this commission for the token payload
    const parentCommission = commissions.find((c) => c.id === p.plot_commission_id);
    const payment = {
      ...p,
      verifyUrl: buildVerifyUrl({
        t: ReceiptType.COMMISSION,
        i: p.id,
        pn: parentCommission?.agent_name || null,
        a: p.amount,
        d: p.date,
        pm: p.payment_mode || null,
        pl: commissions[0]?.plot_no || null,
        sn: siteRow?.name || commissions[0]?.site_name || null,
        sy: siteRow?.city || null,
        ss: siteRow?.state || null,
      }),
    };
    paymentsByCommission[p.plot_commission_id].push(payment);
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

  // Timeline already fetched in parallel above — just shape the rows here.
  // Rows are ordered oldest → newest so the UI can render a left-to-right
  // parcel-style progress tracker.
  const timeline = timelineResult.rows.map(r => ({
    ...r,
    total_commission: parseFloat(r.total_commission) || 0,
    total_paid: parseFloat(r.total_paid) || 0,
    total_paid_all: parseFloat(r.total_paid_all) || 0,
    payment_count: parseInt(r.payment_count) || 0,
    balance: (parseFloat(r.total_commission) || 0) - (parseFloat(r.total_paid_all) || 0),
    is_current: r.plot_id === numPlotId,
    agents_detail: (r.agents_detail || []).map(a => ({
      ...a,
      total_commission: parseFloat(a.total_commission) || 0,
      total_paid: parseFloat(a.total_paid) || 0,
      total_paid_all: parseFloat(a.total_paid_all) || 0,
      balance: parseFloat(a.balance) || 0,
      payment_count: parseInt(a.payment_count) || 0,
    })),
  }));

  // ── Plot-wide grand totals (across EVERY booking/resale of this plot_no) ──
  // The summary cards use this so a resold plot reflects the *total* money
  // committed, given and pending across the previous + new agents — not just
  // the current booking.
  const grand = timeline.reduce(
    (acc, t) => ({
      total_commission: acc.total_commission + t.total_commission,
      total_paid: acc.total_paid + t.total_paid,
      total_paid_all: acc.total_paid_all + t.total_paid_all,
      booking_count: acc.booking_count + 1,
    }),
    { total_commission: 0, total_paid: 0, total_paid_all: 0, booking_count: 0 }
  );
  grand.balance = grand.total_commission - grand.total_paid_all;

  res.json({
    plot: plotInfo,
    agents,
    totals: { total_commission: totalCommission, total_paid: totalPaid, total_paid_all: totalPaidAll, balance: totalCommission - totalPaidAll },
    grand,
    is_resale: commissions.length > 1 || timeline.length > 1,
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

  const masterIdInt = parseInt(master_id);
  const numericAmount = parseFloat(amount);
  const mode = payment_mode || 'CASH';
  const chequeStatus = mode.toUpperCase() === 'CHEQUE' ? 'PENDING' : null;

  // Single CTE round-trip: lookup master + insert payment + compute
  // balance_after_payment from the live SUM, all atomically. The previous
  // implementation was 2 SELECTs (master+totals via heavy aggregation) +
  // 1 INSERT = 3 round-trips. New status update still runs in parallel after.
  const result = await pool.query(
    `WITH master AS (
       SELECT id, site_id, total_commission,
              COALESCE((
                SELECT SUM(amount)
                FROM plot_commission_payments
                WHERE plot_commission_id = $1
                  AND status = 'approved'
                  AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED', 'RETURNED'))
              ), 0) AS already_paid
       FROM plot_commissions_v2
       WHERE id = $1
     ),
     ins AS (
       INSERT INTO plot_commission_payments (
         site_id, plot_commission_id, date, amount, balance_after_payment,
         payment_mode, bank_name, transaction_id, remarks, status,
         voucher_number, voucher_url, assigned_admin_id, created_by,
         cheque_no, cheque_status
       )
       SELECT
         m.site_id, $1, $2::date, $3::numeric,
         (m.total_commission - (m.already_paid + $3::numeric)),
         $4::text, $5::text, $6::text, $7::text, 'pending',
         $8::text, $9::text, $10::int, $11::int,
         $12::text, $13::text
       FROM master m
       RETURNING *
     )
     SELECT row_to_json(ins) AS payment FROM ins`,
    [
      masterIdInt,                                                // $1
      date || new Date().toISOString().split('T')[0],             // $2
      numericAmount,                                              // $3
      mode,                                                       // $4
      bank_name ? bank_name.trim() : null,                        // $5
      transaction_id ? transaction_id.trim() : null,              // $6
      remarks ? remarks.trim() : null,                            // $7
      voucher_number ? voucher_number.trim() : null,              // $8
      voucher_url || null,                                        // $9
      assigned_admin_id ? parseInt(assigned_admin_id) : null,     // $10
      req.user.id,                                                // $11
      cheque_no ? cheque_no.trim() : null,                        // $12
      chequeStatus,                                               // $13
    ]
  );

  const payment = result.rows[0]?.payment;
  if (!payment) {
    return res.status(404).json({ message: 'Commission master not found' });
  }

  // Auto-update status fire-and-forget (the row is already committed).
  // Pending payments don't change `Pending → Partial → Completed` derivation
  // (which only counts approved), so this is purely an observability touch
  // (`updated_at`). Run it in the background.
  autoUpdateCommissionStatus(masterIdInt, pool).catch(() => {});

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
  const { total_commission, remarks } = req.body;

  // Atomic UPDATE — saves a SELECT round-trip. UPDATE returns the row or
  // none (404).
  const result = await pool.query(
    `UPDATE plot_commissions_v2
        SET total_commission = $1,
            remarks          = $2,
            updated_at       = NOW()
      WHERE id = $3
      RETURNING *`,
    [
      parseFloat(total_commission),
      remarks ? remarks.trim() : null,
      parseInt(req.params.id),
    ]
  );
  if (!result.rows[0]) return res.status(404).json({ message: 'Commission not found' });
  res.json({ master: result.rows[0], message: 'Commission updated successfully' });
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
  const numId = parseInt(req.params.id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid payment ID' });

  const { date, amount, payment_mode, bank_name, transaction_id, cheque_no, remarks, voucher_url, assigned_admin_id } = req.body;

  // Build the SET-list dynamically. The cheque_status update needs the
  // existing row's value when payment_mode stays CHEQUE — handled below
  // with a CASE in SQL so we don't need a separate SELECT round-trip.
  const fields = [];
  const values = [];
  const add = (col, val) => { fields.push(`${col} = $${fields.length + 1}`); values.push(val); };

  if (date !== undefined) add('date', date);
  if (amount !== undefined) add('amount', parseFloat(amount));
  if (payment_mode !== undefined) add('payment_mode', payment_mode);
  if (bank_name !== undefined) add('bank_name', bank_name ? bank_name.trim() : null);
  if (transaction_id !== undefined) add('transaction_id', transaction_id ? transaction_id.trim() : null);
  if (cheque_no !== undefined) add('cheque_no', cheque_no ? cheque_no.trim() : null);
  if (remarks !== undefined) add('remarks', remarks ? remarks.trim() : null);
  if (voucher_url !== undefined) add('voucher_url', voucher_url || null);
  if (assigned_admin_id !== undefined) add('assigned_admin_id', assigned_admin_id ? parseInt(assigned_admin_id) : null);

  // cheque_status follows payment_mode: if mode → CHEQUE keep/init PENDING,
  // otherwise NULL. Handled via CASE so we don't need a SELECT round-trip.
  if (payment_mode !== undefined) {
    fields.push(
      `cheque_status = CASE
         WHEN UPPER($${fields.length + 1}::text) = 'CHEQUE'
           THEN COALESCE(plot_commission_payments.cheque_status, 'PENDING')
         ELSE NULL
       END`
    );
    values.push(payment_mode);
  }

  if (fields.length === 0) return res.status(400).json({ message: 'Nothing to update' });

  fields.push(`updated_at = NOW()`);
  values.push(numId);

  const result = await pool.query(
    `UPDATE plot_commission_payments
        SET ${fields.join(', ')}
      WHERE id = $${values.length}
      RETURNING *`,
    values
  );

  const updated = result.rows[0];
  if (!updated) return res.status(404).json({ message: 'Payment not found' });

  // Auto-update commission status in the background (response returns sooner).
  autoUpdateCommissionStatus(updated.plot_commission_id, pool).catch(() => {});

  res.json({ payment: updated, message: 'Payment updated successfully' });
});

/**
 * DELETE /plot-commission/payment/:id
 * Delete an individual commission payment.
 */
export const deletePlotCommissionPayment = asyncHandler(async (req, res) => {
  const numId = parseInt(req.params.id);
  if (isNaN(numId)) return res.status(400).json({ message: 'Invalid payment ID' });

  // Atomic DELETE with the commission_id returned in the same round-trip.
  // Previously: SELECT plot_commission_id + DELETE (2 RTTs); now 1 RTT.
  const deleted = await pool.query(
    `DELETE FROM plot_commission_payments
      WHERE id = $1
      RETURNING plot_commission_id`,
    [numId]
  );
  if (deleted.rows.length === 0) {
    return res.status(404).json({ message: 'Payment not found' });
  }

  // Recalculate status in background — response is already on its way.
  autoUpdateCommissionStatus(deleted.rows[0].plot_commission_id, pool).catch(() => {});

  res.json({ message: 'Payment deleted successfully' });
});
