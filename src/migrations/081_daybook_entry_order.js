import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Presentation-only ordering for the Day Book.
 *
 * Transactions continue to live in their owning modules. This table stores a
 * stable ledger/source key and its position for one site and accounting date;
 * it never updates source IDs, timestamps, dates, amounts, or module records.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('081_daybook_entry_order'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daybook_entry_order (
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entry_date    DATE NOT NULL,
        entry_key     TEXT NOT NULL,
        position      INTEGER NOT NULL CHECK (position > 0),
        updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (site_id, entry_date, entry_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daybook_entry_order_lookup
        ON daybook_entry_order (site_id, entry_date, position)
    `);

    // Range statements can be manually arranged across accounting dates.
    // Keep that presentation sequence separate from the per-date sequence so
    // no transaction date or owning module record ever needs to be changed.
    await client.query(`
      CREATE TABLE IF NOT EXISTS daybook_global_order (
        site_id       INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entry_key     TEXT NOT NULL,
        position      INTEGER NOT NULL CHECK (position > 0),
        updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (site_id, entry_key)
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_daybook_global_order_lookup
        ON daybook_global_order (site_id, position)
    `);

    await client.query('COMMIT');
    console.log('Migration 081_daybook_entry_order complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 081_daybook_entry_order failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
