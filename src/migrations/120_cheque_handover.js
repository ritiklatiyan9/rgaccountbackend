import 'dotenv/config';
import pool from '../config/db.js';

/**
 * Migration 120 — cheque handover tracking inside Document Imprest.
 *
 * The module already tracks "a physical thing handed to a person, expected back".
 * A cheque is the same handover with money attached and a longer tail: after it leaves
 * your hands it can be deposited, clear, bounce, be returned, or be cancelled. So the
 * record gains an `item_type` plus cheque fields, and every state change is appended to
 * `document_imprest_events` — that trail IS the "what happened to that cheque" answer.
 *
 * Existing rows are DOCUMENT by default, so nothing about the current flow changes.
 */
export async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('120_cheque_handover'))`);

    await client.query(`
      ALTER TABLE document_imprest
        ADD COLUMN IF NOT EXISTS item_type        VARCHAR(20) NOT NULL DEFAULT 'DOCUMENT',
        ADD COLUMN IF NOT EXISTS cheque_no        VARCHAR(50),
        ADD COLUMN IF NOT EXISTS bank_name        VARCHAR(150),
        ADD COLUMN IF NOT EXISTS cheque_amount    NUMERIC(15,2),
        ADD COLUMN IF NOT EXISTS cheque_date      DATE,
        ADD COLUMN IF NOT EXISTS payee_name       VARCHAR(255),
        ADD COLUMN IF NOT EXISTS outcome          VARCHAR(20),
        ADD COLUMN IF NOT EXISTS outcome_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS outcome_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS outcome_remarks  TEXT,
        ADD COLUMN IF NOT EXISTS outcome_photo_key TEXT
    `);
    await client.query(`
      ALTER TABLE document_imprest
        DROP CONSTRAINT IF EXISTS document_imprest_item_type_check
    `);
    await client.query(`
      ALTER TABLE document_imprest
        ADD CONSTRAINT document_imprest_item_type_check CHECK (item_type IN ('DOCUMENT', 'CHEQUE'))
    `);
    // Outcomes a cheque can reach once it has left your hands. NULL = still with the holder.
    await client.query(`
      ALTER TABLE document_imprest
        DROP CONSTRAINT IF EXISTS document_imprest_outcome_check
    `);
    await client.query(`
      ALTER TABLE document_imprest
        ADD CONSTRAINT document_imprest_outcome_check
        CHECK (outcome IS NULL OR outcome IN ('DEPOSITED', 'CLEARED', 'BOUNCED', 'RETURNED', 'CANCELLED', 'HANDED_ON'))
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_type ON document_imprest (site_id, item_type, status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_cheque_no ON document_imprest (cheque_no) WHERE cheque_no IS NOT NULL`);

    // The trail. One row per thing that happened, newest last.
    await client.query(`
      CREATE TABLE IF NOT EXISTS document_imprest_events (
        id          SERIAL PRIMARY KEY,
        imprest_id  INTEGER NOT NULL REFERENCES document_imprest(id) ON DELETE CASCADE,
        event       VARCHAR(30) NOT NULL,
        notes       TEXT,
        photo_key   TEXT,
        created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_document_imprest_events_record ON document_imprest_events (imprest_id, created_at)`);

    // Seed the trail for anything already issued/returned so old records aren't blank.
    await client.query(`
      INSERT INTO document_imprest_events (imprest_id, event, notes, photo_key, created_by, created_at)
      SELECT di.id, 'HANDED_OVER', di.remarks, di.photo_key, di.issued_by, di.created_at
        FROM document_imprest di
       WHERE NOT EXISTS (SELECT 1 FROM document_imprest_events e WHERE e.imprest_id = di.id)
    `);
    await client.query(`
      INSERT INTO document_imprest_events (imprest_id, event, notes, photo_key, created_by, created_at)
      SELECT di.id, 'RETURNED', di.return_remarks, di.return_photo_key, di.return_received_by, di.returned_at
        FROM document_imprest di
       WHERE di.status = 'RETURNED' AND di.returned_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM document_imprest_events e WHERE e.imprest_id = di.id AND e.event = 'RETURNED')
    `);

    await client.query(`
      INSERT INTO app_schema_migrations (version) VALUES ('120_cheque_handover')
      ON CONFLICT (version) DO NOTHING
    `);
    await client.query('COMMIT');
    console.log('Migration 120: document_imprest cheque fields + document_imprest_events trail are ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

up()
  .catch((error) => { console.error('Migration 120 failed:', error.message); process.exitCode = 1; })
  .finally(() => pool.end());
