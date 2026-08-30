import 'dotenv/config';
import pool from '../config/db.js';

/** Migration 114 — NOC can name the booking's co-applicant (toggle stored on the registry). */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('114_noc_co_applicant'))`);
    await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS noc_include_co_applicant BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('114_noc_co_applicant') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 114: plot_registries.noc_include_co_applicant is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 114 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
