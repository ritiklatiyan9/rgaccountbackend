import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 155 — one commission engine for projects AND lands.
 *
 * A commission master (plot_commissions_v2) used to belong to a plot only. Brokers also
 * earn on land bought from a farmer (Land Purchase) and on land sold on (Land Sale), so the
 * master now has exactly ONE subject: plot_id, farmer_id or land_deal_id. Payouts
 * (plot_commission_payments), their ledger mirror, approvals, cheques and receipts key off
 * the payout row and are untouched. A land with commissions cannot be deleted (RESTRICT);
 * the land-sale delete path removes its commissions explicitly, like plots do.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('155_land_commission_subjects'))`);

    await client.query(`ALTER TABLE plot_commissions_v2 ADD COLUMN IF NOT EXISTS farmer_id INTEGER REFERENCES farmers(id) ON DELETE RESTRICT`);
    await client.query(`ALTER TABLE plot_commissions_v2 ADD COLUMN IF NOT EXISTS land_deal_id INTEGER REFERENCES land_deals(id) ON DELETE RESTRICT`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_farmer ON plot_commissions_v2 (farmer_id) WHERE farmer_id IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_land_deal ON plot_commissions_v2 (land_deal_id) WHERE land_deal_id IS NOT NULL`);

    const { rows: orphans } = await client.query(
      `SELECT id FROM plot_commissions_v2 WHERE num_nonnulls(plot_id, farmer_id, land_deal_id) <> 1`,
    );
    if (orphans.length) throw new Error(`plot_commissions_v2 ${orphans.map((r) => r.id).join(', ')} have no subject (plot / land) — fix or delete them first`);
    await client.query(`ALTER TABLE plot_commissions_v2 DROP CONSTRAINT IF EXISTS plot_commissions_v2_one_subject`);
    await client.query(`ALTER TABLE plot_commissions_v2 ADD CONSTRAINT plot_commissions_v2_one_subject CHECK (num_nonnulls(plot_id, farmer_id, land_deal_id) = 1)`);

    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('155_land_commission_subjects') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 155: commissions can belong to a plot, a land purchase or a land sale');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 155 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
