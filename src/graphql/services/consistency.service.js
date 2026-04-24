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
  // Revenue: plot_payments + installments
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::numeric AS total
     FROM (
       SELECT pp.amount FROM plot_payments pp
       JOIN plots plt ON plt.id = pp.plot_id
       WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3
         AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
         AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
     ) u`,
    [siteId, start, end]
  );
  const totalRevenue = parseFloat(revResult.rows[0].total) || 0;

  // Expense: all source tables combined. Person-ledger debit is intentionally
  // EXCLUDED — outstanding already subtracts given-returned from adjusted
  // incoming, so counting cfe.debit as expense too would double-deduct it.
  const expResult = await pool.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total
     FROM (
       SELECT fp.amount AS debit FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT debit FROM expenses
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT amount AS debit FROM plot_commission_payments
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT amount AS debit FROM vendor_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       UNION ALL
       SELECT debit FROM day_book
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
         AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
     ) u`,
    [siteId, start, end]
  );
  const totalExpense = parseFloat(expResult.rows[0].total) || 0;

  // Outstanding: person ledger
  const outResult = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.debit), 0)::numeric  AS given,
       COALESCE(SUM(cfe.credit), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
    [siteId]
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
 * Profit modules only, matching the same source_modules used in Run A.
 */
async function runFromCashFlowEntries(siteId, start, end) {
  const profitModules = [
    'plot_payments', 'plot_installment_payments',
    'farmer_payments', 'expenses',
    'plot_commission_payments',
    'vendor_payments',
  ];

  const placeholders = profitModules.map((_, i) => `$${i + 4}`).join(', ');

  const result = await pool.query(
    `SELECT
       COALESCE(SUM(credit), 0)::numeric AS total_credit,
       COALESCE(SUM(debit),  0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${placeholders})
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
    [siteId, start, end, ...profitModules]
  );

  const totalRevenue = parseFloat(result.rows[0].total_credit) || 0;
  const totalExpense = parseFloat(result.rows[0].total_debit) || 0;

  // Also fetch orphan day_book EXPENSE entries synced to cash_flow
  const orphanResult = await pool.query(
    `SELECT COALESCE(SUM(cfe.debit), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'day_book'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')
       AND EXISTS (
         SELECT 1 FROM day_book db
         WHERE db.id = cfe.source_id AND db.entry_type = 'EXPENSE'
           AND db.farmer_payment_id IS NULL AND db.commission_id IS NULL AND db.vendor_payment_id IS NULL
       )`,
    [siteId, start, end]
  );
  const orphanExpense = parseFloat(orphanResult.rows[0].total) || 0;

  // Personal ledger debit (person-type entries are native to cash_flow_entries, not synced)
  const plResult = await pool.query(
    `SELECT COALESCE(SUM(cfe.debit), 0)::numeric AS total
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND LOWER(cfm.ledger_type) = 'person' AND cfe.debit > 0
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
    [siteId, start, end]
  );
  const personalLedgerDebit = parseFloat(plResult.rows[0].total) || 0;

  const adjExpense = totalExpense + orphanExpense + personalLedgerDebit;
  const netProfit = totalRevenue - adjExpense;

  // Outstanding from person ledger (same source for both runs)
  const outResult = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.debit), 0)::numeric  AS given,
       COALESCE(SUM(cfe.credit), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.cheque_status IS NULL OR cfe.cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND (cfe.status IS NULL OR cfe.status != 'rejected')`,
    [siteId]
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
      runA: 'SUM(amount) FROM plot_payments + plot_installment_payments WHERE site_id AND date range AND cheque_status valid',
      runB: 'SUM(credit) FROM cash_flow_entries WHERE source_module IN (plot_payments, plot_installment_payments) AND date range',
    },
    totalExpense: {
      runA: 'SUM(amount/debit) FROM farmer_payments + expenses + plot_commissions + plot_commission_payments + vendor_payments + plot_registry_payments + day_book(EXPENSE orphan) WHERE site_id AND date range',
      runB: 'SUM(debit) FROM cash_flow_entries WHERE source_module IN (profit modules) + day_book EXPENSE orphans AND date range',
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
