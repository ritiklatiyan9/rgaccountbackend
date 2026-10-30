import pool from '../config/db.js';
import financialDb from '../config/financialReportDb.js';
import { OPERATING_TDS_SQL, excludeLinkedTdsSettlement } from './daybookTds.service.js';
import { profitFrom } from '../graphql/services/kpi.service.js';

const number = value => Number(value) || 0;
const money = value => Math.round(number(value) * 100) / 100;
const pct = (value, basis) => basis > 0 ? money(value / basis * 100) : 0;
const operatingSources = `'firm_transactions', 'personal_ledger', 'plot_payments', 'plot_installment_payments',
  'land_deal_payments', 'day_book', 'misc_income_entries', 'partner_profit_payments', 'tds_settlements'`;

// One scoped ledger scan feeds every site's books. Keep the same canonical TDS
// predicate as the dashboard, but its EXISTS reads the already materialized
// ledger rather than expanding the ledger view again for each withholding row.
// The TDS eligibility EXISTS keeps its original all-date policy; booked totals
// use the exclusive report cutoff through the separate filtered ledger CTE.
export const profitPortfolioQueries = {
  financial: `WITH requested AS MATERIALIZED (SELECT unnest($1::int[]) AS id),
  scoped_ledger AS MATERIALIZED (
    SELECT le.id, le.site_id, le.source_key, le.source_id, le.entry_date, le.credit, le.debit, le.bucket, le.ledger_type
      FROM ledger_entries le JOIN requested s ON s.id = le.site_id
  ), ledger AS MATERIALIZED (
    SELECT * FROM scoped_ledger WHERE entry_date < $2::date
  ), operating_tds AS MATERIALIZED (
    SELECT t.* FROM (${OPERATING_TDS_SQL.replace(/FROM ledger_entries le/g, 'FROM scoped_ledger le')}) t
    JOIN requested s ON s.id = t.site_id WHERE t.entry_date < $2::date
  ), plot_receipts AS (
    SELECT le.site_id, COALESCE(pp.plot_id, pip.plot_id) AS plot_id,
           SUM(le.credit - le.debit)::numeric AS received
      FROM ledger le
      LEFT JOIN plot_payments pp ON le.source_key = 'plot_payments' AND pp.id = le.source_id
      LEFT JOIN plot_installment_payments pip ON le.source_key = 'plot_installment_payments' AND pip.id = le.source_id
      JOIN plots receipt_plot ON receipt_plot.id = COALESCE(pp.plot_id, pip.plot_id)
     WHERE le.source_key IN ('plot_payments', 'plot_installment_payments')
       AND ($3::boolean = false OR (UPPER(TRIM(COALESCE(receipt_plot.plot_tag, ''))) <> 'OLD'
         AND UPPER(TRIM(COALESCE(receipt_plot.status, ''))) <> 'RESALE'))
     GROUP BY le.site_id, COALESCE(pp.plot_id, pip.plot_id)
  ), plot_received AS (
    SELECT site_id, SUM(received)::numeric AS received FROM plot_receipts GROUP BY site_id
  ), pricing_plots AS (
    SELECT p.site_id, SUM(COALESCE(p.sale_price, 0))::numeric AS final_sale_value
      FROM plots p JOIN requested s ON s.id = p.site_id
     WHERE UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD' GROUP BY p.site_id
  ), eligible_plots AS (
    SELECT p.site_id, p.id, COALESCE(p.sale_price, 0)::numeric AS sale_value,
           COALESCE(pr.received, 0)::numeric AS received
      FROM plots p JOIN requested s ON s.id = p.site_id
      LEFT JOIN plot_receipts pr ON pr.plot_id = p.id AND pr.site_id = p.site_id
     WHERE COALESCE(p.created_at::date, DATE '1900-01-01') < $2::date
       AND COALESCE(p.sale_price, 0) > 0
       AND UPPER(TRIM(COALESCE(p.status, ''))) NOT IN ('COMPANY', 'CANCEL', 'CANCELLED', 'CANCELLATION',
         'UNDER CANCELLATION', 'AVAILABLE', 'NOT FOR SALE', 'TRANSFERRED')
       AND (UPPER(TRIM(COALESCE(p.status, ''))) <> 'RESALE' OR $3::boolean = false)
       AND ($3::boolean = false OR UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD')
  ), plot_stats AS (
    SELECT site_id, SUM(sale_value)::numeric AS sale_value, SUM(received)::numeric AS matched_received,
           SUM(GREATEST(sale_value - received, 0))::numeric AS remaining,
           SUM(GREATEST(received - sale_value, 0))::numeric AS overpaid, COUNT(*)::int AS plot_count
      FROM eligible_plots GROUP BY site_id
  ), land_receipts AS (
    SELECT le.site_id, ldp.land_deal_id, SUM(le.credit - le.debit)::numeric AS received,
           SUM(le.credit - le.debit) FILTER (WHERE le.bucket = 'cash')::numeric AS cash_received,
           SUM(le.credit - le.debit) FILTER (WHERE le.bucket <> 'cash')::numeric AS bank_received
      FROM ledger le JOIN land_deal_payments ldp ON le.source_key = 'land_deal_payments' AND ldp.id = le.source_id
     GROUP BY le.site_id, ldp.land_deal_id
  ), sold_deals AS (
    SELECT d.site_id, d.id, d.farmer_id, COALESCE(d.sale_amount, 0)::numeric AS sale_value,
           COALESCE(d.purchase_cost, 0)::numeric AS purchase_cost, COALESCE(d.other_cost, 0)::numeric AS other_cost,
           COALESCE(r.received, 0)::numeric AS received, COALESCE(r.cash_received, 0)::numeric AS cash_received,
           COALESCE(r.bank_received, 0)::numeric AS bank_received
      FROM land_deals d JOIN requested s ON s.id = d.site_id
      LEFT JOIN land_receipts r ON r.land_deal_id = d.id AND r.site_id = d.site_id
     WHERE d.deal_date < $2::date AND LOWER(TRIM(COALESCE(d.status, ''))) IN ('open', 'completed')
  ), farmer_tds AS (
    SELECT t.site_id, fp.farmer_id, SUM(t.tds_amount)::numeric AS held
      FROM operating_tds t JOIN farmer_payments fp ON t.source_key = 'farmer_payments' AND fp.id = t.source_id
     GROUP BY t.site_id, fp.farmer_id
  ), farmer_cost_base AS (
    SELECT le.site_id, fp.farmer_id, SUM(le.debit - le.credit)::numeric AS paid
      FROM ledger le JOIN farmer_payments fp ON le.source_key = 'farmer_payments' AND fp.id = le.source_id
     WHERE ${excludeLinkedTdsSettlement('le')} GROUP BY le.site_id, fp.farmer_id
  ), farmer_cost AS (
    SELECT p.site_id, p.farmer_id, p.paid + COALESCE(t.held, 0) AS paid
      FROM farmer_cost_base p LEFT JOIN farmer_tds t ON t.site_id = p.site_id AND t.farmer_id = p.farmer_id
  ), sold_by_farmer AS (
    SELECT site_id, farmer_id, SUM(sale_value)::numeric AS sale_value, SUM(purchase_cost)::numeric AS sold_cost,
           SUM(other_cost)::numeric AS other_cost, SUM(received)::numeric AS received
      FROM sold_deals GROUP BY site_id, farmer_id
  ), attributed_cost AS (
    SELECT s.site_id, SUM(LEAST(s.sold_cost, GREATEST(COALESCE(p.paid, 0), 0)))::numeric AS matched_cost
      FROM sold_by_farmer s LEFT JOIN farmer_cost p ON p.site_id = s.site_id AND p.farmer_id = s.farmer_id
     WHERE s.farmer_id IS NOT NULL GROUP BY s.site_id
  ), land_stats AS (
    SELECT site_id, SUM(sale_value)::numeric AS sale_value, SUM(purchase_cost)::numeric AS purchase_cost,
           SUM(other_cost)::numeric AS other_cost, SUM(sale_value - purchase_cost - other_cost)::numeric AS book_profit,
           SUM(received)::numeric AS received, SUM(GREATEST(sale_value - received, 0))::numeric AS remaining,
           SUM(cash_received)::numeric AS cash_received, SUM(bank_received)::numeric AS bank_received, COUNT(*)::int AS deal_count
      FROM sold_deals GROUP BY site_id
  ), farmer_totals AS (
    SELECT site_id, SUM(paid)::numeric AS paid_to_farmers FROM farmer_cost GROUP BY site_id
  ), lands AS (
    SELECT f.site_id, f.id AS farmer_id, f.name, COALESCE(s.sale_value, 0) AS sale_value,
           COALESCE(s.sold_cost, 0) AS sold_cost, COALESCE(s.other_cost, 0) AS other_cost,
           COALESCE(s.received, 0) AS received, COALESCE(p.paid, 0) AS paid
      FROM farmers f JOIN requested r ON r.id = f.site_id
      LEFT JOIN sold_by_farmer s ON s.site_id = f.site_id AND s.farmer_id = f.id
      LEFT JOIN farmer_cost p ON p.site_id = f.site_id AND p.farmer_id = f.id
     WHERE s.farmer_id IS NOT NULL OR p.farmer_id IS NOT NULL
  ), land_rows AS (
    SELECT site_id, jsonb_agg(to_jsonb(lands) ORDER BY name, farmer_id) AS lands FROM lands GROUP BY site_id
  ), operating_costs AS (
    SELECT site_id, SUM(cost)::numeric AS running_expense FROM (
      SELECT le.site_id, le.debit - le.credit AS cost FROM ledger le
       WHERE (le.debit <> 0 OR le.credit <> 0) AND le.source_key NOT IN (${operatingSources})
         AND le.ledger_type <> 'person' AND ${excludeLinkedTdsSettlement('le')}
      UNION ALL SELECT site_id, tds_amount FROM operating_tds
    ) costs GROUP BY site_id
  ), ledger_balances AS (
    SELECT site_id, SUM(credit)::numeric AS total_money_in, SUM(debit)::numeric AS total_money_out,
           SUM(credit - debit) FILTER (WHERE bucket = 'cash')::numeric AS cash_balance,
           SUM(credit - debit) FILTER (WHERE bucket <> 'cash')::numeric AS bank_balance,
           SUM(credit - debit)::numeric AS balance_before_imprest,
           SUM(credit) FILTER (WHERE entry_date >= DATE '1900-01-01')::numeric AS period_money_in,
           SUM(debit) FILTER (WHERE entry_date >= DATE '1900-01-01')::numeric AS period_money_out,
           SUM(credit - debit) FILTER (WHERE entry_date >= DATE '1900-01-01')::numeric AS period_net
      FROM ledger GROUP BY site_id
  ), user_imprest AS (
    SELECT il.site_id, il.user_id, LOWER(COALESCE(u.role, '')) AS role, SUM(il.amount)::numeric AS balance
      FROM imprest_ledger il JOIN requested r ON r.id = il.site_id JOIN users u ON u.id = il.user_id
     WHERE il.created_at < $2::date GROUP BY il.site_id, il.user_id, LOWER(COALESCE(u.role, ''))
  ), imprest AS (
    SELECT site_id, SUM(GREATEST(balance, 0)) FILTER (WHERE role NOT IN ('admin', 'super_admin'))::numeric AS imprest_held
      FROM user_imprest GROUP BY site_id
  ), pending_imprest AS (
    SELECT site_id, SUM(amount)::numeric AS pending_imprest_reservations FROM (
      SELECT ia.site_id, ia.amount FROM imprest_allocations ia JOIN requested r ON r.id = ia.site_id
       WHERE ia.status = 'PENDING_RECEIPT' AND ia.from_own_float = false AND ia.created_at < $2::date
      UNION ALL SELECT res.site_id, res.amount FROM imprest_site_debit_reservations res JOIN requested r ON r.id = res.site_id
    ) reservations GROUP BY site_id
  )
  SELECT r.id AS site_id, to_jsonb(ps) AS plot_stats, COALESCE(pr.received, 0) AS plot_received,
         COALESCE(pp.final_sale_value, 0) AS final_sale_value, to_jsonb(ls) AS land_stats,
         COALESCE(ac.matched_cost, 0) AS matched_cost, COALESCE(ft.paid_to_farmers, 0) AS paid_to_farmers,
         COALESCE(lr.lands, '[]'::jsonb) AS lands, COALESCE(oc.running_expense, 0) AS running_expense,
         to_jsonb(lb) AS balance_stats, COALESCE(i.imprest_held, 0) AS imprest_held,
         COALESCE(pi.pending_imprest_reservations, 0) AS pending_imprest_reservations
    FROM requested r LEFT JOIN plot_stats ps ON ps.site_id = r.id LEFT JOIN plot_received pr ON pr.site_id = r.id
    LEFT JOIN pricing_plots pp ON pp.site_id = r.id LEFT JOIN land_stats ls ON ls.site_id = r.id
    LEFT JOIN attributed_cost ac ON ac.site_id = r.id LEFT JOIN farmer_totals ft ON ft.site_id = r.id
    LEFT JOIN land_rows lr ON lr.site_id = r.id LEFT JOIN operating_costs oc ON oc.site_id = r.id
    LEFT JOIN ledger_balances lb ON lb.site_id = r.id LEFT JOIN imprest i ON i.site_id = r.id
    LEFT JOIN pending_imprest pi ON pi.site_id = r.id ORDER BY r.id`,
  shares: `SELECT s.site_id, NULL::int AS farmer_id, s.id, s.member_id, s.share_pct::float AS share_pct, s.notes,
      m.full_name, m.member_type, m.phone, m.photo
    FROM site_partner_shares s JOIN members m ON m.id = s.member_id WHERE s.site_id = ANY($1::int[])
    UNION ALL SELECT f.site_id, s.farmer_id, s.id, s.member_id, s.share_pct::float, s.notes,
      m.full_name, m.member_type, m.phone, m.photo
    FROM land_partner_shares s JOIN farmers f ON f.id = s.farmer_id JOIN members m ON m.id = s.member_id
    WHERE f.site_id = ANY($1::int[]) ORDER BY share_pct DESC, full_name ASC`,
  payments: `SELECT p.*, p.date::text AS date, m.full_name, m.phone, m.photo, b.name AS bank_name, u.name AS created_by_name,
      COALESCE(le.debit, 0)::float AS posted_amount,
      CASE WHEN p.date < $2::date AND le.entry_date < $2::date THEN
        le.debit + CASE WHEN le.debit > 0 THEN COALESCE(p.tds_amount, 0) ELSE 0 END ELSE 0 END::float AS summary_paid,
      CASE WHEN p.date < $2::date AND le.entry_date < $2::date THEN 1 ELSE 0 END AS summary_count
    FROM partner_profit_payments p JOIN members m ON m.id = p.member_id
    LEFT JOIN bank_accounts b ON b.id = p.bank_account_id LEFT JOIN users u ON u.id = p.created_by
    LEFT JOIN ledger_entries le ON le.source_key = 'partner_profit_payments' AND le.source_id = p.id AND le.site_id = p.site_id
    WHERE p.site_id = ANY($1::int[]) ORDER BY p.date DESC, p.transaction_time DESC NULLS LAST, p.id DESC`,
  ledgers: `WITH months AS MATERIALIZED (
      SELECT cfm.* FROM cash_flow_months cfm WHERE cfm.site_id = ANY($1::int[]) AND cfm.ledger_type = 'person'
    ), totals AS (
      SELECT cfe.cash_flow_month_id,
        COALESCE(SUM(cfe.debit) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0) AS total_debit,
        COALESCE(SUM(cfe.credit) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0) AS total_credit,
        COALESCE(SUM(FLOOR(cfe.debit * 100 + 0.5)) FILTER (WHERE financial_transaction_posts('debit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0) / 100 AS profit_given_debit,
        COALESCE(SUM(FLOOR(cfe.credit * 100 + 0.5)) FILTER (WHERE financial_transaction_posts('credit', cfe.status, cfe.cash_type, cfe.cheque_status)), 0) / 100 AS profit_return_credit,
        COUNT(*)::int AS entry_count
      FROM cash_flow_entries cfe JOIN months cfm ON cfm.id = cfe.cash_flow_month_id
      WHERE cfe.source_module IS NULL OR cfe.source_module !~ '_person$' GROUP BY cfe.cash_flow_month_id
    )
    SELECT cfm.*, COALESCE(t.total_debit, 0) AS total_debit, COALESCE(t.total_credit, 0) AS total_credit,
      COALESCE(t.profit_given_debit, 0) AS profit_given_debit, COALESCE(t.profit_return_credit, 0) AS profit_return_credit,
      COALESCE(t.entry_count, 0) AS entry_count
    FROM months cfm LEFT JOIN totals t ON t.cash_flow_month_id = cfm.id
    ORDER BY cfm.year DESC, cfm.month DESC, cfm.ledger_name ASC`,
};

export function portfolioProfitFromRow(row) {
  const p = row.plot_stats || {};
  const l = row.land_stats || {};
  const b = row.balance_stats || {};
  const plotIncoming = {
    finalSaleValue: money(row.final_sale_value), saleValue: money(p.sale_value), received: money(row.plot_received),
    matchedReceived: money(p.matched_received), unmatchedReceived: money(number(row.plot_received) - number(p.matched_received)),
    remaining: money(p.remaining), overpaid: money(p.overpaid),
    collectionPct: pct(number(p.sale_value) - number(p.remaining), number(p.sale_value)), plotCount: number(p.plot_count),
  };
  const landProfitDetail = {
    saleValue: money(l.sale_value), purchaseCost: money(l.purchase_cost), otherCost: money(l.other_cost),
    saleProfit: money(number(l.sale_value) - number(l.purchase_cost)), bookProfit: money(l.book_profit),
    currentProfit: money(number(l.received) - number(row.paid_to_farmers)), received: money(l.received),
    paidToFarmers: money(row.paid_to_farmers), remaining: money(l.remaining), cashReceived: money(l.cash_received),
    bankReceived: money(l.bank_received), purchaseCostAlreadyExpensed: money(row.matched_cost),
    collectionPct: pct(number(l.sale_value) - number(l.remaining), number(l.sale_value)),
    marginPct: pct(number(l.book_profit), number(l.sale_value)), dealCount: number(l.deal_count),
  };
  const lands = (row.lands || []).map(land => {
    const book = number(land.sale_value) - number(land.sold_cost) - number(land.other_cost);
    const paid = number(land.paid);
    return { farmer_id: land.farmer_id, name: land.name, saleValue: money(land.sale_value), soldCost: money(land.sold_cost),
      otherCost: money(land.other_cost), bookProfit: money(book), received: money(land.received), paid: money(paid),
      expectedProfit: money(book + Math.min(number(land.sold_cost), Math.max(paid, 0)) - paid),
      currentProfit: money(number(land.received) - paid) };
  });
  const siteBalanceDetail = {
    totalMoneyIn: money(b.total_money_in), totalMoneyOut: money(b.total_money_out), cashBalance: money(b.cash_balance),
    bankBalance: money(b.bank_balance), balanceBeforeImprest: money(b.balance_before_imprest), imprestHeld: money(row.imprest_held),
    adminImprestReserved: 0, pendingImprestReservations: money(row.pending_imprest_reservations),
    distributableBalance: money(number(b.cash_balance) - number(row.imprest_held) - number(row.pending_imprest_reservations)),
    siteBalance: money(number(b.balance_before_imprest) - number(row.imprest_held)),
    periodMoneyIn: money(b.period_money_in), periodMoneyOut: money(b.period_money_out), periodNet: money(b.period_net),
  };
  const runningExpense = money(row.running_expense);
  const { expectedProfit, currentProfit } = profitFrom(plotIncoming, landProfitDetail, runningExpense);
  const landExpected = lands.reduce((sum, land) => sum + land.expectedProfit, 0);
  const landCurrent = lands.reduce((sum, land) => sum + land.currentProfit, 0);
  return { lands, profit: { expectedProfit: money(expectedProfit), currentProfit: money(currentProfit), runningExpense,
    siteBalance: siteBalanceDetail.siteBalance, siteBalanceDetail, plotIncoming, landProfitDetail,
    plot: { expectedProfit: money(expectedProfit - landExpected), currentProfit: money(currentProfit - landCurrent) },
    land: { expectedProfit: money(landExpected), currentProfit: money(landCurrent) } } };
}

/** Four financial/account reads for any site count. No work is scheduled per site or per ledger. */
export async function buildProfitPortfolio(siteIds, end, excludeOldPlots = false, options = {}) {
  siteIds = [...new Set(siteIds.map(Number))].sort((a, b) => a - b);
  const db = options.db || pool;
  const reports = options.financialDb || financialDb;
  if (!siteIds.length) return { data: [], failures: [], completed: 0, total: 0 };
  const [books, shares, payments, ledgers] = await Promise.allSettled([
    reports.query(profitPortfolioQueries.financial, [siteIds, end, excludeOldPlots]),
    db.query(profitPortfolioQueries.shares, [siteIds]),
    db.query(profitPortfolioQueries.payments, [siteIds, end]),
    db.query(profitPortfolioQueries.ledgers, [siteIds]),
  ]);
  const siteNames = options.siteNames || new Map();
  const failure = id => ({ id, name: siteNames.get(Number(id)) || `Site ${id}`,
    message: books.status === 'rejected' ? 'Profit calculation could not be loaded. Please retry.'
      : shares.status === 'rejected' ? 'Partner shares could not be loaded. Please retry.'
      : 'Partner payment or personal ledger data could not be loaded. Please retry.' });
  if (books.status === 'rejected' || shares.status === 'rejected') {
    return { data: [], failures: siteIds.map(failure), completed: siteIds.length, total: siteIds.length };
  }
  const financialRows = new Map(books.value.rows.map(row => [Number(row.site_id), row]));
  const bySite = (result) => {
    const map = new Map();
    if (result.status === 'fulfilled') for (const row of result.value.rows) {
      const key = Number(row.site_id);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
    return map;
  };
  const sharesBySite = bySite(shares), paymentsBySite = bySite(payments), ledgersBySite = bySite(ledgers);
  const data = [], failures = [];
  for (const siteId of siteIds) {
    const row = financialRows.get(Number(siteId));
    if (!row) { failures.push(failure(siteId)); continue; }
    const siteShares = sharesBySite.get(Number(siteId)) || [];
    const sitePayments = paymentsBySite.get(Number(siteId)) || [];
    const paid = new Map();
    for (const payment of sitePayments) {
      if (payment.date >= end) continue;
      const id = String(payment.member_id);
      if (!paid.has(id)) paid.set(id, { member_id: payment.member_id, full_name: payment.full_name,
        phone: payment.phone, photo: payment.photo, paid: 0, payment_count: 0 });
      const member = paid.get(id);
      member.paid += number(payment.summary_paid);
      member.payment_count += number(payment.summary_count);
    }
    const result = portfolioProfitFromRow(row);
    const incomplete = payments.status === 'rejected' || ledgers.status === 'rejected';
    if (incomplete) failures.push(failure(siteId));
    data.push({ siteId, siteName: siteNames.get(Number(siteId)) || `Site ${siteId}`, profit: result.profit,
      lands: result.lands.map(land => ({ ...land, shares: siteShares.filter(share => Number(share.farmer_id) === Number(land.farmer_id)) })),
      shares: siteShares.filter(share => share.farmer_id === null), payments: [...paid.values()],
      profitPayments: sitePayments.map(({ summary_paid, summary_count, ...payment }) => payment),
      personalLedgers: ledgersBySite.get(Number(siteId)) || [],
      personalLedgersUnavailable: ledgers.status === 'rejected', profitPaymentsUnavailable: payments.status === 'rejected' });
  }
  return { data, failures, completed: siteIds.length, total: siteIds.length };
}
