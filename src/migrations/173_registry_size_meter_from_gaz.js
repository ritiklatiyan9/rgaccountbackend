import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Legacy unlinked registries have no Plot Payments area to read. Linked
// registries must retain the plot's stored measurements.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('173_registry_size_meter_from_gaz'))");
    await client.query(`UPDATE plot_registries
       SET size_meter = ROUND(size_sqyard * 0.8364, 4)
     WHERE plot_id IS NULL AND size_sqyard > 0
       AND size_meter IS DISTINCT FROM ROUND(size_sqyard * 0.8364, 4)`);
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
  up().then(() => console.log('Migration 173: unlinked registry m² recomputed from Gaz × 0.8364'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
