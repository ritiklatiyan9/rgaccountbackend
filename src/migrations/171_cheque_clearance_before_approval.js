import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { CHEQUE_SOURCE_CONFIG } from '../services/chequeStatus.service.js';

export const postingPolicySql = `
  CREATE OR REPLACE FUNCTION financial_transaction_posts(
    p_direction TEXT, p_status TEXT, p_payment_mode TEXT, p_cheque_status TEXT
  ) RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE PARALLEL SAFE AS $$
    SELECT CASE
      WHEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved'))
        IN ('rejected', 'cancelled', 'deleted', 'void', 'voided') THEN FALSE
      WHEN (UPPER(TRIM(COALESCE(p_payment_mode, ''))) IN ('CHEQUE', 'CHECK')
            OR NULLIF(TRIM(COALESCE(p_cheque_status, '')), '') IS NOT NULL)
        AND (UPPER(TRIM(COALESCE(p_cheque_status, ''))) <> 'CLEARED'
             OR LOWER(TRIM(COALESCE(p_status, ''))) <> 'approved') THEN FALSE
      WHEN LOWER(TRIM(COALESCE(p_direction, ''))) = 'credit' THEN TRUE
      WHEN LOWER(TRIM(COALESCE(p_direction, ''))) = 'debit'
        THEN LOWER(COALESCE(NULLIF(TRIM(p_status), ''), 'approved')) = 'approved'
      ELSE FALSE
    END
  $$`;

export const approvalGuardSql = `
  CREATE OR REPLACE FUNCTION enforce_cheque_clearance_approval()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
  BEGIN
    -- The cheque normalizers run first. A new/reopened instrument always
    -- needs a fresh approval after clearance, including legacy early approvals.
    IF NULLIF(TRIM(COALESCE(NEW.cheque_status, '')), '') IS NOT NULL THEN
      IF TG_OP = 'UPDATE' AND UPPER(COALESCE(OLD.cheque_status, '')) <> 'CLEARED'
         AND UPPER(NEW.cheque_status) = 'CLEARED'
         AND LOWER(NEW.status) = 'approved' THEN
        NEW.status := 'pending'; NEW.approved_by := NULL; NEW.approved_at := NULL;
      ELSIF UPPER(NEW.cheque_status) <> 'CLEARED' AND LOWER(NEW.status) = 'approved' THEN
        IF TG_OP = 'UPDATE' AND LOWER(OLD.status) IS DISTINCT FROM 'approved' THEN
          RAISE EXCEPTION 'Clear the cheque before approving it'
            USING ERRCODE = '23514', CONSTRAINT = 'cheque_clearance_before_approval';
        END IF;
        NEW.status := 'pending'; NEW.approved_by := NULL; NEW.approved_at := NULL;
      END IF;
    END IF;
    RETURN NEW;
  END $$`;

export async function up(dbPool = pool) {
  const db = await dbPool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('171_cheque_clearance_before_approval'))");
    // Always restore this function: migration 118 also installs it on startup.
    await db.query(postingPolicySql);
    await db.query('ALTER TABLE plot_payments ADD COLUMN IF NOT EXISTS pending_booking_member_id INTEGER');
    await db.query(approvalGuardSql);
    for (const { table } of Object.values(CHEQUE_SOURCE_CONFIG)) {
      await db.query(`DROP TRIGGER IF EXISTS trg_ac_cheque_clearance_approval ON ${table}`);
      await db.query(`CREATE TRIGGER trg_ac_cheque_clearance_approval
        BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION enforce_cheque_clearance_approval()`);
      // Existing uncleared approvals cannot silently post when later cleared.
      // Keep rejected records and already-cleared approvals intact.
      await db.query(`UPDATE ${table} SET status = 'pending', approved_by = NULL, approved_at = NULL
        WHERE LOWER(status) = 'approved'
          AND NULLIF(TRIM(COALESCE(cheque_status, '')), '') IS NOT NULL
          AND UPPER(TRIM(cheque_status)) <> 'CLEARED'`);
    }
    // Recalculate stored installment totals under the new policy as well.
    await db.query(`UPDATE plot_installments pi SET paid_amount = paid.total,
      status = CASE WHEN paid.total >= pi.amount THEN 'paid'
        WHEN pi.due_date < CURRENT_DATE THEN 'overdue'
        WHEN paid.total > 0 THEN 'partially_paid' ELSE 'pending' END
      FROM (SELECT i.id, COALESCE(SUM(p.amount) FILTER (
        WHERE financial_transaction_posts('credit', p.status, p.payment_mode, p.cheque_status)), 0) AS total
        FROM plot_installments i LEFT JOIN plot_installment_payments p ON p.installment_id = i.id
        GROUP BY i.id) paid
      WHERE pi.id = paid.id AND pi.paid_amount IS DISTINCT FROM paid.total
        AND EXISTS (SELECT 1 FROM plot_installment_payments held
          WHERE held.installment_id = pi.id AND held.cheque_status IS NOT NULL AND held.status = 'pending')`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('171_cheque_clearance_before_approval') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 171: cheque clearance and approval gates installed'))
    .catch(error => { console.error('Migration 171 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
