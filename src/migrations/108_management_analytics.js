import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 108 — Management Analytics module.
 *  - members: client geolocation (manual pin from the Location picker or a
 *    cached Nominatim lookup) + village/district (address granularity the
 *    existing city/state/pincode columns lack).
 *  - geocode_cache: Nominatim usage policy requires results to be cached;
 *    keyed on the normalised (city|state|pincode) query so many members share
 *    one lookup.
 *  - indexes for the analytics queries (site-scoped GROUP BYs on members,
 *    the plots↔members name join, and per-site payment timelines).
 * Idempotent: runs on every deploy boot via `npm start`.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('108_management_analytics'))`);

    await client.query(`
      ALTER TABLE members
        ADD COLUMN IF NOT EXISTS latitude          NUMERIC(9,6),
        ADD COLUMN IF NOT EXISTS longitude         NUMERIC(9,6),
        ADD COLUMN IF NOT EXISTS village           VARCHAR(150),
        ADD COLUMN IF NOT EXISTS district          VARCHAR(100),
        ADD COLUMN IF NOT EXISTS geocode_source    VARCHAR(20),
        ADD COLUMN IF NOT EXISTS geocode_precision VARCHAR(40),
        ADD COLUMN IF NOT EXISTS geocoded_at       TIMESTAMPTZ
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS geocode_cache (
        query_key  TEXT PRIMARY KEY,
        lat        NUMERIC(9,6),
        lng        NUMERIC(9,6),
        precision  VARCHAR(40),
        source     VARCHAR(20) NOT NULL,
        raw        JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_site_geo ON members (site_id) WHERE latitude IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_site_city ON members (site_id, city)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_site_occupation ON members (site_id, occupation) WHERE occupation IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_plots_site_buyer_upper ON plots (site_id, UPPER(TRIM(buyer_name)))`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_pp_site_date_plot
        ON plot_payments (site_id, date, plot_id)
        INCLUDE (amount, status, cheque_status, payment_type)
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('108_management_analytics')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 108: management analytics columns, geocode_cache and indexes are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 108 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
