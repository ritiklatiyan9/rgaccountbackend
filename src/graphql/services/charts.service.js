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
       -- Find the earliest actual data date for this site (avoids empty leading buckets)
       SELECT MIN(d) AS min_date FROM (
         SELECT MIN(pp.date) AS d FROM plot_payments pp JOIN plots plt ON plt.id = pp.plot_id WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3 ${oldFilter}
         UNION ALL
         SELECT MIN(pip.payment_date) FROM plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3 ${oldFilterP}
         UNION ALL
         SELECT MIN(fp.date) FROM farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
         UNION ALL
         SELECT MIN(date)    AS d FROM expenses                 WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MIN(payment_date) FROM plot_registry_payments   WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
         UNION ALL
         SELECT MIN(date)    AS d FROM plot_commission_payments WHERE site_id = $1 AND date >= $2 AND date < $3
         UNION ALL
         SELECT MIN(payment_date) FROM vendor_payments          WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
       ) sub
     ),
     range_series AS (
       SELECT generate_series(
         date_trunc($4::text, COALESCE((SELECT min_date FROM first_entry), $2::date)),
         date_trunc($4::text, $3::date - interval '1 day'),
         ('1 ' || $4::text)::interval
       )::date AS bucket
     ),
     earn AS (
       SELECT date_trunc($4::text, date)::date AS bucket, COALESCE(SUM(amount), 0)::numeric AS total
       FROM (
         SELECT pp.date, pp.amount FROM plot_payments pp
         JOIN plots plt ON plt.id = pp.plot_id
         WHERE pp.site_id = $1 AND pp.date >= $2 AND pp.date < $3
           AND (pp.cheque_status IS NULL OR pp.cheque_status NOT IN ('BOUNCED','RETURNED'))
           ${oldFilter}
         UNION ALL
         SELECT pip.payment_date AS date, pip.amount FROM plot_installment_payments pip
         JOIN plots p ON p.id = pip.plot_id
         WHERE p.site_id = $1 AND pip.payment_date >= $2 AND pip.payment_date < $3
           AND (pip.cheque_status IS NULL OR pip.cheque_status NOT IN ('BOUNCED','RETURNED'))
           ${oldFilterP}
       ) u
       GROUP BY 1
     ),
     exp AS (
       SELECT date_trunc($4::text, date)::date AS bucket, COALESCE(SUM(debit), 0)::numeric AS total
       FROM (
         SELECT fp.date, fp.amount AS debit FROM farmer_payments fp
         JOIN farmers f ON f.id = fp.farmer_id
         WHERE f.site_id = $1 AND fp.date >= $2 AND fp.date < $3
           AND (fp.cheque_status IS NULL OR fp.cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT date, debit FROM expenses
         WHERE site_id = $1 AND date >= $2 AND date < $3
           AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT payment_date AS date, amount AS debit FROM plot_registry_payments
         WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
           AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT date, amount AS debit FROM plot_commissions
         WHERE site_id = $1 AND date >= $2 AND date < $3
           AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT date, amount AS debit FROM plot_commission_payments
         WHERE site_id = $1 AND date >= $2 AND date < $3
           AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
         UNION ALL
         SELECT payment_date AS date, amount AS debit FROM vendor_payments
         WHERE site_id = $1 AND payment_date >= $2 AND payment_date < $3
           AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       ) u
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
    [siteId, start, end, truncFn]
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
       AND (cheque_status IS NULL OR cheque_status NOT IN ('BOUNCED','RETURNED'))
       AND debit > 0
     GROUP BY category
     ORDER BY total DESC
     LIMIT $4`,
    [siteId, start, end, top]
  );
  return rows.map(r => ({ category: r.category || 'Uncategorized', amount: parseFloat(r.total) || 0 }));
}
