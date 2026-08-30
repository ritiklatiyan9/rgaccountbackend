import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 113 — Land Profit lifecycle: purchase first, sell later.
 *
 *   purchased → (paying the farmer … 100% = held) → open (sold, collecting) → completed
 *
 * A deal can now exist before it has a buyer, so buyer_name becomes nullable and the
 * status check gains 'purchased'. Purchase-side numbers (rate, unit, conversion used)
 * are kept on the deal for the profit maths; the money itself stays in farmer_payments.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('113_land_deal_lifecycle'))`);
    await client.query(`ALTER TABLE land_deals DROP CONSTRAINT IF EXISTS land_deals_status_check`);
    await client.query(`ALTER TABLE land_deals ADD CONSTRAINT land_deals_status_check CHECK (status IN ('purchased', 'open', 'completed', 'cancelled'))`);
    await client.query(`ALTER TABLE land_deals ALTER COLUMN buyer_name DROP NOT NULL`);
    await client.query(`ALTER TABLE land_deals ADD COLUMN IF NOT EXISTS purchase_date DATE`);
    await client.query(`ALTER TABLE land_deals ADD COLUMN IF NOT EXISTS purchase_rate NUMERIC(15,2)`);
    await client.query(`ALTER TABLE land_deals ADD COLUMN IF NOT EXISTS rate_unit VARCHAR(8) NOT NULL DEFAULT 'bigha'`);
    await client.query(`ALTER TABLE land_deals ADD COLUMN IF NOT EXISTS gaz_per_bigha NUMERIC(10,4)`);
    await client.query(`ALTER TABLE land_deals ADD COLUMN IF NOT EXISTS sold_at TIMESTAMPTZ`);
    await client.query(`UPDATE land_deals SET sold_at = COALESCE(sold_at, created_at) WHERE status IN ('open', 'completed') AND sold_at IS NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('113_land_deal_lifecycle') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 113: land_deals lifecycle (purchased → sold) is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 113 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
