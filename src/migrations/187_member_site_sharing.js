import 'dotenv/config';
import { pathToFileURL } from 'node:url';

export async function up(db) {
  const client=await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('187_member_site_sharing'))");
    const { rows: applied } = await client.query(
      "SELECT 1 FROM app_schema_migrations WHERE version = '187_member_site_sharing'",
    );
    if (applied.length) {
      await client.query('COMMIT');
      return;
    }
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('ALTER TABLE members ADD COLUMN IF NOT EXISTS shared_profile_id UUID');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_members_shared_profile_site
      ON members(shared_profile_id,site_id) WHERE shared_profile_id IS NOT NULL`);
    await client.query(`INSERT INTO app_schema_migrations(version) VALUES('187_member_site_sharing') ON CONFLICT(version) DO NOTHING`);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {default:pool}=await import('../config/db.js');
  try {await up(pool);console.log('Migration 187: shared client registrations are ready');}
  catch(error) {console.error('Member site sharing migration failed:',error.message);process.exitCode=1;}
  finally {await pool.end();}
}
