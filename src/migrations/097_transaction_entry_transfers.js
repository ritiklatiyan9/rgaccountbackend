import 'dotenv/config';
import pool from '../config/db.js';

/** Additive audit trail for cross-module transaction ownership transfers. */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('097_transaction_entry_transfers'))`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_entry_transfers (
        id                  BIGSERIAL PRIMARY KEY,
        site_id             INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        source_type         VARCHAR(40) NOT NULL,
        source_record_id    INTEGER NOT NULL,
        source_parent_id    INTEGER,
        source_parent_name  VARCHAR(255),
        target_type         VARCHAR(40) NOT NULL,
        target_record_id    INTEGER NOT NULL,
        target_parent_id    INTEGER,
        target_parent_name  VARCHAR(255),
        entry_date          DATE NOT NULL,
        direction           VARCHAR(10) NOT NULL CHECK (direction IN ('debit', 'credit')),
        amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
        reason              TEXT NOT NULL,
        source_snapshot     JSONB NOT NULL,
        target_snapshot     JSONB NOT NULL,
        transferred_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE transaction_entry_transfers
          ADD CONSTRAINT transaction_entry_transfers_source_type_check
          CHECK (source_type IN ('personal_ledger', 'expense', 'farmer_payment', 'plot_payment'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE transaction_entry_transfers
          ADD CONSTRAINT transaction_entry_transfers_target_type_check
          CHECK (target_type IN ('personal_ledger', 'expense', 'farmer_payment', 'plot_payment'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE transaction_entry_transfers
          ADD CONSTRAINT transaction_entry_transfers_reason_check
          CHECK (CHAR_LENGTH(BTRIM(reason)) BETWEEN 5 AND 500);
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_transfers_site_created ON transaction_entry_transfers(site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_transfers_source ON transaction_entry_transfers(source_type, source_record_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_txn_transfers_target ON transaction_entry_transfers(target_type, target_record_id)`);
    await client.query('COMMIT');
    console.log('Migration 097_transaction_entry_transfers complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 097_transaction_entry_transfers failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
