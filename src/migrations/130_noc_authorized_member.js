import 'dotenv/config';
import pool from '../config/db.js';

/** Migration 130 — NOC names the company's authorised signatory, picked from Clients (members). */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('130_noc_authorized_member'))`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS noc_authorized_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('130_noc_authorized_member') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 130: plot_registries.noc_authorized_member_id is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 130 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
