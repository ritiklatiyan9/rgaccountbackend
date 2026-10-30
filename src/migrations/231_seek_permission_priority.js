import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const migrationSql = `
ALTER TABLE seek_permissions ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='seek_permissions'::regclass
    AND conname='seek_permissions_priority_check') THEN
    ALTER TABLE seek_permissions ADD CONSTRAINT seek_permissions_priority_check
      CHECK (priority IN ('critical','important','normal'));
  END IF;
END $$;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('231_seek_permission_priority'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version='231_seek_permission_priority'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES('231_seek_permission_priority')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Seek Permission priorities installed' : 'Seek Permission priorities already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
