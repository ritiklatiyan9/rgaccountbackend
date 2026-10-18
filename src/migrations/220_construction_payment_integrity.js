import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Schema and guards only: no historical payment, mirror or ledger row is
// rewritten. If an existing unique-source index is missing and duplicates
// exist, CREATE UNIQUE INDEX fails for operator review without deleting them.
export const migrationSql = `
ALTER TABLE vendor_payments
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(128),
  ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64),
  ADD COLUMN IF NOT EXISTS first_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS vendor_payment_request_once
  ON vendor_payments(site_id,created_by,idempotency_key) WHERE idempotency_key IS NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
      JOIN pg_attribute module_key ON module_key.attrelid=i.indrelid AND module_key.attname='source_module'
      JOIN pg_attribute source_key ON source_key.attrelid=i.indrelid AND source_key.attname='source_id'
     WHERE i.indrelid='cash_flow_entries'::regclass AND i.indisunique AND i.indisvalid
       AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=2
       AND ((i.indkey[0]=module_key.attnum AND i.indkey[1]=source_key.attnum)
         OR (i.indkey[1]=module_key.attnum AND i.indkey[0]=source_key.attnum))
  ) THEN
    CREATE UNIQUE INDEX vendor_cashflow_source_once ON cash_flow_entries(source_module,source_id);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION vendor_payment_reserved(p_status TEXT,p_cheque_status TEXT)
RETURNS BOOLEAN LANGUAGE SQL IMMUTABLE AS $$
  SELECT LOWER(COALESCE(p_status,'pending')) IN ('pending','approved')
    AND UPPER(COALESCE(p_cheque_status,'')) NOT IN ('BOUNCED','RETURNED')
$$;

CREATE OR REPLACE FUNCTION guard_vendor_payment_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE commitment vendor_commitments%ROWTYPE; reserved NUMERIC; current_id INTEGER; paired_transfer BOOLEAN;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Vendor payments must be retained for audit; cancel pending payments instead'
      USING ERRCODE='23514',CONSTRAINT='vendor_payment_history';
  END IF;
  paired_transfer:=NULLIF(to_jsonb(NEW)->>'entry_transfer_id','') IS NOT NULL;
  IF TG_OP='UPDATE' THEN
    NEW.first_approved_at := COALESCE(OLD.first_approved_at, CASE WHEN OLD.status='approved' THEN COALESCE(OLD.approved_at,NOW()) END, NEW.first_approved_at);
    IF OLD.status='rejected' AND NEW.status <> 'rejected' THEN
      RAISE EXCEPTION 'Rejected vendor payments are retained; record a new payment instead'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_history';
    END IF;
    IF (OLD.status <> 'pending' OR OLD.approved_at IS NOT NULL OR OLD.first_approved_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL)
      AND ROW(NEW.site_id,NEW.commitment_id,NEW.payment_date,NEW.amount,NEW.payment_mode,NEW.cheque_no,NEW.tds_amount)
        IS DISTINCT FROM ROW(OLD.site_id,OLD.commitment_id,OLD.payment_date,OLD.amount,OLD.payment_mode,OLD.cheque_no,OLD.tds_amount) THEN
      RAISE EXCEPTION 'Decided vendor payment financial details cannot be rewritten'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_history';
    END IF;
    IF ROW(NEW.id,NEW.created_by,NEW.idempotency_key,NEW.request_fingerprint)
      IS DISTINCT FROM ROW(OLD.id,OLD.created_by,OLD.idempotency_key,OLD.request_fingerprint) THEN
      RAISE EXCEPTION 'Vendor payment source identity cannot change'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_identity';
    END IF;
    IF OLD.cancelled_at IS NOT NULL AND NEW.status <> 'rejected' THEN
      RAISE EXCEPTION 'Cancelled vendor payments cannot be approved'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_history';
    END IF;
  END IF;
  IF NEW.status='approved' THEN NEW.first_approved_at:=COALESCE(NEW.first_approved_at,NEW.approved_at,NOW()); END IF;
  SELECT * INTO commitment FROM vendor_commitments WHERE id=NEW.commitment_id FOR UPDATE;
  IF NOT FOUND OR commitment.site_id <> NEW.site_id THEN
    RAISE EXCEPTION 'Payment commitment must belong to the selected site'
      USING ERRCODE='23514',CONSTRAINT='vendor_payment_site';
  END IF;
  IF NEW.amount=0 OR (NEW.amount<0 AND NOT paired_transfer) OR NEW.tds_amount < 0 OR NEW.payment_date NOT BETWEEN DATE '1900-01-01' AND DATE '2100-12-31' THEN
    RAISE EXCEPTION 'Invalid vendor payment amount or date'
      USING ERRCODE='23514',CONSTRAINT='vendor_payment_values';
  END IF;
  -- Only allocation-affecting changes need the reservation check. Workflow
  -- metadata updates must continue to work on untouched legacy overpayments.
  IF TG_OP='INSERT' OR ROW(NEW.amount,NEW.tds_amount,NEW.status,NEW.cheque_status,NEW.commitment_id)
     IS DISTINCT FROM ROW(OLD.amount,OLD.tds_amount,OLD.status,OLD.cheque_status,OLD.commitment_id) THEN
    IF vendor_payment_reserved(NEW.status,NEW.cheque_status) THEN
      IF TG_OP='INSERT' AND commitment.status <> 'open' AND NOT paired_transfer THEN
        RAISE EXCEPTION 'Payments can only be recorded against an open commitment'
          USING ERRCODE='23514',CONSTRAINT='vendor_payment_commitment_state';
      END IF;
      current_id := CASE WHEN TG_OP='UPDATE' THEN OLD.id ELSE -1 END;
      SELECT COALESCE(SUM(amount+tds_amount),0) INTO reserved FROM vendor_payments
        WHERE commitment_id=NEW.commitment_id AND id<>current_id AND cancelled_at IS NULL
          AND vendor_payment_reserved(status,cheque_status);
      IF reserved+NEW.amount+NEW.tds_amount > commitment.contract_amount THEN
        RAISE EXCEPTION 'Payment exceeds the commitment balance after pending payments and TDS'
          USING ERRCODE='23514',CONSTRAINT='vendor_payment_overpayment';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_az_vendor_payment_integrity ON vendor_payments;
CREATE TRIGGER trg_az_vendor_payment_integrity BEFORE INSERT OR UPDATE OR DELETE ON vendor_payments
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_payment_integrity();

CREATE OR REPLACE FUNCTION guard_vendor_commitment_integrity()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE reserved NUMERIC; project construction_projects%ROWTYPE; committed NUMERIC;
BEGIN
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM vendor_payments WHERE commitment_id=OLD.id) THEN
      RAISE EXCEPTION 'Commitments with payment history must be retained; close or cancel the commitment'
        USING ERRCODE='23514',CONSTRAINT='vendor_commitment_history';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.contract_amount <= 0 OR (NEW.start_date IS NOT NULL AND NEW.due_date < NEW.start_date) THEN
    RAISE EXCEPTION 'Invalid commitment amount or planned dates'
      USING ERRCODE='23514',CONSTRAINT='vendor_commitment_values';
  END IF;
  IF TG_OP='UPDATE' AND NEW.contract_amount < OLD.contract_amount THEN
    SELECT COALESCE(SUM(amount+tds_amount),0) INTO reserved FROM vendor_payments
      WHERE commitment_id=OLD.id AND cancelled_at IS NULL AND vendor_payment_reserved(status,cheque_status);
    IF NEW.contract_amount < reserved THEN
      RAISE EXCEPTION 'Commitment amount cannot be less than approved and pending payments including TDS'
        USING ERRCODE='23514',CONSTRAINT='vendor_commitment_overpayment';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.status='cancelled' AND NEW.status<>'cancelled' THEN
    RAISE EXCEPTION 'Cancelled commitments cannot be reopened'
      USING ERRCODE='23514',CONSTRAINT='vendor_commitment_state';
  END IF;
  IF TG_OP='UPDATE' AND NEW.status='cancelled' AND OLD.status<>'cancelled' AND EXISTS(
    SELECT 1 FROM vendor_payments WHERE commitment_id=OLD.id AND cancelled_at IS NULL AND vendor_payment_reserved(status,cheque_status)) THEN
    RAISE EXCEPTION 'A commitment with pending or approved payments cannot be cancelled; close it instead'
      USING ERRCODE='23514',CONSTRAINT='vendor_commitment_history';
  END IF;
  IF NEW.project_id IS NOT NULL AND NEW.status<>'cancelled' AND (TG_OP='INSERT'
    OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.contract_amount>OLD.contract_amount) THEN
    SELECT * INTO project FROM construction_projects WHERE id=NEW.project_id AND site_id=NEW.site_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Commitment project must belong to the selected site'
        USING ERRCODE='23514',CONSTRAINT='vendor_commitment_site';
    END IF;
    SELECT COALESCE(SUM(contract_amount),0) INTO committed FROM vendor_commitments
      WHERE project_id=NEW.project_id AND status<>'cancelled' AND id<>COALESCE(NEW.id,-1);
    IF committed+NEW.contract_amount>project.budget THEN
      RAISE EXCEPTION 'Vendor commitment exceeds the remaining project budget'
        USING ERRCODE='23514',CONSTRAINT='vendor_commitment_budget';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND ROW(NEW.site_id,NEW.project_id,NEW.vendor_member_id,NEW.vendor_name) IS DISTINCT FROM ROW(OLD.site_id,OLD.project_id,OLD.vendor_member_id,OLD.vendor_name)
    AND EXISTS(SELECT 1 FROM vendor_payments WHERE commitment_id=OLD.id) THEN
    RAISE EXCEPTION 'A commitment with payment history cannot change its site, project or vendor'
      USING ERRCODE='23514',CONSTRAINT='vendor_commitment_history';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_vendor_commitment_integrity ON vendor_commitments;
CREATE TRIGGER trg_vendor_commitment_integrity BEFORE INSERT OR UPDATE OR DELETE ON vendor_commitments
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_commitment_integrity();

-- The module owns its cash-flow mirror. Direct approval/edit/delete of a
-- mirror must never post money while the source is pending or change its value.
CREATE OR REPLACE FUNCTION guard_vendor_cashflow_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE payment vendor_payments%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.source_module='vendor_payments' AND EXISTS(SELECT 1 FROM vendor_payments WHERE id=OLD.source_id) THEN
      RAISE EXCEPTION 'Edit the owning vendor payment instead of its ledger mirror'
        USING ERRCODE='23514',CONSTRAINT='vendor_cashflow_owner';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' AND OLD.source_module='vendor_payments'
    AND ROW(NEW.source_module,NEW.source_id) IS DISTINCT FROM ROW(OLD.source_module,OLD.source_id) THEN
    RAISE EXCEPTION 'Vendor ledger source identity cannot change'
      USING ERRCODE='23514',CONSTRAINT='vendor_cashflow_owner';
  END IF;
  IF NEW.source_module='vendor_payments' THEN
    SELECT * INTO payment FROM vendor_payments WHERE id=NEW.source_id;
    IF NOT FOUND OR NEW.site_id IS DISTINCT FROM payment.site_id
      OR NEW.date::date IS DISTINCT FROM payment.payment_date
      OR NOT ((NEW.debit IS NOT DISTINCT FROM payment.amount AND COALESCE(NEW.credit,0)=0)
        OR (NULLIF(to_jsonb(payment)->>'entry_transfer_id','') IS NOT NULL
          AND NEW.debit=GREATEST(payment.amount,0) AND NEW.credit=GREATEST(-payment.amount,0)))
      OR NEW.status IS DISTINCT FROM payment.status THEN
      RAISE EXCEPTION 'Vendor cash-flow mirror must match its canonical payment source'
        USING ERRCODE='23514',CONSTRAINT='vendor_cashflow_owner';
    END IF;
  ELSIF NEW.source_module='vendor_inventory_payments' AND EXISTS(
    SELECT 1 FROM vendor_inventory_payments WHERE id=NEW.source_id AND source_vendor_payment_id IS NOT NULL) THEN
    RAISE EXCEPTION 'A vendor payment allocation cannot create a second ledger debit'
      USING ERRCODE='23514',CONSTRAINT='vendor_cashflow_owner';
  ELSIF NEW.source_module='day_book' AND EXISTS(
    SELECT 1 FROM day_book WHERE id=NEW.source_id AND (vendor_payment_id IS NOT NULL OR UPPER(entry_type)='VENDOR PAYMENT')) THEN
    RAISE EXCEPTION 'A vendor day-book mirror cannot create a second ledger debit'
      USING ERRCODE='23514',CONSTRAINT='vendor_cashflow_owner';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_zz_vendor_cashflow_owner ON cash_flow_entries;
CREATE TRIGGER trg_zz_vendor_cashflow_owner BEFORE INSERT OR UPDATE OR DELETE ON cash_flow_entries
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_cashflow_owner();

CREATE OR REPLACE FUNCTION guard_vendor_payment_allocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE payment vendor_payments%ROWTYPE; order_commitment INTEGER; allocated NUMERIC;
BEGIN
  IF TG_OP='UPDATE' AND OLD.source_vendor_payment_id IS NOT NULL AND NEW.source_vendor_payment_id IS DISTINCT FROM OLD.source_vendor_payment_id THEN
    RAISE EXCEPTION 'An inventory allocation cannot become an independent payment'
      USING ERRCODE='23514',CONSTRAINT='vendor_payment_allocation';
  END IF;
  IF NEW.source_vendor_payment_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO payment FROM vendor_payments WHERE id=NEW.source_vendor_payment_id FOR UPDATE;
  SELECT commitment_id INTO order_commitment FROM vendor_inventory_orders WHERE id=NEW.order_id AND site_id=NEW.site_id;
  IF payment.id IS NULL OR payment.site_id IS DISTINCT FROM NEW.site_id OR order_commitment IS DISTINCT FROM payment.commitment_id THEN
    RAISE EXCEPTION 'Inventory allocation must belong to the canonical vendor payment and commitment'
      USING ERRCODE='23514',CONSTRAINT='vendor_payment_allocation';
  END IF;
  -- Date/cheque/time propagation triggers can run before the controller's
  -- explicit allocation UPDATE. Always inherit the current source decision.
  NEW.status:=payment.status; NEW.approved_by:=payment.approved_by; NEW.approved_at:=payment.approved_at;
  NEW.payment_date:=payment.payment_date; NEW.payment_mode:=payment.payment_mode;
  NEW.cheque_status:=payment.cheque_status; NEW.cheque_no:=payment.cheque_no;
  IF TG_OP='INSERT' OR ROW(NEW.amount,NEW.source_vendor_payment_id,NEW.order_id)
    IS DISTINCT FROM ROW(OLD.amount,OLD.source_vendor_payment_id,OLD.order_id) THEN
    IF EXISTS(SELECT 1 FROM vendor_inventory_payments WHERE source_vendor_payment_id=NEW.source_vendor_payment_id
      AND order_id=NEW.order_id AND id<>COALESCE(NEW.id,-1)) THEN
      RAISE EXCEPTION 'This payment is already allocated to that inventory item'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_allocation';
    END IF;
    SELECT COALESCE(SUM(amount+tds_amount),0) INTO allocated FROM vendor_inventory_payments
      WHERE source_vendor_payment_id=NEW.source_vendor_payment_id AND id<>COALESCE(NEW.id,-1);
    IF NEW.amount<=0 OR allocated+NEW.amount+NEW.tds_amount>payment.amount+payment.tds_amount THEN
      RAISE EXCEPTION 'Inventory allocations cannot exceed the source vendor payment'
        USING ERRCODE='23514',CONSTRAINT='vendor_payment_allocation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_az_vendor_payment_allocation ON vendor_inventory_payments;
CREATE TRIGGER trg_az_vendor_payment_allocation BEFORE INSERT OR UPDATE ON vendor_inventory_payments
  FOR EACH ROW EXECUTE FUNCTION guard_vendor_payment_allocation();
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('220_construction_payment_integrity'))");
    await db.query(migrationSql);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('220_construction_payment_integrity') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Construction payment integrity installed'))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
