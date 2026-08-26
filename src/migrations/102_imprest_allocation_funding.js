import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Records HOW an imprest allocation is funded, so the confirm/cancel steps stop
 * guessing from the giver's role.
 *
 *   from_own_float = true  → the giver's own imprest float funds it. The giver is
 *                            debited immediately (escrow) and refunded on cancel.
 *   from_own_float = false → an admin is injecting fresh cash from the site
 *                            balance; nothing leaves anyone's float.
 *
 * Role alone can no longer decide this: admins hold floats too, so an admin can
 * be doing either. Legacy rows default to false, which matches the old
 * role-based behaviour (sub-admin givers are still detected by role).
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('102_imprest_allocation_funding'))`);

    await client.query(`
      ALTER TABLE imprest_allocations
        ADD COLUMN IF NOT EXISTS from_own_float BOOLEAN NOT NULL DEFAULT false
    `);

    // Backfill: every allocation whose giver was a sub-admin was already escrowed
    // from that giver's float under the old code path.
    await client.query(`
      UPDATE imprest_allocations ia
         SET from_own_float = true
        FROM users u
       WHERE u.id = ia.admin_id
         AND u.role = 'sub_admin'
         AND ia.from_own_float = false
    `);

    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('102_imprest_allocation_funding')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 102_imprest_allocation_funding complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 102_imprest_allocation_funding failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
