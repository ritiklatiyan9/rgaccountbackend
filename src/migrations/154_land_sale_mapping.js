import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 154 — Land Sale ↔ Land Purchase mapping.
 *
 * Lands Payments is now three modules: Land Purchase (farmers + farmer_payments),
 * Land Sale (land_deals + land_deal_payments) and Land Profit (the rollup).
 * A purchase IS the farmer row, so the placeholder 'purchased' deals from the old
 * "Buy land" flow go away, and every sale must stay mapped to the land it was cut
 * from: farmer_id becomes NOT NULL and a land with sales can no longer be deleted.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('154_land_sale_mapping'))`);

    const { rows: stuck } = await client.query(
      `SELECT d.id FROM land_deals d
        WHERE d.status = 'purchased' AND EXISTS (SELECT 1 FROM land_deal_payments p WHERE p.land_deal_id = d.id)`,
    );
    if (stuck.length) throw new Error(`land_deals ${stuck.map((r) => r.id).join(', ')} are 'purchased' but carry receipts — mark them sold or delete them first`);
    await client.query(`DELETE FROM land_deals WHERE status = 'purchased'`);

    const { rows: unmapped } = await client.query(`SELECT id FROM land_deals WHERE farmer_id IS NULL`);
    if (unmapped.length) throw new Error(`land_deals ${unmapped.map((r) => r.id).join(', ')} are not mapped to a land (farmer_id IS NULL) — map or delete them first`);

    await client.query(`ALTER TABLE land_deals ALTER COLUMN farmer_id SET NOT NULL`);
    await client.query(`ALTER TABLE land_deals DROP CONSTRAINT IF EXISTS land_deals_farmer_id_fkey`);
    await client.query(`ALTER TABLE land_deals ADD CONSTRAINT land_deals_farmer_id_fkey FOREIGN KEY (farmer_id) REFERENCES farmers(id) ON DELETE RESTRICT`);
    await client.query(`ALTER TABLE land_deals DROP CONSTRAINT IF EXISTS land_deals_status_check`);
    await client.query(`ALTER TABLE land_deals ADD CONSTRAINT land_deals_status_check CHECK (status IN ('open', 'completed', 'cancelled'))`);

    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('154_land_sale_mapping') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 154: land sales are mapped to their purchase (farmer_id NOT NULL, delete restricted)');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 154 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
