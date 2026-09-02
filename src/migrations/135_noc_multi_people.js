import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 135 — a NOC can name several farmers, clients and authorised members.
 * Array columns are the new home; the legacy single columns stay in sync with the
 * first element so older readers (print fallback, hosted API) keep working.
 * noc_client_member_ids is new: extra purchasers named beside the auto-resolved buyer.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('135_noc_multi_people'))`);
    for (const col of ['noc_farmer_member_ids', 'noc_authorized_member_ids', 'noc_client_member_ids']) {
      await client.query(`ALTER TABLE plot_registries ADD COLUMN IF NOT EXISTS ${col} INTEGER[]`);
    }
    await client.query(`UPDATE plot_registries SET noc_farmer_member_ids = ARRAY[noc_farmer_member_id] WHERE noc_farmer_member_id IS NOT NULL AND noc_farmer_member_ids IS NULL`);
    await client.query(`UPDATE plot_registries SET noc_authorized_member_ids = ARRAY[noc_authorized_member_id] WHERE noc_authorized_member_id IS NOT NULL AND noc_authorized_member_ids IS NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('135_noc_multi_people') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 135: plot_registries noc_*_member_ids arrays ready (backfilled from single columns)');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 135 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
