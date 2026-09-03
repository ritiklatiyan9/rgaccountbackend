import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 138 — a recipient can decline a pending handover.
 *
 * Adds the DECLINED status to imprest_allocations plus the two columns that
 * make the outcome auditable (who declined is always the recipient, so only
 * the when and the why need storing). Pending handovers are ledger-neutral,
 * so declining moves no money; acceptance stays final because every state
 * change still requires status = 'PENDING_RECEIPT'.
 *
 * Pure DDL, idempotent, no balance changes.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('138_allocation_decline'))`);
    const alreadyApplied = await client.query(`
      SELECT 1 FROM app_schema_migrations
       WHERE version = '138_allocation_decline'
       LIMIT 1
    `);
    if (alreadyApplied.rowCount) {
      await client.query('COMMIT');
      console.log('Migration 138: already applied');
      return;
    }

    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS decline_reason TEXT`);
    await client.query(`ALTER TABLE imprest_allocations DROP CONSTRAINT IF EXISTS imprest_allocations_status_check`);
    await client.query(`
      ALTER TABLE imprest_allocations ADD CONSTRAINT imprest_allocations_status_check
        CHECK (status IN ('PENDING_RECEIPT', 'RECEIVED', 'CANCELLED', 'DECLINED'))
    `);

    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('138_allocation_decline')`);
    await client.query('COMMIT');
    console.log('Migration 138: handover decline is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 138 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
