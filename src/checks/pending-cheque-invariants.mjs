import 'dotenv/config';
import pool from '../config/db.js';

const SOURCES = Object.freeze([
  { table: 'farmer_payments', mode: 'payment_mode' },
  { table: 'plot_commission_payments', mode: 'payment_mode' },
  { table: 'firm_transactions', mode: 'payment_mode' },
  { table: 'plot_payments', mode: 'payment_type', extraMode: 'payment_from' },
  { table: 'plot_installment_payments', mode: 'payment_mode' },
  { table: 'expenses', mode: 'payment_mode' },
  { table: 'vendor_payments', mode: 'payment_mode' },
  { table: 'vendor_inventory_payments', mode: 'payment_mode' },
  { table: 'plot_registry_payments', mode: 'payment_mode', canonical: 'source.source_plot_payment_id IS NULL' },
  { table: 'land_deal_payments', mode: 'payment_mode' },
  { table: 'misc_income_entries', mode: 'payment_mode' },
  { table: 'day_book', mode: 'payment_mode', canonical: 'COALESCE(source.is_financial_projection, FALSE) = FALSE' },
]);

const validStatuses = "'PENDING', 'CLEARED', 'BOUNCED', 'RETURNED'";

async function auditSource(source) {
  const mode = `(
    UPPER(TRIM(COALESCE(source.${source.mode}, ''))) IN ('CHEQUE', 'CHECK')
    ${source.extraMode ? `OR UPPER(TRIM(COALESCE(source.${source.extraMode}, ''))) IN ('CHEQUE', 'CHECK')` : ''}
  )`;
  const canonical = source.canonical || 'TRUE';
  const expectedCashType = `CASE
    WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) = 'CASH' THEN 'cash'
    WHEN UPPER(TRIM(COALESCE(source.${source.mode}, ''))) IN ('CHEQUE', 'CHECK') THEN 'cheque'
    ELSE 'bank'
  END`;
  const result = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE ${mode})::int AS cheque_rows,
      COUNT(*) FILTER (
        WHERE ${mode}
          AND NULLIF(TRIM(COALESCE(source.cheque_status, '')), '') IS NULL
      )::int AS null_status,
      COUNT(*) FILTER (
        WHERE source.cheque_status IS NOT NULL
          AND UPPER(TRIM(source.cheque_status)) NOT IN (${validStatuses})
      )::int AS invalid_status,
      COUNT(*) FILTER (
        WHERE ${mode}
          AND UPPER(TRIM(COALESCE(source.cheque_status, ''))) = 'PENDING'
          AND NULLIF(TRIM(COALESCE(source.cheque_no, '')), '') IS NULL
      )::int AS pending_without_number,
      COUNT(*) FILTER (WHERE ${mode} AND ${canonical} AND mirror.id IS NULL)::int AS missing_canonical_mirror,
      COUNT(*) FILTER (
        WHERE mirror.id IS NOT NULL
          AND (${expectedCashType}, source.cheque_status, source.cheque_no)
              IS DISTINCT FROM (mirror.cash_type, mirror.cheque_status, mirror.cheque_no)
      )::int AS mirror_mismatch
    FROM ${source.table} source
    LEFT JOIN cash_flow_entries mirror
      ON mirror.source_module = '${source.table}'
     AND mirror.source_id = source.id
  `);
  return { table: source.table, ...result.rows[0] };
}

async function main() {
  const sources = [];
  for (const source of SOURCES) sources.push(await auditSource(source));

  const direct = await pool.query(`
    SELECT
      COUNT(*) FILTER (
        WHERE UPPER(TRIM(COALESCE(cash_type, ''))) IN ('CHEQUE', 'CHECK')
      )::int AS cheque_rows,
      COUNT(*) FILTER (
        WHERE UPPER(TRIM(COALESCE(cash_type, ''))) IN ('CHEQUE', 'CHECK')
          AND NULLIF(TRIM(COALESCE(cheque_status, '')), '') IS NULL
      )::int AS null_status,
      COUNT(*) FILTER (
        WHERE cheque_status IS NOT NULL
          AND UPPER(TRIM(cheque_status)) NOT IN (${validStatuses})
      )::int AS invalid_status
    FROM cash_flow_entries
    WHERE source_module IS NULL
  `);

  const linkedRegistry = await pool.query(`
    SELECT COUNT(*)::int AS divergent
      FROM plot_registry_payments registry
      JOIN plot_payments plot ON plot.id = registry.source_plot_payment_id
     WHERE (registry.payment_mode, registry.cheque_status, registry.cheque_no)
           IS DISTINCT FROM (plot.payment_type, plot.cheque_status, plot.cheque_no)
  `);

  const failures = sources.filter((row) => (
    row.null_status > 0
    || row.invalid_status > 0
    || row.missing_canonical_mirror > 0
    || row.mirror_mismatch > 0
  ));
  if (direct.rows[0].null_status > 0 || direct.rows[0].invalid_status > 0) failures.push({ table: 'cash_flow_entries', ...direct.rows[0] });
  if (linkedRegistry.rows[0].divergent > 0) failures.push({ table: 'linked_plot_registry_payments', ...linkedRegistry.rows[0] });

  console.log(JSON.stringify({ sources, direct_cash_flow: direct.rows[0], linked_registry: linkedRegistry.rows[0] }, null, 2));
  if (failures.length) {
    throw new Error(`Pending-cheque integrity check failed: ${failures.map((row) => row.table).join(', ')}`);
  }
}

main()
  .catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => pool.end());
