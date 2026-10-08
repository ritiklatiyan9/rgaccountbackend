import { pathToFileURL } from 'node:url';

export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('197_imprest_approval_activity_indexes'))");
    await db.query('CREATE TABLE IF NOT EXISTS app_schema_migrations (version text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const { rows } = await db.query("SELECT 1 FROM app_schema_migrations WHERE version='197_imprest_approval_activity_indexes'");
    if (!rows.length) {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_request_inbox
        ON imprest_expense_requests(site_id, assigned_admin_id, created_at DESC, id DESC) WHERE status='PENDING'`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_request_sent
        ON imprest_expense_requests(site_id, sub_admin_id, created_at DESC, id DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_return_inbox
        ON imprest_returns(site_id, created_at DESC, id DESC) WHERE status='PENDING'`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_return_sent
        ON imprest_returns(site_id, sub_admin_id, created_at DESC, id DESC)`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_receipt_inbox
        ON imprest_allocations(site_id, sub_admin_id, created_at DESC, id DESC) WHERE status='PENDING_RECEIPT'`);
      await db.query(`CREATE INDEX IF NOT EXISTS idx_imprest_allocation_sent
        ON imprest_allocations(site_id, admin_id, created_at DESC, id DESC)`);
      await db.query("INSERT INTO app_schema_migrations(version) VALUES('197_imprest_approval_activity_indexes') ON CONFLICT DO NOTHING");
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); } finally { await pool.end(); }
}
