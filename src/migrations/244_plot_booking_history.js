import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '244_plot_booking_history';
export const bookingHistorySchemaSql = `
ALTER TABLE plots ADD COLUMN IF NOT EXISTS previous_booking_plot_id INT REFERENCES plots(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS booking_cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT,
  ADD COLUMN IF NOT EXISTS booking_settlement_commission NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS cancellation_settlement_history JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE UNIQUE INDEX IF NOT EXISTS idx_plot_booking_successor ON plots(previous_booking_plot_id) WHERE previous_booking_plot_id IS NOT NULL;
ALTER TABLE plot_commissions_v2 ADD COLUMN IF NOT EXISTS settlement_commission NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS settlement_percent NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS settled_by INT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settlement_reason TEXT;
ALTER TABLE plot_commissions_v2 DROP CONSTRAINT IF EXISTS commission_booking_settlement;
ALTER TABLE plot_commissions_v2 ADD CONSTRAINT commission_booking_settlement CHECK (
  (settlement_commission IS NULL AND settled_at IS NULL AND settlement_percent IS NULL) OR
  (settlement_commission IS NOT NULL AND settled_at IS NOT NULL AND settlement_commission>=0
   AND settlement_commission<=total_commission AND (settlement_percent IS NULL OR settlement_percent BETWEEN 0 AND 100)));

CREATE OR REPLACE FUNCTION guard_managed_commission_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE master plot_commissions_v2%ROWTYPE; candidate plot_commission_payments%ROWTYPE;
  committed NUMERIC; contribution NUMERIC:=0; old_contribution NUMERIC:=0; effective NUMERIC;
  cancellation_approval TEXT;
  cash_paid NUMERIC; gross_paid NUMERIC; cash_contribution NUMERIC:=0; old_cash_contribution NUMERIC:=0;
BEGIN
  candidate:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO master FROM plot_commissions_v2 WHERE id=candidate.plot_commission_id FOR UPDATE;
  IF TG_OP='UPDATE' AND OLD.plot_commission_id IS DISTINCT FROM NEW.plot_commission_id
    AND (master.allocation_type IS NOT NULL OR master.settlement_commission IS NOT NULL OR EXISTS(
      SELECT 1 FROM plot_commissions_v2 WHERE id=OLD.plot_commission_id AND (allocation_type IS NOT NULL OR settlement_commission IS NOT NULL))) THEN
    RAISE EXCEPTION 'A split commission payment cannot move to another dealer record' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  IF master.allocation_type IS NULL AND master.settlement_commission IS NULL THEN RETURN candidate; END IF;
  IF candidate.site_id IS DISTINCT FROM master.site_id THEN
    RAISE EXCEPTION 'Commission payment must belong to the dealer commission site' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  effective:=COALESCE(master.settlement_commission,master.total_commission);
  IF master.settlement_commission IS NOT NULL THEN
    SELECT CASE WHEN to_jsonb(p) ? 'approval_status' THEN COALESCE(to_jsonb(p)->>'approval_status','pending') ELSE 'approved' END INTO cancellation_approval FROM plots p WHERE p.id=master.plot_id;
    IF cancellation_approval<>'approved' AND TG_OP='INSERT' THEN
      RAISE EXCEPTION 'Approve the booking cancellation before recording broker payouts or recoveries' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
    END IF;
  END IF;
  SELECT COALESCE(SUM(CASE WHEN p.amount>=0 OR financial_transaction_posts('credit',p.status,p.payment_mode,p.cheque_status)
    THEN p.amount+COALESCE(p.tds_amount,0) ELSE 0 END),0),
    COALESCE(SUM(p.amount) FILTER(WHERE financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)),0)
    ,COALESCE(SUM(p.amount+COALESCE(p.tds_amount,0)) FILTER(WHERE financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status)),0)
    INTO committed,cash_paid,gross_paid FROM plot_commission_payments p
    WHERE p.plot_commission_id=master.id AND p.id IS DISTINCT FROM candidate.id
      AND LOWER(COALESCE(NULLIF(TRIM(p.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(p.cheque_status,''))) NOT IN ('BOUNCED','RETURNED');
  IF TG_OP<>'INSERT' THEN
    IF LOWER(COALESCE(NULLIF(TRIM(OLD.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(OLD.cheque_status,''))) NOT IN ('BOUNCED','RETURNED')
      AND (OLD.amount>=0 OR financial_transaction_posts('credit',OLD.status,OLD.payment_mode,OLD.cheque_status)) THEN
      old_contribution:=OLD.amount+COALESCE(OLD.tds_amount,0);
    END IF;
    IF financial_transaction_posts(CASE WHEN OLD.amount<0 THEN 'credit' ELSE 'debit' END,OLD.status,OLD.payment_mode,OLD.cheque_status) THEN old_cash_contribution:=OLD.amount; END IF;
  END IF;
  IF TG_OP<>'DELETE' THEN
    IF LOWER(COALESCE(NULLIF(TRIM(candidate.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(candidate.cheque_status,''))) NOT IN ('BOUNCED','RETURNED')
      AND (candidate.amount>=0 OR financial_transaction_posts('credit',candidate.status,candidate.payment_mode,candidate.cheque_status)) THEN
      contribution:=candidate.amount+COALESCE(candidate.tds_amount,0);
    END IF;
    IF financial_transaction_posts(CASE WHEN candidate.amount<0 THEN 'credit' ELSE 'debit' END,candidate.status,candidate.payment_mode,candidate.cheque_status) THEN cash_contribution:=candidate.amount; END IF;
  END IF;
  IF master.settlement_commission IS NOT NULL AND cancellation_approval<>'approved' AND TG_OP='UPDATE'
    AND cash_contribution IS DISTINCT FROM old_cash_contribution AND cash_contribution<>0
    AND financial_transaction_posts(CASE WHEN candidate.amount<0 THEN 'credit' ELSE 'debit' END,candidate.status,candidate.payment_mode,candidate.cheque_status) THEN
    RAISE EXCEPTION 'Approve the booking cancellation before approving broker payouts or recoveries' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  IF committed+contribution>effective AND (master.settlement_commission IS NULL
    OR (candidate.amount>=0 AND (contribution>old_contribution OR cash_contribution>GREATEST(old_cash_contribution,0)))) THEN
    RAISE EXCEPTION 'This payout exceeds the dealer commission or cancellation settlement, including paid and pending payments' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  IF master.settlement_commission IS NOT NULL AND TG_OP<>'DELETE' AND candidate.amount<0 AND cash_contribution<old_cash_contribution
    AND gross_paid+contribution<effective THEN
    RAISE EXCEPTION 'Recovery cannot exceed the excess above this broker cancellation settlement' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  IF master.settlement_commission IS NOT NULL AND cash_paid+cash_contribution<0 AND cash_contribution<old_cash_contribution THEN
    RAISE EXCEPTION 'Recovery cannot exceed cash actually paid to this dealer; TDS is a separate adjustment' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  RETURN candidate;
END $$;

CREATE OR REPLACE FUNCTION guard_managed_commission_master() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE committed NUMERIC;
BEGIN
  IF OLD.settlement_commission IS NOT NULL THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cancelled booking commission history cannot be removed' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard'; END IF;
    IF NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.plot_id IS DISTINCT FROM OLD.plot_id OR NEW.site_id IS DISTINCT FROM OLD.site_id
      OR NEW.total_commission IS DISTINCT FROM OLD.total_commission OR NEW.allocation_type IS DISTINCT FROM OLD.allocation_type
      OR NEW.allocation_value IS DISTINCT FROM OLD.allocation_value OR NEW.allocation_base IS DISTINCT FROM OLD.allocation_base THEN
      RAISE EXCEPTION 'Cancelled booking original commission terms are preserved' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
    END IF;
    IF NEW.settlement_commission IS DISTINCT FROM OLD.settlement_commission OR NEW.settlement_percent IS DISTINCT FROM OLD.settlement_percent OR NEW.settled_at IS DISTINCT FROM OLD.settled_at
      OR NEW.settled_by IS DISTINCT FROM OLD.settled_by OR NEW.settlement_reason IS DISTINCT FROM OLD.settlement_reason THEN
      IF NOT EXISTS(SELECT 1 FROM plots p WHERE p.id=OLD.plot_id AND to_jsonb(p)->>'approval_status'='rejected'
        AND NOT EXISTS(SELECT 1 FROM plots child WHERE child.previous_booking_plot_id=p.id)) THEN
        RAISE EXCEPTION 'Approved cancellation settlements are preserved; only a rejected proposal can be resubmitted' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.allocation_type IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='DELETE' THEN
    IF EXISTS(SELECT 1 FROM plot_commission_payments WHERE plot_commission_id=OLD.id) THEN
      RAISE EXCEPTION 'A dealer with commission payment history cannot be removed' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.plot_id IS DISTINCT FROM OLD.plot_id OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.allocation_type IS NULL THEN
    RAISE EXCEPTION 'An assigned dealer commission cannot be moved to another property or receiver' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN p.amount>=0 OR financial_transaction_posts('credit',p.status,p.payment_mode,p.cheque_status) THEN p.amount+COALESCE(p.tds_amount,0) ELSE 0 END),0) INTO committed FROM plot_commission_payments p
    WHERE p.plot_commission_id=OLD.id AND LOWER(COALESCE(NULLIF(TRIM(p.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(p.cheque_status,''))) NOT IN ('BOUNCED','RETURNED');
  IF NEW.total_commission<committed THEN
    RAISE EXCEPTION 'Dealer commission cannot be lower than paid and pending payments' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_cancelled_plot_booking() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.booking_cancelled_at IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Cancelled booking history cannot be deleted' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard'; END IF;
  IF to_jsonb(OLD)->>'approval_status'='rejected'
    AND NOT EXISTS(SELECT 1 FROM plots child WHERE child.previous_booking_plot_id=OLD.id) THEN
    IF (to_jsonb(NEW)-ARRAY['updated_at','plot_tag','approval_status','approved_at','approved_by','approval_requested_at','approval_requested_by',
      'approval_original_data','approval_proposed_data','cancellation_reason','booking_settlement_commission','cancellation_settlement_history','assigned_admin_id'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','plot_tag','approval_status','approved_at','approved_by','approval_requested_at','approval_requested_by',
      'approval_original_data','approval_proposed_data','cancellation_reason','booking_settlement_commission','cancellation_settlement_history','assigned_admin_id']) THEN
      RAISE EXCEPTION 'Revising a rejected cancellation cannot change its original booking or buyer' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
    END IF;
  ELSIF (to_jsonb(NEW)-ARRAY['updated_at','plot_tag','approval_status','approved_at','approved_by','approval_original_data','approval_proposed_data'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','plot_tag','approval_status','approved_at','approved_by','approval_original_data','approval_proposed_data']) THEN
    RAISE EXCEPTION 'This cancelled booking is preserved. Create a new booking instead of replacing its buyer or dealers' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cancelled_plot_booking_guard ON plots;
CREATE TRIGGER cancelled_plot_booking_guard BEFORE UPDATE OR DELETE ON plots FOR EACH ROW EXECUTE FUNCTION guard_cancelled_plot_booking();
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('244_plot_booking_history'))");
    await db.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ DEFAULT NOW())');
    if ((await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length) { await db.query('COMMIT'); return false; }
    await db.query(bookingHistorySchemaSql);
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1)',[VERSION]);
    await db.query('COMMIT'); return true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(applied=>console.log(applied?'Booking history and manual settlement schema ready; existing records preserved':'Booking history schema already installed'))
    .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
