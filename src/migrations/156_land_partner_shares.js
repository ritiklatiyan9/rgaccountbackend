import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 156 — partner split per land.
 *
 * A site's profit is split by site_partner_shares, but a land bought and sold may involve
 * only some of those partners at different percentages. land_partner_shares holds that
 * split per land (a `farmers` row — its sales inherit it). A land with no rows follows the
 * site split. Profit itself is never stored; it is read live (kpi.service getProfitKpis).
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('156_land_partner_shares'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS land_partner_shares (
        id BIGSERIAL PRIMARY KEY,
        farmer_id INTEGER NOT NULL REFERENCES farmers(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        share_pct NUMERIC(7,4) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (farmer_id, member_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_land_partner_shares_farmer ON land_partner_shares (farmer_id)`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('156_land_partner_shares') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 156: land_partner_shares is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 156 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
