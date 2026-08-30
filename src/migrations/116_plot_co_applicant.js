import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 116 — ONE co-applicant per plot, carried through the whole lifecycle.
 * The plot row is the canonical home (booking → plot → NOC → registry all read it);
 * existing co-applicants on booking clients are copied in once. The NOC toggle becomes
 * tri-state: NULL = include automatically when a co-applicant exists.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('116_plot_co_applicant'))`);
    for (const [col, type] of [['co_applicant_name', 'VARCHAR(255)'], ['co_applicant_relation', 'VARCHAR(100)'], ['co_applicant_phone', 'VARCHAR(20)'], ['co_applicant_aadhar', 'VARCHAR(20)'], ['co_applicant_pan', 'VARCHAR(20)']]) {
      await client.query(`ALTER TABLE plots ADD COLUMN IF NOT EXISTS ${col} ${type}`);
    }
    await client.query(`
      UPDATE plots p
         SET co_applicant_name = UPPER(BTRIM(m.co_applicant_name)),
             co_applicant_relation = m.co_applicant_relation,
             co_applicant_phone = m.co_applicant_phone,
             co_applicant_aadhar = NULLIF(BTRIM(COALESCE(m.co_applicant_aadhar, '')), ''),
             co_applicant_pan = NULLIF(BTRIM(COALESCE(m.co_applicant_pan, '')), '')
        FROM bookings b JOIN members m ON m.id = b.client_member_id
       WHERE b.plot_id = p.id
         AND COALESCE(b.status, '') NOT ILIKE 'cancel%'
         AND NULLIF(BTRIM(COALESCE(m.co_applicant_name, '')), '') IS NOT NULL
         AND NULLIF(BTRIM(COALESCE(p.co_applicant_name, '')), '') IS NULL
    `);
    await client.query(`ALTER TABLE plot_registries ALTER COLUMN noc_include_co_applicant DROP NOT NULL`);
    await client.query(`ALTER TABLE plot_registries ALTER COLUMN noc_include_co_applicant DROP DEFAULT`);
    await client.query(`UPDATE plot_registries SET noc_include_co_applicant = NULL WHERE noc_include_co_applicant = FALSE AND noc_generated_at IS NULL`);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('116_plot_co_applicant') ON CONFLICT (version) DO NOTHING`);
    await client.query('COMMIT');
    console.log('Migration 116: plots.co_applicant_* ready (backfilled from booking clients); NOC toggle tri-state');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 116 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
