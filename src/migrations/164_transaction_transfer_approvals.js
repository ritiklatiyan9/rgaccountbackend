import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

/**
 * A transfer approval is one immutable, balanced posting plan. Accounting rows
 * are created only after the assigned reviewer approves the request.
 */
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('164_transaction_transfer_approvals'))");
    await db.query(`CREATE TABLE IF NOT EXISTS transaction_transfer_approval_requests (
      id BIGSERIAL PRIMARY KEY,
      request_id UUID NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
      assigned_admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      transfer_date DATE NOT NULL,
      amount NUMERIC(15,2) NOT NULL CHECK (amount > 0),
      source_label TEXT NOT NULL,
      target_label TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 5 AND 500),
      request_payload JSONB NOT NULL,
      preview JSONB NOT NULL,
      result JSONB,
      approved_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((status = 'pending' AND approved_by IS NULL AND approved_at IS NULL)
        OR (status IN ('approved','rejected') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)),
      CHECK (status <> 'approved' OR result IS NOT NULL)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS transaction_transfer_approval_pending_assignee
      ON transaction_transfer_approval_requests(assigned_admin_id, site_id, created_at DESC)
      WHERE status = 'pending'`);
    await db.query(`CREATE INDEX IF NOT EXISTS transaction_transfer_approval_pending_site
      ON transaction_transfer_approval_requests(site_id, transfer_date DESC, created_at DESC)
      WHERE status = 'pending'`);
    await db.query(`CREATE OR REPLACE FUNCTION protect_transaction_transfer_approval_request()
      RETURNS TRIGGER LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP='DELETE' THEN
          RAISE EXCEPTION 'Transfer approval history cannot be deleted'
            USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
        END IF;
        IF OLD.status<>'pending'
          OR (to_jsonb(NEW)-ARRAY['status','result','approved_by','approved_at','updated_at'])
             IS DISTINCT FROM
             (to_jsonb(OLD)-ARRAY['status','result','approved_by','approved_at','updated_at']) THEN
          RAISE EXCEPTION 'Transfer approval history cannot be changed'
            USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
        END IF;
        RETURN NEW;
      END $$`);
    await db.query('DROP TRIGGER IF EXISTS transaction_transfer_approval_immutable ON transaction_transfer_approval_requests');
    await db.query(`CREATE TRIGGER transaction_transfer_approval_immutable
      BEFORE UPDATE OR DELETE ON transaction_transfer_approval_requests
      FOR EACH ROW EXECUTE FUNCTION protect_transaction_transfer_approval_request()`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('164_transaction_transfer_approvals') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up()
    .then(() => console.log('Transaction transfer approval schema ready'))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
