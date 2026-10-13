// Retained pre-optimization SQL for equivalence checks and repeatable benchmarks.
export async function baselineReportRows(db, { def, dimension, bucket, where, params, rowLimit }) {
  const amount = def.amount || 'NULL::numeric';
  const [totals, trend, breakdown, rows] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS record_count,
      COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total,
      COALESCE(AVG(${amount}), 0)::numeric(18,2) AS average,
      COALESCE(MAX(${amount}), 0)::numeric(18,2) AS largest,
      MIN(${def.dateCol}) AS first_entry, MAX(${def.dateCol}) AS last_entry
      FROM ${def.from} WHERE ${where}`, params),
    db.query(`SELECT to_char(date_trunc('${bucket}', ${def.dateCol}), 'YYYY-MM-DD') AS bucket,
      COUNT(*)::int AS count, COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total
      FROM ${def.from} WHERE ${where} GROUP BY 1 ORDER BY 1`, params),
    db.query(`SELECT ${dimension.expr} AS label, COUNT(*)::int AS count,
      COALESCE(SUM(${amount}), 0)::numeric(18,2) AS total
      FROM ${def.from} WHERE ${where} GROUP BY 1
      ORDER BY ${def.amount ? 'total' : 'count'} DESC NULLS LAST LIMIT 12`, params),
    db.query(`SELECT ${def.columns.map(column => `${column.expr} AS "${column.key}"`).join(', ')}
      FROM ${def.from} WHERE ${where} ORDER BY ${def.dateCol} DESC NULLS LAST LIMIT $4`, [...params, rowLimit]),
  ]);
  return { totals: totals.rows[0], trend: trend.rows, breakdown: breakdown.rows, rows: rows.rows };
}

const date = value => value == null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
export const normaliseReportRows = data => ({
  ...data,
  totals: { ...data.totals, total: Number(data.totals.total), average: Number(data.totals.average),
    largest: Number(data.totals.largest), first_entry: date(data.totals.first_entry),
    last_entry: date(data.totals.last_entry) },
  trend: data.trend.map(row => ({ ...row, total: Number(row.total) })),
  // Ties have no specified secondary order in the original public contract.
  breakdown: data.breakdown.map(row => ({ ...row, total: Number(row.total) })).sort((a, b) => String(a.label).localeCompare(String(b.label))),
});
