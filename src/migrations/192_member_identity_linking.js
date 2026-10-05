import 'dotenv/config';
import { pathToFileURL } from 'node:url';

export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('192_member_identity_linking'))");
    const { rows } = await db.query("SELECT 1 FROM app_schema_migrations WHERE version='192_member_identity_linking'");
    if (!rows.length) {
      await db.query("SET LOCAL lock_timeout = '5s'");
      // Legacy duplicates may have separate financial records in the same site.
      // Linking their identity must preserve both registrations and all IDs.
      await db.query('DROP INDEX IF EXISTS idx_members_shared_profile_site');
      await db.query(`CREATE INDEX idx_members_shared_profile_site ON members(shared_profile_id,site_id)
        WHERE shared_profile_id IS NOT NULL`);
      await db.query(`CREATE TABLE member_identity_link_events (
        id BIGSERIAL PRIMARY KEY, organization_id INTEGER NOT NULL, member_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL, shared_profile_id UUID NOT NULL,
        profiles_before JSONB NOT NULL, profiles_after JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
      await db.query(`INSERT INTO app_schema_migrations(version) VALUES('192_member_identity_linking')`);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Member identity linking is ready'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
