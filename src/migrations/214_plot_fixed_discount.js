import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Additive only: existing sale prices, rates and approval history stay intact.
export const migrationSql = `
ALTER TABLE plots ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(15,2) NOT NULL DEFAULT 0
  CHECK (discount_amount >= 0);
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('214_plot_fixed_discount'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '214_plot_fixed_discount'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('214_plot_fixed_discount')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Plot total rupee discounts installed' : 'Plot total rupee discounts already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
