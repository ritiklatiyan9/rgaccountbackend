import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '235_request_history_indexes';
// One compact archive index per source. Pending queues keep their existing
// indexes; the native cash-flow archive also excludes accounting mirrors.
const tables = ['transaction_transfer_approval_requests', 'plot_status_approvals', 'farmer_payments', 'land_deal_payments',
  'misc_income_entries', 'plot_commissions', 'plot_commission_payments', 'cash_flow_entries', 'firm_transactions',
  'plot_payments', 'plot_installment_payments', 'expenses', 'vendor_payments', 'plot_registry_payments',
  'vendor_inventory_payments', 'day_book', 'edit_requests', 'seek_permissions', 'loyalty_vault_transfers',
  'wallet_imprest_transfers', 'imprest_expense_requests', 'imprest_returns', 'imprest_allocations'];
const includeColumns = ['approved_at', 'resolved_at', 'decided_at', 'reviewed_at', 'confirmed_at', 'declined_at',
  'updated_at', 'created_at', 'created_by', 'requested_by', 'assigned_admin_id', 'sub_admin_id', 'sender_id', 'recipient_id'];

export async function up(database = pool, { concurrently = true, log = () => {} } = {}) {
  const db = await database.connect();
  const built = [];
  try {
    // Session-level lock: CONCURRENTLY cannot run inside a transaction.
    await db.query('SELECT pg_advisory_lock(hashtext($1))', [VERSION]);
    await db.query("SET lock_timeout='3s'");
    await db.query("SET statement_timeout='90s'");
    // Some installations retain legacy approval sources as views. Their base
    // tables own the indexes; CREATE INDEX on a view is invalid.
    const { rows } = await db.query(`SELECT table_name,column_name FROM information_schema.columns c
      WHERE table_schema='public' AND table_name=ANY($1::text[])
        AND EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
          WHERE n.nspname=c.table_schema AND r.relname=c.table_name AND r.relkind='r')`, [tables]);
    const columns = new Map();
    for (const row of rows) {
      if (!columns.has(row.table_name)) columns.set(row.table_name, new Set());
      columns.get(row.table_name).add(row.column_name);
    }
    for (const table of tables) {
      const fields = columns.get(table);
      if (!fields?.has('status') || !fields.has('id')) continue;
      const site = ['site_id', 'farmer_id', 'plot_id'].find(column => fields.has(column));
      if (!site) continue;
      const name = `request_history_${table}`;
      const existing = await db.query(`SELECT i.indisvalid FROM pg_index i
        JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relname=$1 AND n.nspname='public'`, [name]);
      if (existing.rows[0]?.indisvalid) continue;
      // Interrupted concurrent builds leave an invalid index; retry this named
      // build instead of silently retaining an unusable IF NOT EXISTS index.
      if (existing.rows.length) await db.query(`DROP INDEX ${concurrently ? 'CONCURRENTLY ' : ''}public.${name}`);
      const included = includeColumns.filter(column => fields.has(column));
      await db.query(`CREATE INDEX ${concurrently ? 'CONCURRENTLY ' : ''}${name}
        ON public.${table} (${site},lower(status::text),id DESC)
        ${included.length ? `INCLUDE (${included.join(',')})` : ''}
        WHERE lower(status::text) IN ('approved','accepted','received','returned','rejected','declined')
        ${table === 'cash_flow_entries' && fields.has('source_module') ? 'AND source_module IS NULL' : ''}`);
      await db.query(`ANALYZE public.${table}`);
      built.push(name);
      log(name);
    }
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [VERSION]);
    return built;
  } finally {
    try {
      await db.query('RESET lock_timeout');
      await db.query('RESET statement_timeout');
      await db.query('SELECT pg_advisory_unlock(hashtext($1))', [VERSION]);
    } finally { db.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up(pool, { log: name => console.log(`Ready: ${name}`) })
    .then(built => console.log(`Request history indexes ready (${built.length} created)`))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
