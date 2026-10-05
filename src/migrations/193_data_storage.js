import { pathToFileURL } from 'node:url';

export const statements = [
  `CREATE TABLE IF NOT EXISTS data_storage_entries (
    id SERIAL PRIMARY KEY,
    site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    parent_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
    name VARCHAR(255) NOT NULL CHECK (length(trim(name)) > 0),
    storage_key TEXT,
    mime_type TEXT,
    file_size BIGINT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, site_id),
    FOREIGN KEY (parent_id, site_id) REFERENCES data_storage_entries(id, site_id),
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK ((kind = 'folder' AND storage_key IS NULL AND file_size IS NULL)
      OR (kind = 'file' AND storage_key IS NOT NULL AND file_size IS NOT NULL AND file_size >= 0))
  )`,
  // Root and nested siblings share the same case-insensitive name rules.
  `CREATE UNIQUE INDEX IF NOT EXISTS data_storage_sibling_name
    ON data_storage_entries(site_id, COALESCE(parent_id, 0), lower(name))`,
  `CREATE INDEX IF NOT EXISTS data_storage_parent
    ON data_storage_entries(site_id, parent_id, kind, name)`,
];

export async function up(database) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('193_data_storage'))");
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    for (const sql of statements) await client.query(sql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES('193_data_storage') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Migration 193: Data Storage is ready'); }
  catch (error) { console.error('Data Storage migration failed:', error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
