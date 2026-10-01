import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`
      ALTER TABLE plot_commission_payments
        ADD COLUMN IF NOT EXISTS tds_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tds_mode TEXT,
        ADD COLUMN IF NOT EXISTS tds_section VARCHAR(10);
      ALTER TABLE tds_deductions
        ADD COLUMN IF NOT EXISTS commission_payment_id INTEGER UNIQUE REFERENCES plot_commission_payments(id) ON DELETE CASCADE,
        ADD COLUMN IF NOT EXISTS source_module TEXT,
        ADD COLUMN IF NOT EXISTS calculation_mode TEXT;
      CREATE INDEX IF NOT EXISTS tds_deductions_module_date_idx ON tds_deductions(site_id, source_module, deduction_date);

      CREATE OR REPLACE FUNCTION guard_commission_tds() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE master plot_commissions_v2%ROWTYPE; module_key text; enabled boolean; committed numeric; deposited boolean;
      BEGIN
        IF TG_OP <> 'INSERT' THEN
          SELECT deposit_date IS NOT NULL INTO deposited FROM tds_deductions
            WHERE commission_payment_id=OLD.id FOR UPDATE;
          IF deposited AND (TG_OP='DELETE') THEN
            RAISE EXCEPTION 'TDS has been deposited. This payment cannot be deleted.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
          IF deposited AND (NEW.amount IS DISTINCT FROM OLD.amount OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount
            OR NEW.date IS DISTINCT FROM OLD.date OR NEW.plot_commission_id IS DISTINCT FROM OLD.plot_commission_id
            OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.tds_section IS DISTINCT FROM OLD.tds_section
            OR NEW.tds_rate IS DISTINCT FROM OLD.tds_rate OR NEW.tds_mode IS DISTINCT FROM OLD.tds_mode
            OR NEW.payment_mode IS DISTINCT FROM OLD.payment_mode OR NEW.cheque_status IS DISTINCT FROM OLD.cheque_status
            OR NEW.status IS DISTINCT FROM OLD.status) THEN
            RAISE EXCEPTION 'TDS has been deposited. This payment is locked because its TDS has been deposited.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        IF NEW.tds_amount < 0 OR NEW.tds_rate < 0 OR NEW.tds_rate > 100 THEN
          RAISE EXCEPTION 'Invalid TDS amount or rate.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_amount > 0 AND (NEW.amount <= 0 OR NEW.tds_mode NOT IN ('manual','percentage')
          OR NEW.tds_mode IS NULL OR NEW.tds_section IS NULL
          OR NEW.tds_section NOT IN ('192','194C','194H','194I','194IA','194J','194Q','OTHER')) THEN
          RAISE EXCEPTION 'TDS requires a positive payout, calculation mode and section.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
        END IF;
        -- A source edit from Day Book or an edit request must never silently
        -- reinterpret a net payment as gross. Use the commission form instead.
        IF TG_OP='UPDATE' AND OLD.tds_amount>0 AND NEW.amount IS DISTINCT FROM OLD.amount
          AND NEW.tds_amount IS NOT DISTINCT FROM OLD.tds_amount AND OLD.tds_mode='percentage' THEN
          IF NEW.tds_amount <> round((NEW.amount+NEW.tds_amount)*NEW.tds_rate/100,2) THEN
            RAISE EXCEPTION 'Edit this TDS payment from the commission module.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        IF NEW.tds_amount>0 AND NEW.tds_mode='percentage'
          AND NEW.tds_amount <> round((NEW.amount+NEW.tds_amount)*NEW.tds_rate/100,2) THEN
          RAISE EXCEPTION 'TDS amount does not match its percentage and gross amount.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_amount>0 AND NEW.tds_mode='manual' THEN
          NEW.tds_rate := round(NEW.tds_amount/(NEW.amount+NEW.tds_amount)*100,2);
        END IF;
        SELECT * INTO master FROM plot_commissions_v2 WHERE id=NEW.plot_commission_id FOR UPDATE;
        IF NEW.site_id IS DISTINCT FROM master.site_id THEN
          RAISE EXCEPTION 'Payment site does not match commission.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
        END IF;
        module_key := CASE WHEN master.plot_id IS NOT NULL THEN 'plot_commission'
          WHEN master.farmer_id IS NOT NULL THEN 'land_purchase_commission' ELSE 'land_sale_commission' END;
        IF NEW.tds_amount>0 AND (TG_OP='INSERT' OR OLD.tds_amount=0) THEN
          SELECT COALESCE((setting_value->module_key->>'enabled')::boolean,false) INTO enabled
            FROM application_settings WHERE site_id=NEW.site_id AND setting_key='tds_workflow';
          IF NOT COALESCE(enabled,false) THEN
            RAISE EXCEPTION 'Enable TDS for this module in Settings first.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        -- Serialize against the master to make the gross cap safe under
        -- concurrent payouts. Pending payments reserve their full gross amount.
        IF NEW.amount>0 AND lower(COALESCE(NEW.status,'approved'))<>'rejected'
          AND COALESCE(NEW.cheque_status,'') NOT IN ('BOUNCED','RETURNED')
          AND (TG_OP='INSERT' OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount
            OR NEW.plot_commission_id IS DISTINCT FROM OLD.plot_commission_id
            OR lower(COALESCE(OLD.status,'approved'))='rejected'
            OR COALESCE(OLD.cheque_status,'') IN ('BOUNCED','RETURNED')) THEN
          SELECT COALESCE(sum(amount+tds_amount),0) INTO committed FROM plot_commission_payments
            WHERE plot_commission_id=NEW.plot_commission_id AND id<>NEW.id
            AND lower(COALESCE(status,'approved'))<>'rejected' AND COALESCE(cheque_status,'') NOT IN ('BOUNCED','RETURNED');
          IF committed+NEW.amount+NEW.tds_amount>master.total_commission+0.005 THEN
            RAISE EXCEPTION 'Gross payment including TDS exceeds the decided commission.' USING ERRCODE='23514', CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS commission_tds_guard ON plot_commission_payments;
      CREATE TRIGGER commission_tds_guard BEFORE INSERT OR UPDATE OR DELETE ON plot_commission_payments
        FOR EACH ROW EXECUTE FUNCTION guard_commission_tds();

      CREATE OR REPLACE FUNCTION sync_commission_tds() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE master plot_commissions_v2%ROWTYPE; person members%ROWTYPE; module_key text; paid numeric;
      BEGIN
        IF TG_OP <> 'DELETE' THEN
          SELECT * INTO master FROM plot_commissions_v2 WHERE id=NEW.plot_commission_id;
          module_key := CASE WHEN master.plot_id IS NOT NULL THEN 'plot_commission'
            WHEN master.farmer_id IS NOT NULL THEN 'land_purchase_commission' ELSE 'land_sale_commission' END;
          IF NEW.tds_amount>0 THEN
            SELECT * INTO person FROM members WHERE id=master.agent_id;
            INSERT INTO tds_deductions(site_id,member_id,deductee_name,pan,aadhaar,section,deduction_date,
              gross_amount,tds_rate,tds_amount,nature,notes,created_by,updated_by,commission_payment_id,source_module,calculation_mode)
              VALUES(NEW.site_id,master.agent_id,person.full_name,
                CASE WHEN upper(trim(person.pan_no)) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN upper(trim(person.pan_no)) END,
                CASE WHEN regexp_replace(COALESCE(person.aadhar_no,''),'[^0-9]','','g') ~ '^[0-9]{12}$'
                  THEN regexp_replace(person.aadhar_no,'[^0-9]','','g') END,
                NEW.tds_section,NEW.date,NEW.amount+NEW.tds_amount,NEW.tds_rate,NEW.tds_amount,
                'Commission #'||master.id,COALESCE(NEW.remarks,''),NEW.created_by,NEW.created_by,NEW.id,module_key,NEW.tds_mode)
              ON CONFLICT(commission_payment_id) DO UPDATE SET
                deduction_date=EXCLUDED.deduction_date,gross_amount=EXCLUDED.gross_amount,
                tds_rate=EXCLUDED.tds_rate,tds_amount=EXCLUDED.tds_amount,section=EXCLUDED.section,
                notes=EXCLUDED.notes,calculation_mode=EXCLUDED.calculation_mode,updated_at=NOW();
          ELSE
            DELETE FROM tds_deductions WHERE commission_payment_id=NEW.id;
          END IF;
        END IF;
        SELECT COALESCE(sum(amount+tds_amount),0) INTO paid FROM plot_commission_payments
          WHERE plot_commission_id=CASE WHEN TG_OP='DELETE' THEN OLD.plot_commission_id ELSE NEW.plot_commission_id END
          AND financial_transaction_posts(CASE WHEN amount<0 THEN 'credit' ELSE 'debit' END,status,payment_mode,cheque_status);
        UPDATE plot_commissions_v2 SET status=CASE WHEN paid>=total_commission THEN 'Completed'
          WHEN paid>0 THEN 'Partial' ELSE 'Pending' END,updated_at=NOW()
          WHERE id=CASE WHEN TG_OP='DELETE' THEN OLD.plot_commission_id ELSE NEW.plot_commission_id END;
        RETURN NULL;
      END $$;
      DROP TRIGGER IF EXISTS commission_tds_sync ON plot_commission_payments;
      CREATE TRIGGER commission_tds_sync AFTER INSERT OR UPDATE OR DELETE ON plot_commission_payments
        FOR EACH ROW EXECUTE FUNCTION sync_commission_tds();
    `);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Commission TDS workflow ready'))
    .catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
