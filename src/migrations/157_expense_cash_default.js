import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Expense reports already classify a blank instrument as cash. Persist that
// default before the accounting and imprest triggers run, including requests
// from older clients and approvals of pending blank-mode expenses.
// Deliberately do not bulk backfill historic approved expenses.
export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('157_expense_cash_default'))");
    await client.query(`
      CREATE OR REPLACE FUNCTION normalize_expense_payment_mode()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.payment_mode := COALESCE(NULLIF(UPPER(TRIM(NEW.payment_mode)), ''), 'CASH');
        RETURN NEW;
      END
      $$
    `);
    // Runs before the cheque invariant and all AFTER posting triggers.
    await client.query('DROP TRIGGER IF EXISTS trg_00_expense_payment_mode ON expenses');
    await client.query(`
      CREATE TRIGGER trg_00_expense_payment_mode
      BEFORE INSERT OR UPDATE ON expenses
      FOR EACH ROW EXECUTE FUNCTION normalize_expense_payment_mode()
    `);
    await client.query("ALTER TABLE expenses ALTER COLUMN payment_mode SET DEFAULT 'CASH'");
    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('157_expense_cash_default')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up()
    .then(() => console.log('Migration 157: expense cash default ready'))
    .catch(error => { console.error('Migration 157 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
