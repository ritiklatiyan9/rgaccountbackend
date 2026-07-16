import asyncHandler from '../utils/asyncHandler.js';
import pool from '../config/db.js';

/**
 * Predictive Cash-Flow Forecast.
 *
 * Projects the next N months of company cash movement from the ONLY forward-dated schedules that
 * exist in the schema, plus the investor payout schedule this module adds (migration 070):
 *
 *   INFLOW  = pending plot installments (plot_installments.due_date). "Pending" is recomputed with
 *             the SAME waterfall the rest of the app uses — plot_installments.status/paid_amount are
 *             stale, so we sum all real money received (plot_payments + plot_installment_payments,
 *             excluding bounced/returned cheques) and subtract it from the cumulative installment
 *             schedule, earliest-first. Only ACTIVE agreements (plots.status filter).
 *   OUTFLOW = open vendor_commitments remaining balance (by due_date) + investor_payouts (by due_date,
 *             expanded across the horizon for monthly/quarterly frequency).
 *
 * Context figures that have NO reliable due date are reported separately (never fake-bucketed):
 * overdue receivables, undated vendor commitment balances, and the farmer/land-owner outstanding
 * liability. See migrations 010 (installments), 018 (vendor commitments), 046 (farmers), 070 (investors).
 */

// ── Pure, testable month/frequency helpers ───────────────────────────────────
const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const keyToIdx = (key) => { const [y, m] = String(key).split('-').map(Number); return y * 12 + (m - 1); };
export const idxToKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
const round2 = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * Horizon of `n` months. `start` may be a 'YYYY-MM' key (pass the DB clock so buckets align — the
 * SQL uses date_trunc('month', CURRENT_DATE) and a JS clock can be in a different month at boundaries),
 * a Date, or omitted (falls back to the app clock). [{ key:'YYYY-MM', label:'Jul 26' }].
 */
export function buildHorizon(n, start) {
  let startIdx;
  if (typeof start === 'string') startIdx = keyToIdx(start);
  else { const d = start instanceof Date ? start : new Date(); startIdx = d.getFullYear() * 12 + d.getMonth(); }
  const out = [];
  for (let i = 0; i < n; i++) {
    const idx = startIdx + i;
    out.push({ key: idxToKey(idx), label: `${MONTHS_ABBR[idx % 12]} ${String(Math.floor(idx / 12) % 100).padStart(2, '0')}` });
  }
  return out;
}

/**
 * Expand one investor payout into per-month contributions across the horizon.
 * - once: on its due month; if overdue (due before the horizon) it folds into the first month.
 * - monthly/quarterly: recurs from due_date; if it started in the past, it aligns to the due month
 *   (quarterly hits months where (idx - dueIdx) % 3 === 0). Returns { 'YYYY-MM': amount }.
 */
export function expandPayout(payout, horizonKeys) {
  const out = {};
  const amt = Number(payout.amount) || 0;
  if (!amt || !payout.due_month || !horizonKeys.length) return out;
  const dueIdx = keyToIdx(payout.due_month);
  const firstIdx = keyToIdx(horizonKeys[0]);
  const lastIdx = keyToIdx(horizonKeys[horizonKeys.length - 1]);
  const bump = (idx) => { const k = idxToKey(idx); out[k] = round2((out[k] || 0) + amt); };

  if (payout.frequency === 'once') {
    const idx = dueIdx < firstIdx ? firstIdx : dueIdx; // overdue → current month
    if (idx >= firstIdx && idx <= lastIdx) bump(idx);
  } else {
    const step = payout.frequency === 'quarterly' ? 3 : 1;
    // A past-due occurrence that doesn't land on the cadence still folds into the first month
    // (mirrors the 'once' overdue behavior — a still-owed liability must surface near-term).
    if (dueIdx < firstIdx && (firstIdx - dueIdx) % step !== 0) bump(firstIdx);
    for (let idx = firstIdx; idx <= lastIdx; idx++) {
      const diff = idx - dueIdx;
      if (diff >= 0 && diff % step === 0) bump(idx);
    }
  }
  return out;
}

// ── SQL ──────────────────────────────────────────────────────────────────────
// Pending installment inflow (waterfall), bucketed by month; overdue collapsed to one 'OVERDUE' row.
const INFLOW_SQL = `
  WITH direct AS (        -- earmarked installment payments (plot_installment_payments) claim their own installment first
    SELECT pip.installment_id, SUM(pip.amount) AS direct_paid
    FROM plot_installment_payments pip
    JOIN plots p ON p.id = pip.plot_id
    WHERE p.site_id = $1 AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
    GROUP BY pip.installment_id
  ),
  generic AS (            -- non-earmarked money waterfalls across the residual need, earliest-first:
                          -- all plot_payments + any installment payment NOT tied to a specific installment.
    SELECT plot_id, SUM(amount) AS generic_pool FROM (
      SELECT pp.plot_id, pp.amount FROM plot_payments pp
        JOIN plots p ON p.id = pp.plot_id
        WHERE p.site_id = $1 AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
      UNION ALL
      SELECT pip.plot_id, pip.amount FROM plot_installment_payments pip
        JOIN plots p ON p.id = pip.plot_id
        WHERE p.site_id = $1 AND pip.installment_id IS NULL
          AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
    ) g GROUP BY plot_id
  ),
  sched AS (
    SELECT pi.plot_id, pi.due_date,
           GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0)) AS need,
           SUM(GREATEST(0, pi.amount - COALESCE(d.direct_paid, 0))) OVER (
             PARTITION BY pi.plot_id ORDER BY pi.sort_order, pi.due_date, pi.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_need
    FROM plot_installments pi
    JOIN plots p ON p.id = pi.plot_id
    LEFT JOIN direct d ON d.installment_id = pi.id
    WHERE p.site_id = $1 AND p.status NOT IN ('CANCELLED','AVAILABLE','RESALE','TRANSFERRED')
  ),
  pending AS (
    SELECT s.due_date, GREATEST(0, LEAST(s.need, s.cum_need - COALESCE(g.generic_pool, 0))) AS remaining
    FROM sched s LEFT JOIN generic g ON g.plot_id = s.plot_id
  )
  -- OVERDUE mirrors the app tracker (due < today), so the forecast's overdue figure reconciles with it.
  SELECT CASE WHEN due_date < CURRENT_DATE THEN 'OVERDUE'
              ELSE to_char(date_trunc('month', due_date), 'YYYY-MM') END AS bucket,
         SUM(remaining)::float8 AS amount
  FROM pending
  WHERE remaining > 0
    AND due_date < date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
  GROUP BY 1`;

// Scheduled vendor commitment payables (remaining balance) by due month.
const VENDOR_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT to_char(date_trunc('month', vc.due_date), 'YYYY-MM') AS month,
         SUM(vc.contract_amount - COALESCE(p.paid_amount, 0))::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NOT NULL
    AND vc.due_date >= date_trunc('month', CURRENT_DATE)
    AND vc.due_date <  date_trunc('month', CURRENT_DATE) + make_interval(months => $2::int)
    AND (vc.contract_amount - COALESCE(p.paid_amount, 0)) > 0
  GROUP BY 1`;

// Undated (no due_date) open vendor commitment balances — reported as context, not month-bucketed.
const VENDOR_UNSCHEDULED_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open' AND vc.due_date IS NULL`;

// Overdue (past due_date) open vendor commitment balances — reported as context so the payable
// never silently vanishes (it falls between the future-window and the null-due-date query).
const VENDOR_OVERDUE_SQL = `
  WITH paid AS (
    SELECT commitment_id, SUM(amount) AS paid_amount FROM vendor_payments
     WHERE site_id = $1 AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     GROUP BY commitment_id
  )
  SELECT COALESCE(SUM(GREATEST(0, vc.contract_amount - COALESCE(p.paid_amount, 0))), 0)::float8 AS amount
  FROM vendor_commitments vc LEFT JOIN paid p ON p.commitment_id = vc.id
  WHERE vc.site_id = $1 AND vc.status = 'open'
    AND vc.due_date IS NOT NULL AND vc.due_date < date_trunc('month', CURRENT_DATE)`;

// Farmer/land-owner outstanding liability (undated — no schedule exists).
const FARMER_SQL = `
  SELECT COALESCE(SUM(GREATEST(0, f.total_amount - COALESCE(pd.paid, 0))), 0)::float8 AS amount
  FROM farmers f
  LEFT JOIN (
    SELECT farmer_id, SUM(amount) AS paid FROM farmer_payments
     WHERE (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED')) AND status <> 'rejected'
     GROUP BY farmer_id
  ) pd ON pd.farmer_id = f.id
  WHERE f.site_id = $1 AND f.status = 'active'`;

const INVESTOR_SCHED_SQL = `
  SELECT amount::float8 AS amount, to_char(due_date, 'YYYY-MM') AS due_month, frequency
  FROM investor_payouts WHERE site_id = $1 AND status = 'scheduled'`;

/** GET /forecast?site_id=&months=6 */
export const getCashflowForecast = asyncHandler(async (req, res) => {
  const siteId = parseInt(req.query.site_id, 10);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const months = Math.min(Math.max(parseInt(req.query.months, 10) || 6, 1), 12);

  const [clockRes, inflowRes, vendorRes, vendorUnschedRes, vendorOverdueRes, farmerRes, investorRes] = await Promise.all([
    pool.query(`SELECT to_char(date_trunc('month', CURRENT_DATE), 'YYYY-MM') AS m`),
    pool.query(INFLOW_SQL, [siteId, months]),
    pool.query(VENDOR_SQL, [siteId, months]),
    pool.query(VENDOR_UNSCHEDULED_SQL, [siteId]),
    pool.query(VENDOR_OVERDUE_SQL, [siteId]),
    pool.query(FARMER_SQL, [siteId]),
    pool.query(INVESTOR_SCHED_SQL, [siteId]),
  ]);

  // Anchor the horizon to the DB clock so its month keys match the SQL date_trunc buckets exactly.
  const horizon = buildHorizon(months, clockRes.rows[0].m);
  const horizonKeys = horizon.map((h) => h.key);

  const inflowByMonth = {};
  let overdueReceivables = 0;
  for (const r of inflowRes.rows) {
    if (r.bucket === 'OVERDUE') overdueReceivables = r.amount;
    else inflowByMonth[r.bucket] = r.amount;
  }

  const vendorByMonth = Object.fromEntries(vendorRes.rows.map((r) => [r.month, r.amount]));

  const investorByMonth = {};
  for (const p of investorRes.rows) {
    const contrib = expandPayout(p, horizonKeys);
    for (const [k, v] of Object.entries(contrib)) investorByMonth[k] = (investorByMonth[k] || 0) + v;
  }

  const monthsOut = horizon.map((h) => {
    const inflow = round2(inflowByMonth[h.key] || 0);
    const outflowVendors = round2(vendorByMonth[h.key] || 0);
    const outflowInvestors = round2(investorByMonth[h.key] || 0);
    const outflow = round2(outflowVendors + outflowInvestors);
    return { key: h.key, label: h.label, inflow, outflowVendors, outflowInvestors, outflow, net: round2(inflow - outflow) };
  });

  const totals = monthsOut.reduce(
    (a, m) => ({ inflow: a.inflow + m.inflow, outflow: a.outflow + m.outflow }),
    { inflow: 0, outflow: 0 }
  );

  res.json({
    months: monthsOut,
    context: {
      overdueReceivables: round2(overdueReceivables),
      vendorOverdue: round2(vendorOverdueRes.rows[0]?.amount || 0),
      vendorUnscheduled: round2(vendorUnschedRes.rows[0]?.amount || 0),
      farmerOutstanding: round2(farmerRes.rows[0]?.amount || 0),
    },
    totals: { inflow: round2(totals.inflow), outflow: round2(totals.outflow), net: round2(totals.inflow - totals.outflow) },
    horizonMonths: months,
    generatedAt: new Date().toISOString(),
  });
});

// ── Investor payout CRUD (feeds the outflow side of the forecast) ─────────────
const FREQ = new Set(['once', 'monthly', 'quarterly']);
const PTYPE = new Set(['interest', 'profit_share', 'principal', 'other']);

/** GET /forecast/investor-payouts?site_id= */
export const listInvestorPayouts = asyncHandler(async (req, res) => {
  const siteId = parseInt(req.query.site_id, 10);
  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  const { rows } = await pool.query(
    `SELECT ip.id, ip.investor_name, ip.member_id, ip.note, ip.amount::float8 AS amount,
            to_char(ip.due_date, 'YYYY-MM-DD') AS due_date, ip.frequency, ip.payout_type, ip.status, ip.created_at,
            COALESCE(m.full_name, ip.investor_name) AS display_name
       FROM investor_payouts ip
       LEFT JOIN members m ON m.id = ip.member_id
      WHERE ip.site_id = $1
      ORDER BY ip.status = 'scheduled' DESC, ip.due_date ASC`,
    [siteId]
  );
  res.json({ payouts: rows });
});

/** POST /forecast/investor-payouts */
export const createInvestorPayout = asyncHandler(async (req, res) => {
  const siteId = parseInt(req.body.site_id, 10);
  const amount = Number(req.body.amount);
  const dueDate = req.body.due_date;
  const frequency = String(req.body.frequency || 'once');
  const payoutType = String(req.body.payout_type || 'interest');

  if (!siteId) return res.status(400).json({ message: 'site_id is required' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ message: 'A valid amount is required' });
  if (!dueDate || Number.isNaN(Date.parse(dueDate))) return res.status(400).json({ message: 'A valid due_date is required' });
  if (!FREQ.has(frequency)) return res.status(400).json({ message: 'frequency must be once, monthly or quarterly' });
  if (!PTYPE.has(payoutType)) return res.status(400).json({ message: 'invalid payout_type' });
  const investorName = (req.body.investor_name || '').trim();
  const memberId = req.body.member_id ? parseInt(req.body.member_id, 10) : null;
  if (!investorName && !memberId) return res.status(400).json({ message: 'investor_name or member_id is required' });

  const { rows } = await pool.query(
    `INSERT INTO investor_payouts (site_id, member_id, investor_name, note, amount, due_date, frequency, payout_type, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     RETURNING id, investor_name, member_id, note, amount::float8 AS amount,
               to_char(due_date, 'YYYY-MM-DD') AS due_date, frequency, payout_type, status, created_at`,
    [siteId, memberId, investorName || null, req.body.note || null, amount, dueDate, frequency, payoutType, req.user?.id || null]
  );
  res.status(201).json(rows[0]);
});

/** PATCH /forecast/investor-payouts/:id */
export const updateInvestorPayout = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const params = [];
  const add = (v) => { params.push(v); return `$${params.length}`; };
  const sets = [];

  if (req.body.investor_name !== undefined) sets.push(`investor_name = ${add(String(req.body.investor_name).trim() || null)}`);
  if (req.body.member_id !== undefined) sets.push(`member_id = ${add(req.body.member_id ? parseInt(req.body.member_id, 10) : null)}`);
  if (req.body.note !== undefined) sets.push(`note = ${add(req.body.note || null)}`);
  if (req.body.amount !== undefined) {
    if (!Number.isFinite(Number(req.body.amount)) || Number(req.body.amount) <= 0) return res.status(400).json({ message: 'invalid amount' });
    sets.push(`amount = ${add(Number(req.body.amount))}`);
  }
  if (req.body.due_date !== undefined) {
    if (!req.body.due_date || Number.isNaN(Date.parse(req.body.due_date))) return res.status(400).json({ message: 'invalid due_date' });
    sets.push(`due_date = ${add(req.body.due_date)}::date`);
  }
  if (req.body.frequency !== undefined) {
    if (!FREQ.has(String(req.body.frequency))) return res.status(400).json({ message: 'invalid frequency' });
    sets.push(`frequency = ${add(req.body.frequency)}`);
  }
  if (req.body.payout_type !== undefined) {
    if (!PTYPE.has(String(req.body.payout_type))) return res.status(400).json({ message: 'invalid payout_type' });
    sets.push(`payout_type = ${add(req.body.payout_type)}`);
  }
  if (req.body.status !== undefined) {
    if (!['scheduled', 'paid', 'cancelled'].includes(String(req.body.status))) return res.status(400).json({ message: 'invalid status' });
    sets.push(`status = ${add(req.body.status)}`);
    sets.push(`paid_at = ${req.body.status === 'paid' ? 'now()' : 'NULL'}`);
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' });
  sets.push('updated_at = now()');

  const { rows } = await pool.query(
    `UPDATE investor_payouts SET ${sets.join(', ')} WHERE id = ${add(id)}
     RETURNING id, investor_name, member_id, note, amount::float8 AS amount,
               to_char(due_date, 'YYYY-MM-DD') AS due_date, frequency, payout_type, status`,
    params
  );
  if (!rows[0]) return res.status(404).json({ message: 'Payout not found' });
  res.json(rows[0]);
});

/** DELETE /forecast/investor-payouts/:id */
export const deleteInvestorPayout = asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM investor_payouts WHERE id = $1', [req.params.id]);
  if (!rowCount) return res.status(404).json({ message: 'Payout not found' });
  res.json({ message: 'Payout deleted', id: Number(req.params.id) });
});
