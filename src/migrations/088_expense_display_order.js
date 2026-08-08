import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Presentation-only ordering for the Expenses list.
 *
 * Same idea as daybook_entry_order, but expenses rows are always native rows
 * of this table (the page always queries with only_site), so one nullable
 * column beats a side table. NULL means "never dragged" → sorts after the
 * arranged rows of the same date, by created_at.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('088_expense_display_order'))`);

    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS display_order INTEGER`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_expenses_display_order
        ON expenses (site_id, date, display_order)
    `);

    await client.query('COMMIT');
    console.log('Migration 088_expense_display_order complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 088_expense_display_order failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
