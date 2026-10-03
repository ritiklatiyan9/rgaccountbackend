import 'dotenv/config';
import { pathToFileURL } from 'node:url';

const VERSION = '190_google_drive_share_jobs';

/**
 * Drive shares run in the background: the request only queues a row, the
 * in-process runner uploads it and keeps live progress on the row. The table
 * doubles as the queue, so two statuses and a few columns are added.
 */
export const statements = [
  'ALTER TABLE google_drive_shares DROP CONSTRAINT IF EXISTS google_drive_shares_status_check',
  `ALTER TABLE google_drive_shares ADD CONSTRAINT google_drive_shares_status_check
     CHECK (status IN ('queued','running','completed','partial','failed'))`,
  `ALTER TABLE google_drive_shares
     ADD COLUMN IF NOT EXISTS request JSONB,
     ADD COLUMN IF NOT EXISTS progress JSONB,
     ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
     ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`,
  `CREATE INDEX IF NOT EXISTS idx_gdrive_shares_queue ON google_drive_shares (status, id)
     WHERE status IN ('queued','running')`,
];

export async function up(db) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    const { rows: applied } = await client.query(
      'SELECT 1 FROM app_schema_migrations WHERE version = $1',
      [VERSION],
    );
    if (applied.length) {
      await client.query('COMMIT');
      return;
    }
    await client.query("SET LOCAL lock_timeout = '5s'");
    for (const sql of statements) await client.query(sql);
    await client.query(
      'INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT(version) DO NOTHING',
      [VERSION],
    );
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Migration 190: background Google Drive shares are ready'); }
  catch (error) { console.error('Google Drive share jobs migration failed:', error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
