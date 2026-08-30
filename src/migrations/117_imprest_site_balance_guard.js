import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 117 — Imprest distribution is governed by the Site Balance (the Admin's money in
 * hand). An allocation records the site balance it was drawn against and, when the Admin
 * chose to distribute beyond it, the reason they gave.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('117_imprest_site_balance_guard'))`);
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS override_reason TEXT`);
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS site_balance_at_allocation NUMERIC(15,2)`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('117_imprest_site_balance_guard') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 117: imprest allocations carry site_balance_at_allocation + override_reason');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 117 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
