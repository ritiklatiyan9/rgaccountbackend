import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const migrationSql = `
CREATE TABLE IF NOT EXISTS imprest_management_visibility (
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  visible_user_ids INTEGER[] NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, site_id)
);`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('229_imprest_management_visibility'))");
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('229_imprest_management_visibility') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Imprest Management visibility installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
