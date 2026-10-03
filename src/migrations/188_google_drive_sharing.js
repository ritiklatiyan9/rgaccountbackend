import 'dotenv/config';
import { pathToFileURL } from 'node:url';

const VERSION = '188_google_drive_sharing';

/**
 * Share-to-Google-Drive: one OAuth-connected Drive per organization, the
 * emails granted access to its root folder, a folder-id cache, and a log of
 * every share (module-generic so other modules can reuse it later).
 */
export const statements = [
  `CREATE TABLE IF NOT EXISTS google_drive_connections (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    google_account_email VARCHAR(255) NOT NULL,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    token_expiry TIMESTAMPTZ,
    scope TEXT,
    root_folder_id VARCHAR(200),
    root_folder_name VARCHAR(200) NOT NULL DEFAULT 'Defence Garden Accounts',
    connected_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS google_drive_access_emails (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    role VARCHAR(10) NOT NULL DEFAULT 'writer' CHECK (role IN ('writer','reader')),
    drive_permission_id VARCHAR(100),
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, email)
  )`,
  `CREATE TABLE IF NOT EXISTS google_drive_folders (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    root_folder_id VARCHAR(200) NOT NULL,
    path TEXT NOT NULL,
    folder_id VARCHAR(200) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (organization_id, root_folder_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS google_drive_shares (
    id BIGSERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
    module VARCHAR(40) NOT NULL,
    entity_type VARCHAR(40) NOT NULL,
    entity_id BIGINT NOT NULL,
    payment_id BIGINT,
    scope VARCHAR(20) NOT NULL CHECK (scope IN ('overall','transaction','documents')),
    label TEXT NOT NULL,
    folder_path TEXT NOT NULL,
    folder_id VARCHAR(200),
    folder_url TEXT,
    files JSONB NOT NULL DEFAULT '[]'::jsonb,
    status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','partial','failed')),
    error TEXT,
    shared_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  'CREATE INDEX IF NOT EXISTS idx_gdrive_shares_entity ON google_drive_shares (organization_id, module, entity_type, entity_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_gdrive_shares_recent ON google_drive_shares (organization_id, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_gdrive_shares_site ON google_drive_shares (site_id, created_at DESC)',
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
  try { await up(pool); console.log('Migration 188: Google Drive sharing tables are ready'); }
  catch (error) { console.error('Google Drive sharing migration failed:', error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
