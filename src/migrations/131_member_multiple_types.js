import 'dotenv/config';
import pool from '../config/db.js';

/** Migration 131 — a member can hold several roles (CLIENT + FARMER, …).
 *  member_type stays the primary role so every existing query keeps working;
 *  member_types is the full set and always contains the primary. */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('131_member_multiple_types'))`);
    await client.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS member_types TEXT[]`);
    await client.query(
      `UPDATE members
          SET member_types = ARRAY[UPPER(COALESCE(NULLIF(BTRIM(member_type), ''), 'OTHER'))]
        WHERE member_types IS NULL OR cardinality(member_types) = 0`
    );
    await client.query(`CREATE INDEX IF NOT EXISTS idx_members_site_member_types ON members USING GIN (member_types)`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('131_member_multiple_types') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 131: members.member_types is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 131 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
