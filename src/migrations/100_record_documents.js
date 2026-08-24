import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 100 — documents attached to accounting module records.
 *
 * The existing documents table already owns storage, URLs and metadata. These
 * nullable columns add a small, generic owner link for records that are not
 * farmers or plots (cash-flow ledgers, vendor commitments, projects, stock
 * materials, registries and the site-level imprest dashboard).
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT to_regclass('public.documents') IS NOT NULL AS has_documents`
    );
    if (!rows[0]?.has_documents) {
      throw new Error('Shared documents table missing — run the document migrations first.');
    }

    await client.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS entity_type VARCHAR(40),
        ADD COLUMN IF NOT EXISTS entity_id BIGINT,
        ADD COLUMN IF NOT EXISTS payment_mode VARCHAR(20)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_entity_created
        ON documents(entity_type, entity_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_documents_entity_payment_mode
        ON documents(entity_type, entity_id, payment_mode)
        WHERE payment_mode IS NOT NULL
    `);
    await client.query('COMMIT');
    console.log('Migration 100_record_documents complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 100_record_documents failed (rolled back):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
