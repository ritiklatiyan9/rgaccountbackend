import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Seek Permission v2: the requester picks who to ask (an admin, or a sub-admin
// of the same site) and may attach PDFs/photos. Attachments are S3 metadata only
// ({ url, name, type, size }); links are signed per view. Additive only.
export const migrationSql = `
ALTER TABLE seek_permissions ADD COLUMN IF NOT EXISTS asked_to INTEGER REFERENCES users(id);
ALTER TABLE seek_permissions ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb
  CHECK (CASE WHEN jsonb_typeof(attachments) = 'array' THEN jsonb_array_length(attachments) <= 5 ELSE false END);
CREATE INDEX IF NOT EXISTS seek_permissions_asked_pending_idx ON seek_permissions (asked_to, site_id, created_at DESC) WHERE status = 'pending';
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('223_seek_permission_targets'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '223_seek_permission_targets'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('223_seek_permission_targets')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Seek permission targets installed' : 'Seek permission targets already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
