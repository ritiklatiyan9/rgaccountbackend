import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Broker-first portfolio reads group commissions across sites and then join the
// compact payment rollup by commission id. These indexes keep that path fast as
// the organisation accumulates more sites and payouts.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('169_all_sites_commission_indexes'))");
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcv2_agent_site_created
      ON plot_commissions_v2(agent_id, site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_pcp_commission_date_cover
      ON plot_commission_payments(plot_commission_id, date DESC)
      INCLUDE (amount, payment_mode, status, cheque_status)`);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('169_all_sites_commission_indexes') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 169: all-sites commission indexes ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
