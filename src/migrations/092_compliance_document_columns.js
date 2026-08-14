import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 092 — Compliance document registry columns.
 *
 * Ports the compliance_documents additions the document controller needs
 * (typed documents, provenance, review workflow, versioned series with
 * supersede) from the source app's 094_rera_phase1_foundation. The RERA
 * foreign keys and triggers are not ported — this install has no RERA
 * module; the rera_* columns stay as inert BIGINTs so the controller's
 * insert/select lists work unchanged.
 */
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('092_compliance_document_columns'))`);

    await client.query(`
      ALTER TABLE compliance_approvals ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_documents ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_notification_log ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT;
      ALTER TABLE compliance_audit_log ALTER COLUMN entity_id TYPE BIGINT USING entity_id::BIGINT
    `);

    await client.query(`
      ALTER TABLE compliance_documents
        ADD COLUMN IF NOT EXISTS document_type VARCHAR(120),
        ADD COLUMN IF NOT EXISTS document_number VARCHAR(200),
        ADD COLUMN IF NOT EXISTS effective_date DATE,
        ADD COLUMN IF NOT EXISTS source_type VARCHAR(32),
        ADD COLUMN IF NOT EXISTS source_reference TEXT,
        ADD COLUMN IF NOT EXISTS source_url TEXT,
        ADD COLUMN IF NOT EXISTS source_retrieved_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_status VARCHAR(20),
        ADD COLUMN IF NOT EXISTS reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS review_notes TEXT,
        ADD COLUMN IF NOT EXISTS document_series_key VARCHAR(160),
        ADD COLUMN IF NOT EXISTS supersedes_document_id BIGINT,
        ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS superseded_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_documents_series_version
        ON compliance_documents (
          organization_id, entity_type, entity_id, document_series_key, version_no
        )
        WHERE document_series_key IS NOT NULL
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_documents_org_id
        ON compliance_documents (organization_id, id)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_source_type_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_source_type_chk CHECK (
              source_type IS NULL OR source_type IN (
                'USER_UPLOADED', 'OFFICIAL_PORTAL', 'AUTHORITY_DOCUMENT', 'IMPORTED', 'OTHER'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_review_status_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_review_status_chk CHECK (
              review_status IS NULL OR review_status IN (
                'NOT_REVIEWED', 'PENDING', 'ACCEPTED', 'REJECTED'
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_reviewed_at_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_reviewed_at_chk CHECK (
              review_status NOT IN ('ACCEPTED', 'REJECTED')
              OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_not_self_supersede_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_not_self_supersede_chk CHECK (
              supersedes_document_id IS NULL OR supersedes_document_id <> id
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'compliance_document_effective_dates_chk'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT compliance_document_effective_dates_chk CHECK (
              effective_date IS NULL
              OR (
                (issue_date IS NULL OR effective_date >= issue_date)
                AND (expiry_date IS NULL OR expiry_date >= effective_date)
              )
            );
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'fk_compliance_document_supersedes'
        ) THEN
          ALTER TABLE compliance_documents
            ADD CONSTRAINT fk_compliance_document_supersedes
            FOREIGN KEY (organization_id, supersedes_document_id)
            REFERENCES compliance_documents (organization_id, id) ON DELETE RESTRICT;
        END IF;
      END $$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_document_superseded_once
        ON compliance_documents (organization_id, supersedes_document_id)
        WHERE supersedes_document_id IS NOT NULL AND deleted_at IS NULL
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_compliance_documents_number
        ON compliance_documents (organization_id, UPPER(document_number))
        WHERE document_number IS NOT NULL AND deleted_at IS NULL
    `);

    await client.query('COMMIT');
    console.log('Migration 092_compliance_document_columns complete');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 092 failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function rollback() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('092_compliance_document_columns'))`);
    await client.query(`DROP INDEX IF EXISTS uq_compliance_documents_series_version`);
    await client.query(`DROP INDEX IF EXISTS uq_compliance_document_superseded_once`);
    await client.query(`DROP INDEX IF EXISTS idx_compliance_documents_number`);
    await client.query(`
      ALTER TABLE compliance_documents
        DROP CONSTRAINT IF EXISTS fk_compliance_document_supersedes,
        DROP CONSTRAINT IF EXISTS compliance_document_source_type_chk,
        DROP CONSTRAINT IF EXISTS compliance_document_review_status_chk,
        DROP CONSTRAINT IF EXISTS compliance_document_reviewed_at_chk,
        DROP CONSTRAINT IF EXISTS compliance_document_not_self_supersede_chk,
        DROP CONSTRAINT IF EXISTS compliance_document_effective_dates_chk,
        DROP COLUMN IF EXISTS document_type,
        DROP COLUMN IF EXISTS document_number,
        DROP COLUMN IF EXISTS effective_date,
        DROP COLUMN IF EXISTS source_type,
        DROP COLUMN IF EXISTS source_reference,
        DROP COLUMN IF EXISTS source_url,
        DROP COLUMN IF EXISTS source_retrieved_at,
        DROP COLUMN IF EXISTS review_status,
        DROP COLUMN IF EXISTS reviewed_by,
        DROP COLUMN IF EXISTS reviewed_at,
        DROP COLUMN IF EXISTS review_notes,
        DROP COLUMN IF EXISTS document_series_key,
        DROP COLUMN IF EXISTS supersedes_document_id,
        DROP COLUMN IF EXISTS superseded_at,
        DROP COLUMN IF EXISTS superseded_by
    `);
    await client.query('COMMIT');
    console.log('Migration 092_compliance_document_columns rolled back');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Migration 092 rollback failed:', error.message);
    throw error;
  } finally {
    client.release();
  }
}

const action = process.argv.includes('--down') ? rollback : migrate;
action()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
