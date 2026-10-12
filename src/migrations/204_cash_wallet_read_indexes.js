import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('204_cash_wallet_read_indexes'))");
    const applied = await db.query("SELECT 1 FROM app_schema_migrations WHERE version='204_cash_wallet_read_indexes'");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    const nativeTables = [...LOYALTY_VAULT_SOURCE_TABLES].filter(table => table !== 'cash_flow_entries');
    const nativeNames = nativeTables.map(table => `${table}_cash_wallet_created`);
    const existing = await db.query("SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[])", [nativeNames]);
    if (Number(existing.rows[0].n) !== nativeNames.length) {
      for (const table of nativeTables) await db.query(`CREATE INDEX IF NOT EXISTS ${table}_cash_wallet_created ON ${table}(created_at,id)`);
    }
    if (!applied.rows.length) {
      await db.query(`
        CREATE INDEX IF NOT EXISTS cash_wallet_recent_sources ON cash_flow_entries(created_at,id);
        CREATE INDEX IF NOT EXISTS cash_wallet_history_org_site ON loyalty_vault_entries(organization_id,site_id,id DESC);
        CREATE INDEX IF NOT EXISTS cash_wallet_pending_inbox ON loyalty_vault_transfers(organization_id,recipient_id,created_at DESC,id DESC) WHERE status='pending';
        CREATE INDEX IF NOT EXISTS cash_wallet_transfer_sender ON loyalty_vault_transfers(organization_id,sender_id,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS cash_wallet_transfer_from_holder ON loyalty_vault_transfers(organization_id,from_holder_type,from_holder_id,created_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS cash_wallet_transfer_to_holder ON loyalty_vault_transfers(organization_id,to_holder_id,created_at DESC,id DESC);
      `);
      // Stale statistics made small assignment sets scan whole financial
      // tables. Refresh once after installing indexes, not on every restart.
      for (const table of [...LOYALTY_VAULT_SOURCE_TABLES, 'wallet_sources', 'loyalty_vault_sources', 'loyalty_vault_entries', 'loyalty_vault_transfers']) {
        await db.query(`ANALYZE ${table}`);
      }
      await db.query("INSERT INTO app_schema_migrations(version) VALUES('204_cash_wallet_read_indexes')");
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 204: Cash Wallet read indexes ready'))
    .catch(error => { console.error('Migration 204 failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
