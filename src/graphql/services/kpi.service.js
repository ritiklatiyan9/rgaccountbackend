/**
 * KPI Service — Direct SQL aggregation against source tables.
 * All computations happen in PostgreSQL, never in JS.
 *
 * Total Incoming = plot_payments + plot_installment_payments
 * Total Expenses = farmer_payments + expenses + plot_commission_payments
 *                  + vendor_payments + personal_ledger_debit + orphan day_book EXPENSE
 * Plot Registry  = mapping of plot_payments only, NOT counted as new incoming/outgoing
 * Cashflow       = site-type cash_flow_entries (credit − debit)
 * Outstanding    = person-ledger pending (given − returned)
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
// Total Expenses = farmer_payments + expenses + commissions + commission_payments
//                  + vendor_payments + personal_ledger_debit + orphan daybook EXPENSE
// NOTE: plot_registry_payments are EXCLUDED — they are just mapped plot payments
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
         AND fp.status != 'rejected'
       UNION ALL
       SELECT debit, 'expenses' AS source_type
       FROM expenses
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         AND status != 'rejected'
       UNION ALL
       SELECT amount AS debit, 'commission_payments' AS source_type
       FROM plot_commission_payments
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         AND status != 'rejected'
       UNION ALL
       SELECT amount AS debit, 'vendor_payments' AS source_type
       FROM vendor_payments
       WHERE site_id = $1 ${dateFilter('payment_date', 2)}
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         AND status != 'rejected'
       UNION ALL
       SELECT cfe.debit, 'personal_ledger_debit' AS source_type
       FROM cash_flow_entries cfe
       JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
       WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
         AND LOWER(cfm.ledger_type) = 'person'
         AND cfe.debit > 0
         AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT debit, 'daybook_expense' AS source_type
       FROM day_book
       WHERE site_id = $1 ${dateFilter('date', 2)}
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         AND status != 'rejected'
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
export async function getOutstanding(siteId, start, end) {
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

// ── Personal Ledger Credit (date-filtered) — money received from persons ──
export async function getPersonalLedgerCredit(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(cfe.credit), 0)::numeric AS total_credit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
       AND LOWER(cfm.ledger_type) = 'person'
       AND cfe.credit > 0
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total_credit) || 0;
}

// ── Registry Payments: money received via Plot Registry (registry-only ledger) ──
// Lives in plot_registry_payments and is intentionally independent from plot_payments /
// installment payments. Excluded from revenue/expense totals — purely a registry-side KPI.
export async function getRegistryPayments(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0)::numeric AS total,
       COUNT(*)::int                     AS txn_count
     FROM plot_registry_payments
     WHERE site_id = $1 ${dateFilter('payment_date', 2)}
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))`,
    [siteId, start, end]
  );
  return {
    total: parseFloat(rows[0].total) || 0,
    count: parseInt(rows[0].txn_count, 10) || 0,
  };
}

// ── Imprest: total money given (allocated) for a site ──
export async function getImprestGiven(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM imprest_allocations
     WHERE site_id = $1 ${dateFilter('created_at', 2)}
       AND status != 'CANCELLED'`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total) || 0;
}

// ── Imprest giver→receiver pair totals ──
// One row per (giverId, receiverId) showing the final net transferred amount in the window.
// Counts every non-CANCELLED allocation regardless of receipt confirmation status so the
// Site Balance KPI can surface in-flight peer transfers too.
export async function getImprestPairs(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       ia.admin_id                                                            AS giver_id,
       COALESCE(NULLIF(TRIM(gv.name), ''), gv.email, CONCAT('USER #', ia.admin_id::text))     AS giver_name,
       gv.role                                                                AS giver_role,
       ia.sub_admin_id                                                        AS receiver_id,
       COALESCE(NULLIF(TRIM(rc.name), ''), rc.email, CONCAT('USER #', ia.sub_admin_id::text)) AS receiver_name,
       rc.role                                                                AS receiver_role,
       COALESCE(SUM(ia.amount), 0)::numeric                                   AS total_amount,
       COUNT(*)::int                                                          AS allocation_count
     FROM imprest_allocations ia
     LEFT JOIN users gv ON gv.id = ia.admin_id
     LEFT JOIN users rc ON rc.id = ia.sub_admin_id
     WHERE ia.site_id = $1 ${dateFilter('ia.created_at', 2)}
       AND ia.status != 'CANCELLED'
     GROUP BY ia.admin_id, gv.name, gv.email, gv.role, ia.sub_admin_id, rc.name, rc.email, rc.role
     HAVING COALESCE(SUM(ia.amount), 0) > 0
     ORDER BY total_amount DESC, giver_name ASC`,
    [siteId, start, end]
  );

  return rows.map((r) => ({
    giverId: parseInt(r.giver_id, 10),
    giverName: r.giver_name,
    giverRole: r.giver_role || 'user',
    receiverId: parseInt(r.receiver_id, 10),
    receiverName: r.receiver_name,
    receiverRole: r.receiver_role || 'user',
    totalAmount: parseFloat(r.total_amount) || 0,
    allocationCount: parseInt(r.allocation_count, 10) || 0,
  }));
}

// ── Imprest distribution: who received how much ──
export async function getImprestDistribution(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       ia.sub_admin_id,
       COALESCE(NULLIF(TRIM(sa.name), ''), sa.email, CONCAT('USER #', ia.sub_admin_id::text)) AS recipient_name,
       COALESCE(SUM(ia.amount), 0)::numeric AS total_amount,
       COUNT(*)::int AS allocation_count
     FROM imprest_allocations ia
     LEFT JOIN users sa ON sa.id = ia.sub_admin_id
     WHERE ia.site_id = $1 ${dateFilter('ia.created_at', 2)}
       AND ia.status != 'CANCELLED'
     GROUP BY ia.sub_admin_id, recipient_name
     ORDER BY total_amount DESC, recipient_name ASC`,
    [siteId, start, end]
  );

  return rows.map((r) => ({
    subAdminId: parseInt(r.sub_admin_id, 10),
    recipientName: r.recipient_name,
    totalAmount: parseFloat(r.total_amount) || 0,
    allocationCount: parseInt(r.allocation_count, 10) || 0,
  }));
}

// ── Combined KPI fetch (single round-trip where possible) ──
export async function getAllKpis(siteId, start, end, excludeOldPlots = false) {
  const [revenue, expData, cashflow, outstanding, personalLedgerCredit, imprestGiven, imprestDistribution, registryPayments, imprestPairs] = await Promise.all([
    getRevenue(siteId, start, end, excludeOldPlots),
    getExpenseBreakdown(siteId, start, end),
    getSiteCashflow(siteId, start, end),
    getOutstanding(siteId, start, end),
    getPersonalLedgerCredit(siteId, start, end),
    getImprestGiven(siteId, start, end),
    getImprestDistribution(siteId, start, end),
    getRegistryPayments(siteId, start, end),
    getImprestPairs(siteId, start, end),
  ]);

  // Total Incoming = Plot Payments only
  // Total Expenses = farmer + expenses + commissions + vendors + personal_ledger_debit + orphan daybook
  // Profit = Total Incoming - Total Expenses
  const netProfit = revenue - expData.total;
  const profitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  return {
    totalRevenue: revenue,
    totalExpense: expData.total,
    netProfit,
    profitMargin: Math.round(profitMargin * 100) / 100,
    outstanding: outstanding.pending,
    cashflow: cashflow.net,
    personalLedgerCredit,
    imprestGiven,
    imprestDistribution,
    imprestPairs,
    registryPayments: registryPayments.total,
    registryPaymentsCount: registryPayments.count,
    breakdown: {
      ...expData.breakdown,
      plot_payments: { credit: revenue, debit: 0, count: 0 },
    },
    cashflowDetail: cashflow,
    outstandingDetail: outstanding,
  };
}
