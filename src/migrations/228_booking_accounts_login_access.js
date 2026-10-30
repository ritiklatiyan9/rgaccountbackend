import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Additive and safe whichever shared-database backend is deployed first. Never
// reset existing choices when this migration is run again.
export const migrationSql = `
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_accounts BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS can_login_booking BOOLEAN NOT NULL DEFAULT TRUE;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='users' AND column_name='can_login_booking_accounts') THEN
    ALTER TABLE users ADD COLUMN can_login_booking_accounts BOOLEAN NOT NULL DEFAULT TRUE;
    UPDATE users SET can_login_booking_accounts=can_login_booking;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS login_otps (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pending_token TEXT NOT NULL UNIQUE,
  otp_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE login_otps ADD COLUMN IF NOT EXISTS app_context TEXT;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('shared_booking_accounts_login_access'))");
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('228_booking_accounts_login_access') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log("Booking's Account login permissions installed"))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
