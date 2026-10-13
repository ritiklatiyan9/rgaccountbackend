/**
 * One source aggregation produces the report's totals, trend and dimension.
 * GROUPING SETS keeps joins/filtering to one pass; the separately limited detail
 * query avoids materializing every detail row in a large date range.
 * All SQL fragments are server-owned report definitions, never request values.
 */
export function reportReadQueries(def, dimension, bucket, where) {
  const amount = def.amount || 'NULL::numeric';
  return {
    summary: `WITH source_rows AS (
      SELECT to_char(date_trunc('${bucket}', ${def.dateCol}), 'YYYY-MM-DD') AS bucket,
             ${dimension.expr} AS label, ${amount} AS amount, ${def.dateCol} AS entry_date
      FROM ${def.from} WHERE ${where}
    ), grouped AS (
      SELECT bucket, label, GROUPING(bucket, label) AS grouping,
             COUNT(*)::int AS count,
             COALESCE(SUM(amount), 0)::numeric(18,2) AS total,
             COALESCE(AVG(amount), 0)::numeric(18,2) AS average,
             COALESCE(MAX(amount), 0)::numeric(18,2) AS largest,
             MIN(entry_date) AS first_entry, MAX(entry_date) AS last_entry
      FROM source_rows GROUP BY GROUPING SETS ((), (bucket), (label))
    )
    SELECT
      (SELECT json_build_object('record_count', count, 'total', total,
         'average', average, 'largest', largest, 'first_entry', first_entry,
         'last_entry', last_entry) FROM grouped WHERE grouping = 3) AS totals,
      COALESCE((SELECT json_agg(json_build_object('bucket', bucket, 'count', count,
         'total', total) ORDER BY bucket) FROM grouped WHERE grouping = 1), '[]'::json) AS trend,
      COALESCE((SELECT json_agg(json_build_object('label', label, 'count', count,
         'total', total) ORDER BY ${def.amount ? 'total' : 'count'} DESC NULLS LAST)
        FROM (SELECT * FROM grouped WHERE grouping = 2
          ORDER BY ${def.amount ? 'total' : 'count'} DESC NULLS LAST LIMIT 12) top_groups), '[]'::json) AS breakdown`,
    detail: `SELECT ${def.columns.map((column) => `${column.expr} AS "${column.key}"`).join(', ')}
      FROM ${def.from} WHERE ${where}
      ORDER BY ${def.dateCol} DESC NULLS LAST LIMIT $4`,
  };
}

export async function loadReportRows(db, { def, dimension, bucket, where, params, rowLimit }) {
  const queries = reportReadQueries(def, dimension, bucket, where);
  const [summary, detail] = await Promise.all([
    db.query(queries.summary, params),
    db.query(queries.detail, [...params, rowLimit]),
  ]);
  const data = summary.rows[0];
  return {
    totals: data.totals,
    trend: data.trend,
    breakdown: data.breakdown,
    rows: detail.rows,
  };
}
