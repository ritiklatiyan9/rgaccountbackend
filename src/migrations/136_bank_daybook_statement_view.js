import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Keeps a bank-export presentation separate from accounting-source records.
 * Deactivating a view is a full rollback of the Day Book presentation; no
 * module table, ledger entry, amount, date, or approval status is touched.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('136_bank_daybook_statement_view'))`);
    const alreadyApplied = await client.query(`
      SELECT 1 FROM app_schema_migrations
       WHERE version = '136_bank_daybook_statement_view'
       LIMIT 1
    `);
    if (alreadyApplied.rowCount) {
      await client.query('COMMIT');
      console.log('Migration 136: already applied');
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_daybook_statement_views (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        account_number VARCHAR(64),
        source_filename TEXT NOT NULL,
        source_hash CHAR(64) NOT NULL,
        statement_sheet TEXT,
        parser_version VARCHAR(48) NOT NULL,
        date_from DATE,
        date_to DATE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, site_id, source_hash)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_daybook_statement_view_rows (
        id BIGSERIAL PRIMARY KEY,
        view_id BIGINT NOT NULL REFERENCES bank_daybook_statement_views(id) ON DELETE CASCADE,
        position INTEGER NOT NULL CHECK (position > 0),
        sheet_row INTEGER,
        statement_serial TEXT,
        transaction_date DATE,
        value_date DATE,
        narration TEXT,
        transaction_reference TEXT,
        cheque_reference TEXT,
        debit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
        credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
        running_balance NUMERIC(18,2),
        raw_row JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (view_id, position)
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_daybook_statement_view_active_site
        ON bank_daybook_statement_views (site_id)
        WHERE is_active
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_daybook_statement_view_rows_date
        ON bank_daybook_statement_view_rows (view_id, transaction_date, position)
    `);
    await client.query(`INSERT INTO app_schema_migrations (version) VALUES ('136_bank_daybook_statement_view')`);
    await client.query('COMMIT');
    console.log('Migration 136: bank Day Book statement view is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 136 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
