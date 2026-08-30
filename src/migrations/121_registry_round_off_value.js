import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 121 — Registry Value RO (round-off).
 * In practice the office receives a rounded amount for a registry (cash + bank). The exact
 * paid figures stay in the records; these two manual fields hold the final rounded amount
 * actually received, so reports can show both and the round-off difference between them.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('121_registry_round_off_value'))`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS ro_cash_amount NUMERIC(15,2)`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS ro_bank_amount NUMERIC(15,2)`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS ro_updated_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS ro_updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('121_registry_round_off_value') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 121: plot_registries.ro_cash_amount / ro_bank_amount are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 121 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
