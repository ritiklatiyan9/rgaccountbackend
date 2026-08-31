import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Separate general transaction classification from cheque clearing while
 * continuing to use the hardened bank-statement parser and row store.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('127_transaction_reconciliation'))`);

    await client.query(`
      ALTER TABLE bank_statement_uploads
      ADD COLUMN IF NOT EXISTS workflow VARCHAR(24) NOT NULL DEFAULT 'CHEQUE'
    `);
    await client.query(`
      ALTER TABLE bank_statement_uploads
      DROP CONSTRAINT IF EXISTS bank_statement_uploads_workflow_check
    `);
    await client.query(`
      ALTER TABLE bank_statement_uploads
      ADD CONSTRAINT bank_statement_uploads_workflow_check
      CHECK (workflow IN ('CHEQUE', 'TRANSACTION'))
    `);

    // The same physical file can legitimately be used in each independent
    // workflow, but remains idempotent inside either one.
    await client.query(`
      ALTER TABLE bank_statement_uploads
      DROP CONSTRAINT IF EXISTS bank_statement_uploads_organization_id_site_id_file_hash_key
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_upload_workflow_file
      ON bank_statement_uploads (organization_id, site_id, file_hash, workflow)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_bank_uploads_workflow_latest
      ON bank_statement_uploads (organization_id, site_id, workflow, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_transaction_module_links (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        upload_id BIGINT NOT NULL REFERENCES bank_statement_uploads(id) ON DELETE RESTRICT,
        bank_transaction_id BIGINT NOT NULL REFERENCES bank_statement_transactions(id) ON DELETE RESTRICT,
        direction VARCHAR(8) NOT NULL CHECK (direction IN ('credit', 'debit')),
        module_key VARCHAR(32) NOT NULL CHECK (module_key IN (
          'farmer', 'land_profit', 'cashflow', 'firm', 'expense',
          'daybook', 'plot', 'plot_commission', 'misc_income'
        )),
        source_entry_id INTEGER NOT NULL CHECK (source_entry_id > 0),
        entry_date DATE NOT NULL,
        entry_amount NUMERIC(18,2) NOT NULL CHECK (entry_amount > 0),
        entry_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (bank_transaction_id),
        UNIQUE (organization_id, module_key, source_entry_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_transaction_module_links_upload
      ON bank_transaction_module_links (upload_id, created_at)
    `);

    await client.query(`
      INSERT INTO public.app_schema_migrations (version)
      VALUES ('127_transaction_reconciliation')
      ON CONFLICT (version) DO NOTHING
    `);

    await client.query('COMMIT');
    console.log('Migration 127_transaction_reconciliation complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 127_transaction_reconciliation failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
