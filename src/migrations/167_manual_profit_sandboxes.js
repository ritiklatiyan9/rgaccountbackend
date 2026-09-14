import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Private, planning-only profit workspaces. The JSON document deliberately has
// no foreign keys or triggers into accounting tables: these figures must never
// become ledger entries, dashboard totals, or live partner balances.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('167_manual_profit_sandboxes'))");
    await client.query(`CREATE TABLE IF NOT EXISTS manual_profit_sandboxes (
      id BIGSERIAL PRIMARY KEY,
      owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL,
      document JSONB NOT NULL DEFAULT '{"version":1,"asOf":"","notes":"","sites":[]}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (jsonb_typeof(document) = 'object')
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_manual_profit_sandboxes_owner_updated ON manual_profit_sandboxes(owner_user_id, updated_at DESC, id DESC)');
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('167_manual_profit_sandboxes') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 167: manual profit sandboxes ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
