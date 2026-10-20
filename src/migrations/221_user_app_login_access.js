import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Per-frontend sign-in switches managed from User ID Management.
// Accounts = dgdefence.com (this backend), Booking = dgbooking.com (sales-backend).
// Default TRUE so every existing ID keeps the access it has today.
export const migrationSql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_accounts BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_booking BOOLEAN NOT NULL DEFAULT TRUE;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('221_user_app_login_access'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '221_user_app_login_access'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('221_user_app_login_access')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'User app login access installed' : 'User app login access already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
