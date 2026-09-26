import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Registries created from a plot copied the plot's stored plot_size_mtr instead of
// Gaz × 0.8364. Recompute m² from Gaz; size only, no money column changes.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('173_registry_size_meter_from_gaz'))");
    await client.query(`UPDATE plot_registries
       SET size_meter = ROUND(size_sqyard * 0.8364, 2)
     WHERE size_sqyard > 0
       AND size_meter IS DISTINCT FROM ROUND(size_sqyard * 0.8364, 2)`);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('173_registry_size_meter_from_gaz') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 173: registry m² recomputed from Gaz × 0.8364'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
