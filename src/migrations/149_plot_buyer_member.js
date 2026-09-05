import 'dotenv/config';
import pool from '../config/db.js';

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('149_plot_buyer_member'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`ALTER TABLE plots ADD COLUMN IF NOT EXISTS buyer_member_id INTEGER REFERENCES members(id) ON DELETE SET NULL`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_plots_buyer_member ON plots(site_id, buyer_member_id) WHERE buyer_member_id IS NOT NULL');
    await client.query("INSERT INTO app_schema_migrations (version) VALUES ('149_plot_buyer_member') ON CONFLICT (version) DO NOTHING");
    await client.query('COMMIT');
    console.log('Migration 149: explicit plot buyer links ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

up().catch((error) => {
  console.error('Plot buyer link migration failed:', error.message);
  process.exitCode = 1;
}).finally(() => pool.end());
