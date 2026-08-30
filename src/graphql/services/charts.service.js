/**
 * Chart Service — Pre-aggregated data for dashboard charts.
 * All computation in PostgreSQL; frontend receives ready-to-render arrays.
 */
import pool from '../../config/db.js';

/**
 * Revenue vs Expense trend — grouped by resolution.
 * Used for both area chart and bar chart.
 */
export async function getRevenueVsExpense(siteId, start, end, resolution = 'MONTH', excludeOldPlots = false) {
  const truncFn = resolution === 'DAY' ? 'day'
    : resolution === 'WEEK' ? 'week'
    : resolution === 'QUARTER' ? 'quarter'
    : resolution === 'YEAR' ? 'year'
    : 'month';

  const oldFilter = excludeOldPlots ? `AND (plt.plot_tag IS NULL OR plt.plot_tag != 'OLD')` : '';
  const oldFilterP = excludeOldPlots ? `AND (p.plot_tag IS NULL OR p.plot_tag != 'OLD')` : '';

  const { rows } = await pool.query(
    `WITH first_entry AS (
       -- Earliest actual data date for this site (avoids empty leading buckets)
       SELECT MIN(d) AS min_date FROM (
         SELECT MIN(pp.date) AS d FROM plot_payments pp JOIN plots plt ON plt.id = pp.plot_id WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3 ${oldFilter}
         UNION ALL
         SELECT MIN(pip.payment_date) FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3 ${oldFilterP}
         UNION ALL
         SELECT MIN(ldp.date) FROM land_deal_payments ldp JOIN land_deals ld ON ld.id = ldp.land_deal_id WHERE ld.site_id = $1 AND ld.status IN ('open', 'completed') AND ldp.date >= $2 AND ldp.date < $3
         UNION ALL
         SELECT MIN(fp.date) FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         UNION ALL
         SELECT MIN(date)    AS d FROM expenses                 WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MIN(date)    AS d FROM plot_commission_payments WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MIN(payment_date) FROM vendor_payments          WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
       ) sub
     ),
     last_entry AS (
       -- Latest actual data date for this site. The 'overall' preset sends
       -- end = 2100-01-01, which would otherwise produce ~74 empty yearly
       -- buckets stretching out to 2099. Cap the upper bound at the real
       -- max data date so the chart only spans years that actually contain
       -- entries.
       SELECT MAX(d) AS max_date FROM (
         SELECT MAX(pp.date) AS d FROM plot_payments pp JOIN plots plt ON plt.id = pp.plot_id WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3 ${oldFilter}
         UNION ALL
         SELECT MAX(pip.payment_date) FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3 ${oldFilterP}
         UNION ALL
         SELECT MAX(ldp.date) FROM land_deal_payments ldp JOIN land_deals ld ON ld.id = ldp.land_deal_id WHERE ld.site_id = $1 AND ld.status IN ('open', 'completed') AND ldp.date >= $2 AND ldp.date < $3
         UNION ALL
         SELECT MAX(fp.date) FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         UNION ALL
         SELECT MAX(date)    AS d FROM expenses                 WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MAX(date)    AS d FROM plot_commission_payments WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MAX(payment_date) FROM vendor_payments          WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
       ) sub
     ),
     range_series AS (
       SELECT generate_series(
         date_trunc($4::text, COALESCE((SELECT min_date FROM first_entry), $2::date)),
         -- Upper bound = LEAST(requested end − 1 day, latest actual data date).
         -- For "Today / This Week / This Month / This Year" the requested
         -- end is recent so LEAST is a no-op. For "Overall" (end = 2100-01-01)
         -- it shrinks the series to the real max data date — no empty tail.
         date_trunc($4::text, LEAST(
           $3::date - interval '1 day',
           COALESCE((SELECT max_date FROM last_entry), $3::date - interval '1 day')
         )),
         ('1 ' || $4::text)::interval
       )::date AS bucket
     ),
     earn AS (
       SELECT date_trunc($4::text, entry_date)::date AS bucket, COALESCE(SUM(credit), 0)::numeric AS total
       FROM ledger_entries le
       WHERE le.site_id = $1 AND le.entry_date >= $2 AND le.entry_date < $3
         AND le.source_key IN ('plot_payments', 'plot_installment_payments', 'land_deal_payments')
         AND ($5::boolean = FALSE OR le.plot_tag <> 'OLD')
         AND (
           le.source_key <> 'land_deal_payments'
           OR EXISTS (
             SELECT 1
             FROM land_deal_payments ldp
             JOIN land_deals ld ON ld.id = ldp.land_deal_id
             WHERE ldp.id = le.source_id AND ld.status IN ('open', 'completed')
           )
         )
       GROUP BY 1
     ),
     exp AS (
       SELECT date_trunc($4::text, entry_date)::date AS bucket, COALESCE(SUM(debit), 0)::numeric AS total
       FROM ledger_entries
       WHERE site_id = $1 AND entry_date >= $2 AND entry_date < $3
         AND debit <> 0
         AND source_key NOT IN ('plot_payments', 'plot_installment_payments', 'day_book', 'misc_income_entries', 'firm_transactions')
         AND ledger_type <> 'person'
       GROUP BY 1
     )
     SELECT rs.bucket AS date,
            to_char(rs.bucket, CASE
              WHEN $4 = 'day' THEN 'DD Mon'
              WHEN $4 = 'week' THEN 'DD Mon'
              WHEN $4 = 'month' THEN 'Mon YY'
              WHEN $4 = 'quarter' THEN '"Q"Q YY'
              ELSE 'YYYY'
            END) AS label,
            COALESCE(e.total, 0) AS revenue,
            COALESCE(x.total, 0) AS expense
     FROM range_series rs
     LEFT JOIN earn e ON e.bucket = rs.bucket
     LEFT JOIN exp  x ON x.bucket = rs.bucket
     ORDER BY rs.bucket`,
    [siteId, start, end, truncFn, excludeOldPlots]
  );

  return rows.map(r => ({
    date: r.date,
    label: r.label,
    revenue: parseFloat(r.revenue) || 0,
    expense: parseFloat(r.expense) || 0,
  }));
}

/**
 * Net profit trend — simple revenue minus expense per bucket.
 */
export async function getProfitTrend(siteId, start, end, resolution = 'MONTH', excludeOldPlots = false) {
  const data = await getRevenueVsExpense(siteId, start, end, resolution, excludeOldPlots);
  return data.map(d => ({
    date: d.date,
    label: d.label,
    value: d.revenue - d.expense,
  }));
}

/**
 * Expense category breakdown — top N categories.
 */
export async function getExpenseByCategory(siteId, start, end, top = 8) {
  const { rows } = await pool.query(
    `SELECT category, COALESCE(SUM(debit), 0)::numeric AS total
     FROM expenses
     WHERE site_id = $1 AND date >= $2 AND date < $3
       AND financial_transaction_posts('debit', status, payment_mode, cheque_status)
       AND debit > 0
     GROUP BY category
     ORDER BY total DESC
     LIMIT $4`,
    [siteId, start, end, top]
  );
  return rows.map(r => ({ category: r.category || 'Uncategorized', amount: parseFloat(r.total) || 0 }));
}
