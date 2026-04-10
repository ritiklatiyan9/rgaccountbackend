/**
 * KPI Service — Direct SQL aggregation against source tables.
 * All computations happen in PostgreSQL, never in JS.
 *
 * Revenue  = plot_payments + plot_installment_payments
 * Expense  = farmer_payments + expenses + plot_commissions + plot_commission_payments
 *            + vendor_payments + plot_registry_payments + day_book EXPENSE entries (orphan)
 * Cashflow = site-type cash_flow_entries (credit − debit)
 * Outstanding = person-ledger pending (given − returned)
 */
import pool from '../../config/db.js';

// ── Date range WHERE fragments ──
const dateFilter = (col, paramStart) =>
  `AND ${col} >= $${paramStart} AND ${col} < $${paramStart + 1}`;

// ── Revenue: plot_payments + plot_installment_payments ──
export async function getRevenue(siteId, start, end, excludeOldPlots = false) {
  const oldFilter = excludeOldPlots ? `AND (plt.plot_tag IS NULL OR plt.plot_tag != 'OLD')` : '';
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM (
       SELECT pp.amount FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE pp.site_id = $1 ${dateFilter('pp.date', 2)}
         AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
         ${oldFilter}
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 ${dateFilter('pip.payment_date', 2)}
         AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
         ${oldFilter.replace(/plt\./g, 'p.')}
     ) u`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total) || 0;
}

// ── Expense breakdown by module ──
export async function getExpenseBreakdown(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT source_type,
            COALESCE(SUM(debit), 0)::numeric AS total_debit,
            COUNT(*)::int AS txn_count
     FROM (
       SELECT fp.amount AS debit, 'farmer_payments' AS source_type
       FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 ${dateFilter('fp.date', 2)}
         AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT debit, 'expenses' AS source_type
       FROM expenses
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'plot_registry_payments' AS source_type
       FROM plot_registry_payments
       WHERE site_id = $1 ${dateFilter('payment_date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         AND source_plot_payment_id IS NULL
       UNION ALL
       SELECT amount AS debit, 'commissions' AS source_type
       FROM plot_commissions
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'commission_payments' AS source_type
       FROM plot_commission_payments
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT amount AS debit, 'vendor_payments' AS source_type
       FROM vendor_payments
       WHERE site_id = $1 ${dateFilter('payment_date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT debit, 'daybook_expense' AS source_type
       FROM day_book
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     ) u
     GROUP BY source_type`,
    [siteId, start, end]
  );

  const breakdown = {};
  let total = 0;
  for (const r of rows) {
    const val = parseFloat(r.total_debit) || 0;
    breakdown[r.source_type] = { debit: val, count: parseInt(r.txn_count) || 0 };
    total += val;
  }
  return { total, breakdown };
}

// ── Site Cashflow: credit − debit from site-type ledgers ──
export async function getSiteCashflow(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.credit), 0)::numeric AS total_credit,
       COALESCE(SUM(cfe.debit),  0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
       AND LOWER(cfm.ledger_type) = 'site'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`,
    [siteId, start, end]
  );
  const credit = parseFloat(rows[0].total_credit) || 0;
  const debit = parseFloat(rows[0].total_debit) || 0;
  return { incoming: credit, outgoing: debit, net: credit - debit };
}

// ── Person Ledger Outstanding ──
export async function getOutstanding(siteId) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.debit),  0)::numeric AS given,
       COALESCE(SUM(cfe.credit), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`,
    [siteId]
  );
  const given = parseFloat(rows[0].given) || 0;
  const returned = parseFloat(rows[0].returned) || 0;
  return { given, returned, pending: given - returned };
}

// ── Combined KPI fetch (single round-trip where possible) ──
export async function getAllKpis(siteId, start, end, excludeOldPlots = false) {
  const [revenue, expData, cashflow, outstanding] = await Promise.all([
    getRevenue(siteId, start, end, excludeOldPlots),
    getExpenseBreakdown(siteId, start, end),
    getSiteCashflow(siteId, start, end),
    getOutstanding(siteId),
  ]);

  const netProfit = revenue - expData.total;
  const profitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  return {
    totalRevenue: revenue,
    totalExpense: expData.total,
    netProfit,
    profitMargin: Math.round(profitMargin * 100) / 100,
    outstanding: outstanding.pending,
    cashflow: cashflow.net,
    breakdown: {
      ...expData.breakdown,
      plot_payments: { credit: revenue, debit: 0, count: 0 },
    },
    cashflowDetail: cashflow,
    outstandingDetail: outstanding,
  };
}
