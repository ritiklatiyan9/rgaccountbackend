import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * Register Farmer quotes its land rate the same way a land sale does: per bigha,
 * gaz or m². Without the unit and the bigha factor beside the rate, reopening a
 * farmer would re-read a per-gaz rate as per-bigha. Mirrors `land_deals`.
 */
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('165_farmer_rate_unit'))");
    await db.query(`ALTER TABLE farmers
      ADD COLUMN IF NOT EXISTS rate_unit VARCHAR(10) NOT NULL DEFAULT 'bigha',
      ADD COLUMN IF NOT EXISTS gaz_per_bigha NUMERIC(12,4)`);
    await db.query('ALTER TABLE farmers DROP CONSTRAINT IF EXISTS farmers_rate_unit_check');
    await db.query(`ALTER TABLE farmers ADD CONSTRAINT farmers_rate_unit_check
      CHECK (rate_unit IN ('bigha','gaz','mtr'))`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('165_farmer_rate_unit') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up()
    .then(() => console.log('Farmer rate unit schema ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
