import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Fast normalized-phone lookup plus an audit link for KYC copied from another
 * site registration. This is additive and does not rewrite legacy members.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('147_member_phone_kyc_reuse'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_members_normalized_phone_site
        ON members (
          (RIGHT(REGEXP_REPLACE(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10)),
          site_id
        )
    `);
    await client.query(`
      ALTER TABLE kyc_cases
        ADD COLUMN IF NOT EXISTS reused_from_case_id INTEGER
          REFERENCES kyc_cases(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kyc_cases_reused_from
        ON kyc_cases(reused_from_case_id)
        WHERE reused_from_case_id IS NOT NULL
    `);
    await client.query(`
      INSERT INTO app_schema_migrations (version)
      VALUES ('147_member_phone_kyc_reuse')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log('Migration 147: cross-site member lookup and KYC reuse are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Member phone/KYC reuse migration failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
