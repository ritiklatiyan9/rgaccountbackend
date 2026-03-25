import asyncHandler from '../utils/asyncHandler.js';
import { installmentModel, installmentPaymentModel } from '../models/Installment.model.js';
import { plotModel } from '../models/Plot.model.js';
import pool from '../config/db.js';

let hasGracePeriodColumnCache = null;
const hasGracePeriodColumn = async () => {
  if (hasGracePeriodColumnCache !== null) return hasGracePeriodColumnCache;
  const { rows } = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_name = 'plots' AND column_name = 'grace_period_days'
    ) AS exists_col`
  );
  hasGracePeriodColumnCache = !!rows[0]?.exists_col;
  return hasGracePeriodColumnCache;
};

// ══════════════════════════════════════════════════
//  INTEREST CALCULATION HELPERS
// ══════════════════════════════════════════════════

function calculateInterest(remainingAmount, rate, type, fromDate, toDate) {
  if (!rate || rate <= 0 || remainingAmount <= 0) return 0;
  const from = new Date(fromDate);
  const to = new Date(toDate);
  if (to <= from) return 0;

  const diffMs = to - from;
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  let periods = 0;
  switch (type) {
    case 'per_day':     periods = diffDays; break;
    case 'per_month':   periods = diffDays / 30; break;
    case 'per_quarter': periods = diffDays / 90; break;
    case 'per_year':    periods = diffDays / 365; break;
    default:            periods = diffDays / 30; break;
  }

  return Math.round(remainingAmount * (rate / 100) * periods * 100) / 100;
}

// ══════════════════════════════════════════════════
//  PAYMENT REMINDERS
// ══════════════════════════════════════════════════

/** GET /plots/payment-reminders?site_id=X&page=1&limit=10 */
export const paymentReminders = asyncHandler(async (req, res) => {
  const { site_id, page = 1, limit = 10 } = req.query;
  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const todayStr = new Date().toISOString().split('T')[0];
  const todayMs = new Date(todayStr).getTime();
  const DAY = 86400000;
  const fmt = (n) => Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  // 1. All plots in the site with remaining balance
  const plotRes = await pool.query(
    `SELECT p.id, p.plot_no, p.block, p.buyer_name, p.sale_price,
            p.booking_date, p.booking_by, p.interest_enabled,
            p.interest_rate, p.interest_type, p.assigned_admin_id
     FROM plots p
     WHERE p.site_id = $1
     ORDER BY p.plot_no ASC`,
    [parseInt(site_id)]
  );
  if (plotRes.rows.length === 0) {
    return res.json({ reminders: [], pagination: { totalItems: 0, totalPages: 0, currentPage: 1, itemsPerPage: parseInt(limit) }, summary: { total: 0, overdue: 0, inactive: 0, upcoming: 0 } });
  }

  const plotIds = plotRes.rows.map(r => r.id);

  // 2. Installments
  const instRes = await pool.query(
    `SELECT id, plot_id, installment_name, amount, due_date, sort_order
     FROM plot_installments WHERE plot_id = ANY($1)
     ORDER BY plot_id, sort_order ASC, due_date ASC`,
    [plotIds]
  );
  const instByPlot = {};
  for (const i of instRes.rows) {
    if (!instByPlot[i.plot_id]) instByPlot[i.plot_id] = [];
    instByPlot[i.plot_id].push(i);
  }

  // 3. Total received per plot
  const payRes = await pool.query(
    `SELECT plot_id, COALESCE(SUM(amount), 0) AS total_received
     FROM plot_payments WHERE plot_id = ANY($1) GROUP BY plot_id`,
    [plotIds]
  );
  const receivedMap = {};
  for (const r of payRes.rows) receivedMap[r.plot_id] = parseFloat(r.total_received) || 0;

  // 4. Last payment date per plot
  const lastPayRes = await pool.query(
    `SELECT plot_id, MAX(date) AS last_payment_date
     FROM plot_payments WHERE plot_id = ANY($1) GROUP BY plot_id`,
    [plotIds]
  );
  const lastPayMap = {};
  for (const r of lastPayRes.rows) lastPayMap[r.plot_id] = r.last_payment_date;

  // 5. Individual payments per plot (for pattern detection)
  const allPayRes = await pool.query(
    `SELECT plot_id, date, amount FROM plot_payments
     WHERE plot_id = ANY($1) ORDER BY plot_id, date ASC`,
    [plotIds]
  );
  const paymentsByPlot = {};
  for (const r of allPayRes.rows) {
    if (!paymentsByPlot[r.plot_id]) paymentsByPlot[r.plot_id] = [];
    paymentsByPlot[r.plot_id].push({ date: r.date, amount: parseFloat(r.amount) || 0 });
  }

  // 6. Generate reminders
  const reminders = [];

  for (const plot of plotRes.rows) {
    const installments = instByPlot[plot.id] || [];
    const salePrice = parseFloat(plot.sale_price) || 0;
    const totalReceived = receivedMap[plot.id] || 0;
    const lastPayDate = lastPayMap[plot.id] || null;

    // Distribute payments across installments
    let pool_ = totalReceived;
    const enriched = installments.map(inst => {
      const amt = parseFloat(inst.amount) || 0;
      const paid = Math.min(pool_, amt);
      pool_ -= paid;
      return { ...inst, paid, remaining: Math.max(amt - paid, 0) };
    });

    // Overall remaining
    const totalRemaining = installments.length > 0
      ? enriched.reduce((s, i) => s + i.remaining, 0)
      : Math.max(salePrice - totalReceived, 0);

    // Skip fully paid
    if (totalRemaining <= 0) continue;

    // A. Overdue installments
    for (const inst of enriched) {
      if (inst.remaining > 0 && new Date(inst.due_date).getTime() < todayMs) {
        const daysOverdue = Math.floor((todayMs - new Date(inst.due_date).getTime()) / DAY);
        let severity = 'low';
        if (daysOverdue > 90) severity = 'critical';
        else if (daysOverdue > 30) severity = 'high';
        else if (daysOverdue > 7) severity = 'medium';

        reminders.push({
          type: 'overdue',
          severity,
          priority: daysOverdue > 90 ? 1 : daysOverdue > 30 ? 2 : 3,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          installment_name: inst.installment_name,
          due_date: inst.due_date,
          days_overdue: daysOverdue,
          amount_due: inst.remaining,
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `${inst.installment_name} is ${daysOverdue} days overdue — ₹${fmt(inst.remaining)} pending from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }

    // B. Upcoming due (within 7 days)
    for (const inst of enriched) {
      const dueDateMs = new Date(inst.due_date).getTime();
      if (inst.remaining > 0 && dueDateMs >= todayMs && dueDateMs <= todayMs + 15 * DAY) {
        const daysUntil = Math.floor((dueDateMs - todayMs) / DAY);
        reminders.push({
          type: 'upcoming',
          severity: daysUntil <= 1 ? 'high' : 'medium',
          priority: 4,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          installment_name: inst.installment_name,
          due_date: inst.due_date,
          days_until: daysUntil,
          amount_due: inst.remaining,
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `${inst.installment_name} due ${daysUntil === 0 ? 'today' : `in ${daysUntil} day${daysUntil > 1 ? 's' : ''}`} — ₹${fmt(inst.remaining)} from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }

    // C. Inactive — no payment for 30+ days with remaining balance (one reminder per plot)
    if (lastPayDate) {
      const daysSincePay = Math.floor((todayMs - new Date(lastPayDate).getTime()) / DAY);
      if (daysSincePay >= 15 && totalRemaining > 0) {
        reminders.push({
          type: 'inactive',
          severity: daysSincePay > 90 ? 'critical' : daysSincePay > 60 ? 'high' : 'medium',
          priority: daysSincePay > 90 ? 1 : daysSincePay > 60 ? 2 : 5,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          days_since_payment: daysSincePay,
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `No payment in ${daysSincePay} days — ₹${fmt(totalRemaining)} remaining from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    } else if (totalRemaining > 0 && plot.booking_date) {
      // No payment ever made
      const daysSinceBooking = Math.floor((todayMs - new Date(plot.booking_date).getTime()) / DAY);
      if (daysSinceBooking >= 15) {
        reminders.push({
          type: 'inactive',
          severity: daysSinceBooking > 60 ? 'critical' : 'high',
          priority: 1,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          days_since_payment: daysSinceBooking,
          total_remaining: totalRemaining,
          last_payment_date: null,
          message: `No payment received since booking (${daysSinceBooking} days) — ₹${fmt(totalRemaining)} pending from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }
    // D. Low progress — paid < 20% of sale price & booking 30+ days ago
    if (salePrice > 0 && plot.booking_date) {
      const pctPaid = (totalReceived / salePrice) * 100;
      const daysSinceBooking = Math.floor((todayMs - new Date(plot.booking_date).getTime()) / DAY);
      if (pctPaid < 20 && daysSinceBooking >= 30) {
        reminders.push({
          type: 'low_progress',
          severity: pctPaid < 5 ? 'critical' : pctPaid < 10 ? 'high' : 'medium',
          priority: pctPaid < 5 ? 1 : 3,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          pct_paid: Math.round(pctPaid),
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `Only ${Math.round(pctPaid)}% paid after ${daysSinceBooking} days — ₹${fmt(totalRemaining)} remaining from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }

    // E. Slow payer — 2+ installments paid after their due dates
    const plotPayments = paymentsByPlot[plot.id] || [];
    if (enriched.length >= 2 && plotPayments.length >= 2) {
      let lateCount = 0;
      let cumPaid = 0;
      for (const inst of enriched) {
        const instAmt = parseFloat(inst.amount) || 0;
        const dueMs = new Date(inst.due_date).getTime();
        // Find when this installment was fully covered
        let coveredDate = null;
        let running = 0;
        for (const pay of plotPayments) {
          running += pay.amount;
          if (running >= cumPaid + instAmt) {
            coveredDate = new Date(pay.date).getTime();
            break;
          }
        }
        cumPaid += instAmt;
        if (coveredDate && coveredDate > dueMs + 3 * DAY) lateCount++; // 3-day grace period
      }
      if (lateCount >= 2) {
        reminders.push({
          type: 'slow_payer',
          severity: lateCount >= 4 ? 'critical' : lateCount >= 3 ? 'high' : 'medium',
          priority: lateCount >= 4 ? 1 : 4,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          late_count: lateCount,
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `${lateCount} installments paid late — pattern of delayed payments from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }

    // F. Large gap — irregular payments (gap > 60 days between consecutive payments)
    if (plotPayments.length >= 2) {
      let maxGap = 0;
      for (let i = 1; i < plotPayments.length; i++) {
        const gap = Math.floor((new Date(plotPayments[i].date).getTime() - new Date(plotPayments[i - 1].date).getTime()) / DAY);
        if (gap > maxGap) maxGap = gap;
      }
      if (maxGap >= 60 && totalRemaining > 0) {
        reminders.push({
          type: 'irregular',
          severity: maxGap >= 120 ? 'high' : 'medium',
          priority: 5,
          plot_id: plot.id,
          plot_no: plot.plot_no,
          block: plot.block,
          buyer_name: plot.buyer_name,
          assigned_admin_id: plot.assigned_admin_id,
          max_gap_days: maxGap,
          total_remaining: totalRemaining,
          last_payment_date: lastPayDate,
          message: `Irregular payments — ${maxGap}-day gap detected between payments from ${plot.buyer_name || 'Unknown'}`,
        });
      }
    }

    // G. No installments setup — has balance but no installment plan
    if (installments.length === 0 && totalRemaining > 0 && salePrice > 0) {
      reminders.push({
        type: 'no_plan',
        severity: 'medium',
        priority: 6,
        plot_id: plot.id,
        plot_no: plot.plot_no,
        block: plot.block,
        buyer_name: plot.buyer_name,
        assigned_admin_id: plot.assigned_admin_id,
        total_remaining: totalRemaining,
        last_payment_date: lastPayDate,
        message: `No installment plan setup — ₹${fmt(totalRemaining)} remaining from ${plot.buyer_name || 'Unknown'}`,
      });
    }
  }

  // Sort by priority, then severity
  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  reminders.sort((a, b) => a.priority - b.priority || severityOrder[a.severity] - severityOrder[b.severity]);

  // Deduplicate: remove inactive/low_progress/irregular if plot already has overdue
  const overdueIds = new Set(reminders.filter(r => r.type === 'overdue').map(r => r.plot_id));
  let deduped = reminders.filter(r => {
    if (overdueIds.has(r.plot_id) && ['inactive', 'irregular'].includes(r.type)) return false;
    return true;
  });
  // Also remove irregular if plot has slow_payer (more specific)
  const slowIds = new Set(deduped.filter(r => r.type === 'slow_payer').map(r => r.plot_id));
  deduped = deduped.filter(r => !(r.type === 'irregular' && slowIds.has(r.plot_id)));

  // Summary
  const summary = {
    total: deduped.length,
    overdue: deduped.filter(r => r.type === 'overdue').length,
    inactive: deduped.filter(r => r.type === 'inactive').length,
    upcoming: deduped.filter(r => r.type === 'upcoming').length,
    low_progress: deduped.filter(r => r.type === 'low_progress').length,
    slow_payer: deduped.filter(r => r.type === 'slow_payer').length,
    irregular: deduped.filter(r => r.type === 'irregular').length,
    no_plan: deduped.filter(r => r.type === 'no_plan').length,
  };

  // Paginate
  const pg = parseInt(page) || 1;
  const lim = parseInt(limit) || 10;
  const start = (pg - 1) * lim;
  const paginated = deduped.slice(start, start + lim);

  res.json({
    reminders: paginated,
    pagination: { totalItems: deduped.length, totalPages: Math.ceil(deduped.length / lim), currentPage: pg, itemsPerPage: lim },
    summary,
  });
});

// ══════════════════════════════════════════════════
//  PLOT INSTALLMENT SETTINGS
// ══════════════════════════════════════════════════

/** PUT /plots/:id/installment-settings — Update installment & interest config on plot */
export const updateInstallmentSettings = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { installments_enabled, interest_enabled, interest_rate, interest_type, grace_period_days } = req.body;

  const plot = await plotModel.findById(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const updateData = {};
  if (installments_enabled !== undefined) updateData.installments_enabled = !!installments_enabled;
  if (interest_enabled !== undefined) updateData.interest_enabled = !!interest_enabled;
  if (interest_rate !== undefined) updateData.interest_rate = parseFloat(interest_rate) || 0;
  if (interest_type !== undefined) {
    const validTypes = ['per_day', 'per_month', 'per_quarter', 'per_year'];
    updateData.interest_type = validTypes.includes(interest_type) ? interest_type : 'per_month';
  }
  if (grace_period_days !== undefined && await hasGracePeriodColumn()) {
    updateData.grace_period_days = Math.max(0, parseInt(grace_period_days) || 0);
  }

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await plotModel.update(parseInt(id), updateData, pool);
  res.json({ plot: updated });
});

// ══════════════════════════════════════════════════
//  INSTALLMENTS CRUD
// ══════════════════════════════════════════════════

/** GET /plots/:id/installments — List installments for a plot */
export const listInstallments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const plot = await plotModel.findById(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  const installments = await installmentModel.findByPlotId(parseInt(id), pool);
  const today = new Date();

  // Get total received from plot_payments (the single source of truth)
  const totalRes = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS total_received FROM plot_payments WHERE plot_id = $1`,
    [parseInt(id)]
  );
  let remaining_pool = parseFloat(totalRes.rows[0].total_received) || 0;

  // Distribute total received across installments in sort order
  const graceDays = parseInt(plot.grace_period_days) || 15;

  const enriched = installments.map(inst => {
    const instAmount = parseFloat(inst.amount) || 0;
    const canApply = Math.min(remaining_pool, instAmount);
    remaining_pool -= canApply;

    const paid_amount = canApply;
    const remaining = Math.max(instAmount - paid_amount, 0);

    // Determine status
    let status = 'pending';
    if (paid_amount >= instAmount && instAmount > 0) {
      status = 'paid';
    } else if (paid_amount > 0) {
      status = 'partially_paid';
    } else if (new Date(inst.due_date) < today) {
      status = 'overdue';
    }

    let interest = 0;
    if (plot.interest_enabled && remaining > 0 && new Date(inst.due_date) < today) {
      interest = calculateInterest(remaining, parseFloat(plot.interest_rate), plot.interest_type, inst.due_date, today);
    }

    const dueDt = new Date(inst.due_date);
    const daysOverdue = dueDt < today ? Math.floor((today - dueDt) / (1000 * 60 * 60 * 24)) : 0;
    const underCancellation = remaining > 0 && daysOverdue > graceDays;

    return {
      ...inst,
      paid_amount,
      status,
      remaining_amount: remaining,
      interest_due: interest,
      days_overdue: daysOverdue,
      grace_period_days: graceDays,
      under_cancellation: underCancellation,
    };
  });

  // Auto move plot into UNDER CANCELLATION after grace window if not manually cancelled.
  const shouldUnderCancellation = enriched.some((i) => i.under_cancellation);
  const currentStatus = String(plot.status || '').toUpperCase();
  const protectedStatuses = ['CANCELLED', 'RESALE', 'TRANSFERRED'];

  if (!protectedStatuses.includes(currentStatus)) {
    if (shouldUnderCancellation && currentStatus !== 'UNDER CANCELLATION') {
      await plotModel.update(parseInt(id), { status: 'UNDER CANCELLATION' }, pool);
      plot.status = 'UNDER CANCELLATION';
    }
    if (!shouldUnderCancellation && currentStatus === 'UNDER CANCELLATION') {
      await plotModel.update(parseInt(id), { status: 'BOOKED' }, pool);
      plot.status = 'BOOKED';
    }
  }

  res.json({ installments: enriched, plot });
});

/** POST /plots/:id/installments — Create installment(s) for a plot */
export const createInstallments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { installments } = req.body; // Array of { installment_name, amount, due_date }

  if (!Array.isArray(installments) || installments.length === 0)
    return res.status(400).json({ message: 'At least one installment is required' });

  const plot = await plotModel.findById(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  // Get existing installments to determine sort_order
  const existing = await installmentModel.findByPlotId(parseInt(id), pool);
  let nextOrder = existing.length > 0 ? Math.max(...existing.map(e => e.sort_order)) + 1 : 1;

  const created = [];
  for (const inst of installments) {
    if (!inst.amount || !inst.due_date)
      return res.status(400).json({ message: 'Each installment must have amount and due_date' });

    const data = {
      plot_id: parseInt(id),
      installment_name: inst.installment_name || `Installment ${nextOrder}`,
      amount: parseFloat(inst.amount) || 0,
      due_date: inst.due_date,
      status: 'pending',
      paid_amount: 0,
      sort_order: nextOrder++,
    };
    const row = await installmentModel.create(data, pool);
    created.push(row);
  }

  // Enable installments on the plot
  if (!plot.installments_enabled) {
    await plotModel.update(parseInt(id), { installments_enabled: true }, pool);
  }

  res.status(201).json({ installments: created });
});

/** PUT /plots/installments/:instId — Update a single installment */
export const updateInstallment = asyncHandler(async (req, res) => {
  const { instId } = req.params;
  const { installment_name, amount, due_date, sort_order } = req.body;

  const inst = await installmentModel.findById(parseInt(instId), pool);
  if (!inst) return res.status(404).json({ message: 'Installment not found' });

  const updateData = {};
  if (installment_name !== undefined) updateData.installment_name = installment_name;
  if (amount !== undefined) updateData.amount = parseFloat(amount) || 0;
  if (due_date !== undefined) updateData.due_date = due_date;
  if (sort_order !== undefined) updateData.sort_order = parseInt(sort_order);

  if (Object.keys(updateData).length === 0) return res.status(400).json({ message: 'Nothing to update' });

  const updated = await installmentModel.update(parseInt(instId), updateData, pool);
  res.json({ installment: updated });
});

/** DELETE /plots/installments/:instId — Delete an installment */
export const deleteInstallment = asyncHandler(async (req, res) => {
  const { instId } = req.params;
  const inst = await installmentModel.findById(parseInt(instId), pool);
  if (!inst) return res.status(404).json({ message: 'Installment not found' });

  await installmentModel.delete(parseInt(instId), pool);
  res.json({ message: 'Installment deleted' });
});

// ══════════════════════════════════════════════════
//  RECORD PAYMENT AGAINST INSTALLMENTS
// ══════════════════════════════════════════════════

/** POST /plots/:id/installment-payment — Record a payment, auto-apply to earliest unpaid */
export const recordInstallmentPayment = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { amount, payment_date, payment_mode, reference, notes, installment_id } = req.body;

  if (!amount || parseFloat(amount) <= 0)
    return res.status(400).json({ message: 'A positive payment amount is required' });

  const plot = await plotModel.findById(parseInt(id), pool);
  if (!plot) return res.status(404).json({ message: 'Plot not found' });

  await installmentModel.refreshStatuses(parseInt(id), pool);

  let remaining = parseFloat(amount);
  const payments = [];

  if (installment_id) {
    // Pay specific installment
    const inst = await installmentModel.findById(parseInt(installment_id), pool);
    if (!inst || inst.plot_id !== parseInt(id))
      return res.status(404).json({ message: 'Installment not found for this plot' });

    const canPay = Math.min(remaining, inst.amount - inst.paid_amount);
    if (canPay <= 0) return res.status(400).json({ message: 'This installment is already fully paid' });

    const paymentRow = await installmentPaymentModel.create({
      installment_id: inst.id,
      plot_id: parseInt(id),
      amount: canPay,
      payment_date: payment_date || new Date().toISOString().split('T')[0],
      payment_mode: payment_mode || null,
      reference: reference || null,
      notes: notes || null,
      created_by: req.user.id,
    }, pool);
    payments.push(paymentRow);

    await installmentModel.update(inst.id, { paid_amount: parseFloat(inst.paid_amount) + canPay }, pool);
    remaining -= canPay;
  } else {
    // Auto-apply to earliest unpaid installments
    const installments = await installmentModel.findByPlotId(parseInt(id), pool);
    const unpaid = installments.filter(i => i.paid_amount < i.amount);

    for (const inst of unpaid) {
      if (remaining <= 0) break;
      const canPay = Math.min(remaining, inst.amount - inst.paid_amount);

      const paymentRow = await installmentPaymentModel.create({
        installment_id: inst.id,
        plot_id: parseInt(id),
        amount: canPay,
        payment_date: payment_date || new Date().toISOString().split('T')[0],
        payment_mode: payment_mode || null,
        reference: reference || null,
        notes: notes || null,
        created_by: req.user.id,
      }, pool);
      payments.push(paymentRow);

      await installmentModel.update(inst.id, { paid_amount: parseFloat(inst.paid_amount) + canPay }, pool);
      remaining -= canPay;
    }
  }

  // Refresh statuses after payment
  await installmentModel.refreshStatuses(parseInt(id), pool);

  res.status(201).json({
    payments,
    applied: parseFloat(amount) - remaining,
    unapplied: remaining,
  });
});

/** GET /plots/:id/installment-payments — All payments for a plot's installments */
export const listInstallmentPayments = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const payments = await installmentPaymentModel.findByPlotId(parseInt(id), pool);
  res.json({ payments });
});

// ══════════════════════════════════════════════════
//  PAYMENT MANAGEMENT DASHBOARD (admin overview)
// ══════════════════════════════════════════════════

/** GET /plots/payment-management — Aggregated view of all plots with installment data */
export const paymentManagementList = asyncHandler(async (req, res) => {
  const { site_id, status, search, due_filter, date_from, date_to } = req.query;

  if (!site_id) return res.status(400).json({ message: 'site_id is required' });

  const today = new Date().toISOString().split('T')[0];

  // ── Fetch all plots for this site ──
  let plotQuery = `
    SELECT p.id, p.plot_no, p.block, p.buyer_name, p.sale_price, p.status AS plot_status,
           p.installments_enabled, p.interest_enabled, p.interest_rate, p.interest_type,
           p.booking_date, p.booking_by, p.assigned_admin_id
    FROM plots p
    WHERE p.site_id = $1
  `;
  const plotParams = [parseInt(site_id)];
  let pIdx = 2;

  if (search) {
    plotQuery += ` AND (p.plot_no ILIKE $${pIdx} OR p.buyer_name ILIKE $${pIdx} OR p.booking_by ILIKE $${pIdx} OR p.block ILIKE $${pIdx})`;
    plotParams.push(`%${search}%`);
    pIdx++;
  }
  plotQuery += ` ORDER BY p.plot_no ASC`;

  const plotResult = await pool.query(plotQuery, plotParams);

  if (plotResult.rows.length === 0) {
    return res.json({ plots: [], summary: { total_count: 0, paid_count: 0, pending_count: 0, partial_count: 0, overdue_count: 0 } });
  }

  const plotIds = plotResult.rows.map(r => r.id);

  // ── Fetch all installments for these plots in one query ──
  const instResult = await pool.query(
    `SELECT id, plot_id, installment_name, amount, due_date, sort_order
     FROM plot_installments
     WHERE plot_id = ANY($1)
     ORDER BY plot_id, sort_order ASC, due_date ASC`,
    [plotIds]
  );

  // ── Fetch total received per plot from plot_payments (single source of truth) ──
  const payResult = await pool.query(
    `SELECT plot_id, COALESCE(SUM(amount), 0) AS total_received
     FROM plot_payments
     WHERE plot_id = ANY($1)
     GROUP BY plot_id`,
    [plotIds]
  );
  const receivedMap = {};
  for (const r of payResult.rows) receivedMap[r.plot_id] = parseFloat(r.total_received) || 0;

  // ── Group installments by plot and compute dynamic paid/status ──
  const instByPlot = {};
  for (const inst of instResult.rows) {
    if (!instByPlot[inst.plot_id]) instByPlot[inst.plot_id] = [];
    instByPlot[inst.plot_id].push(inst);
  }

  const plots = [];

  for (const plot of plotResult.rows) {
    const installments = instByPlot[plot.id] || [];
    let remainingPool = receivedMap[plot.id] || 0;
    const salePrice = parseFloat(plot.sale_price) || 0;

    let totalInstAmount = 0, totalPaid = 0, totalRemaining = 0;
    let paidCount = 0, overdueCount = 0;
    let nextDueDate = null, nextDueAmount = null;
    let interestDue = 0;

    if (installments.length > 0) {
      for (const inst of installments) {
        const instAmt = parseFloat(inst.amount) || 0;
        const canApply = Math.min(remainingPool, instAmt);
        remainingPool -= canApply;

        const paidAmt = canApply;
        const remaining = Math.max(instAmt - paidAmt, 0);

        let instStatus = 'pending';
        if (paidAmt >= instAmt && instAmt > 0) {
          instStatus = 'paid';
        } else if (paidAmt > 0) {
          instStatus = 'partially_paid';
        } else if (new Date(inst.due_date) < new Date(today)) {
          instStatus = 'overdue';
        }

        totalInstAmount += instAmt;
        totalPaid += paidAmt;
        totalRemaining += remaining;
        if (instStatus === 'paid') paidCount++;
        if (instStatus === 'overdue') overdueCount++;

        // Track next due
        if (instStatus !== 'paid' && !nextDueDate) {
          nextDueDate = inst.due_date;
          nextDueAmount = remaining;
        }

        // Interest calculation for overdue
        if (plot.interest_enabled && remaining > 0 && new Date(inst.due_date) < new Date(today)) {
          interestDue += calculateInterest(remaining, parseFloat(plot.interest_rate), plot.interest_type, inst.due_date, today);
        }
      }
    } else {
      // No installments — compute from plot_payments directly
      totalPaid = receivedMap[plot.id] || 0;
      totalRemaining = Math.max(salePrice - totalPaid, 0);
    }

    const installmentCount = installments.length;

    // Derive overall plot status
    let plotInstStatus = 'pending';
    if (salePrice > 0 && totalRemaining <= 0) plotInstStatus = 'paid';
    else if (overdueCount > 0) plotInstStatus = 'overdue';
    else if (totalPaid > 0 && totalRemaining > 0) plotInstStatus = 'partially_paid';

    // Apply filters
    if (status && status !== 'all') {
      if (status === 'paid' && plotInstStatus !== 'paid') continue;
      if (status === 'overdue' && plotInstStatus !== 'overdue') continue;
      if (status === 'partially_paid' && plotInstStatus !== 'partially_paid') continue;
      if (status === 'pending' && plotInstStatus !== 'pending') continue;
    }

    if (due_filter && due_filter !== 'all' && nextDueDate) {
      const ndd = new Date(nextDueDate);
      const todayDate = new Date(today);
      if (due_filter === 'today' && ndd.toISOString().split('T')[0] !== today) continue;
      if (due_filter === 'this_week') {
        const weekEnd = new Date(todayDate); weekEnd.setDate(weekEnd.getDate() + (7 - weekEnd.getDay()));
        if (ndd < todayDate || ndd > weekEnd) continue;
      }
      if (due_filter === 'this_month') {
        const monthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0);
        if (ndd < todayDate || ndd > monthEnd) continue;
      }
      if (due_filter === 'overdue' && overdueCount === 0) continue;
    } else if (due_filter && due_filter !== 'all' && !nextDueDate) {
      if (due_filter !== 'overdue') continue;
      if (due_filter === 'overdue' && overdueCount === 0) continue;
    }

    if (date_from && nextDueDate && new Date(nextDueDate) < new Date(date_from)) continue;
    if (date_to && nextDueDate && new Date(nextDueDate) > new Date(date_to)) continue;

    plots.push({
      ...plot,
      total_installment_amount: totalInstAmount,
      total_paid: totalPaid,
      total_remaining: totalRemaining,
      installment_count: installmentCount,
      paid_count: paidCount,
      overdue_count: overdueCount,
      next_due_date: nextDueDate,
      next_due_amount: nextDueAmount,
      interest_due: interestDue,
    });
  }

  // Sort: overdue first, then by next_due_date
  plots.sort((a, b) => {
    if (a.overdue_count > 0 && b.overdue_count === 0) return -1;
    if (a.overdue_count === 0 && b.overdue_count > 0) return 1;
    if (a.next_due_date && b.next_due_date) return new Date(a.next_due_date) - new Date(b.next_due_date);
    if (a.next_due_date) return -1;
    if (b.next_due_date) return 1;
    return 0;
  });

  // ── Summary: compute from all plots (unfiltered) for the summary cards ──
  // Re-run quickly over all plots
  let sumTotal = 0, sumPaid = 0, sumPending = 0, sumPartial = 0, sumOverdue = 0;
  for (const plot of plotResult.rows) {
    const installments = instByPlot[plot.id] || [];
    const sp = parseFloat(plot.sale_price) || 0;
    let rp = receivedMap[plot.id] || 0;
    let tp = 0, tr = 0, oc = 0;
    if (installments.length > 0) {
      for (const inst of installments) {
        const ia = parseFloat(inst.amount) || 0;
        const ca = Math.min(rp, ia);
        rp -= ca;
        tr += Math.max(ia - ca, 0);
        tp += ca;
        if (ca < ia && ca === 0 && new Date(inst.due_date) < new Date(today)) oc++;
      }
    } else {
      tp = rp;
      tr = Math.max(sp - tp, 0);
    }
    sumTotal++;
    if (sp > 0 && tr <= 0) sumPaid++;
    else if (oc > 0) sumOverdue++;
    else if (tp > 0) sumPartial++;
    else sumPending++;
  }

  res.json({
    plots,
    summary: {
      total_count: sumTotal,
      paid_count: sumPaid,
      pending_count: sumPending,
      partial_count: sumPartial,
      overdue_count: sumOverdue,
    },
  });
});
