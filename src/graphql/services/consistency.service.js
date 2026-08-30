/**
 * Consistency Service — Dual-run financial verification.
 *
 * Run A: Aggregate from SOURCE TABLES directly (plot_payments, expenses, etc.)
 * Run B: Aggregate from CASH_FLOW_ENTRIES (sync table maintained by triggers)
 *
 * If Run A ≠ Run B → sync triggers are broken → CRITICAL flag.
 *
 * Tolerance: ₹0.01 (floating-point rounding)
 */
import pool from '../../config/db.js';

const TOLERANCE = 0.01;

/**
 * Run A — Source tables (single source of truth).
 * Mirrors getProfitSummary logic exactly.
 */
async function runFromSourceTables(siteId, start, end) {
  // Revenue: plot receipts + sold-land buyer receipts
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM (
       SELECT pp.amount FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3
         AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
         AND financial_transaction_posts('credit', pip.status, pip.payment_mode, pip.cheque_status)
       UNION ALL
       SELECT ldp.amount FROM land_deal_payments ldp
       JOIN land_deals ld ON ld.id = ldp.land_deal_id
       WHERE ld.site_id = $1 AND ld.status IN ('open', 'completed')
         AND ldp.date >= $2 AND ldp.date < $3
         AND financial_transaction_posts('credit', ldp.status, ldp.payment_mode, ldp.cheque_status)
     ) u`,
    [siteId, start, end]
  );
  const totalRevenue = parseFloat(revResult.rows[0].total) || 0;

  // Expense: mirror getProfitSummary exactly. Person-ledger debit is intentionally
  // EXCLUDED — outstanding already subtracts given-returned, so counting it as
  // expense too would double-deduct.
  const expResult = await pool.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total
     FROM (
       SELECT fp.amount AS debit FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         AND financial_transaction_posts('debit', fp.status, fp.payment_mode, fp.cheque_status)
       UNION ALL
       SELECT debit FROM expenses
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
       UNION ALL
       SELECT amount AS debit FROM plot_commissions
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND financial_transaction_posts('debit', status, by_note, cheque_status)
       UNION ALL
       SELECT amount AS debit FROM plot_commission_payments
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND financial_transaction_posts(
           CASE WHEN amount < 0 THEN 'credit' ELSE 'debit' END,
           status, payment_mode, cheque_status
         )
       UNION ALL
       SELECT amount AS debit FROM vendor_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
       UNION ALL
       SELECT amount AS debit FROM plot_registry_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
         AND source_plot_payment_id IS NULL
       UNION ALL
       SELECT debit FROM day_book
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
     ) u`,
    [siteId, start, end]
  );
  const totalExpense = parseFloat(expResult.rows[0].total) || 0;

  // Outstanding: person ledger
  const outResult = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.debit) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric  AS given,
       COALESCE(SUM(cfe.credit) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND cfe.date >= $2 AND cfe.date < $3
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.source_module IS NULL OR cfe.source_module !~ '_person$')
      `,
    [siteId, start, end]
  );
  const outstanding = (parseFloat(outResult.rows[0].given) || 0) - (parseFloat(outResult.rows[0].returned) || 0);

  const netProfit = totalRevenue - totalExpense;
  return {
    totalRevenue,
    totalExpense,
    netProfit,
    profitMargin: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0,
    outstanding,
    cashflow: 0, // calculated separately if needed
  };
}

/**
 * Run B — Cash flow entries table (trigger-synced mirror).
 * Profit modules only, matching the exact set used in Run A / getProfitSummary.
 */
async function runFromCashFlowEntries(siteId, start, end) {
  // Revenue side: plot payments + installments + sold-land buyer receipts
  const revenueModules = ['plot_payments', 'plot_installment_payments', 'land_deal_payments'];
  // Expense side: every source table that contributes to canonical totalExpense
  // (plot_registry_payments handled separately to filter source_plot_payment_id)
  const expenseModules = [
    'farmer_payments', 'expenses',
    'plot_commissions', 'plot_commission_payments',
    'vendor_payments',
  ];

  const revPlaceholders = revenueModules.map((_, i) => `$${i + 4}`).join(', ');
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(credit), 0)::numeric AS total_credit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${revPlaceholders})
       AND financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)
       AND (
         cfe.source_module <> 'land_deal_payments'
         OR EXISTS (
           SELECT 1 FROM land_deal_payments ldp
           JOIN land_deals ld ON ld.id = ldp.land_deal_id
           WHERE ldp.id = cfe.source_id AND ld.status IN ('open', 'completed')
         )
       )`,
    [siteId, start, end, ...revenueModules]
  );
  const totalRevenue = parseFloat(revResult.rows[0].total_credit) || 0;

  const expPlaceholders = expenseModules.map((_, i) => `$${i + 4}`).join(', ');
  const expResult = await pool.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${expPlaceholders})
       AND financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)`,
    [siteId, start, end, ...expenseModules]
  );
  const totalExpense = parseFloat(expResult.rows[0].total_debit) || 0;

  // Plot registry payments — only those NOT auto-paid via a plot_payment
  // (matches canonical: source_plot_payment_id IS NULL).
  const registryResult = await pool.query(
    `SELECT COALESCE(SUM(cfe.debit), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'plot_registry_payments'
       AND financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)
       AND EXISTS (
         SELECT 1 FROM plot_registry_payments prp
         WHERE prp.id = cfe.source_id AND prp.source_plot_payment_id IS NULL
       )`,
    [siteId, start, end]
  );
  const registryExpense = parseFloat(registryResult.rows[0].total) || 0;

  // Orphan day_book EXPENSE entries synced to cash_flow
  const orphanResult = await pool.query(
    `SELECT COALESCE(SUM(cfe.debit), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'day_book'
       AND financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)
       AND EXISTS (
         SELECT 1 FROM day_book db
         WHERE db.id = cfe.source_id AND db.entry_type = 'EXPENSE'
           AND db.farmer_payment_id IS NULL AND db.commission_id IS NULL AND db.vendor_payment_id IS NULL
       )`,
    [siteId, start, end]
  );
  const orphanExpense = parseFloat(orphanResult.rows[0].total) || 0;

  // NOTE: Person-ledger debit is intentionally NOT added here. It belongs to
  // outstanding (given-returned), not expense — including it would double-deduct
  // and break parity with Run A / getProfitSummary.
  const adjExpense = totalExpense + registryExpense + orphanExpense;
  const netProfit = totalRevenue - adjExpense;

  // Outstanding from person ledger (same source for both runs)
  const outResult = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.debit) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric  AS given,
       COALESCE(SUM(cfe.credit) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND cfe.date >= $2 AND cfe.date < $3
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.source_module IS NULL OR cfe.source_module !~ '_person$')
      `,
    [siteId, start, end]
  );
  const outstanding = (parseFloat(outResult.rows[0].given) || 0) - (parseFloat(outResult.rows[0].returned) || 0);

  return {
    totalRevenue,
    totalExpense: adjExpense,
    netProfit,
    profitMargin: totalRevenue > 0 ? Math.round((netProfit / totalRevenue) * 10000) / 100 : 0,
    outstanding,
    cashflow: 0,
  };
}

/**
 * Compare two KPI objects, return list of discrepancies.
 */
function compareRuns(runA, runB) {
  const kpis = ['totalRevenue', 'totalExpense', 'netProfit', 'profitMargin', 'outstanding'];
  const discrepancies = [];
  for (const kpi of kpis) {
    const a = runA[kpi];
    const b = runB[kpi];
    const diff = Math.abs(a - b);
    if (diff > TOLERANCE) {
      discrepancies.push({
        kpi,
        runAValue: a,
        runBValue: b,
        diff,
        severity: diff > 100 ? 'CRITICAL' : 'WARNING',
      });
    }
  }
  return discrepancies;
}

/**
 * SQL queries used — exposed for transparency panel.
 */
export function getQueryDescriptions() {
  return {
    totalRevenue: {
      runA: 'SUM(amount) FROM posted plot/installment receipts + sold-land buyer receipts: credits count while pending; cheques wait for clearance',
      runB: 'SUM(credit) FROM cash_flow_entries using the same credit-first and cheque-clearance policy',
    },
    totalExpense: {
      runA: 'SUM(amount/debit) from debit modules only after approval; cheque debits also require clearance',
      runB: 'SUM(debit) from matching cash-flow mirrors with the same approval and cheque-clearance policy. Person-ledger debit is excluded here because it is counted in outstanding.',
    },
    netProfit: {
      formula: 'totalRevenue − totalExpense',
    },
    profitMargin: {
      formula: '(netProfit / totalRevenue) × 100',
    },
    outstanding: {
      formula: 'SUM(debit) − SUM(credit) FROM cash_flow_entries WHERE ledger_type = person',
    },
  };
}

/**
 * Main verification function — runs both paths and compares.
 */
export async function verifyFinancialIntegrity(siteId, start, end) {
  const [runA, runB] = await Promise.all([
    runFromSourceTables(siteId, start, end),
    runFromCashFlowEntries(siteId, start, end),
  ]);

  const discrepancies = compareRuns(runA, runB);

  return {
    passed: discrepancies.length === 0,
    runA,
    runB,
    discrepancies,
    queriesUsed: getQueryDescriptions(),
    checkedAt: new Date().toISOString(),
  };
}
