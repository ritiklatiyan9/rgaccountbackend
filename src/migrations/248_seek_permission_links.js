import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Which Seek Permission request an approval/money entry was done under (the
// bell card's "+" / "i"). A note, never money: no amount column. One entry →
// at most one permission; one permission → many entries. Additive only.
export const migrationSql = `
CREATE TABLE IF NOT EXISTS seek_permission_links (
  target TEXT NOT NULL CHECK (target ~ '^[a-z_]{1,40}$'),
  target_id INTEGER NOT NULL CHECK (target_id > 0),
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  seek_permission_id INTEGER NOT NULL REFERENCES seek_permissions(id) ON DELETE CASCADE,
  linked_by INTEGER NOT NULL REFERENCES users(id),
  linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (target, target_id)
);
CREATE INDEX IF NOT EXISTS seek_permission_links_seek_idx ON seek_permission_links (seek_permission_id);
CREATE INDEX IF NOT EXISTS seek_permission_links_site_idx ON seek_permission_links (site_id, linked_at DESC);
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('248_seek_permission_links'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version='248_seek_permission_links'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES('248_seek_permission_links')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Seek Permission links installed' : 'Seek Permission links already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
