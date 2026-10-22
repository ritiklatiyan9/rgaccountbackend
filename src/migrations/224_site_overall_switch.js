import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// "Show in overall" switch on the Sites page. A site switched off stays out of
// the all-sites pages (commission, personal ledgers, profit) and its Dashboard
// hides its finance. Default TRUE so every existing site keeps showing.
export const migrationSql = `
ALTER TABLE sites ADD COLUMN IF NOT EXISTS include_in_overall BOOLEAN NOT NULL DEFAULT TRUE;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('224_site_overall_switch'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '224_site_overall_switch'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('224_site_overall_switch')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Site overall switch installed' : 'Site overall switch already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
