import { attachModuleChequeDates } from './chequeDates.service.js';

const CHEQUE_REPORT_MODES = Object.freeze({ plot_payments: 'payment_type', expenses: 'payment_mode', vendor_payments: 'payment_mode',
  farmer_payments: 'payment_mode', day_book: 'payment_mode', cash_flow_entries: 'cash_type', firm_transactions: 'payment_mode' });
const chequeReportSource = (def) => {
  const [table, alias] = def.from.split(/\s+/);
  return CHEQUE_REPORT_MODES[table] ? { table, alias, mode: CHEQUE_REPORT_MODES[table] } : null;
};

/**
 * One source aggregation produces the report's totals, trend and dimension.
 * GROUPING SETS keeps joins/filtering to one pass; the separately limited detail
 * query avoids materializing every detail row in a large date range.
 * All SQL fragments are server-owned report definitions, never request values.
 */
export function reportReadQueries(def, dimension, bucket, where) {
  const amount = def.amount || 'NULL::numeric';
  const chequeSource = chequeReportSource(def);
  let detailFrom = def.from;
  const detailColumns = def.columns.map((column) => `${column.expr} AS "${column.key}"`);
  if (chequeSource) {
    const { table, alias, mode } = chequeSource;
    const mirror = table === 'cash_flow_entries' ? alias : 'report_cheque';
    if (table !== 'cash_flow_entries') detailFrom += ` LEFT JOIN cash_flow_entries report_cheque
      ON report_cheque.source_module = '${table}' AND report_cheque.source_id = ${alias}.id AND report_cheque.site_id = ${def.siteCol}`;
    detailColumns.push(`${alias}.id AS id`, `${alias}.id AS original_id`, `${def.siteCol} AS site_id`,
      `${alias}.${mode} AS payment_mode`, `${alias}.cheque_status`, `${alias}.cheque_no`,
      `TO_CHAR(${def.dateCol}, 'YYYY-MM-DD') AS cheque_apply_date`,
      `TO_CHAR(${mirror}.cheque_transaction_date, 'YYYY-MM-DD') AS cheque_transaction_date`);
    if (table === 'cash_flow_entries') detailColumns.push(`${alias}.source_module`, `${alias}.source_id`);
    if (table === 'day_book') detailColumns.push(...['farmer_payment_id', 'commission_id', 'cash_flow_entry_id', 'firm_transaction_id', 'plot_payment_id', 'vendor_payment_id']
      .map(key => `(to_jsonb(${alias})->>'${key}')::int AS ${key}`));
  }
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
    detail: `SELECT ${detailColumns.join(', ')}
      FROM ${detailFrom} WHERE ${where}
      ORDER BY ${def.dateCol} DESC NULLS LAST LIMIT $4`,
  };
}

export async function loadReportRows(db, { def, dimension, bucket, where, params, rowLimit }) {
  const queries = reportReadQueries(def, dimension, bucket, where);
  const [summary, detail] = await Promise.all([
    db.query(queries.summary, params),
    db.query(queries.detail, [...params, rowLimit]),
  ]);
  const chequeSource = chequeReportSource(def);
  if (chequeSource) await attachModuleChequeDates(detail.rows, db, chequeSource.table, params[0]);
  const data = summary.rows[0];
  return {
    totals: data.totals,
    trend: data.trend,
    breakdown: data.breakdown,
    rows: detail.rows,
  };
}
