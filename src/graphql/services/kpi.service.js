/**
 * KPI Service — Direct SQL aggregation against source tables.
 * PostgreSQL owns every money aggregation; JS only combines the returned
 * aggregates into the named dashboard formulas.
 *
 * Expected Profit = Plot Payments sale-price total − running expenses + sold-land
 *                   book profit, with already-posted sold-land cost added back
 *                   so each land purchase cost is deducted once.
 * Current Profit  = all posted plot + sold-land receipts − running expenses.
 * Registry        = plot/installment receipts on REGISTRY-status plots, split
 *                   from their posted ledger CASH/BANK bucket.
 * Site Balance    = all posted credits − all posted debits − staff imprest.
 *
 * Person-ledger movements are intentionally NOT in Total Expenses: advances
 * and returns move custody, but they are not operating income or expense.
 * They remain visible in Personal Ledger and in the all-ledger Site Balance.
 */
import pool from '../../config/db.js';

// ── Date range WHERE fragments ──
const dateFilter = (col, paramStart) =>
  `AND ${col} >= $${paramStart} AND ${col} < $${paramStart + 1}`;

const numberOf = (value) => parseFloat(value) || 0;
const intOf = (value) => parseInt(value, 10) || 0;
const roundMoney = (value) => Math.round(numberOf(value) * 100) / 100;
const roundPct = (value) => Math.round(numberOf(value) * 100) / 100;

// ── Revenue: money in, from the shared ledger ──
// `ledger_entries` (migration 079) is the same view the Day Book and the
// Balance Sheet read, so these KPIs can no longer drift from those pages.
// It already applies the shared credit-first/debit-approval/cheque-clearance,
// sane-date and registry de-duplication policy. This used to be a third
// private copy of all of it.
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

// ── Plot incoming book, cumulative as at the dashboard range end ──
// A plot is counted once. Receipts are first netted per plot, which makes the
// remaining and overpaid figures reconcile even when a receipt is reversed.
export async function getPlotIncoming(siteId, end, excludeOldPlots = false) {
  const { rows } = await pool.query(
     `WITH plot_receipts AS (
       SELECT COALESCE(pp.plot_id, pip.plot_id) AS plot_id,
              COALESCE(SUM(le.credit), 0)::numeric AS received
         FROM ledger_entries le
         LEFT JOIN plot_payments pp
           ON le.source_key = 'plot_payments' AND pp.id = le.source_id
         LEFT JOIN plot_installment_payments pip
           ON le.source_key = 'plot_installment_payments' AND pip.id = le.source_id
         JOIN plots receipt_plot ON receipt_plot.id = COALESCE(pp.plot_id, pip.plot_id)
        WHERE le.site_id = $1
          AND le.entry_date < $2::date
          AND le.source_key IN ('plot_payments', 'plot_installment_payments')
          AND ($3::bool = false OR (
            UPPER(TRIM(COALESCE(receipt_plot.plot_tag, ''))) <> 'OLD'
            AND UPPER(TRIM(COALESCE(receipt_plot.status, ''))) <> 'RESALE'
          ))
        GROUP BY COALESCE(pp.plot_id, pip.plot_id)
     ), pricing_plots AS (
       -- This is deliberately the same book shown in Plot Payments > Pricing:
       -- every current plot contributes its sale price, irrespective of status.
       -- OLD rows are resold history and never contribute size/rate/sale price
       -- in that page's cumulative footer.
       SELECT COALESCE(p.sale_price, 0)::numeric AS sale_value
         FROM plots p
        WHERE p.site_id = $1
          AND UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD'
     ), eligible_plots AS (
       SELECT p.id,
              COALESCE(p.sale_price, 0)::numeric AS sale_value,
              COALESCE(pr.received, 0)::numeric AS received
         FROM plots p
         LEFT JOIN plot_receipts pr ON pr.plot_id = p.id
        WHERE p.site_id = $1
          AND COALESCE(p.created_at::date, DATE '1900-01-01') < $2::date
          AND COALESCE(p.sale_price, 0) > 0
          AND UPPER(TRIM(COALESCE(p.status, ''))) NOT IN (
            'COMPANY', 'CANCEL', 'CANCELLED', 'CANCELLATION',
            'UNDER CANCELLATION', 'AVAILABLE', 'NOT FOR SALE', 'TRANSFERRED'
          )
          -- RESALE rows are legacy/OLD inventory and belong only in the
          -- inclusive view. New-only mode must never pull them back in.
          AND (UPPER(TRIM(COALESCE(p.status, ''))) <> 'RESALE' OR $3::bool = false)
          AND ($3::bool = false OR UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD')
     )
     SELECT
       COALESCE((SELECT SUM(sale_value) FROM pricing_plots), 0)::numeric AS final_sale_value,
       COALESCE(SUM(sale_value), 0)::numeric AS sale_value,
       COALESCE((SELECT SUM(received) FROM plot_receipts), 0)::numeric AS received,
       COALESCE(SUM(received), 0)::numeric AS matched_received,
       COALESCE(SUM(GREATEST(sale_value - received, 0)), 0)::numeric AS remaining,
       COALESCE(SUM(GREATEST(received - sale_value, 0)), 0)::numeric AS overpaid,
       COUNT(*)::int AS plot_count
     FROM eligible_plots`,
    [siteId, end, excludeOldPlots]
  );

  const row = rows[0];
  const finalSaleValue = numberOf(row.final_sale_value);
  const saleValue = numberOf(row.sale_value);
  const received = numberOf(row.received);
  const matchedReceived = numberOf(row.matched_received);
  const remaining = numberOf(row.remaining);
  return {
    // Expected Profit mirrors Plot Payments > Pricing > Sale price exactly.
    // `saleValue` remains the narrower eligible collection book used to
    // reconcile receipts and remaining balances.
    finalSaleValue: roundMoney(finalSaleValue),
    saleValue: roundMoney(saleValue),
    received: roundMoney(received),
    matchedReceived: roundMoney(matchedReceived),
    unmatchedReceived: roundMoney(received - matchedReceived),
    remaining: roundMoney(remaining),
    overpaid: roundMoney(row.overpaid),
    // Cap at each plot before aggregating: an overpaid plot cannot make a
    // different plot appear more collected than it is.
    collectionPct: saleValue > 0 ? roundPct(((saleValue - remaining) / saleValue) * 100) : 0,
    plotCount: intOf(row.plot_count),
  };
}

// ── Land-profit book, cumulative as at the dashboard range end ──
// `purchase_cost` is a book allocation (farmer payments already move cash),
// so it is used for contract profit but is never posted to Site Balance again.
export async function getLandProfitDetail(siteId, end) {
  const { rows } = await pool.query(
    `WITH posted_receipts AS (
       SELECT ldp.land_deal_id,
              COALESCE(SUM(le.credit), 0)::numeric AS received,
              COALESCE(SUM(le.credit) FILTER (WHERE le.bucket = 'cash'), 0)::numeric AS cash_received,
              COALESCE(SUM(le.credit) FILTER (WHERE le.bucket <> 'cash'), 0)::numeric AS bank_received
         FROM ledger_entries le
         JOIN land_deal_payments ldp
           ON le.source_key = 'land_deal_payments' AND ldp.id = le.source_id
        WHERE le.site_id = $1 AND le.entry_date < $2::date
        GROUP BY ldp.land_deal_id
     ), sold_deals AS (
       SELECT d.id,
              d.farmer_id,
              COALESCE(d.sale_amount, 0)::numeric AS sale_value,
              COALESCE(NULLIF(d.purchase_cost, 0), f.total_amount, 0)::numeric AS purchase_cost,
              COALESCE(d.other_cost, 0)::numeric AS other_cost,
              COALESCE(r.received, 0)::numeric AS received,
              COALESCE(r.cash_received, 0)::numeric AS cash_received,
              COALESCE(r.bank_received, 0)::numeric AS bank_received
         FROM land_deals d
         LEFT JOIN farmers f ON f.id = d.farmer_id
         LEFT JOIN posted_receipts r ON r.land_deal_id = d.id
        WHERE d.site_id = $1
          AND d.deal_date < $2::date
          AND LOWER(TRIM(COALESCE(d.status, ''))) IN ('open', 'completed')
     ), sold_purchase_by_farmer AS (
       SELECT farmer_id, COALESCE(SUM(purchase_cost), 0)::numeric AS sold_purchase_cost
       FROM sold_deals
       WHERE farmer_id IS NOT NULL
       GROUP BY farmer_id
     ), posted_farmer_cost AS (
       SELECT fp.farmer_id, COALESCE(SUM(le.debit), 0)::numeric AS posted_cost
       FROM ledger_entries le
       JOIN farmer_payments fp
         ON le.source_key = 'farmer_payments' AND fp.id = le.source_id
       WHERE le.site_id = $1 AND le.entry_date < $2::date
       GROUP BY fp.farmer_id
     ), attributed_cost AS (
       SELECT COALESCE(SUM(LEAST(
                sp.sold_purchase_cost,
                GREATEST(COALESCE(pc.posted_cost, 0), 0)
              )), 0)::numeric AS purchase_cost_already_expensed
       FROM sold_purchase_by_farmer sp
       LEFT JOIN posted_farmer_cost pc ON pc.farmer_id = sp.farmer_id
     )
     SELECT
       COALESCE(SUM(sale_value), 0)::numeric AS sale_value,
       COALESCE(SUM(purchase_cost), 0)::numeric AS purchase_cost,
       COALESCE(SUM(other_cost), 0)::numeric AS other_cost,
       COALESCE(SUM(sale_value - purchase_cost - other_cost), 0)::numeric AS book_profit,
       COALESCE(SUM(received), 0)::numeric AS received,
       COALESCE(SUM(GREATEST(sale_value - received, 0)), 0)::numeric AS remaining,
       COALESCE(SUM(cash_received), 0)::numeric AS cash_received,
       COALESCE(SUM(bank_received), 0)::numeric AS bank_received,
       (SELECT purchase_cost_already_expensed FROM attributed_cost)::numeric AS purchase_cost_already_expensed,
       COUNT(*)::int AS deal_count
     FROM sold_deals`,
    [siteId, end]
  );

  const row = rows[0];
  const saleValue = numberOf(row.sale_value);
  const received = numberOf(row.received);
  const remaining = numberOf(row.remaining);
  const bookProfit = numberOf(row.book_profit);
  return {
    saleValue: roundMoney(saleValue),
    purchaseCost: roundMoney(row.purchase_cost),
    otherCost: roundMoney(row.other_cost),
    bookProfit: roundMoney(bookProfit),
    received: roundMoney(received),
    remaining: roundMoney(remaining),
    cashReceived: roundMoney(row.cash_received),
    bankReceived: roundMoney(row.bank_received),
    purchaseCostAlreadyExpensed: roundMoney(row.purchase_cost_already_expensed),
    collectionPct: saleValue > 0 ? roundPct(((saleValue - remaining) / saleValue) * 100) : 0,
    marginPct: saleValue > 0 ? roundPct((bookProfit / saleValue) * 100) : 0,
    dealCount: intOf(row.deal_count),
  };
}

// Period land receipts for the module breakdown. The headline profit books
// are cumulative; this row intentionally follows the selected dashboard range.
export async function getLandRevenue(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(le.credit), 0)::numeric AS credit,
            COUNT(*) FILTER (WHERE le.credit <> 0)::int AS txn_count
       FROM ledger_entries le
       JOIN land_deal_payments ldp
         ON le.source_key = 'land_deal_payments' AND ldp.id = le.source_id
       JOIN land_deals ld ON ld.id = ldp.land_deal_id
      WHERE le.site_id = $1
        AND le.entry_date >= $2::date
        AND le.entry_date < $3::date
        AND LOWER(TRIM(COALESCE(ld.status, ''))) IN ('open', 'completed')`,
    [siteId, start, end]
  );
  return {
    credit: roundMoney(rows[0].credit),
    count: intOf(rows[0].txn_count),
  };
}

// ── Expense breakdown by module ──
// Every operating debit in the ledger. Person-ledger legs are custody
// movements, not operating expense, and remain represented in Site Balance.
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
        AND source_key NOT IN (
          'firm_transactions', 'personal_ledger', 'plot_payments',
          'plot_installment_payments', 'day_book', 'misc_income_entries'
        )
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

// Expense stock through the selected end. This intentionally shares the exact
// source policy above, while totalExpense remains the selected-period movement.
export async function getRunningExpense(siteId, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(debit), 0)::numeric AS total
       FROM ledger_entries
      WHERE site_id = $1 AND entry_date < $2::date
        AND debit <> 0
        AND source_key NOT IN (
          'firm_transactions', 'personal_ledger', 'plot_payments',
          'plot_installment_payments', 'day_book', 'misc_income_entries'
        )
        AND ledger_type <> 'person'`,
    [siteId, end]
  );
  return roundMoney(rows[0].total);
}

// ── Miscellaneous income (maintenance, tokens, gifts…) — income net of refunds ──
// Its debit rows are refunds of that income, so they net here instead of
// counting as expenses (excluded from getExpenseBreakdown above).
export async function getMiscIncome(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(credit), 0)::numeric AS credit,
            COALESCE(SUM(debit), 0)::numeric AS debit,
            COUNT(*)::int AS txn_count
       FROM ledger_entries
      WHERE site_id = $1 AND entry_date >= $2 AND entry_date < $3
        AND source_key = 'misc_income_entries'`,
    [siteId, start, end]
  );
  const credit = parseFloat(rows[0].credit) || 0;
  const debit = parseFloat(rows[0].debit) || 0;
  return { credit, debit, net: credit - debit, count: parseInt(rows[0].txn_count, 10) || 0 };
}

// ── Site Balance stock as at the selected range end ──
// Site Balance is the Admin's money in hand. Staff float is outside that hand,
// while Admin float and pending site-funded allocations are reservations that
// reduce what can be distributed without changing the authoritative balance.
// Period movement is returned separately; a time filter must never turn a
// stock balance into only today's movement.
export async function getSiteBalanceDetail(siteId, start, end, db = pool) {
  const { rows } = await db.query(
    `WITH ledger AS (
       SELECT
         COALESCE(SUM(credit) FILTER (WHERE entry_date < $3::date), 0)::numeric AS total_money_in,
         COALESCE(SUM(debit) FILTER (WHERE entry_date < $3::date), 0)::numeric AS total_money_out,
         COALESCE(SUM(credit - debit) FILTER (WHERE entry_date < $3::date AND bucket = 'cash'), 0)::numeric AS cash_balance,
         COALESCE(SUM(credit - debit) FILTER (WHERE entry_date < $3::date AND bucket <> 'cash'), 0)::numeric AS bank_balance,
         COALESCE(SUM(credit - debit) FILTER (WHERE entry_date < $3::date), 0)::numeric AS balance_before_imprest,
         COALESCE(SUM(credit) FILTER (WHERE entry_date >= $2::date AND entry_date < $3::date), 0)::numeric AS period_money_in,
         COALESCE(SUM(debit) FILTER (WHERE entry_date >= $2::date AND entry_date < $3::date), 0)::numeric AS period_money_out,
         COALESCE(SUM(credit - debit) FILTER (WHERE entry_date >= $2::date AND entry_date < $3::date), 0)::numeric AS period_net
       FROM ledger_entries
       WHERE site_id = $1
         AND entry_date < $3::date
     ),
     user_imprest AS (
       SELECT il.user_id,
              LOWER(COALESCE(u.role, '')) AS role,
              COALESCE(SUM(il.amount), 0)::numeric AS user_balance
         FROM imprest_ledger il
         JOIN users u ON u.id = il.user_id
        WHERE il.site_id IS NOT NULL AND il.site_id = $1
          AND il.created_at < $3::date
        GROUP BY il.user_id, LOWER(COALESCE(u.role, ''))
     ),
     imprest AS (
       SELECT
         COALESCE(SUM(GREATEST(user_balance, 0))
           FILTER (WHERE role NOT IN ('admin', 'super_admin')), 0)::numeric AS imprest_held,
         COALESCE(SUM(GREATEST(user_balance, 0))
           FILTER (WHERE role IN ('admin', 'super_admin')), 0)::numeric AS admin_imprest_reserved
       FROM user_imprest
     ),
     pending AS (
       SELECT COALESCE(SUM(amount), 0)::numeric AS pending_imprest_reservations
         FROM imprest_allocations
        WHERE site_id = $1
          AND status = 'PENDING_RECEIPT'
          AND from_own_float = false
          AND created_at < $3::date
     )
     SELECT
       ledger.*,
       imprest.imprest_held,
       imprest.admin_imprest_reserved,
       pending.pending_imprest_reservations,
       ledger.balance_before_imprest - imprest.imprest_held AS site_balance,
       ledger.balance_before_imprest - imprest.imprest_held
         - imprest.admin_imprest_reserved - pending.pending_imprest_reservations AS distributable_balance
     FROM ledger CROSS JOIN imprest CROSS JOIN pending`,
    [siteId, start, end]
  );

  const row = rows[0];
  return {
    totalMoneyIn:               roundMoney(row.total_money_in),
    totalMoneyOut:              roundMoney(row.total_money_out),
    cashBalance:                roundMoney(row.cash_balance),
    bankBalance:                roundMoney(row.bank_balance),
    balanceBeforeImprest:       roundMoney(row.balance_before_imprest),
    imprestHeld:                roundMoney(row.imprest_held),
    adminImprestReserved:       roundMoney(row.admin_imprest_reserved),
    pendingImprestReservations: roundMoney(row.pending_imprest_reservations),
    distributableBalance:       roundMoney(row.distributable_balance),
    siteBalance:                roundMoney(row.site_balance),
    periodMoneyIn:              roundMoney(row.period_money_in),
    periodMoneyOut:             roundMoney(row.period_money_out),
    periodNet:                  roundMoney(row.period_net),
  };
}

// Kept as the small compatibility API used by consistency checks and any
// callers that only need the final number.
export async function getSiteBalance(siteId, end) {
  const detail = await getSiteBalanceDetail(siteId, '1900-01-01', end);
  return detail.siteBalance;
}

// ── Site Cashflow: credit − debit from site-type ledgers ──
export async function getSiteCashflow(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT
       COALESCE(SUM(cfe.credit) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS total_credit,
       COALESCE(SUM(cfe.debit) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS total_debit
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
       AND LOWER(cfm.ledger_type) = 'site'`,
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
       COALESCE(SUM(cfe.debit) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS given,
       COALESCE(SUM(cfe.credit) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0)::numeric AS returned
     FROM cash_flow_entries cfe
     JOIN cash_flow_months cfm ON cfm.id = cfe.cash_flow_month_id
     WHERE cfe.site_id = $1 ${dateFilter('cfe.date', 2)}
       AND LOWER(cfm.ledger_type) = 'person'
       AND (cfe.source_module IS NULL OR cfe.source_module !~ '_person$')`,
    [siteId, start, end]
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
       AND (cfe.source_module IS NULL OR cfe.source_module !~ '_person$')
       AND cfe.credit > 0
       AND financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)`,
    [siteId, start, end]
  );
  return parseFloat(rows[0].total_credit) || 0;
}

// ── Registry-plot receipts in the selected dashboard window ──
// Preserve the established card universe: every posted plot or installment
// receipt whose plot is currently at REGISTRY status. Registry mappings are
// documents/workflow references, not a second money source, and manual registry
// payments are debit-side costs. Reading ledger_entries applies the shared
// credit-first and cheque-clearance policy before the CASH/BANK split.
export async function getRegistryPayments(siteId, start, end) {
  const { rows } = await pool.query(
    `WITH activity AS (
       SELECT
         le.credit::numeric AS amount,
         le.bucket,
         UPPER(TRIM(COALESCE(p.plot_tag, ''))) = 'OLD' AS is_old
       FROM ledger_entries le
       LEFT JOIN plot_payments pp
         ON le.source_key = 'plot_payments' AND pp.id = le.source_id
       LEFT JOIN plot_installment_payments pip
         ON le.source_key = 'plot_installment_payments' AND pip.id = le.source_id
       JOIN plots p ON p.id = COALESCE(pp.plot_id, pip.plot_id)
       WHERE le.site_id = $1
         AND le.entry_date >= $2::date
         AND le.entry_date < $3::date
         AND le.source_key IN ('plot_payments', 'plot_installment_payments')
         AND le.credit <> 0
         AND UPPER(TRIM(COALESCE(p.status, ''))) = 'REGISTRY'
     )
     SELECT
       COALESCE(SUM(amount), 0)::numeric AS total,
       COALESCE(SUM(amount) FILTER (WHERE bucket = 'cash'), 0)::numeric AS cash_total,
       COALESCE(SUM(amount) FILTER (WHERE bucket <> 'cash'), 0)::numeric AS bank_total,
       COALESCE(SUM(amount) FILTER (WHERE is_old), 0)::numeric AS old_total,
       COALESCE(SUM(amount) FILTER (WHERE NOT is_old), 0)::numeric AS new_total,
       COALESCE(SUM(amount) FILTER (WHERE is_old AND bucket = 'cash'), 0)::numeric AS old_cash,
       COALESCE(SUM(amount) FILTER (WHERE is_old AND bucket <> 'cash'), 0)::numeric AS old_bank,
       COALESCE(SUM(amount) FILTER (WHERE NOT is_old AND bucket = 'cash'), 0)::numeric AS new_cash,
       COALESCE(SUM(amount) FILTER (WHERE NOT is_old AND bucket <> 'cash'), 0)::numeric AS new_bank,
       COUNT(*)::int AS txn_count,
       COUNT(*) FILTER (WHERE is_old)::int AS old_count,
       COUNT(*) FILTER (WHERE NOT is_old)::int AS new_count
     FROM activity`,
    [siteId, start, end]
  );
  const r = rows[0];
  return {
    total: roundMoney(r.total),
    cash: roundMoney(r.cash_total),
    bank: roundMoney(r.bank_total),
    newTotal: roundMoney(r.new_total),
    oldTotal: roundMoney(r.old_total),
    newCash: roundMoney(r.new_cash),
    newBank: roundMoney(r.new_bank),
    oldCash: roundMoney(r.old_cash),
    oldBank: roundMoney(r.old_bank),
    count: intOf(r.txn_count),
    newCount: intOf(r.new_count),
    oldCount: intOf(r.old_count),
  };
}

// ── Imprest: net outstanding (cash still held by sub-admins as imprest) ──
// Sourced from imprest_ledger, which records every allocation (+), expense (−)
// and refund (−). Summing per user and taking only positive balances yields
// "money currently sitting with sub-admins" — the only portion that should
// reduce Site Balance. Expenses spent from imprest are already in totalExpense,
// and accepted returns cancel out allocations, so both drop out automatically.
// These are current balances, so they accumulate from inception through end.
export async function getImprestGiven(siteId, start, end) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(user_balance, 0)), 0)::numeric AS total
     FROM (
       SELECT il.user_id, COALESCE(SUM(il.amount), 0) AS user_balance
       FROM imprest_ledger il
       JOIN users u ON u.id = il.user_id
       WHERE il.site_id IS NOT NULL AND il.site_id = $1
         AND il.created_at < $2::date
         AND LOWER(COALESCE(u.role, '')) NOT IN ('admin', 'super_admin')
       GROUP BY il.user_id
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
     WHERE il.site_id IS NOT NULL AND il.site_id = $1
       AND il.created_at < $2::date
       AND LOWER(COALESCE(sa.role, '')) NOT IN ('admin', 'super_admin')
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
  const [
    revenue,
    expData,
    cashflow,
    outstanding,
    personalLedgerCredit,
    imprestGiven,
    imprestDistribution,
    registryPayments,
    imprestPairs,
    siteBalanceDetail,
    miscIncome,
    plotIncoming,
    landProfitDetail,
    runningExpense,
    landRevenue,
  ] = await Promise.all([
    getRevenue(siteId, start, end, excludeOldPlots),
    getExpenseBreakdown(siteId, start, end),
    getSiteCashflow(siteId, start, end),
    getOutstanding(siteId, start, end),
    getPersonalLedgerCredit(siteId, start, end),
    getImprestGiven(siteId, start, end),
    getImprestDistribution(siteId, start, end),
    getRegistryPayments(siteId, start, end),
    getImprestPairs(siteId, start, end),
    getSiteBalanceDetail(siteId, start, end),
    getMiscIncome(siteId, start, end),
    getPlotIncoming(siteId, end, excludeOldPlots),
    getLandProfitDetail(siteId, end),
    getRunningExpense(siteId, end),
    getLandRevenue(siteId, start, end),
  ]);

  // Expected Profit uses the full sold-land book profit. Posted farmer payments
  // attributable to those sold parcels already sit inside runningExpense, so add
  // that overlap back once; otherwise the same purchase cost is deducted both in
  // runningExpense and again inside bookProfit. Current Profit remains cash-basis.
  const expectedProfit = plotIncoming.finalSaleValue
    + landProfitDetail.bookProfit
    - runningExpense
    + landProfitDetail.purchaseCostAlreadyExpensed;
  const currentProfit = plotIncoming.received + landProfitDetail.received - runningExpense;
  const currentReceipts = plotIncoming.received + landProfitDetail.received;
  const currentProfitMargin = currentReceipts > 0 ? (currentProfit / currentReceipts) * 100 : 0;
  const periodRevenue = revenue + landRevenue.credit;
  const periodNetProfit = periodRevenue - expData.total;
  const periodProfitMargin = periodRevenue > 0 ? (periodNetProfit / periodRevenue) * 100 : 0;

  return {
    siteBalance: siteBalanceDetail.siteBalance,
    siteBalanceDetail,
    plotIncoming,
    landProfitDetail,
    registryPaymentDetail: registryPayments,
    runningExpense: roundMoney(runningExpense),
    expectedProfit: roundMoney(expectedProfit),
    currentProfit: roundMoney(currentProfit),
    totalRevenue: roundMoney(periodRevenue),
    totalExpense: expData.total,
    // Preserve the legacy selected-period trio. Cumulative cash performance is
    // exposed separately as currentProfit/currentProfitMargin.
    netProfit: roundMoney(periodNetProfit),
    profitMargin: roundPct(periodProfitMargin),
    currentProfitMargin: roundPct(currentProfitMargin),
    outstanding: outstanding.pending,
    cashflow: cashflow.net,
    personalLedgerCredit,
    miscIncome: miscIncome.net,
    miscIncomeDetail: miscIncome,
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
      land_deal_payments: { credit: landRevenue.credit, debit: 0, count: landRevenue.count },
      misc_income_entries: { credit: miscIncome.credit, debit: miscIncome.debit, count: miscIncome.count },
    },
    cashflowDetail: cashflow,
    outstandingDetail: outstanding,
  };
}
