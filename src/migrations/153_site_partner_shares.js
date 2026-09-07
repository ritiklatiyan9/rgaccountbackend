import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Profit distribution: which clients (members) are partners in a site and what
 * percentage of that site's profit each one takes.
 *
 * Only the shares are stored. Profit itself is never persisted — it is read
 * live from getAllKpis(), the same source the Dashboard profit cards use, so a
 * distribution can never drift from the ledger.
 * ponytail: one flat table, no versioning/effective-dates. Add a
 * valid_from column if shares ever need to change mid-project retroactively.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('153_site_partner_shares'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS site_partner_shares (
        id BIGSERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
        share_pct NUMERIC(7,4) NOT NULL CHECK (share_pct > 0 AND share_pct <= 100),
        notes TEXT,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (site_id, member_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_site_partner_shares_site ON site_partner_shares (site_id)`);

    await client.query('COMMIT');
    console.log('Migration 153: site_partner_shares is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 153 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
