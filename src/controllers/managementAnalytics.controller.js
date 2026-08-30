// Management Analytics — read-only, whole-site aggregates for management.
// Money invariant: every money total reads the ledger_entries VIEW (approved-only, bounced
// excluded). Per-plot collections join the view to plot_payments on source_id so plot
// receivables reconcile with the Day Book. Raw plot_payments rows are only read for
// payment BEHAVIOUR facts (who paid when) with the approved/non-bounced predicate applied.
import pool from '../config/db.js';
import asyncHandler from '../utils/asyncHandler.js';
import { cleanText } from '../services/openRouterStream.service.js';
import { getSiteBalanceDetail } from '../graphql/services/kpi.service.js';

export { cleanText };

const ADMIN_ROLES = new Set(['admin', 'super_admin']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const num = (v) => Number(v) || 0;
const pct = (part, total) => (num(total) > 0 ? Math.round((num(part) / num(total)) * 1000) / 10 : 0);
const rowsNum = (rows, keys) => rows.map((r) => {
  const out = { ...r };
  for (const k of keys) out[k] = num(r[k]);
  return out;
});

// Local calendar day (IST server or not, never toISOString's UTC day).
const today = () => new Date().toLocaleDateString('en-CA');
// 'YYYY-MM-DD' + 1 day, for the Dashboard's exclusive end-date convention.
const nextDay = (d) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + 1); return x.toLocaleDateString('en-CA'); };
const monthsAgo = (n) => {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return d.toLocaleDateString('en-CA');
};

/**
 * Site + date range from `source` ('query' | 'body' | default: both merged).
 * `to` is clamped to today; default range = last 12 months. Responds 400 and returns null when site_id is missing.
 */
export const parseScope = (req, res, source) => {
  const src = source === 'body' ? (req.body || {}) : source === 'query' ? (req.query || {}) : { ...(req.query || {}), ...(req.body || {}) };
  const siteId = Number.parseInt(src.site_id ?? src.siteId, 10);
  if (!Number.isInteger(siteId) || siteId <= 0) {
    if (!res) return { error: 'site_id is required' }; // legacy call style: parseScope(req)
    res.status(400).json({ message: 'site_id is required' });
    return null;
  }
  const max = today();
  let to = DATE_RE.test(src.to) ? src.to : max;
  if (to > max) to = max;
  let from = DATE_RE.test(src.from) ? src.from : monthsAgo(11);
  if (from > to) from = to;
  return { siteId, from, to };
};

/**
 * Admins bypass; sub-admins must be assigned the site in user_sites (same check as report.controller).
 * assertSiteAccess(user, siteId) throws a 403 Error; legacy form assertSiteAccess(req, res, siteId) responds 403 and returns false.
 */
export const assertSiteAccess = async (userOrReq, siteIdOrRes, legacySiteId) => {
  const legacy = legacySiteId !== undefined;
  const user = legacy ? userOrReq?.user : userOrReq;
  const siteId = legacy ? legacySiteId : siteIdOrRes;
  const ok = ADMIN_ROLES.has(user?.role)
    || Boolean((await pool.query('SELECT 1 FROM user_sites WHERE user_id = $1 AND site_id = $2 LIMIT 1', [user?.id, siteId])).rows[0]);
  if (ok) return true;
  if (legacy) { siteIdOrRes.status(403).json({ message: 'Access denied to this site' }); return false; }
  const err = new Error('Access denied to this site');
  err.statusCode = 403; err.code = 'SITE_ACCESS_DENIED';
  throw err;
};

const scopeOrReject = async (req, res) => {
  const scope = parseScope(req, res, 'query');
  if (!scope) return null;
  await assertSiteAccess(req.user, scope.siteId);
  return scope;
};

const siteInfo = async (siteId) => (await pool.query('SELECT id, name, city, state FROM sites WHERE id = $1', [siteId])).rows[0] || { id: siteId, name: `Site ${siteId}`, city: null, state: null };

const SOURCE_LABELS = {
  plot_payments: 'Plot payments', plot_installment_payments: 'Installments', expenses: 'Expenses', farmer_payments: 'Farmer payments',
  land_deal_payments: 'Land-sale receipts',
  plot_commission_payments: 'Commissions', vendor_payments: 'Vendor payments', vendor_inventory_payments: 'Vendor inventory',
  firm_transactions: 'Firm transactions', day_book: 'Day book', personal_ledger: 'Personal ledger',
};
const sourceLabel = (k) => SOURCE_LABELS[k] || String(k || 'other').replace(/_/g, ' ');

// ── shared SQL fragments ────────────────────────────────────────────────────
// Sold universe: anything that is not company stock / cancelled / unsold, with a price.
const SOLD_PLOT = `UPPER(TRIM(COALESCE(p.status, ''))) NOT IN ('COMPANY', 'CANCEL', 'CANCELLED', 'CANCELLATION', 'UNDER CANCELLATION', 'AVAILABLE', 'NOT FOR SALE', 'TRANSFERRED') AND COALESCE(p.sale_price, 0) > 0`;
// Ledger rows per plot ($1 = site_id), NET of reversals (negative credits stay in so `collected`
// reconciles with kpi.service getRevenue / Balance Sheet SUM(credit)). Timing facts (first/last pay,
// payment count, cumulative curve) only count receipts: filter `amt > 0` where used.
// ponytail: plot_installment_payments has 0 rows live — not joined.
const PAY_CTE = `pay AS (
  SELECT pp.plot_id, l.entry_date AS d, l.credit AS amt, l.bucket, l.raw_mode
    FROM ledger_entries l
    JOIN plot_payments pp ON pp.id = l.source_id
   WHERE l.site_id = $1 AND l.source_key = 'plot_payments' AND l.credit <> 0)`;
const PLOT_PAID_CTE = `plot_paid AS (
  SELECT plot_id, SUM(amt)::numeric(18,2) AS collected,
         MIN(d) FILTER (WHERE amt > 0) AS first_pay, MAX(d) FILTER (WHERE amt > 0) AS last_pay,
         COUNT(*) FILTER (WHERE amt > 0)::int AS payments
    FROM pay GROUP BY plot_id)`;
const APPROVED_PP = `financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)`;
const CLIENT = `m.site_id = $1 AND UPPER(COALESCE(m.member_type, '')) = 'CLIENT' AND LOWER(COALESCE(m.status, 'active')) <> 'deleted'`;
const FILLED = (col) => `COUNT(*) FILTER (WHERE NULLIF(TRIM(${col}), '') IS NOT NULL)::int`;
const REG_PAY_CTE = `reg_pay AS (
  SELECT prp.registry_id,
         COALESCE(SUM(prp.amount) FILTER (WHERE
           (prp.source_plot_payment_id IS NULL
             AND financial_transaction_posts('credit', prp.status, prp.payment_mode, prp.cheque_status))
           OR
           (prp.source_plot_payment_id IS NOT NULL
             AND pp.plot_id = pr.plot_id
             AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status))
         ), 0)::numeric(18,2) AS mapped_amount,
         COUNT(*) FILTER (WHERE
           (prp.source_plot_payment_id IS NULL
             AND financial_transaction_posts('credit', prp.status, prp.payment_mode, prp.cheque_status))
           OR
           (prp.source_plot_payment_id IS NOT NULL
             AND pp.plot_id = pr.plot_id
             AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status))
         )::int AS payment_count
    FROM plot_registry_payments prp
    JOIN plot_registries pr ON pr.id = prp.registry_id
    LEFT JOIN plot_payments pp ON pp.id = prp.source_plot_payment_id
   WHERE pr.site_id = $1
   GROUP BY prp.registry_id)`;

const q = async (sql, params) => (await pool.query(sql, params)).rows;

// ── Overview ────────────────────────────────────────────────────────────────
const overviewData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  // The ledger_entries view materialises every row before filtering (~200ms per pass), so the
  // in-range money facts come from ONE pass grouped by month × source × bucket and are split in JS.
  const [cells, balance, months, paidBySource, expCat, plots, byStatus, clients, byType, comp, kyc, commissions, farmers, vendors, inv, approvals, cheques, registries, imprest, activity] = await Promise.all([
    q(`SELECT to_char(date_trunc('month', entry_date), 'YYYY-MM') AS month, source_key, bucket, COALESCE(ledger_type,'') AS ledger_type,
              COALESCE(SUM(credit),0)::numeric(18,2) AS credit, COALESCE(SUM(debit),0)::numeric(18,2) AS debit,
              COUNT(*)::int AS count, COUNT(*) FILTER (WHERE debit > 0)::int AS debit_count
         FROM ledger_entries WHERE site_id = $1 AND entry_date >= $2::date AND entry_date <= LEAST($3::date, CURRENT_DATE)
        GROUP BY 1, 2, 3, 4`, P),
    // Site Balance exactly as the Dashboard computes it (cash + bank − imprest held); end is exclusive there.
    getSiteBalanceDetail(siteId, from, nextDay(to < today() ? to : today())).catch(() => null),
    q(`SELECT to_char(g.m, 'YYYY-MM') AS month, to_char(g.m, 'Mon YY') AS label
         FROM generate_series(date_trunc('month', $1::date), date_trunc('month', LEAST($2::date, CURRENT_DATE)), INTERVAL '1 month') AS g(m) ORDER BY g.m`, [from, to]),
    // all-time paid totals for the module cards (commissions / farmers / vendors) — one ledger pass
    q(`SELECT source_key, COALESCE(SUM(debit),0)::numeric(18,2) AS paid FROM ledger_entries
        WHERE site_id = $1 AND source_key IN ('plot_commission_payments','farmer_payments','vendor_payments') GROUP BY 1`, [siteId]),
    q(`SELECT COALESCE(NULLIF(TRIM(e.category), ''), 'Uncategorised') AS category, SUM(l.debit)::numeric(18,2) AS amount, COUNT(*) FILTER (WHERE l.debit > 0)::int AS count
         FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
        WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.debit <> 0 AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date, CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 25`, P),
    q(`WITH ${PAY_CTE}, ${PLOT_PAID_CTE}
       SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${SOLD_PLOT})::int AS sold,
              COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE(p.status,''))) = 'COMPANY')::int AS company_stock,
              COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE(p.status,''))) = 'RESALE')::int AS resale_count,
              COUNT(*) FILTER (WHERE UPPER(TRIM(COALESCE(p.plot_tag,''))) = 'OLD')::int AS old_tag_count,
              COALESCE(SUM(p.sale_price) FILTER (WHERE ${SOLD_PLOT}),0)::numeric(18,2) AS sale_value_total,
              COALESCE(SUM(pp.collected) FILTER (WHERE ${SOLD_PLOT}),0)::numeric(18,2) AS collected_total,
              COALESCE(SUM(GREATEST(p.sale_price - COALESCE(pp.collected,0),0)) FILTER (WHERE ${SOLD_PLOT}),0)::numeric(18,2) AS outstanding_total,
              COUNT(*) FILTER (WHERE ${SOLD_PLOT} AND p.sale_price - COALESCE(pp.collected,0) > 0)::int AS plots_with_balance,
              -- same rule as the payment-behaviour 'stalled' segment: < 95% collected and no receipt for 180+ days
              COUNT(*) FILTER (WHERE ${SOLD_PLOT} AND COALESCE(pp.collected,0) < 0.95 * p.sale_price
                                 AND COALESCE(pp.last_pay, p.booking_date, p.created_at::date) < CURRENT_DATE - 180)::int AS stalled_plots
         FROM plots p LEFT JOIN plot_paid pp ON pp.plot_id = p.id WHERE p.site_id = $1`, [siteId]),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(status)), ''), 'UNSET') AS status, COUNT(*)::int AS count, COALESCE(SUM(sale_price),0)::numeric(18,2) AS sale_value
         FROM plots WHERE site_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE m.created_at >= CURRENT_DATE - 30)::int AS new_last_30d,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM plots p WHERE p.site_id = $1 AND UPPER(TRIM(p.buyer_name)) = UPPER(TRIM(m.full_name))))::int AS buyers_linked
         FROM members m WHERE ${CLIENT}`, [siteId]),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(member_type)),''),'UNSPECIFIED') AS member_type, COUNT(*)::int AS count
         FROM members WHERE site_id = $1 AND LOWER(COALESCE(status,'active')) <> 'deleted' GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`SELECT COUNT(*)::int AS total, ${FILLED('m.phone')} AS phone, ${FILLED('m.address')} AS address, ${FILLED('m.occupation')} AS occupation,
              COUNT(m.latitude)::int AS geo
         FROM members m WHERE ${CLIENT}`, [siteId]),
    q(`SELECT COUNT(DISTINCT client_member_id)::int AS verified FROM kyc_cases WHERE site_id = $1 AND UPPER(status) = 'VERIFIED'`, [siteId]),
    // decided = per plot: plots.plot_commission, else the largest v2 decision — summed over plots, never over agents.
    q(`SELECT (SELECT COALESCE(SUM(COALESCE(NULLIF(p.plot_commission,0), v.mx, 0)),0)
                 FROM plots p LEFT JOIN (SELECT plot_id, MAX(total_commission) AS mx FROM plot_commissions_v2 WHERE site_id = $1 AND LOWER(COALESCE(status,'')) <> 'cancelled' GROUP BY plot_id) v ON v.plot_id = p.id
                WHERE p.site_id = $1)::numeric(18,2) AS decided_total,
              (SELECT COUNT(DISTINCT agent_id) FROM plot_commissions_v2 WHERE site_id = $1)::int AS agents`, [siteId]),
    q(`SELECT COUNT(*)::int AS count, COALESCE(SUM(total_amount),0)::numeric(18,2) AS liability_total FROM farmers WHERE site_id = $1`, [siteId]),
    q(`SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) = 'open')::int AS commitments_open,
              COALESCE(SUM(contract_amount),0)::numeric(18,2) AS contract_total
         FROM vendor_commitments WHERE site_id = $1`, [siteId]),
    q(`SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) IN ('open','partial'))::int AS inventory_orders_open
         FROM vendor_inventory_orders WHERE site_id = $1`, [siteId]),
    q(`SELECT (SELECT COUNT(*) FROM plot_payments WHERE site_id = $1 AND LOWER(status) = 'pending')::int AS pending_plot_payments,
              (SELECT COUNT(*) FROM expenses WHERE site_id = $1 AND LOWER(status) = 'pending')::int AS pending_expenses,
              (SELECT COUNT(*) FROM plot_commission_payments WHERE site_id = $1 AND LOWER(status) = 'pending')::int AS pending_commission_payments`, [siteId]),
    q(`SELECT ((SELECT COUNT(*) FROM plot_payments WHERE site_id = $1 AND UPPER(cheque_status) = 'PENDING')
             + (SELECT COUNT(*) FROM expenses WHERE site_id = $1 AND UPPER(cheque_status) = 'PENDING'))::int AS pending_cheques`, [siteId]),
    q(`SELECT COUNT(*)::int AS count, COUNT(noc_generated_at)::int AS noc_generated FROM plot_registries WHERE site_id = $1`, [siteId]),
    q(`SELECT COALESCE(SUM(GREATEST(bal,0)),0)::numeric(18,2) AS outstanding_float, COUNT(*) FILTER (WHERE bal > 0)::int AS holders
         FROM (
           SELECT DISTINCT ON (il.user_id) il.user_id, il.balance_after AS bal
           FROM imprest_ledger il JOIN users u ON u.id = il.user_id
           WHERE il.site_id = $1 AND u.role NOT IN ('admin', 'super_admin')
           ORDER BY il.user_id, il.created_at DESC, il.id DESC
         ) staff`, [siteId]),
    q(`SELECT (SELECT COUNT(*) FROM plot_payments WHERE site_id = $1 AND created_at >= CURRENT_DATE - 30)::int AS payments_30d,
              (SELECT COUNT(*) FROM expenses WHERE site_id = $1 AND created_at >= CURRENT_DATE - 30)::int AS expenses_30d,
              (SELECT COUNT(*) FROM audit_logs WHERE site_id = $1 AND created_at >= CURRENT_DATE - 30)::int AS audit_events_30d,
              (SELECT COUNT(*) FROM construction_projects WHERE site_id = $1)::int AS construction_projects,
              (SELECT COUNT(*) FROM construction_projects WHERE site_id = $1 AND status = 'ACTIVE')::int AS construction_active,
              (SELECT COUNT(*) FROM construction_projects WHERE site_id = $1 AND (status = 'DELAYED' OR (target_end_date < CURRENT_DATE AND status NOT IN ('COMPLETED','CANCELLED'))))::int AS construction_delayed,
              (SELECT COALESCE(SUM(budget),0) FROM construction_projects WHERE site_id = $1)::numeric(18,2) AS construction_budget,
              (SELECT COALESCE(SUM(qty*rate),0) FROM inventory_movements WHERE site_id = $1 AND movement_type = 'CONSUMPTION')::numeric(18,2) AS construction_actual_cost`, [siteId]),
  ]);

  const pl = plots[0]; const cl = clients[0]; const cp = comp[0]; const co = commissions[0]; const fa = farmers[0]; const ve = vendors[0]; const ac = activity[0];
  const paid = Object.fromEntries(paidBySource.map((r) => [r.source_key, num(r.paid)]));
  const r2 = (v) => Math.round(v * 100) / 100;
  // Same definitions as the Dashboard KPI cards (graphql/services/kpi.service.js getAllKpis):
  //   Plot Payments   = credit where source_key IN (plot_payments, plot_installment_payments)
  //   Total Incoming  = Plot + land receipts + misc + personal-ledger credit
  //   Total Expenses  = operating debits; person/day-book/firm transfers excluded
  //   Current Profit  = Plot receipts + sold-land receipts − Total Expenses
  // gross_in/gross_out (+ cash/bank splits, by_source) are EVERY ledger row — shown as the module breakdown only.
  const PLOT_SRC = new Set(['plot_payments', 'plot_installment_payments']);
  const LAND_SRC = 'land_deal_payments';
  const NON_EXPENSE_SRC = new Set(['personal_ledger', 'plot_payments', 'plot_installment_payments', LAND_SRC, 'day_book', 'misc_income_entries', 'firm_transactions']);
  const m = { gross_in: 0, gross_out: 0, cash_in: 0, bank_in: 0, cash_out: 0, bank_out: 0, plot_payments: 0, land_receipts: 0, misc_income: 0, personal_ledger_credit: 0, total_expense: 0 };
  const byMonth = new Map(); const bySrc = new Map(); const exp = { total: 0, count: 0 };
  const monthRow = (k) => byMonth.get(k) || { gross_in: 0, gross_out: 0, plot_payments: 0, land_receipts: 0, misc_income: 0, personal_ledger_credit: 0, total_expense: 0 };
  for (const c of cells) {
    const cr = num(c.credit); const dr = num(c.debit); const cash = c.bucket === 'cash';
    const isPlot = PLOT_SRC.has(c.source_key);
    const isPerson = c.ledger_type === 'person';
    const isExpense = !NON_EXPENSE_SRC.has(c.source_key) && !isPerson;
    m.gross_in += cr; m.gross_out += dr;
    if (cash) { m.cash_in += cr; m.cash_out += dr; } else { m.bank_in += cr; m.bank_out += dr; }
    if (isPlot) m.plot_payments += cr;
    if (c.source_key === LAND_SRC) m.land_receipts += cr;
    if (isPerson) m.personal_ledger_credit += cr;
    if (isExpense) m.total_expense += dr;
    if (c.source_key === 'misc_income_entries') m.misc_income += cr - dr;
    if (c.source_key === 'expenses') { exp.total += dr; exp.count += num(c.debit_count); }
    const mo = monthRow(c.month);
    mo.gross_in += cr; mo.gross_out += dr;
    if (isPlot) mo.plot_payments += cr;
    if (c.source_key === LAND_SRC) mo.land_receipts += cr;
    if (isPerson) mo.personal_ledger_credit += cr;
    if (isExpense) mo.total_expense += dr;
    if (c.source_key === 'misc_income_entries') mo.misc_income += cr - dr;
    byMonth.set(c.month, mo);
    const so = bySrc.get(c.source_key) || { inflow: 0, outflow: 0, count: 0 }; so.inflow += cr; so.outflow += dr; so.count += num(c.count); bySrc.set(c.source_key, so);
  }
  const plotPayments = r2(m.plot_payments);
  const landReceipts = r2(m.land_receipts);
  const miscIncome = r2(m.misc_income);
  const totalIncoming = r2(m.plot_payments + m.land_receipts + m.misc_income + m.personal_ledger_credit);
  const totalExpense = r2(m.total_expense);
  const profit = r2(plotPayments + landReceipts - totalExpense);
  return {
    site_id: siteId,
    range: { from, to },
    generated_at: new Date().toISOString(),
    money: {
      // Dashboard-aligned headline figures
      plot_payments: plotPayments, land_receipts: landReceipts, misc_income: miscIncome, personal_ledger_credit: r2(m.personal_ledger_credit), total_incoming: totalIncoming,
      total_expense: totalExpense, profit, profit_margin: (plotPayments + landReceipts) > 0 ? Math.round((profit / (plotPayments + landReceipts)) * 1000) / 10 : 0,
      site_balance: r2(balance?.siteBalance), cash_balance: r2(balance?.cashBalance), bank_balance: r2(balance?.bankBalance), imprest_held: r2(balance?.imprestHeld),
      // aliases kept for the AI snapshot / insights / older readers — same numbers as the Dashboard cards
      inflow: totalIncoming, outflow: totalExpense, net: profit, revenue_plots: plotPayments,
      // gross ledger movement (every source, incl. personal ledger / firm / day book) — module breakdown only
      gross_in: r2(m.gross_in), gross_out: r2(m.gross_out),
      cash_in: r2(m.cash_in), bank_in: r2(m.bank_in), cash_out: r2(m.cash_out), bank_out: r2(m.bank_out),
      definitions: {
        total_incoming: 'Plot receipts + sold-land receipts + misc income (net) + personal-ledger credit',
        total_expense: 'Farmer + expenses + commissions + vendors; personal ledger, firm transfers and day book excluded',
        profit: 'Plot receipts + sold-land receipts − Total expenses (Dashboard: Current Profit)',
        site_balance: 'All posted credits − all posted debits − staff imprest held (Dashboard: Admin Site Balance)',
        gross: 'Every approved ledger row, all modules (gross, never netted)',
      },
      monthly: months.map((r) => { const mo = monthRow(r.month); const currentProfit = mo.plot_payments + mo.land_receipts - mo.total_expense; return { month: r.month, label: r.label, plot_payments: r2(mo.plot_payments), land_receipts: r2(mo.land_receipts), personal_ledger_credit: r2(mo.personal_ledger_credit), total_expense: r2(mo.total_expense), profit: r2(currentProfit), inflow: r2(mo.plot_payments + mo.land_receipts + mo.personal_ledger_credit), outflow: r2(mo.total_expense), net: r2(currentProfit), gross_in: r2(mo.gross_in), gross_out: r2(mo.gross_out) }; }),
      by_source: [...bySrc.entries()].map(([k, s]) => ({ source_key: k, label: sourceLabel(k), inflow: r2(s.inflow), outflow: r2(s.outflow), count: s.count })).sort((a, b) => b.inflow - a.inflow),
    },
    plots: {
      total: num(pl.total), sold: num(pl.sold), company_stock: num(pl.company_stock), resale_count: num(pl.resale_count), old_tag_count: num(pl.old_tag_count),
      sale_value_total: num(pl.sale_value_total), collected_total: num(pl.collected_total), outstanding_total: num(pl.outstanding_total),
      collected_pct: pct(pl.collected_total, pl.sale_value_total),
      by_status: rowsNum(byStatus, ['count', 'sale_value']),
    },
    receivables: {
      outstanding_total: num(pl.outstanding_total), collected_pct: pct(pl.collected_total, pl.sale_value_total),
      plots_with_balance: num(pl.plots_with_balance), stalled_plots: num(pl.stalled_plots),
    },
    clients: {
      total: num(cl.total), by_type: byType, new_last_30d: num(cl.new_last_30d), buyers_linked: num(cl.buyers_linked), kyc_verified: num(kyc[0].verified),
      completeness: { phone_pct: pct(cp.phone, cp.total), address_pct: pct(cp.address, cp.total), occupation_pct: pct(cp.occupation, cp.total), geo_pct: pct(cp.geo, cp.total) },
    },
    commissions: { decided_total: num(co.decided_total), paid_total: num(paid.plot_commission_payments), pending_total: r2(Math.max(num(co.decided_total) - num(paid.plot_commission_payments), 0)), agents: num(co.agents) },
    farmers: { count: num(fa.count), liability_total: num(fa.liability_total), paid_total: num(paid.farmer_payments), outstanding: r2(Math.max(num(fa.liability_total) - num(paid.farmer_payments), 0)) },
    vendors: {
      commitments_open: num(ve.commitments_open), contract_total: num(ve.contract_total), paid_total: num(paid.vendor_payments),
      outstanding: r2(Math.max(num(ve.contract_total) - num(paid.vendor_payments), 0)), inventory_orders_open: num(inv[0].inventory_orders_open),
    },
    expenses: { total: r2(exp.total), count: exp.count, by_category: rowsNum(expCat, ['amount', 'count']) },
    approvals: { ...rowsNum(approvals, ['pending_plot_payments', 'pending_expenses', 'pending_commission_payments'])[0], pending_cheques: num(cheques[0].pending_cheques) },
    registries: rowsNum(registries, ['count', 'noc_generated'])[0],
    construction: {
      projects: num(ac.construction_projects), active: num(ac.construction_active), delayed: num(ac.construction_delayed),
      budget: num(ac.construction_budget), actual_cost: num(ac.construction_actual_cost),
    },
    imprest: rowsNum(imprest, ['outstanding_float', 'holders'])[0],
    activity: rowsNum(activity, ['payments_30d', 'expenses_30d', 'audit_events_30d'])[0],
  };
};

/** GET /management-analytics/overview?site_id&from&to → { overview } */
export const getOverview = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  const [overview, site] = await Promise.all([overviewData(scope.siteId, scope), siteInfo(scope.siteId)]);
  res.json({ overview: { ...overview, site } });
});

// ── Clients ─────────────────────────────────────────────────────────────────
const bucket = (siteId, expr, limit = 12) => q(
  `SELECT COALESCE(NULLIF(UPPER(TRIM(${expr})), ''), 'UNSPECIFIED') AS label, COUNT(*)::int AS count
     FROM members m WHERE ${CLIENT} GROUP BY 1 ORDER BY 2 DESC LIMIT $2::int`, [siteId, limit]);

const AGE_BAND = `CASE WHEN m.date_of_birth IS NULL THEN NULL
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 30 THEN 'Under 30'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 40 THEN '30-39'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 50 THEN '40-49'
  WHEN EXTRACT(YEAR FROM age(m.date_of_birth)) < 60 THEN '50-59' ELSE '60+' END`;

const clientsData = async (siteId) => {
  const [total, byType, comp, kyc, occ, city, state, gender, age, qual, team, newByMonth, topClients, agents, linked] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total FROM members m WHERE ${CLIENT}`, [siteId]),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(member_type)),''),'UNSPECIFIED') AS member_type, COUNT(*)::int AS count
         FROM members WHERE site_id = $1 AND LOWER(COALESCE(status,'active')) <> 'deleted' GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`SELECT COUNT(*)::int AS total, ${FILLED('m.phone')} AS phone, ${FILLED('m.email')} AS email, ${FILLED('m.address')} AS address,
              ${FILLED('m.city')} AS city, ${FILLED('m.pincode')} AS pincode, ${FILLED('m.occupation')} AS occupation,
              COUNT(m.date_of_birth)::int AS dob, COUNT(m.latitude)::int AS geo
         FROM members m WHERE ${CLIENT}`, [siteId]),
    q(`SELECT COUNT(DISTINCT client_member_id)::int AS verified FROM kyc_cases WHERE site_id = $1 AND UPPER(status) = 'VERIFIED'`, [siteId]),
    bucket(siteId, 'm.occupation'), bucket(siteId, 'm.city'), bucket(siteId, 'm.state', 8), bucket(siteId, 'm.gender', 6),
    bucket(siteId, AGE_BAND, 8), bucket(siteId, 'm.qualification', 8), bucket(siteId, 'm.team'),
    q(`SELECT to_char(g.m, 'YYYY-MM') AS month, to_char(g.m, 'Mon YY') AS label, COUNT(m.id)::int AS count
         FROM generate_series(date_trunc('month', CURRENT_DATE) - INTERVAL '11 months', date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS g(m)
         LEFT JOIN members m ON ${CLIENT} AND date_trunc('month', m.created_at) = g.m
        GROUP BY g.m ORDER BY g.m`, [siteId]),
    q(`WITH ${PAY_CTE}, ${PLOT_PAID_CTE}
       SELECT MIN(m.id)::int AS member_id, INITCAP(UPPER(TRIM(m.full_name))) AS name, COUNT(DISTINCT p.id)::int AS plots,
              COALESCE(SUM(pp.collected),0)::numeric(18,2) AS total_paid,
              COALESCE(SUM(GREATEST(p.sale_price - COALESCE(pp.collected,0),0)),0)::numeric(18,2) AS outstanding
         FROM members m
         JOIN plots p ON p.site_id = $1 AND UPPER(TRIM(p.buyer_name)) = UPPER(TRIM(m.full_name)) AND ${SOLD_PLOT}
         LEFT JOIN plot_paid pp ON pp.plot_id = p.id
        WHERE ${CLIENT}
        GROUP BY UPPER(TRIM(m.full_name)) ORDER BY total_paid DESC LIMIT 15`, [siteId]),
    q(`WITH ${PAY_CTE}, ${PLOT_PAID_CTE},
       comm AS (
         SELECT c.plot_id, MAX(c.total_commission) AS decided FROM plot_commissions_v2 c -- decided is repeated per agent row, never summed
          WHERE c.site_id = $1 AND LOWER(COALESCE(c.status,'')) <> 'cancelled' GROUP BY c.plot_id),
       comm_paid AS (
         SELECT c.plot_id, SUM(l.debit) AS paid
           FROM ledger_entries l JOIN plot_commission_payments cp ON cp.id = l.source_id JOIN plot_commissions_v2 c ON c.id = cp.plot_commission_id
          WHERE l.site_id = $1 AND l.source_key = 'plot_commission_payments' GROUP BY c.plot_id)
       SELECT UPPER(TRIM(p.booking_by)) AS name, COUNT(*)::int AS plots,
              COALESCE(SUM(p.sale_price),0)::numeric(18,2) AS sale_value, COALESCE(SUM(pp.collected),0)::numeric(18,2) AS collected,
              COALESCE(SUM(cm.decided),0)::numeric(18,2) AS commission_decided, COALESCE(SUM(cpd.paid),0)::numeric(18,2) AS commission_paid
         FROM plots p LEFT JOIN plot_paid pp ON pp.plot_id = p.id LEFT JOIN comm cm ON cm.plot_id = p.id LEFT JOIN comm_paid cpd ON cpd.plot_id = p.id
        WHERE p.site_id = $1 AND ${SOLD_PLOT} AND NULLIF(TRIM(p.booking_by),'') IS NOT NULL
          AND UPPER(TRIM(p.booking_by)) NOT IN ('COMPANY', 'NOT FOR SALE', 'SELF')
        GROUP BY 1 ORDER BY collected DESC LIMIT 20`, [siteId]),
    q(`SELECT (SELECT COUNT(*) FROM members m WHERE ${CLIENT} AND EXISTS (SELECT 1 FROM plots p WHERE p.site_id = $1 AND UPPER(TRIM(p.buyer_name)) = UPPER(TRIM(m.full_name))))::int AS linked_members,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM members m WHERE ${CLIENT} AND UPPER(TRIM(m.full_name)) = UPPER(TRIM(p.buyer_name))))::int AS plots_linked,
              COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM members m WHERE ${CLIENT} AND UPPER(TRIM(m.full_name)) = UPPER(TRIM(p.buyer_name))))::int AS plots_unlinked
         FROM plots p WHERE p.site_id = $1 AND ${SOLD_PLOT}`, [siteId]),
  ]);
  const c = comp[0]; const t = num(c.total);
  return {
    site_id: siteId,
    total: num(total[0].total),
    by_type: byType,
    completeness: {
      phone_pct: pct(c.phone, t), email_pct: pct(c.email, t), address_pct: pct(c.address, t), city_pct: pct(c.city, t), pincode_pct: pct(c.pincode, t),
      occupation_pct: pct(c.occupation, t), dob_pct: pct(c.dob, t), kyc_pct: pct(kyc[0].verified, t), geo_pct: pct(c.geo, t),
      missing_address: t - num(c.address), missing_occupation: t - num(c.occupation),
    },
    by_occupation: occ, by_city: city, by_state: state, by_gender: gender, by_age_band: age, by_qualification: qual, by_team: team,
    new_by_month: newByMonth,
    buyers: rowsNum(linked, ['linked_members', 'plots_linked', 'plots_unlinked'])[0],
    top_clients: rowsNum(topClients, ['plots', 'total_paid', 'outstanding']),
    agents: rowsNum(agents, ['plots', 'sale_value', 'collected', 'commission_decided', 'commission_paid']).map((a) => ({ ...a, collected_pct: pct(a.collected, a.sale_value) })),
    generated_at: new Date().toISOString(),
  };
};

/** GET /management-analytics/clients?site_id → { clients } */
export const getClients = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  res.json({ clients: await clientsData(scope.siteId) });
});

// ── Client map ──────────────────────────────────────────────────────────────
/** GET /management-analytics/clients/map?site_id → { map } */
export const getClientMap = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  const { siteId } = scope;
  const MEMBER = `m.site_id = $1 AND LOWER(COALESCE(m.status,'active')) <> 'deleted'`;
  const [summary, points, unresolved, byCity, byPin] = await Promise.all([
    q(`SELECT COUNT(*)::int AS total, COUNT(m.latitude)::int AS geocoded,
              COUNT(*) FILTER (WHERE m.latitude IS NOT NULL AND m.geocode_source = 'manual')::int AS manual,
              COUNT(*) FILTER (WHERE m.latitude IS NOT NULL AND COALESCE(m.geocode_source,'') <> 'manual')::int AS approx
         FROM members m WHERE ${MEMBER}`, [siteId]),
    // ponytail: no server-side filtering/paging; 3000-point cap is far above any site today.
    q(`WITH ${PAY_CTE}, ${PLOT_PAID_CTE}
       SELECT m.id, m.full_name AS name, UPPER(COALESCE(m.member_type,'OTHER')) AS member_type, m.city, m.village, m.district, m.pincode,
              m.latitude::float AS lat, m.longitude::float AS lng, COALESCE(m.geocode_source,'unknown') AS source, COALESCE(m.geocode_precision,'') AS precision,
              COALESCE((SELECT SUM(pp.collected) FROM plots p JOIN plot_paid pp ON pp.plot_id = p.id
                         WHERE p.site_id = $1 AND UPPER(TRIM(p.buyer_name)) = UPPER(TRIM(m.full_name))),0)::numeric(18,2) AS total_paid
         FROM members m WHERE ${MEMBER} AND m.latitude IS NOT NULL AND m.longitude IS NOT NULL
        ORDER BY m.id LIMIT 3000`, [siteId]),
    q(`SELECT COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE NULLIF(TRIM(m.city),'') IS NULL AND COALESCE(m.pincode,'') !~ '^\\d{6}$')::int AS no_address
         FROM members m WHERE ${MEMBER} AND m.latitude IS NULL`, [siteId]),
    q(`SELECT UPPER(TRIM(m.city)) AS label, COUNT(*)::int AS count FROM members m
        WHERE ${MEMBER} AND m.latitude IS NULL AND NULLIF(TRIM(m.city),'') IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [siteId]),
    q(`SELECT TRIM(m.pincode) AS label, COUNT(*)::int AS count FROM members m
        WHERE ${MEMBER} AND m.latitude IS NULL AND COALESCE(m.pincode,'') ~ '^\\d{6}$' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, [siteId]),
  ]);
  const pts = rowsNum(points, ['total_paid']);
  const center = pts.length
    ? { lat: pts.reduce((s, p) => s + p.lat, 0) / pts.length, lng: pts.reduce((s, p) => s + p.lng, 0) / pts.length }
    : null;
  res.json({
    map: {
      site_id: siteId,
      summary: summary[0],
      points: pts,
      unresolved: { ...unresolved[0], by_city: byCity, by_pincode: byPin },
      center,
      generated_at: new Date().toISOString(),
    },
  });
});

// ── Payment behaviour ───────────────────────────────────────────────────────
const SEGMENTS = [
  ['settled_fast', 'Settled fast', 'Paid 95%+ of the sale price within 90 days of the first receipt.'],
  ['settled', 'Settled', 'Paid 95%+ of the sale price, taking more than 90 days.'],
  ['steady', 'Steady', 'Balance outstanding, with a receipt in the last 90 days.'],
  ['slow', 'Slow', 'Balance outstanding; last receipt 91-180 days ago.'],
  ['stalled', 'Stalled', 'Balance outstanding and no receipt for 180+ days.'],
  ['no_payment', 'No payment', 'Sold plot with no approved receipt on the ledger.'],
];
const median = (arr) => {
  const a = arr.filter((v) => v != null && Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
};
const mean = (arr) => { const a = arr.filter((v) => v != null && Number.isFinite(v)); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : null; };
const sizeBand = (size) => (!size ? 'Unknown' : size < 100 ? '< 100' : size < 150 ? '100-149' : size < 200 ? '150-199' : size < 300 ? '200-299' : '300+');

const groupPlots = (plots, keyFn) => {
  const g = new Map();
  for (const p of plots) {
    const k = keyFn(p);
    if (k == null) continue;
    const e = g.get(k) || { plots: 0, sale_value: 0, collected: 0, outstanding: 0, stalled: 0, settle: [] };
    e.plots += 1; e.sale_value += p.sale_price; e.collected += p.collected; e.outstanding += p.outstanding;
    if (p.segment === 'stalled') e.stalled += 1;
    if (p.days_to_settle != null) e.settle.push(p.days_to_settle);
    g.set(k, e);
  }
  const r2 = (v) => Math.round(v * 100) / 100; // keep float sums tidy (no 13900.520000000019)
  return [...g.entries()].map(([k, e]) => ({ key: k, plots: e.plots, sale_value: r2(e.sale_value), collected: r2(e.collected), outstanding: r2(e.outstanding), stalled: e.stalled, collected_pct: pct(e.collected, e.sale_value), avg_days_to_settle: mean(e.settle) == null ? null : Math.round(mean(e.settle)) }));
};

const paymentBehaviourData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  // Receipts only: negative plot_payments rows are refunds/reversals, which are not payment behaviour (flows stay gross).
  const RECEIPT = `FROM plot_payments pp WHERE pp.site_id = $1 AND ${APPROVED_PP} AND pp.amount > 0 AND pp.date >= $2::date AND pp.date <= LEAST($3::date, CURRENT_DATE)`;
  const [plots, modes, bounce, dom, weekday, monthly, inst] = await Promise.all([
    // ONE per-plot facts query (a few hundred rows): receipts, settle date (running sum crossing 95%), amounts
    // collected within N days of the first receipt, and the median gap between consecutive receipts.
    // ponytail: segments/blocks/bands/agents/cohorts/curve are derived in JS; move to SQL past ~5k plots.
    q(`WITH ${PAY_CTE}, ${PLOT_PAID_CTE},
       cum AS (SELECT pay.plot_id, pay.d, pay.amt, SUM(pay.amt) OVER (PARTITION BY pay.plot_id ORDER BY pay.d, pay.amt) AS cum,
                      pay.d - LAG(pay.d) OVER (PARTITION BY pay.plot_id ORDER BY pay.d, pay.amt) AS gap FROM pay WHERE pay.amt > 0),
       settled AS (SELECT c.plot_id, MIN(c.d) AS settle_date FROM cum c JOIN plots p ON p.id = c.plot_id WHERE c.cum >= 0.95 * p.sale_price GROUP BY c.plot_id),
       win AS (SELECT c.plot_id,
                      SUM(c.amt) FILTER (WHERE c.d <= f.first_pay + 30) AS a30, SUM(c.amt) FILTER (WHERE c.d <= f.first_pay + 60) AS a60,
                      SUM(c.amt) FILTER (WHERE c.d <= f.first_pay + 90) AS a90, SUM(c.amt) FILTER (WHERE c.d <= f.first_pay + 180) AS a180,
                      SUM(c.amt) FILTER (WHERE c.d <= f.first_pay + 365) AS a365,
                      percentile_cont(0.5) WITHIN GROUP (ORDER BY c.gap) FILTER (WHERE c.gap IS NOT NULL) AS median_gap
                 FROM cum c JOIN plot_paid f ON f.plot_id = c.plot_id GROUP BY c.plot_id)
       SELECT p.id AS plot_id, p.plot_no, p.block, p.buyer_name, p.sale_price::float, UPPER(TRIM(COALESCE(p.booking_by,''))) AS agent,
              COALESCE(p.plot_size, p.plot_size_mtr)::float AS plot_size, p.installments_enabled,
              COALESCE(pp.collected,0)::float AS collected, pp.payments, pp.first_pay::text, pp.last_pay::text,
              (s.settle_date - pp.first_pay)::int AS days_to_settle,
              (CURRENT_DATE - pp.last_pay)::int AS days_since_last_payment,
              w.a30::float, w.a60::float, w.a90::float, w.a180::float, w.a365::float, w.median_gap::float
         FROM plots p LEFT JOIN plot_paid pp ON pp.plot_id = p.id LEFT JOIN settled s ON s.plot_id = p.id LEFT JOIN win w ON w.plot_id = p.id
        WHERE p.site_id = $1 AND ${SOLD_PLOT} LIMIT 5000`, [siteId]),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(pp.payment_from)),''),'UNKNOWN') AS mode, SUM(pp.amount)::numeric(18,2) AS amount, COUNT(*)::int AS count ${RECEIPT} GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, P),
    q(`SELECT COUNT(*) FILTER (WHERE UPPER(COALESCE(pp.payment_from,'')) = 'CHEQUE' OR pp.cheque_no IS NOT NULL)::int AS cheques,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(pp.cheque_status,'')) IN ('BOUNCED','RETURNED'))::int AS bounced
         FROM plot_payments pp WHERE pp.site_id = $1 AND pp.date >= $2::date AND pp.date <= LEAST($3::date, CURRENT_DATE)`, P),
    q(`SELECT EXTRACT(DAY FROM pp.date)::int AS day, COUNT(*)::int AS count, SUM(pp.amount)::numeric(18,2) AS amount ${RECEIPT} GROUP BY 1 ORDER BY 1`, P),
    q(`SELECT TRIM(to_char(pp.date, 'Dy')) AS weekday, EXTRACT(ISODOW FROM pp.date)::int AS dow, COUNT(*)::int AS count, SUM(pp.amount)::numeric(18,2) AS amount ${RECEIPT} GROUP BY 1, 2 ORDER BY 2`, P),
    // Monthly collections intentionally has its own all-site timeline. The page-level
    // range still controls the other behaviour metrics, while this series powers a
    // year picker from the site's first recorded plot activity through today.
    q(`WITH bounds AS (
         SELECT COALESCE(
                  LEAST(
                    (SELECT MIN(l.entry_date) FROM ledger_entries l
                      WHERE l.site_id = $1 AND l.source_key IN ('plot_payments','plot_installment_payments') AND l.credit <> 0),
                    (SELECT MIN(COALESCE(p.booking_date, p.created_at::date)) FROM plots p WHERE p.site_id = $1)
                  ),
                  CURRENT_DATE
                ) AS first_date
       ), months AS (
         SELECT generate_series(date_trunc('month', first_date), date_trunc('month', CURRENT_DATE), INTERVAL '1 month') AS m
           FROM bounds
       )
       SELECT to_char(months.m, 'YYYY-MM') AS month, to_char(months.m, 'Mon YY') AS label,
              COALESCE(SUM(l.credit),0)::numeric(18,2) AS amount,
              COUNT(l.id) FILTER (WHERE l.credit > 0)::int AS count
         FROM months
         LEFT JOIN ledger_entries l ON l.site_id = $1
                                   AND l.source_key IN ('plot_payments','plot_installment_payments')
                                   AND l.credit <> 0
                                   AND l.entry_date <= CURRENT_DATE
                                   AND date_trunc('month', l.entry_date) = months.m
        GROUP BY months.m ORDER BY months.m`, [siteId]),
    q(`SELECT (SELECT COUNT(*) FROM plots WHERE site_id = $1 AND installments_enabled)::int AS plots_enabled,
              COUNT(*)::int AS schedules, COUNT(*) FILTER (WHERE i.due_date < CURRENT_DATE AND LOWER(COALESCE(i.status,'')) <> 'paid')::int AS due_past
         FROM plot_installments i JOIN plots p ON p.id = i.plot_id WHERE p.site_id = $1`, [siteId]),
  ]);

  const rows = plots.map((p) => {
    const sale = num(p.sale_price); const collected = num(p.collected);
    const outstanding = Math.max(sale - collected, 0);
    const paidPct = pct(collected, sale);
    const since = p.days_since_last_payment == null ? Infinity : p.days_since_last_payment;
    let segment;
    if (collected <= 0) segment = 'no_payment';
    else if (paidPct >= 95) segment = p.days_to_settle != null && p.days_to_settle <= 90 ? 'settled_fast' : 'settled';
    else if (since <= 90) segment = 'steady';
    else if (since <= 180) segment = 'slow';
    else segment = 'stalled';
    return { ...p, sale_price: sale, collected, outstanding, collected_pct: paidPct, payments: num(p.payments), segment };
  });
  const paidRows = rows.filter((r) => r.collected > 0);
  const sum = (arr, k) => arr.reduce((s, r) => s + num(r[k]), 0);
  const saleTotal = sum(rows, 'sale_price');
  const collectedTotal = sum(rows, 'collected');
  const modeRows = rowsNum(modes, ['amount', 'count']);
  const modeTotal = modeRows.reduce((s, r) => s + r.amount, 0);
  const cashAmt = modeRows.filter((r) => r.mode === 'CASH').reduce((s, r) => s + r.amount, 0);
  const b = rowsNum(bounce, ['cheques', 'bounced'])[0];
  const settle = rows.map((r) => r.days_to_settle);
  const gapMedians = paidRows.map((r) => (r.median_gap == null ? null : num(r.median_gap)));
  const byKey = (fn) => groupPlots(rows, fn);
  const WINDOWS = [30, 60, 90, 180, 365];
  const cohortMap = new Map();
  for (const r of paidRows) {
    const y = String(r.first_pay || '').slice(0, 4);
    if (!y) continue;
    const c = cohortMap.get(y) || { cohort: y, plots: 0, sale_value: 0, a30: 0, a90: 0, a180: 0, a365: 0, now: 0 };
    c.plots += 1; c.sale_value += r.sale_price; c.now += r.collected;
    for (const w of [30, 90, 180, 365]) c[`a${w}`] += num(r[`a${w}`]);
    cohortMap.set(y, c);
  }
  return {
    site_id: siteId,
    range: { from, to },
    anchor_note: 'Timing metrics are anchored on the first approved receipt per plot (booking dates are data-entry dates on older sites). Money figures come from the ledger; only approved, non-bounced receipts count.',
    summary: {
      plots: rows.length, buyers: new Set(rows.map((r) => String(r.buyer_name || '').trim().toUpperCase()).filter(Boolean)).size,
      sale_value: saleTotal, collected: collectedTotal, collected_pct: pct(collectedTotal, saleTotal), outstanding: sum(rows, 'outstanding'),
      median_days_to_settle: median(settle), avg_days_to_settle: mean(settle) == null ? null : Math.round(mean(settle)),
      // ponytail: median of per-plot median gaps (one row per plot), not the global median over every receipt pair.
      median_gap_days: median(gapMedians) == null ? null : Math.round(median(gapMedians)),
      avg_payments_per_plot: paidRows.length ? Math.round((paidRows.reduce((s, r) => s + r.payments, 0) / paidRows.length) * 10) / 10 : 0,
      bounce_rate: pct(b.bounced, b.cheques), cash_share: pct(cashAmt, modeTotal), bank_share: pct(modeTotal - cashAmt, modeTotal),
    },
    segments: SEGMENTS.map(([key, label, description]) => {
      const inSeg = rows.filter((r) => r.segment === key);
      return { key, label, description, count: inSeg.length, sale_value: inSeg.reduce((s, r) => s + r.sale_price, 0), collected: inSeg.reduce((s, r) => s + r.collected, 0), outstanding: inSeg.reduce((s, r) => s + r.outstanding, 0) };
    }),
    collection_curve: WINDOWS.map((days) => ({ days, pct: pct(sum(paidRows, `a${days}`), sum(paidRows, 'sale_price')) })),
    cohorts: [...cohortMap.values()].sort((x, y) => y.cohort.localeCompare(x.cohort)).slice(0, 12)
      .map((c) => ({ cohort: c.cohort, plots: c.plots, sale_value: Math.round(c.sale_value * 100) / 100, pct_30: pct(c.a30, c.sale_value), pct_90: pct(c.a90, c.sale_value), pct_180: pct(c.a180, c.sale_value), pct_365: pct(c.a365, c.sale_value), pct_now: pct(c.now, c.sale_value) })),
    modes: modeRows.map((r) => ({ ...r, share: pct(r.amount, modeTotal) })),
    bounce: b,
    day_of_month: rowsNum(dom, ['day', 'count', 'amount']),
    weekday: rowsNum(weekday, ['count', 'amount']).map((r) => ({ weekday: r.weekday, count: r.count, amount: r.amount })),
    monthly: rowsNum(monthly, ['amount', 'count']),
    blocks: byKey((p) => (p.block ? String(p.block).trim().toUpperCase() : null)).map((e) => ({ block: e.key, plots: e.plots, collected_pct: e.collected_pct, outstanding: e.outstanding })).sort((a, b2) => b2.plots - a.plots).slice(0, 15),
    size_bands: byKey((p) => sizeBand(num(p.plot_size))).map((e) => ({ band: e.key, plots: e.plots, collected_pct: e.collected_pct, avg_days_to_settle: e.avg_days_to_settle })),
    agents: byKey((p) => (p.agent && !['COMPANY', 'NOT FOR SALE', 'SELF'].includes(p.agent) ? p.agent : null))
      .map((e) => ({ agent: e.key, plots: e.plots, sale_value: e.sale_value, collected: e.collected, collected_pct: e.collected_pct, avg_days_to_settle: e.avg_days_to_settle, stalled: e.stalled }))
      .sort((a, b2) => b2.collected - a.collected).slice(0, 20),
    fastest: rows.filter((r) => r.days_to_settle != null).sort((a, b2) => a.days_to_settle - b2.days_to_settle || b2.sale_price - a.sale_price).slice(0, 15)
      .map((r) => ({ plot_id: r.plot_id, plot_no: r.plot_no, block: r.block, buyer_name: r.buyer_name, sale_price: r.sale_price, days_to_settle: r.days_to_settle, payments: r.payments })),
    slowest: rows.filter((r) => r.outstanding > 0).sort((a, b2) => b2.outstanding - a.outstanding).slice(0, 15)
      .map((r) => ({ plot_id: r.plot_id, plot_no: r.plot_no, block: r.block, buyer_name: r.buyer_name, sale_price: r.sale_price, outstanding: r.outstanding, collected_pct: r.collected_pct, days_since_last_payment: r.days_since_last_payment, last_payment: r.last_pay })),
    installments: {
      ...rowsNum(inst, ['plots_enabled', 'schedules', 'due_past'])[0],
      note: 'Installment schedules are barely populated, so on-time vs late by due date is not reported; settlement speed above uses receipt dates instead.',
    },
    generated_at: new Date().toISOString(),
  };
};

/** GET /management-analytics/payment-behaviour?site_id&from&to → { payment_behaviour } */
export const getPaymentBehaviour = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res);
  if (!scope) return;
  res.json({ payment_behaviour: await paymentBehaviourData(scope.siteId, scope) });
});

// ── Registry analytics ──────────────────────────────────────────────────────
const registryAnalyticsData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  const DATE = `COALESCE(pr.registry_date, pr.created_entry_date, pr.created_at::date)`;
  const [summary, monthly, workflow, farmers, firms, agents, rows, handovers] = await Promise.all([
    q(`WITH ${REG_PAY_CTE}
       SELECT COUNT(*)::int AS registries,
              COUNT(pr.noc_generated_at)::int AS noc_generated,
              COUNT(pr.noc_approved_at)::int AS noc_approved,
              COUNT(*) FILTER (WHERE pr.noc_generated_at IS NULL)::int AS noc_pending,
              COALESCE(SUM(pr.registry_payment),0)::numeric(18,2) AS declared_value,
              COALESCE(SUM(rp.mapped_amount),0)::numeric(18,2) AS mapped_amount,
              COALESCE(SUM(pr.bank_amount),0)::numeric(18,2) AS bank_amount,
              COALESCE(ROUND((AVG(pr.noc_generated_at::date - ${DATE})
                FILTER (WHERE pr.noc_generated_at IS NOT NULL))::numeric, 0),0)::int AS avg_days_to_noc
         FROM plot_registries pr LEFT JOIN reg_pay rp ON rp.registry_id = pr.id
        WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date, CURRENT_DATE)`, P),
    q(`WITH ${REG_PAY_CTE}, scoped AS (
         SELECT pr.id, ${DATE} AS d, COALESCE(rp.mapped_amount,0) AS mapped_amount
           FROM plot_registries pr LEFT JOIN reg_pay rp ON rp.registry_id = pr.id
          WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date, CURRENT_DATE)
       )
       SELECT to_char(g.m, 'YYYY-MM') AS month, to_char(g.m, 'Mon YY') AS label,
              COUNT(s.id)::int AS count, COALESCE(SUM(s.mapped_amount),0)::numeric(18,2) AS mapped_amount
         FROM generate_series(date_trunc('month',$2::date), date_trunc('month',LEAST($3::date,CURRENT_DATE)), INTERVAL '1 month') g(m)
         LEFT JOIN scoped s ON date_trunc('month',s.d) = g.m
        GROUP BY g.m ORDER BY g.m`, P),
    q(`SELECT CASE
                WHEN EXISTS (SELECT 1 FROM registry_document_handovers h WHERE h.registry_id = pr.id) THEN 'Documents handed over'
                WHEN pr.noc_approved_at IS NOT NULL THEN 'NOC approved'
                WHEN pr.noc_generated_at IS NOT NULL THEN 'NOC generated'
                ELSE 'Registry recorded'
              END AS label, COUNT(*)::int AS count
         FROM plot_registries pr
        WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC`, P),
    q(`SELECT COALESCE(NULLIF(TRIM(pr.farmer_name),''),'Unspecified') AS label, COUNT(*)::int AS count
         FROM plot_registries pr WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, P),
    q(`SELECT COALESCE(NULLIF(TRIM(pr.firm_name),''),'Unspecified') AS label, COUNT(*)::int AS count
         FROM plot_registries pr WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, P),
    q(`SELECT COALESCE(NULLIF(TRIM(p.booking_by),''),'Unspecified') AS label, COUNT(*)::int AS count
         FROM plot_registries pr LEFT JOIN plots p ON p.id = pr.plot_id
        WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`, P),
    q(`WITH ${REG_PAY_CTE}
       SELECT pr.id, pr.plot_id, pr.plot_no, pr.customer_name, ${DATE}::text AS registry_date,
              pr.farmer_name, pr.firm_name, COALESCE(p.booking_by,'') AS agent,
              COALESCE(rp.mapped_amount,0)::numeric(18,2) AS mapped_amount,
              COALESCE(rp.payment_count,0)::int AS payment_count,
              pr.noc_generated_at::date::text AS noc_date, pr.noc_approved_at::date::text AS noc_approved_date,
              (CURRENT_DATE - ${DATE})::int AS age_days,
              (SELECT COUNT(*)::int FROM documents d WHERE d.plot_id = pr.plot_id AND UPPER(COALESCE(d.category,'')) = 'REGISTRY') AS document_count,
              (SELECT COUNT(*)::int FROM registry_document_handovers h WHERE h.registry_id = pr.id) AS handover_count
         FROM plot_registries pr LEFT JOIN plots p ON p.id = pr.plot_id LEFT JOIN reg_pay rp ON rp.registry_id = pr.id
        WHERE pr.site_id = $1 AND ${DATE} >= $2::date AND ${DATE} <= LEAST($3::date,CURRENT_DATE)
        ORDER BY (pr.noc_generated_at IS NULL) DESC, ${DATE} DESC, pr.id DESC LIMIT 40`, P),
    q(`SELECT COUNT(*)::int AS handovers
         FROM registry_document_handovers h JOIN plot_registries pr ON pr.id = h.registry_id
        WHERE pr.site_id = $1 AND h.given_at::date >= $2::date AND h.given_at::date <= LEAST($3::date,CURRENT_DATE)`, P),
  ]);
  return {
    summary: { ...rowsNum(summary, ['registries', 'noc_generated', 'noc_approved', 'noc_pending', 'declared_value', 'mapped_amount', 'bank_amount', 'avg_days_to_noc'])[0], handovers: num(handovers[0].handovers) },
    monthly: rowsNum(monthly, ['count', 'mapped_amount']), workflow: rowsNum(workflow, ['count']),
    by_farmer: rowsNum(farmers, ['count']), by_firm: rowsNum(firms, ['count']), by_agent: rowsNum(agents, ['count']),
    registries: rowsNum(rows, ['mapped_amount', 'payment_count', 'age_days', 'document_count', 'handover_count']),
    generated_at: new Date().toISOString(),
  };
};

export const getRegistryAnalytics = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res); if (!scope) return;
  res.json({ registries: await registryAnalyticsData(scope.siteId, scope) });
});

// ── Expense analytics ───────────────────────────────────────────────────────
const expenseAnalyticsData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  const [summary, monthly, categories, modes, payees, coverage, pending, rows] = await Promise.all([
    q(`SELECT COALESCE(SUM(debit),0)::numeric(18,2) AS total,
              COALESCE(SUM(credit),0)::numeric(18,2) AS refunds,
              COUNT(*) FILTER (WHERE debit > 0)::int AS count,
              COALESCE(AVG(debit) FILTER (WHERE debit > 0),0)::numeric(18,2) AS average,
              COALESCE(MAX(debit),0)::numeric(18,2) AS largest,
              COALESCE(SUM(debit) FILTER (WHERE bucket = 'cash'),0)::numeric(18,2) AS cash,
              COALESCE(SUM(debit) FILTER (WHERE bucket = 'bank'),0)::numeric(18,2) AS bank
         FROM ledger_entries WHERE site_id = $1 AND source_key = 'expenses'
          AND entry_date >= $2::date AND entry_date <= LEAST($3::date,CURRENT_DATE)`, P),
    q(`SELECT to_char(g.m,'YYYY-MM') AS month, to_char(g.m,'Mon YY') AS label,
              COALESCE(SUM(l.debit),0)::numeric(18,2) AS amount,
              COUNT(l.id) FILTER (WHERE l.debit > 0)::int AS count
         FROM generate_series(date_trunc('month',$2::date),date_trunc('month',LEAST($3::date,CURRENT_DATE)),INTERVAL '1 month') g(m)
         LEFT JOIN ledger_entries l ON l.site_id = $1 AND l.source_key = 'expenses' AND date_trunc('month',l.entry_date) = g.m
        GROUP BY g.m ORDER BY g.m`, P),
    q(`SELECT COALESCE(NULLIF(TRIM(e.category),''),'Uncategorised') AS label,
              COALESCE(SUM(l.debit),0)::numeric(18,2) AS amount, COUNT(*) FILTER (WHERE l.debit > 0)::int AS count
         FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
        WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`, P),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(l.raw_mode)),''),UPPER(l.bucket),'UNKNOWN') AS label,
              COALESCE(SUM(l.debit),0)::numeric(18,2) AS amount, COUNT(*) FILTER (WHERE l.debit > 0)::int AS count
         FROM ledger_entries l WHERE l.site_id = $1 AND l.source_key = 'expenses'
          AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC`, P),
    q(`SELECT COALESCE(NULLIF(TRIM(e.to_entity),''),'Unspecified') AS label,
              COALESCE(SUM(l.debit),0)::numeric(18,2) AS amount, COUNT(*) FILTER (WHERE l.debit > 0)::int AS count
         FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
        WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC LIMIT 15`, P),
    q(`SELECT COUNT(*)::int AS posted,
              COUNT(*) FILTER (WHERE NULLIF(e.voucher_url,'') IS NOT NULL OR COALESCE(cardinality(e.voucher_urls),0) > 0)::int AS with_voucher,
              COUNT(*) FILTER (WHERE NULLIF(e.bill_url,'') IS NOT NULL OR COALESCE(cardinality(e.bill_urls),0) > 0)::int AS with_bill,
              COUNT(*) FILTER (WHERE NULLIF(e.customer_signature_url,'') IS NOT NULL)::int AS customer_signed,
              COUNT(*) FILTER (WHERE NULLIF(e.authority_signature_url,'') IS NOT NULL)::int AS authority_signed
         FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
        WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.debit > 0
          AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date,CURRENT_DATE)`, P),
    q(`SELECT COUNT(*) FILTER (WHERE LOWER(COALESCE(status,'')) = 'pending')::int AS pending_count,
              COALESCE(SUM(debit) FILTER (WHERE LOWER(COALESCE(status,'')) = 'pending'),0)::numeric(18,2) AS pending_amount,
              COUNT(*) FILTER (WHERE UPPER(COALESCE(cheque_status,'')) IN ('BOUNCED','RETURNED'))::int AS bounced
         FROM expenses WHERE site_id = $1 AND date >= $2::date AND date <= LEAST($3::date,CURRENT_DATE)`, P),
    q(`SELECT e.id, l.entry_date::text AS date, COALESCE(e.category,'Uncategorised') AS category,
              COALESCE(e.to_entity,'') AS payee, COALESCE(e.remark,'') AS remark,
              COALESCE(l.raw_mode,e.payment_mode,'') AS payment_mode, l.debit::numeric(18,2) AS amount,
              CASE WHEN NULLIF(e.voucher_url,'') IS NOT NULL OR COALESCE(cardinality(e.voucher_urls),0) > 0 THEN true ELSE false END AS has_voucher,
              CASE WHEN NULLIF(e.bill_url,'') IS NOT NULL OR COALESCE(cardinality(e.bill_urls),0) > 0 THEN true ELSE false END AS has_bill
         FROM ledger_entries l JOIN expenses e ON e.id = l.source_id
        WHERE l.site_id = $1 AND l.source_key = 'expenses' AND l.debit > 0
          AND l.entry_date >= $2::date AND l.entry_date <= LEAST($3::date,CURRENT_DATE)
        ORDER BY l.debit DESC, l.entry_date DESC LIMIT 40`, P),
  ]);
  return {
    summary: rowsNum(summary, ['total', 'refunds', 'count', 'average', 'largest', 'cash', 'bank'])[0],
    monthly: rowsNum(monthly, ['amount', 'count']), categories: rowsNum(categories, ['amount', 'count']),
    modes: rowsNum(modes, ['amount', 'count']), payees: rowsNum(payees, ['amount', 'count']),
    coverage: rowsNum(coverage, ['posted', 'with_voucher', 'with_bill', 'customer_signed', 'authority_signed'])[0],
    pending: rowsNum(pending, ['pending_count', 'pending_amount', 'bounced'])[0],
    largest: rowsNum(rows, ['amount']), generated_at: new Date().toISOString(),
  };
};

export const getExpenseAnalytics = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res); if (!scope) return;
  res.json({ expenses: await expenseAnalyticsData(scope.siteId, scope) });
});

// ── Vendor analytics ────────────────────────────────────────────────────────
const VENDOR_PAID_CTE = `vendor_paid AS (
  SELECT vp.commitment_id, SUM(l.debit)::numeric(18,2) AS paid
    FROM ledger_entries l JOIN vendor_payments vp ON vp.id = l.source_id
   WHERE l.site_id = $1 AND l.source_key = 'vendor_payments' GROUP BY vp.commitment_id)`;
const INVENTORY_PAID_CTE = `inventory_paid AS (
  SELECT vip.order_id, SUM(l.debit)::numeric(18,2) AS paid
    FROM ledger_entries l JOIN vendor_inventory_payments vip ON vip.id = l.source_id
   WHERE l.site_id = $1 AND l.source_key = 'vendor_inventory_payments' GROUP BY vip.order_id)`;

const vendorAnalyticsData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  const [summary, monthly, modes, heads, statuses, vendors, commitments, inventory] = await Promise.all([
    q(`WITH ${VENDOR_PAID_CTE}, ${INVENTORY_PAID_CTE}
       SELECT (SELECT COUNT(*) FROM vendor_commitments WHERE site_id = $1)::int AS commitments,
              (SELECT COUNT(*) FROM vendor_commitments WHERE site_id = $1 AND LOWER(status) = 'open')::int AS open_commitments,
              (SELECT COALESCE(SUM(contract_amount),0) FROM vendor_commitments WHERE site_id = $1)::numeric(18,2) AS contract_value,
              (SELECT COALESCE(SUM(paid),0) FROM vendor_paid)::numeric(18,2) AS commitment_paid,
              (SELECT COUNT(*) FROM vendor_commitments vc LEFT JOIN vendor_paid vp ON vp.commitment_id = vc.id
                WHERE vc.site_id = $1 AND vc.due_date < CURRENT_DATE AND LOWER(vc.status) = 'open' AND vc.contract_amount > COALESCE(vp.paid,0))::int AS overdue_commitments,
              (SELECT COUNT(*) FROM vendor_inventory_orders WHERE site_id = $1)::int AS inventory_orders,
              (SELECT COALESCE(SUM(net_amount),0) FROM vendor_inventory_orders WHERE site_id = $1 AND LOWER(status) <> 'cancelled')::numeric(18,2) AS inventory_value,
              (SELECT COALESCE(SUM(paid),0) FROM inventory_paid)::numeric(18,2) AS inventory_paid`, [siteId]),
    q(`SELECT to_char(g.m,'YYYY-MM') AS month, to_char(g.m,'Mon YY') AS label,
              COALESCE(SUM(l.debit) FILTER (WHERE l.source_key = 'vendor_payments'),0)::numeric(18,2) AS commitments,
              COALESCE(SUM(l.debit) FILTER (WHERE l.source_key = 'vendor_inventory_payments'),0)::numeric(18,2) AS inventory
         FROM generate_series(date_trunc('month',$2::date),date_trunc('month',LEAST($3::date,CURRENT_DATE)),INTERVAL '1 month') g(m)
         LEFT JOIN ledger_entries l ON l.site_id = $1 AND l.source_key IN ('vendor_payments','vendor_inventory_payments') AND date_trunc('month',l.entry_date) = g.m
        GROUP BY g.m ORDER BY g.m`, P),
    q(`SELECT COALESCE(NULLIF(UPPER(TRIM(raw_mode)),''),UPPER(bucket),'UNKNOWN') AS label,
              COALESCE(SUM(debit),0)::numeric(18,2) AS amount, COUNT(*) FILTER (WHERE debit > 0)::int AS count
         FROM ledger_entries WHERE site_id = $1 AND source_key IN ('vendor_payments','vendor_inventory_payments')
          AND entry_date >= $2::date AND entry_date <= LEAST($3::date,CURRENT_DATE)
        GROUP BY 1 ORDER BY 2 DESC`, P),
    q(`WITH ${VENDOR_PAID_CTE}
       SELECT COALESCE(NULLIF(TRIM(vc.head_name),''),'Uncategorised') AS label,
              COUNT(*)::int AS count, COALESCE(SUM(vc.contract_amount),0)::numeric(18,2) AS contract_value,
              COALESCE(SUM(vp.paid),0)::numeric(18,2) AS paid
         FROM vendor_commitments vc LEFT JOIN vendor_paid vp ON vp.commitment_id = vc.id
        WHERE vc.site_id = $1 GROUP BY 1 ORDER BY 3 DESC LIMIT 15`, [siteId]),
    q(`SELECT INITCAP(COALESCE(NULLIF(status,''),'unknown')) AS label, COUNT(*)::int AS count
         FROM vendor_commitments WHERE site_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`WITH ${VENDOR_PAID_CTE}
       SELECT vc.vendor_name AS label, COUNT(*)::int AS commitments,
              COALESCE(SUM(vc.contract_amount),0)::numeric(18,2) AS contract_value,
              COALESCE(SUM(vp.paid),0)::numeric(18,2) AS paid,
              COALESCE(SUM(GREATEST(vc.contract_amount - COALESCE(vp.paid,0),0)),0)::numeric(18,2) AS outstanding
         FROM vendor_commitments vc LEFT JOIN vendor_paid vp ON vp.commitment_id = vc.id
        WHERE vc.site_id = $1 GROUP BY vc.vendor_name ORDER BY outstanding DESC LIMIT 20`, [siteId]),
    q(`WITH ${VENDOR_PAID_CTE}
       SELECT vc.id, vc.vendor_name, vc.work_title, COALESCE(vc.head_name,'') AS head,
              vc.contract_amount::numeric(18,2), COALESCE(vp.paid,0)::numeric(18,2) AS paid,
              GREATEST(vc.contract_amount - COALESCE(vp.paid,0),0)::numeric(18,2) AS outstanding,
              vc.status, vc.start_date::text, vc.due_date::text,
              CASE WHEN vc.due_date < CURRENT_DATE AND LOWER(vc.status) = 'open' THEN (CURRENT_DATE - vc.due_date)::int ELSE 0 END AS overdue_days
         FROM vendor_commitments vc LEFT JOIN vendor_paid vp ON vp.commitment_id = vc.id
        WHERE vc.site_id = $1 ORDER BY outstanding DESC, vc.due_date NULLS LAST LIMIT 40`, [siteId]),
    q(`WITH ${INVENTORY_PAID_CTE}
       SELECT o.id, o.vendor_name, o.item_name, COALESCE(o.item_category,'') AS category, o.unit,
              o.qty_ordered::float, o.qty_received::float, o.net_amount::numeric(18,2),
              COALESCE(ip.paid,0)::numeric(18,2) AS paid,
              GREATEST(o.net_amount - COALESCE(ip.paid,0),0)::numeric(18,2) AS outstanding,
              o.status, o.order_date::text, o.expected_date::text
         FROM vendor_inventory_orders o LEFT JOIN inventory_paid ip ON ip.order_id = o.id
        WHERE o.site_id = $1 ORDER BY outstanding DESC, o.order_date DESC LIMIT 40`, [siteId]),
  ]);
  const s = rowsNum(summary, ['commitments', 'open_commitments', 'contract_value', 'commitment_paid', 'overdue_commitments', 'inventory_orders', 'inventory_value', 'inventory_paid'])[0];
  return {
    summary: { ...s, outstanding: Math.max(s.contract_value - s.commitment_paid, 0), inventory_outstanding: Math.max(s.inventory_value - s.inventory_paid, 0) },
    monthly: rowsNum(monthly, ['commitments', 'inventory']), modes: rowsNum(modes, ['amount', 'count']),
    heads: rowsNum(heads, ['count', 'contract_value', 'paid']), statuses: rowsNum(statuses, ['count']),
    vendors: rowsNum(vendors, ['commitments', 'contract_value', 'paid', 'outstanding']),
    commitments: rowsNum(commitments, ['contract_amount', 'paid', 'outstanding', 'overdue_days']),
    inventory: rowsNum(inventory, ['qty_ordered', 'qty_received', 'net_amount', 'paid', 'outstanding']),
    generated_at: new Date().toISOString(),
  };
};

export const getVendorAnalytics = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res); if (!scope) return;
  res.json({ vendors: await vendorAnalyticsData(scope.siteId, scope) });
});

// ── Construction analytics ─────────────────────────────────────────────────
const constructionAnalyticsData = async (siteId, { from, to }) => {
  const P = [siteId, from, to];
  const [summary, projectStatuses, taskStatuses, monthly, materials, requests, projects] = await Promise.all([
    q(`SELECT COUNT(*)::int AS projects,
              COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active_projects,
              COUNT(*) FILTER (WHERE status = 'DELAYED' OR (target_end_date < CURRENT_DATE AND status NOT IN ('COMPLETED','CANCELLED')))::int AS delayed_projects,
              COALESCE(SUM(budget),0)::numeric(18,2) AS budget,
              COALESCE(ROUND(AVG(progress_pct) FILTER (WHERE status NOT IN ('COMPLETED','CANCELLED'))),0)::int AS avg_progress,
              (SELECT COALESCE(SUM(qty * rate),0) FROM inventory_movements WHERE site_id = $1 AND movement_type = 'CONSUMPTION')::numeric(18,2) AS actual_cost,
              (SELECT COUNT(*) FROM construction_tasks t JOIN construction_projects p ON p.id = t.project_id
                WHERE p.site_id = $1 AND t.due_date < CURRENT_DATE AND t.status <> 'DONE')::int AS overdue_tasks,
              (SELECT COUNT(*) FROM construction_material_requests WHERE site_id = $1 AND status IN ('REQUESTED','PARTIALLY_FULFILLED'))::int AS pending_requests
         FROM construction_projects WHERE site_id = $1`, [siteId]),
    q(`SELECT INITCAP(REPLACE(COALESCE(status,'UNKNOWN'),'_',' ')) AS label, COUNT(*)::int AS count
         FROM construction_projects WHERE site_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`SELECT INITCAP(REPLACE(COALESCE(t.status,'UNKNOWN'),'_',' ')) AS label, COUNT(*)::int AS count
         FROM construction_tasks t JOIN construction_projects p ON p.id = t.project_id
        WHERE p.site_id = $1 GROUP BY 1 ORDER BY 2 DESC`, [siteId]),
    q(`SELECT to_char(g.m,'YYYY-MM') AS month, to_char(g.m,'Mon YY') AS label,
              COALESCE(SUM(im.qty * im.rate),0)::numeric(18,2) AS actual_cost,
              COUNT(im.id)::int AS movements
         FROM generate_series(date_trunc('month',$2::date),date_trunc('month',LEAST($3::date,CURRENT_DATE)),INTERVAL '1 month') g(m)
         LEFT JOIN inventory_movements im ON im.site_id = $1 AND im.movement_type = 'CONSUMPTION' AND date_trunc('month',im.created_at) = g.m
        GROUP BY g.m ORDER BY g.m`, P),
    q(`SELECT m.name AS label, m.unit, COALESCE(SUM(im.qty),0)::float AS quantity,
              COALESCE(SUM(im.qty * im.rate),0)::numeric(18,2) AS actual_cost,
              COUNT(im.id)::int AS movements
         FROM inventory_movements im JOIN inventory_materials m ON m.id = im.material_id
        WHERE im.site_id = $1 AND im.movement_type = 'CONSUMPTION'
          AND im.created_at::date >= $2::date AND im.created_at::date <= LEAST($3::date,CURRENT_DATE)
        GROUP BY m.id,m.name,m.unit ORDER BY actual_cost DESC LIMIT 20`, P),
    q(`SELECT COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE r.status IN ('REQUESTED','PARTIALLY_FULFILLED'))::int AS pending,
              COALESCE(SUM(i.qty_requested),0)::float AS requested_qty,
              COALESCE(SUM(i.qty_issued),0)::float AS issued_qty
         FROM construction_material_requests r LEFT JOIN construction_material_request_items i ON i.request_id = r.id
        WHERE r.site_id = $1`, [siteId]),
    q(`SELECT p.id, p.name, COALESCE(p.code,'') AS code, p.status, p.start_date::text, p.target_end_date::text,
              p.budget::numeric(18,2), p.progress_pct::int,
              COALESCE(a.actual_cost,0)::numeric(18,2) AS actual_cost,
              (p.budget - COALESCE(a.actual_cost,0))::numeric(18,2) AS budget_remaining,
              COALESCE(t.tasks,0)::int AS tasks, COALESCE(t.done_tasks,0)::int AS done_tasks,
              COALESCE(r.pending_requests,0)::int AS pending_requests
         FROM construction_projects p
         LEFT JOIN (SELECT project_id, SUM(qty*rate) AS actual_cost FROM inventory_movements WHERE site_id = $1 AND movement_type = 'CONSUMPTION' GROUP BY project_id) a ON a.project_id = p.id
         LEFT JOIN (SELECT project_id, COUNT(*) AS tasks, COUNT(*) FILTER (WHERE status = 'DONE') AS done_tasks FROM construction_tasks GROUP BY project_id) t ON t.project_id = p.id
         LEFT JOIN (SELECT project_id, COUNT(*) FILTER (WHERE status IN ('REQUESTED','PARTIALLY_FULFILLED')) AS pending_requests FROM construction_material_requests GROUP BY project_id) r ON r.project_id = p.id
        WHERE p.site_id = $1 ORDER BY (p.status IN ('DELAYED','ACTIVE')) DESC, p.target_end_date NULLS LAST LIMIT 40`, [siteId]),
  ]);
  const s = rowsNum(summary, ['projects', 'active_projects', 'delayed_projects', 'budget', 'avg_progress', 'actual_cost', 'overdue_tasks', 'pending_requests'])[0];
  const rq = rowsNum(requests, ['requests', 'pending', 'requested_qty', 'issued_qty'])[0];
  return {
    summary: { ...s, budget_remaining: s.budget - s.actual_cost, material_fulfilment_pct: pct(rq.issued_qty, rq.requested_qty) },
    project_statuses: rowsNum(projectStatuses, ['count']), task_statuses: rowsNum(taskStatuses, ['count']),
    monthly: rowsNum(monthly, ['actual_cost', 'movements']), materials: rowsNum(materials, ['quantity', 'actual_cost', 'movements']),
    requests: rq, projects: rowsNum(projects, ['budget', 'progress_pct', 'actual_cost', 'budget_remaining', 'tasks', 'done_tasks', 'pending_requests']),
    generated_at: new Date().toISOString(),
  };
};

export const getConstructionAnalytics = asyncHandler(async (req, res) => {
  const scope = await scopeOrReject(req, res); if (!scope) return;
  res.json({ construction: await constructionAnalyticsData(scope.siteId, scope) });
});

// ── AI snapshot (aggregates + names only; never phone/aadhaar/PAN/address/bank) ──
export const buildSiteSnapshot = async (siteId, range) => {
  // ponytail: sequential on purpose — the three builders fire ~40 queries; in parallel they exhaust the
  // 20-client pool and pg-pool's connectionTimeoutMillis fires on the queue wait (seen on Neon).
  const site = await siteInfo(siteId);
  const o = await overviewData(siteId, range);
  const c = await clientsData(siteId);
  const p = await paymentBehaviourData(siteId, range);
  const strip = (r) => ({ ...r, buyer_name: cleanText(r.buyer_name, 60) });
  return {
    site: cleanText(site.name, 80),
    period: `${range.from} to ${range.to}`,
    money: { ...o.money, monthly: o.money.monthly.slice(-12), by_source: o.money.by_source },
    plots: o.plots, receivables: o.receivables, commissions: o.commissions, farmers: o.farmers, vendors: o.vendors, construction: o.construction,
    expenses: { total: o.expenses.total, count: o.expenses.count, top_categories: o.expenses.by_category.slice(0, 8) },
    approvals: o.approvals, registries: o.registries, imprest: o.imprest, activity: o.activity,
    clients: {
      total: c.total, by_type: c.by_type, completeness: c.completeness,
      top_occupations: c.by_occupation.slice(0, 6), top_cities: c.by_city.slice(0, 6), new_by_month: c.new_by_month,
      top_clients: c.top_clients.slice(0, 8).map((r) => ({ name: cleanText(r.name, 60), plots: r.plots, total_paid: r.total_paid, outstanding: r.outstanding })),
      agents: c.agents.slice(0, 8).map((a) => ({ ...a, name: cleanText(a.name, 60) })),
    },
    payment_behaviour: {
      summary: p.summary, segments: p.segments.map(({ description, ...s }) => s), collection_curve: p.collection_curve, cohorts: p.cohorts.slice(0, 6),
      modes: p.modes, bounce: p.bounce, agents: p.agents.slice(0, 8).map((a) => ({ ...a, agent: cleanText(a.agent, 60) })),
      fastest: p.fastest.slice(0, 5).map(strip), largest_outstanding: p.slowest.slice(0, 8).map(strip), installments: p.installments,
      busiest_days_of_month: [...p.day_of_month].sort((a, b) => b.count - a.count).slice(0, 8).map((d) => ({ day: d.day, receipts: d.count, amount: Math.round(d.amount) })),
      by_weekday: p.weekday.map((w) => ({ weekday: w.weekday, receipts: w.count, amount: Math.round(w.amount) })),
      monthly_receipts: p.monthly.slice(-12).map((m) => ({ month: m.month, receipts: m.count, amount: Math.round(m.amount) })),
    },
  };
};
