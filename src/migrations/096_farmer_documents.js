import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 096 — Farmer documents.
 *
 * Adds a nullable owner link to the shared documents store. Nullable + SET NULL follows the
 * existing plot-document retention policy: deleting a farmer never silently deletes evidence.
 * The application only surfaces rows that remain attached to a farmer.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT to_regclass('public.documents') IS NOT NULL AS has_documents`);
    if (!rows[0]?.has_documents) {
      throw new Error('Shared documents table missing — run the document migrations first.');
    }

    await client.query(`
      ALTER TABLE documents
        ADD COLUMN IF NOT EXISTS farmer_id INTEGER REFERENCES farmers(id) ON DELETE SET NULL
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_documents_farmer_created ON documents(farmer_id, created_at DESC)`);
    await client.query('COMMIT');
    console.log('Migration 096_farmer_documents complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 096_farmer_documents failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
