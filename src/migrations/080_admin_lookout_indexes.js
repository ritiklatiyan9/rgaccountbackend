import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Partial and covering indexes for the Administrative Pending Lookout.
 * This migration is idempotent and changes no business data.
 */
const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('080_admin_lookout_indexes'))`);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kyc_cases_pending_lookout
        ON kyc_cases (site_id, updated_at, id)
        INCLUDE (status, client_member_id, created_by)
        WHERE status NOT IN ('VERIFIED', 'REJECTED')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kyc_cases_member_status_lookout
        ON kyc_cases (site_id, client_member_id, status)
        WHERE client_member_id IS NOT NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kyc_documents_case_status
        ON documents (kyc_case_id, ocr_status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_edit_requests_pending_lookout
        ON edit_requests (site_id, created_at DESC, id)
        WHERE status = 'pending'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_imprest_requests_pending_lookout
        ON imprest_expense_requests (site_id, created_at DESC, id)
        WHERE status = 'PENDING'
    `);

    await client.query('COMMIT');
    console.log('Migration 080_admin_lookout_indexes complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 080_admin_lookout_indexes failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
