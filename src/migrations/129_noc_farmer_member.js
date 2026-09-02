import 'dotenv/config';
import pool from '../config/db.js';

/** Migration 129 — NOC can name the seller/farmer picked from Clients (members). */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('129_noc_farmer_member'))`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS noc_farmer_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('129_noc_farmer_member') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 129: plot_registries.noc_farmer_member_id is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 129 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
