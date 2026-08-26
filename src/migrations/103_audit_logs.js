import 'dotenv/config';
import pool from '../config/db.js';

export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('103_audit_logs'))`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id BIGSERIAL PRIMARY KEY,
        organization_id INTEGER NOT NULL DEFAULT 1,
        site_id INTEGER,
        user_id INTEGER,
        action VARCHAR(32) NOT NULL,
        event_type VARCHAR(32) NOT NULL DEFAULT 'HTTP',
        module VARCHAR(80) NOT NULL,
        transaction_name TEXT,
        amount NUMERIC(18,2),
        entity_type VARCHAR(100),
        entity_id VARCHAR(120),
        request_method VARCHAR(10),
        request_path TEXT,
        status_code INTEGER,
        outcome VARCHAR(16) NOT NULL DEFAULT 'SUCCESS'
          CHECK (outcome IN ('SUCCESS', 'FAILURE')),
        description TEXT NOT NULL,
        old_values JSONB,
        new_values JSONB,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        ip_address VARCHAR(80),
        user_agent TEXT,
        request_id UUID,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS transaction_name TEXT');
    await client.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS amount NUMERIC(18,2)');

    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created ON audit_logs (organization_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_site_created ON audit_logs (site_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_created ON audit_logs (user_id, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_module_action ON audit_logs (organization_id, module, action, created_at DESC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs (entity_type, entity_id, created_at DESC)`);

    // Audit rows are append-only. User/site IDs intentionally are not foreign
    // keys so deleting an account or site cannot erase or rewrite its history.
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_logs is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS trg_audit_logs_append_only ON audit_logs`);
    await client.query(`
      CREATE TRIGGER trg_audit_logs_append_only
      BEFORE UPDATE OR DELETE ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation()
    `);

    // A stable, one-time system event makes the deployment itself auditable
    // and gives a newly opened module a useful first record.
    await client.query(`
      INSERT INTO audit_logs (
        organization_id, action, event_type, module, entity_type,
        outcome, description, metadata, request_id
      )
      SELECT
        1, 'CREATE', 'SYSTEM', 'audit_logs', 'audit_log_schema',
        'SUCCESS', 'Audit logging was enabled',
        '{"append_only": true, "page_size": 100}'::jsonb,
        '00000000-0000-0000-0000-000000000103'::uuid
      WHERE NOT EXISTS (
        SELECT 1 FROM audit_logs
         WHERE request_id = '00000000-0000-0000-0000-000000000103'::uuid
      )
    `);

    await client.query('COMMIT');
    console.log('Migration 103: immutable audit logs are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => {
    console.error('Migration 103 failed:', error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
