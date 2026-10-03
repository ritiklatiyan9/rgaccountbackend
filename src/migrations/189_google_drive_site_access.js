import 'dotenv/config';
import { pathToFileURL } from 'node:url';

const VERSION = '189_google_drive_site_access';

/**
 * Site-scoped Drive access: each site owns one folder under the root and its
 * own list of people (its CA) granted on that folder, so a CA never sees
 * another site's records. Rows without a site (none exist in practice) keep
 * meaning "granted on the root folder, all sites".
 */
export const statements = [
  'ALTER TABLE google_drive_access_emails ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES sites(id) ON DELETE CASCADE',
  'ALTER TABLE google_drive_access_emails DROP CONSTRAINT IF EXISTS google_drive_access_emails_organization_id_email_key',
  // One row per person per site; COALESCE keeps the org-wide (NULL site) rows unique too.
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_gdrive_access_site_email ON google_drive_access_emails (organization_id, COALESCE(site_id, 0), email)',
  'CREATE INDEX IF NOT EXISTS idx_gdrive_access_site ON google_drive_access_emails (site_id)',
  `CREATE TABLE IF NOT EXISTS google_drive_site_folders (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    root_folder_id VARCHAR(200) NOT NULL,
    folder_id VARCHAR(200) NOT NULL,
    folder_name VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, root_folder_id, site_id)
  )`,
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
  try { await up(pool); console.log('Migration 189: site-scoped Google Drive access is ready'); }
  catch (error) { console.error('Google Drive site access migration failed:', error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
