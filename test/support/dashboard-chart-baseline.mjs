// Preserve the pre-optimization date bounds for output and plan comparisons.
// The financial aggregation below range_series is deliberately unchanged.
export function dashboardChartBaselineSql(sql, excludeOldPlots = false) {
  const old = excludeOldPlots ? " AND (plt.plot_tag IS NULL OR plt.plot_tag != 'OLD')" : '';
  const oldP = excludeOldPlots ? " AND (p.plot_tag IS NULL OR p.plot_tag != 'OLD')" : '';
  const sources = [
    ['pp.date', 'plot_payments pp JOIN plots plt ON plt.id = pp.plot_id', `pp.site_id = $1${old}`],
    ['pip.payment_date', 'plot_installment_payments pip JOIN plots p ON p.id = pip.plot_id', `p.site_id = $1${oldP}`],
    ['ldp.date', 'land_deal_payments ldp JOIN land_deals ld ON ld.id = ldp.land_deal_id', "ld.site_id = $1 AND ld.status IN ('open', 'completed')"],
    ['fp.date', 'farmer_payments fp JOIN farmers f ON f.id = fp.farmer_id', 'f.site_id = $1'],
    ['date', 'expenses', 'site_id = $1'],
    ['date', 'plot_commission_payments', 'site_id = $1'],
    ['payment_date', 'vendor_payments', 'site_id = $1'],
    ['payment_date', 'vendor_inventory_payments', 'site_id = $1 AND source_vendor_payment_id IS NULL'],
  ];
  const bounds = (aggregate, name) => `${name} AS (
    SELECT ${aggregate}(d) AS ${aggregate === 'MIN' ? 'min_date' : 'max_date'} FROM (
      ${sources.map(([date, from, where]) => `SELECT ${aggregate}(${date}) AS d FROM ${from}
        WHERE ${where} AND ${date} >= $2 AND ${date} < $3`).join('\nUNION ALL\n')}
    ) sub
  )`;
  const tail = sql.slice(sql.indexOf('range_series AS'));
  if (!tail.startsWith('range_series AS')) throw new Error('Dashboard chart SQL has no range_series');
  return `WITH ${bounds('MIN', 'first_entry')}, ${bounds('MAX', 'last_entry')}, ${tail}`
    .replace('FROM date_bounds', 'FROM first_entry').replace('FROM date_bounds', 'FROM last_entry')
    .replace(/CASE WHEN \$4 = 'quarter' THEN interval '3 months'\s+ELSE \('1 ' \|\| \$4::text\)::interval END/, "('1 ' || $4::text)::interval");
}
