import 'dotenv/config';
import pool from '../config/db.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('111_transaction_receipt_history'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_receipts (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL DEFAULT 1,
        site_id INTEGER,
        module VARCHAR(80) NOT NULL,
        record_id VARCHAR(120) NOT NULL,
        customer_signature_url TEXT,
        authority_signature_url TEXT,
        evidence_photo_url TEXT,
        created_by INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (organization_id, module, record_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS transaction_receipt_prints (
        id BIGSERIAL PRIMARY KEY,
        receipt_id BIGINT NOT NULL REFERENCES transaction_receipts(id),
        print_number INTEGER NOT NULL CHECK (print_number > 0),
        watermark VARCHAR(16) NOT NULL CHECK (watermark IN ('ORIGINAL', 'DUPLICATE')),
        printed_by INTEGER,
        printed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        preview_print BOOLEAN NOT NULL DEFAULT FALSE,
        workflow_id UUID,
        route_path TEXT,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        UNIQUE (receipt_id, print_number)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_transaction_receipts_site ON transaction_receipts (site_id, updated_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transaction_receipt_prints_receipt ON transaction_receipt_prints (receipt_id, printed_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_transaction_receipt_prints_user ON transaction_receipt_prints (printed_by, printed_at DESC)`);

    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_transaction_receipt_print_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'transaction_receipt_prints is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_transaction_receipt_prints_append_only ON transaction_receipt_prints`);
    await client.query(`
      CREATE TRIGGER trg_transaction_receipt_prints_append_only
      BEFORE UPDATE OR DELETE ON transaction_receipt_prints
      FOR EACH ROW EXECUTE FUNCTION prevent_transaction_receipt_print_mutation()
    `);

    await client.query('COMMIT');
    console.log('Migration 111: transaction receipt history is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 111 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
