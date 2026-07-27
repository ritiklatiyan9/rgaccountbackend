import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Small revision rows make Day Book ordering conflict-safe and retry-safe.
 * They are intentionally separate from the position tables: an empty order
 * still has a revision, and retrying a request never needs to rewrite entries.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('082_daybook_order_state'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daybook_order_state (
        site_id          INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        entry_date       DATE NOT NULL,
        revision         BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
        last_request_id  VARCHAR(128),
        updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (site_id, entry_date)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daybook_global_order_state (
        site_id          INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
        revision         BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
        last_request_id  VARCHAR(128),
        updated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('COMMIT');
    console.log('Migration 082_daybook_order_state complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 082_daybook_order_state failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
