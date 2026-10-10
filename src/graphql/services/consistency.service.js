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
import { ACTIVE_SOURCE_TDS_SQL, excludeLinkedTdsSettlement, excludeSourceLinkedTdsSettlement } from '../../services/daybookTds.service.js';

const TOLERANCE = 0.01;
const postedMirrorDebit = `CASE WHEN financial_transaction_posts(
  CASE WHEN cfe.debit < 0 THEN 'credit' ELSE 'debit' END,
  cfe.status, cfe.cash_type, cfe.cheque_status) THEN COALESCE(cfe.debit, 0) ELSE 0 END`;
const postedMirrorCredit = `CASE WHEN financial_transaction_posts(
  CASE WHEN cfe.credit < 0 THEN 'debit' ELSE 'credit' END,
  cfe.status, cfe.cash_type, cfe.cheque_status) THEN COALESCE(cfe.credit, 0) ELSE 0 END`;
const postedExpenseNet = `(CASE WHEN financial_transaction_posts(
  CASE WHEN debit < 0 THEN 'credit' ELSE 'debit' END,
  status, payment_mode, cheque_status) THEN COALESCE(debit, 0) + COALESCE(tds_amount, 0) ELSE 0 END
  - CASE WHEN financial_transaction_posts(
    CASE WHEN credit < 0 THEN 'debit' ELSE 'credit' END,
    status, payment_mode, cheque_status) THEN COALESCE(credit, 0) ELSE 0 END)`;

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
         AND financial_transaction_posts(CASE WHEN pp.amount < 0 THEN 'debit' ELSE 'credit' END, pp.status, pp.payment_type, pp.cheque_status)
       UNION ALL
       SELECT pip.amount FROM plot_installment_payments pip
       JOIN plots p ON p.id = pip.plot_id
       WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
         AND financial_transaction_posts(CASE WHEN pip.amount < 0 THEN 'debit' ELSE 'credit' END, pip.status, pip.payment_mode, pip.cheque_status)
       UNION ALL
       SELECT ldp.amount FROM land_deal_payments ldp
       JOIN land_deals ld ON ld.id = ldp.land_deal_id
       WHERE ld.site_id = $1 AND ld.status IN ('open', 'completed')
         AND ldp.date >= $2 AND ldp.date < $3
         AND financial_transaction_posts(CASE WHEN ldp.amount < 0 THEN 'debit' ELSE 'credit' END, ldp.status, ldp.payment_mode, ldp.cheque_status)
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
       SELECT fp.amount + COALESCE(fp.tds_amount, 0) AS debit FROM farmer_payments fp
       JOIN farmers f ON f.id = fp.farmer_id
       WHERE ${excludeSourceLinkedTdsSettlement('farmer_payments', 'fp.id')} AND f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         AND financial_transaction_posts(CASE WHEN fp.amount < 0 THEN 'credit' ELSE 'debit' END, fp.status, fp.payment_mode, fp.cheque_status)
       UNION ALL
       SELECT ${postedExpenseNet} AS debit FROM expenses
       WHERE ${excludeSourceLinkedTdsSettlement('expenses')} AND site_id = $1 AND date >= $2 AND date < $3
       UNION ALL
       SELECT amount + COALESCE(tds_amount, 0) AS debit FROM plot_commissions
       WHERE ${excludeSourceLinkedTdsSettlement('plot_commissions')} AND site_id = $1 AND date >= $2 AND date < $3
         AND financial_transaction_posts(CASE WHEN amount < 0 THEN 'credit' ELSE 'debit' END, status, by_note, cheque_status)
       UNION ALL
       SELECT amount + COALESCE(tds_amount, 0) AS debit FROM plot_commission_payments
       WHERE ${excludeSourceLinkedTdsSettlement('plot_commission_payments')} AND site_id = $1 AND date >= $2 AND date < $3
         AND financial_transaction_posts(
           CASE WHEN amount < 0 THEN 'credit' ELSE 'debit' END,
           status, payment_mode, cheque_status
         )
       UNION ALL
       SELECT amount + COALESCE(tds_amount, 0) AS debit FROM vendor_payments
       WHERE ${excludeSourceLinkedTdsSettlement('vendor_payments')} AND site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND financial_transaction_posts(CASE WHEN amount < 0 THEN 'credit' ELSE 'debit' END, status, payment_mode, cheque_status)
       UNION ALL
       SELECT amount + COALESCE(tds_amount, 0) AS debit FROM vendor_inventory_payments
       WHERE ${excludeSourceLinkedTdsSettlement('vendor_inventory_payments')} AND site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND source_vendor_payment_id IS NULL
         AND financial_transaction_posts(CASE WHEN amount < 0 THEN 'credit' ELSE 'debit' END, status, payment_mode, cheque_status)
       UNION ALL
       SELECT amount AS debit FROM plot_registry_payments
       WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
         AND source_plot_payment_id IS NULL
       UNION ALL
       SELECT ${postedExpenseNet} AS debit FROM day_book
       WHERE site_id = $1 AND date >= $2 AND date < $3
         AND ${excludeSourceLinkedTdsSettlement('day_book')}
         AND entry_type = 'EXPENSE'
         AND farmer_payment_id IS NULL AND commission_id IS NULL AND vendor_payment_id IS NULL
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
    'vendor_payments', 'vendor_inventory_payments',
  ];

  const revPlaceholders = revenueModules.map((_, i) => `$${i + 4}`).join(', ');
  const revResult = await pool.query(
    `SELECT COALESCE(SUM(${postedMirrorCredit} - ${postedMirrorDebit}), 0)::numeric AS total_credit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${revPlaceholders})
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
    `SELECT COALESCE(SUM(${postedMirrorDebit} - ${postedMirrorCredit}), 0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module IN (${expPlaceholders})
       AND ${excludeLinkedTdsSettlement('cfe')}`,
    [siteId, start, end, ...expenseModules]
  );
  const totalExpense = parseFloat(expResult.rows[0].total_debit) || 0;

  // Plot registry payments — only those NOT auto-paid via a plot_payment
  // (matches canonical: source_plot_payment_id IS NULL).
  const registryResult = await pool.query(
    `SELECT COALESCE(SUM(${postedMirrorDebit} - ${postedMirrorCredit}), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'plot_registry_payments'
       AND ${excludeLinkedTdsSettlement('cfe')}
       AND EXISTS (
         SELECT 1 FROM plot_registry_payments prp
         WHERE prp.id = cfe.source_id AND prp.source_plot_payment_id IS NULL
       )`,
    [siteId, start, end]
  );
  const registryExpense = parseFloat(registryResult.rows[0].total) || 0;

  // Orphan day_book EXPENSE entries synced to cash_flow
  const orphanResult = await pool.query(
    `SELECT COALESCE(SUM(${postedMirrorDebit} - ${postedMirrorCredit}), 0)::numeric AS total
     FROM cash_flow_entries cfe
     WHERE cfe.site_id = $1 AND cfe.date >= $2 AND cfe.date < $3
       AND cfe.source_module = 'day_book'
       AND ${excludeLinkedTdsSettlement('cfe')}
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
  // Mirrors store net cash, so add the active owner withholding once. The
  // EXISTS guard detects a missing owner mirror without multiplying split rows.
  const withholdingResult = await pool.query(`
    SELECT COALESCE(SUM(t.tds_amount), 0)::numeric AS total
      FROM (${ACTIVE_SOURCE_TDS_SQL}) t
     WHERE t.site_id = $1 AND t.entry_date >= $2 AND t.entry_date < $3
       AND EXISTS (
         SELECT 1 FROM cash_flow_entries cfe
          WHERE cfe.site_id = t.site_id AND cfe.source_module = t.source_key AND cfe.source_id = t.source_id
            AND ${excludeLinkedTdsSettlement('cfe')}
            AND (cfe.source_module = ANY($4::text[]) OR (
              cfe.source_module = 'day_book' AND EXISTS (
                SELECT 1 FROM day_book db WHERE db.id = cfe.source_id AND db.entry_type = 'EXPENSE'
                  AND db.farmer_payment_id IS NULL AND db.commission_id IS NULL AND db.vendor_payment_id IS NULL
              )
            ))
       )`, [siteId, start, end, expenseModules]);
  const withholding = parseFloat(withholdingResult.rows[0].total) || 0;
  const adjExpense = totalExpense + registryExpense + orphanExpense + withholding;
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
      runB: 'Posted credit minus debit from receipt mirrors, including transfer offsets and refunds',
    },
    totalExpense: {
      runA: 'Gross posted operating costs: net payments plus active TDS withholding, minus recoveries. TDS settlements are excluded.',
      runB: 'Posted net cash-flow mirrors plus each active owner withholding once. TDS settlements and personal custody movements are excluded from expense.',
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
