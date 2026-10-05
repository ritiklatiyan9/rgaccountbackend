import 'dotenv/config';
import { pathToFileURL } from 'node:url';

export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('194_member_identity_consolidation'))");
    await db.query(`CREATE TABLE IF NOT EXISTS member_identity_aliases (
      member_id INTEGER PRIMARY KEY,
      canonical_member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
      organization_id INTEGER NOT NULL,
      site_id INTEGER NOT NULL,
      merged_by INTEGER NOT NULL,
      member_snapshot JSONB NOT NULL,
      linked_records JSONB NOT NULL DEFAULT '{}'::jsonb,
      merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK(member_id <> canonical_member_id))`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_member_identity_aliases_canonical
      ON member_identity_aliases(canonical_member_id)`);
    await db.query(`INSERT INTO app_schema_migrations(version)
      VALUES('194_member_identity_consolidation') ON CONFLICT DO NOTHING`);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Member identity consolidation is ready'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
