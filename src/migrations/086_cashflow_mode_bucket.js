import pool from '../config/db.js';

/**
 * Migration: classify cash_flow_entries.cash_type by the real payment instrument.
 *
 * Every branch of sync_cashflow_from_modules() only mapped the literal 'BANK'
 * to 'bank' and sent everything else to 'cash'. So a Quick Entry bank payment
 * (whose mode is RTGS / NEFT / UPI / IMPS) and every cheque payment were both
 * stored as cash — the ledger, the dashboard Mode column and any cash-vs-bank
 * report then read them as cash.
 *
 * cashflow_mode_bucket() is now the single place that decision is made.
 */
const BUCKET_FN = `
CREATE OR REPLACE FUNCTION cashflow_mode_bucket(mode TEXT)
RETURNS VARCHAR(20)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN mode IS NULL OR btrim(mode) = '' THEN 'cash'
    WHEN UPPER(btrim(mode)) LIKE '%CHEQUE%' OR UPPER(btrim(mode)) LIKE '%CHECK%'
      OR UPPER(btrim(mode)) = 'DD' OR UPPER(btrim(mode)) LIKE '%DEMAND DRAFT%' THEN 'cheque'
    WHEN UPPER(btrim(mode)) = 'CASH' THEN 'cash'
    ELSE 'bank'
  END;
$$;
`;

const SYNC_FN = `
CREATE OR REPLACE FUNCTION public.sync_cashflow_from_modules()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
      DECLARE
        v_site_id INTEGER;
        v_entry_date DATE;
        v_particular VARCHAR(500);
        v_debit NUMERIC(15,2) := 0;
        v_credit NUMERIC(15,2) := 0;
        v_cash_type VARCHAR(20) := 'cash';
        v_remarks TEXT;
        v_created_by INTEGER;
        v_month_id INTEGER;
        v_source_module VARCHAR(50);
        v_person_source_module VARCHAR(60);
        v_source_id INTEGER;
        v_assigned_admin_id INTEGER;
        v_voucher_url TEXT;
        v_status VARCHAR(20) := 'pending';
        v_approved_by INTEGER;
        v_approved_at TIMESTAMPTZ;
      BEGIN
        v_source_module := TG_TABLE_NAME;
        -- Mirrors are no longer created (owner rule 2026-07-27: personal
        -- ledgers are record-only). The '_person' name is kept only to
        -- garbage-collect mirrors 076 left behind when their source changes.
        v_person_source_module := TG_TABLE_NAME || '_person';

        IF TG_OP = 'DELETE' THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = OLD.id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = OLD.id;
          RETURN OLD;
        END IF;

        v_source_id := NEW.id;

        IF TG_TABLE_NAME = 'farmer_payments' THEN
          SELECT f.site_id, f.name INTO v_site_id, v_particular
          FROM farmers f
          WHERE f.id = NEW.farmer_id;

          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('FARMER PAYMENT - ' || COALESCE(v_particular, 'FARMER'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := NEW.remarks;
          v_created_by := NULL;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_commissions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION - ' || COALESCE(NEW.particular, 'COMMISSION'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := cashflow_mode_bucket(NEW.by_note);
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_commission_payments' THEN
          SELECT COALESCE(m.full_name, 'AGENT') INTO v_particular
          FROM plot_commissions_v2 pcm
          LEFT JOIN members m ON m.id = pcm.agent_id
          WHERE pcm.id = NEW.plot_commission_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT COMMISSION PAYMENT - ' || COALESCE(v_particular, 'AGENT'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'day_book' THEN
          IF UPPER(COALESCE(NEW.entry_type, 'GENERAL')) IN ('CASH FLOW', 'FARMER PAYMENT', 'PLOT COMMISSION', 'FIRM TRANSACTION', 'PLOT PAYMENT', 'VENDOR PAYMENT') THEN
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
            DELETE FROM cash_flow_entries cfe
            WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
            RETURN NEW;
          END IF;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.particular, 'DAY BOOK ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := NEW.remarks;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'firm_transactions' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.description, 'FIRM TRANSACTION');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := NEW.remark;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'plot_payments' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := ('PLOT PAYMENT - ' || COALESCE(NEW.payment_from, 'PLOT'))::VARCHAR(500);
          v_debit := 0;
          v_credit := COALESCE(NEW.amount, 0);
          v_cash_type := cashflow_mode_bucket(NEW.payment_type);
          v_remarks := NEW.narration;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'expenses' THEN
          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.date, CURRENT_DATE);
          v_particular := COALESCE(NEW.remark, 'EXPENSE ENTRY');
          v_debit := COALESCE(NEW.debit, 0);
          v_credit := COALESCE(NEW.credit, 0);
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := CONCAT_WS(' | ', NEW.from_entity, NEW.to_entity, NEW.category);
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;

        ELSIF TG_TABLE_NAME = 'vendor_payments' THEN
          SELECT COALESCE(vc.vendor_name, 'VENDOR') INTO v_particular
          FROM vendor_commitments vc
          WHERE vc.id = NEW.commitment_id;

          v_site_id := NEW.site_id;
          v_entry_date := COALESCE(NEW.payment_date, CURRENT_DATE);
          v_particular := ('VENDOR PAYMENT - ' || COALESCE(v_particular, 'VENDOR'))::VARCHAR(500);
          v_debit := COALESCE(NEW.amount, 0);
          v_credit := 0;
          v_cash_type := cashflow_mode_bucket(NEW.payment_mode);
          v_remarks := NEW.note;
          v_created_by := NEW.created_by;
          v_assigned_admin_id := NEW.assigned_admin_id;
          v_voucher_url := NEW.voucher_url;
          v_status := COALESCE(NEW.status, 'pending');
          v_approved_by := NEW.approved_by;
          v_approved_at := NEW.approved_at;
        ELSE
          RETURN NEW;
        END IF;

        IF v_site_id IS NULL OR (COALESCE(v_debit, 0) = 0 AND COALESCE(v_credit, 0) = 0) THEN
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_source_module AND cfe.source_id = v_source_id;
          DELETE FROM cash_flow_entries cfe
          WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;
          RETURN NEW;
        END IF;

        v_month_id := ensure_site_cashflow_month(v_site_id, v_entry_date, v_created_by);

        INSERT INTO cash_flow_entries (
          cash_flow_month_id, site_id, date, particular, debit, credit, cash_type, remarks,
          created_by, assigned_admin_id, source_module, source_id, voucher_url, status, approved_by, approved_at
        ) VALUES (
          v_month_id, v_site_id, v_entry_date, v_particular, v_debit, v_credit, v_cash_type, v_remarks,
          v_created_by, v_assigned_admin_id, v_source_module, v_source_id, v_voucher_url, v_status, v_approved_by, v_approved_at
        )
        ON CONFLICT (source_module, source_id)
        DO UPDATE SET
          cash_flow_month_id = EXCLUDED.cash_flow_month_id,
          site_id = EXCLUDED.site_id,
          date = EXCLUDED.date,
          particular = EXCLUDED.particular,
          debit = EXCLUDED.debit,
          credit = EXCLUDED.credit,
          cash_type = EXCLUDED.cash_type,
          remarks = EXCLUDED.remarks,
          created_by = EXCLUDED.created_by,
          assigned_admin_id = EXCLUDED.assigned_admin_id,
          voucher_url = EXCLUDED.voucher_url,
          status = EXCLUDED.status,
          approved_by = EXCLUDED.approved_by,
          approved_at = EXCLUDED.approved_at,
          updated_at = NOW();

        -- Person mirror removed (was 076). Drop any stale mirror this source
        -- row still has so it can never freeze at an outdated amount/status.
        DELETE FROM cash_flow_entries cfe
        WHERE cfe.source_module = v_person_source_module AND cfe.source_id = v_source_id;

        RETURN NEW;
      END;
      $function$

`;

const migrate = async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(BUCKET_FN);
    await client.query(SYNC_FN);
    await client.query('COMMIT');
    console.log('✅ Migration 086 complete: cash_type now follows the real payment mode.');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration 086 failed (rolled back, no changes):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
