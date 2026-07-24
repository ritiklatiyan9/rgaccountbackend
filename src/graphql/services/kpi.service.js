/**
 * KPI Service — Direct SQL aggregation against source tables.
 * All computations happen in PostgreSQL, never in JS.
 *
 * Total Incoming = plot_payments + plot_installment_payments
 * Total Expenses = farmer_payments + expenses + plot_commission_payments
 *                  + vendor_payments
 * Plot Registry  = mapping of plot_payments only, NOT counted as new incoming/outgoing
 * Cashflow       = site-type cash_flow_entries (credit − debit)
 * Outstanding    = person-ledger pending (given − returned)
 *
 * Person-ledger debit (cfe.debit on person ledger) is intentionally NOT in
 * Total Expenses — it is already captured in Outstanding, which is subtracted
 * from revenue via adjustedIncoming = revenue − outstanding. Double-counting
 * it as an expense was a bug that made Site Balance too negative and Day Book
 * breakdowns show 2× the real loan amount.
 */
import pool from '../../config/db.js';

// ── Date range WHERE fragments ──
const dateFilter = (col, paramStart) =>
  `AND ${col} >= $${paramStart} AND ${col} < $${paramStart + 1}`;

// ── Revenue: money in, from the shared ledger ──
// `ledger_entries` (migration 079) is the same view the Day Book and the
// Balance Sheet read, so these KPIs can no longer drift from those pages.
// It already applies approved-only, bounced-cheque, sane-date and registry
// de-duplication policy — this used to be a third private copy of all of it.
export async function getRevenue(siteId, start, end, excludeOldPlots = false) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(credit), 0)::numeric AS total
       FROM ledger_entries
      WHERE site_id = $1 AND entry_date >= $2 AND entry_date < $3
        AND source_key IN ('plot_payments', 'plot_installment_payments')
        AND ($4::bool = false OR plot_tag <> 'OLD')`,
    [siteId, start, end, excludeOldPlots]
  );
  return parseFloat(rows[0].total) || 0;
}

// ── Expense breakdown by module ──
// Every debit in the ledger except the person-ledger legs, which are already
// reflected via `outstanding = given − returned` feeding
// adjustedIncoming = revenue − outstanding. Counting them here too would
// double-deduct loans given, which was a long-standing bug.
// `day_book` is excluded too: manual Day Book entries for a plot commission
// (or any other module payment) are re-entries of a transaction already
// counted under that module's own source_key — e.g. OM Associates had 3
// "…COMMISSION" Day Book rows for plots already fully paid off in
// plot_commission_payments, double-counting ₹4,53,570 as expense.
// `debit <> 0`, NOT `debit > 0`: a reversed/refunded payment is entered as a
// negative-amount row in its module, and dropping those made the card show
// what was *committed* instead of what was actually paid out — ₹5.99 cr too
// high on OM Associates farmer payments alone. Site Balance and the
// Revenue-vs-Expense chart already net them, so the card was the odd one out.
export async function getExpenseBreakdown(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT source_key AS source_type,
            COALESCE(SUM(debit), 0)::numeric AS total_debit,
            COUNT(*)::int AS txn_count
       FROM ledger_entries
      WHERE site_id = $1 AND entry_date >= $2 AND entry_date < $3
        AND debit <> 0
        AND source_key NOT IN ('personal_ledger', 'plot_payments', 'plot_installment_payments', 'day_book')
        AND ledger_type <> 'person'
      GROUP BY source_key`,
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

// ── Site Balance: the one number every page must agree on ──
// Net of the ledger minus the imprest float (cash sitting with sub-admins).
// Identical to daybook's siteBalanceAsOf and the Balance Sheet's
// balance_in_hand — computed here so the dashboard stops re-deriving it from
// revenue/expense/outstanding components that each rounded differently.
export async function getSiteBalance(siteId, end) {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COALESCE(SUM(credit - debit), 0)::numeric
          FROM ledger_entries
         WHERE site_id = $1 AND entry_date < $2::date)
       -
       (SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric
          FROM (
            SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
            FROM imprest_ledger
            WHERE site_id IS NOT NULL AND site_id = $1 AND created_at < $2
            GROUP BY user_id
          ) u)
       AS balance`,
    [siteId, end]
  );
  return parseFloat(rows[0].balance) || 0;
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
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
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
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
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
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total_credit) || 0;
}

// ── Registry Payments: ALL money received for plots whose status = REGISTRY ──
// Exactly mirrors the /plot-payments page footer (with the filter set to
// REGISTRY). To guarantee the two numbers agree we deliberately:
//   • drop the dashboard date range — the page has no date filter, so if we
//     applied one the dashboard would silently miss any row with an
//     out-of-range / sentinel date.
//   • match OLD-tag detection case-insensitively — plot_tag data can be
//     'OLD' / 'old' / 'Old' in the wild; both views now bucket them the same.
//   • trim + uppercase the status check to catch 'Registry ' / 'registry' /
//     ' REGISTRY' etc.
//
// Returns a breakdown:
//   total      = OLD + NEW total
//   newTotal   = UPPER(TRIM(plot_tag)) != 'OLD' (or NULL)
//   oldTotal   = UPPER(TRIM(plot_tag)) == 'OLD'
//   count      = total payment rows
// Sums plot_payments + plot_installment_payments across every payment mode
// (cash / bank / cheque / UPI / other). Scoped via plt.site_id (same join
// the Plot Payments page uses). Bounced / returned cheques are excluded.
export async function getRegistryPayments(siteId, _start, _end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(amount), 0)::numeric                                         AS total,
       COALESCE(SUM(amount) FILTER (WHERE is_old), 0)::numeric                   AS old_total,
       COALESCE(SUM(amount) FILTER (WHERE NOT is_old), 0)::numeric               AS new_total,
       COUNT(*)::int                                                             AS txn_count,
       COUNT(*) FILTER (WHERE is_old)::int                                       AS old_count,
       COUNT(*) FILTER (WHERE NOT is_old)::int                                   AS new_count
     FROM (
       SELECT pp.amount AS amount,
              (UPPER(TRIM(COALESCE(plt.plot_tag, ''))) = 'OLD') AS is_old
       FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE plt.site_id = $1
         AND UPPER(TRIM(COALESCE(plt.status, ''))) = 'REGISTRY'
         AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))

       UNION ALL

       SELECT pip.amount AS amount,
              (UPPER(TRIM(COALESCE(plt.plot_tag, ''))) = 'OLD') AS is_old
       FROM plot_installment_payments pip
       JOIN plots plt ON plt.id = pip.plot_id
       WHERE plt.site_id = $1
         AND UPPER(TRIM(COALESCE(plt.status, ''))) = 'REGISTRY'
         AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
     ) u`,
    [siteId]
  );
  const r = rows[0];
  return {
    total:    parseFloat(r.total)     || 0,
    newTotal: parseFloat(r.new_total) || 0,
    oldTotal: parseFloat(r.old_total) || 0,
    count:    parseInt(r.txn_count, 10) || 0,
    newCount: parseInt(r.new_count, 10) || 0,
    oldCount: parseInt(r.old_count, 10) || 0,
  };
}

// ── Imprest: net outstanding (cash still held by sub-admins as imprest) ──
// Sourced from imprest_ledger, which records every allocation (+), expense (−)
// and refund (−). Summing per user and taking only positive balances yields
// "money currently sitting with sub-admins" — the only portion that should
// reduce Site Balance. Expenses spent from imprest are already in totalExpense,
// and accepted returns cancel out allocations, so both drop out automatically.
// Window is cumulative up to `end` (not `start..end`) because we want the
// standing balance at period end, not in-period flow.
export async function getImprestGiven(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS total
     FROM (
       SELECT user_id, COALESCE(SUM(amount), 0) AS user_balance
       FROM imprest_ledger
       WHERE site_id IS NOT NULL AND site_id = $1 AND created_at < $2
       GROUP BY user_id
     ) u`,
    [siteId, end]
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
     WHERE ia.site_id IS NOT NULL AND ia.site_id = $1 ${dateFilter('ia.created_at', 2)}
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

// ── Imprest distribution: net outstanding per recipient ──
// Mirrors getImprestGiven semantics: per sub-admin, the current imprest_ledger
// balance (allocations − expenses − refunds), keeping only positive balances
// so the list sums to the Site Balance card's "Imprest Given" total.
export async function getImprestDistribution(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       il.user_id AS sub_admin_id,
       COALESCE(NULLIF(TRIM(sa.name), ''), sa.email, CONCAT('USER #', il.user_id::text)) AS recipient_name,
       SUM(il.amount)::numeric AS balance,
       COUNT(*) FILTER (WHERE il.type = 'ALLOCATION')::int AS allocation_count
     FROM imprest_ledger il
     LEFT JOIN users sa ON sa.id = il.user_id
     WHERE il.site_id IS NOT NULL AND il.site_id = $1 AND il.created_at < $2
     GROUP BY il.user_id, recipient_name
     HAVING SUM(il.amount) > 0
     ORDER BY balance DESC, recipient_name ASC`,
    [siteId, end]
  );

  return rows.map((r) => ({
    subAdminId: parseInt(r.sub_admin_id, 10),
    recipientName: r.recipient_name,
    totalAmount: parseFloat(r.balance) || 0,
    allocationCount: parseInt(r.allocation_count, 10) || 0,
  }));
}

// ── Combined KPI fetch (single round-trip where possible) ──
export async function getAllKpis(siteId, start, end, excludeOldPlots = false) {
  const [revenue, expData, cashflow, outstanding, personalLedgerCredit, imprestGiven, imprestDistribution, registryPayments, imprestPairs, siteBalance] = await Promise.all([
    getRevenue(siteId, start, end, excludeOldPlots),
    getExpenseBreakdown(siteId, start, end),
    getSiteCashflow(siteId, start, end),
    getOutstanding(siteId, start, end),
    getPersonalLedgerCredit(siteId, start, end),
    getImprestGiven(siteId, start, end),
    getImprestDistribution(siteId, start, end),
    getRegistryPayments(siteId, start, end),
    getImprestPairs(siteId, start, end),
    getSiteBalance(siteId, end),
  ]);

  // Total Incoming = Plot Payments only
  // Total Expenses = farmer + expenses + commissions + vendors
  // Profit = Total Incoming - Total Expenses
  const netProfit = revenue - expData.total;
  const profitMargin = revenue > 0 ? (netProfit / revenue) * 100 : 0;

  return {
    siteBalance,
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
    registryPaymentsNew: registryPayments.newTotal,
    registryPaymentsOld: registryPayments.oldTotal,
    registryPaymentsNewCount: registryPayments.newCount,
    registryPaymentsOldCount: registryPayments.oldCount,
    breakdown: {
      ...expData.breakdown,
      plot_payments: { credit: revenue, debit: 0, count: 0 },
    },
    cashflowDetail: cashflow,
    outstandingDetail: outstanding,
  };
}
