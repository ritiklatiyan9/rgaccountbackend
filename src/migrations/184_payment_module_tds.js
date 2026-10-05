import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { TDS_SOURCES } from '../services/paymentTds.service.js';

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE tds_deductions
      ADD COLUMN IF NOT EXISTS source_table TEXT,
      ADD COLUMN IF NOT EXISTS source_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_label TEXT,
      ADD COLUMN IF NOT EXISTS source_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'active';
      CREATE UNIQUE INDEX IF NOT EXISTS tds_deductions_native_source_idx ON tds_deductions(source_table,source_id);
      CREATE OR REPLACE FUNCTION guard_native_payment_tds() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE draft jsonb; prior jsonb; deduction tds_deductions%ROWTYPE; payout numeric; gross numeric;
        site integer; allowed boolean; module_key text; parent jsonb;
      BEGIN
        IF TG_OP<>'INSERT' THEN
          SELECT * INTO deduction FROM tds_deductions WHERE source_table=TG_TABLE_NAME AND source_id=OLD.id FOR UPDATE;
          IF deduction.deposit_date IS NOT NULL THEN
            IF TG_OP='DELETE' THEN
              RAISE EXCEPTION 'TDS has been deposited. This payment cannot be deleted.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
            END IF;
            draft:=to_jsonb(NEW); prior:=to_jsonb(OLD);
            IF (draft - ARRAY['tds_revision','updated_at','approved_at','approved_by','voucher_url','customer_signature_url','authority_signature_url','evidence_photo_url','bill_url','bill_urls','voucher_urls','remark','remarks','note','by_note'])
              IS DISTINCT FROM (prior - ARRAY['tds_revision','updated_at','approved_at','approved_by','voucher_url','customer_signature_url','authority_signature_url','evidence_photo_url','bill_url','bill_urls','voucher_urls','remark','remarks','note','by_note']) THEN
              RAISE EXCEPTION 'TDS has been deposited. Financial details and payment state are locked.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
            END IF;
          END IF;
          IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        END IF;
        draft:=to_jsonb(NEW);
        IF TG_OP='UPDATE' AND OLD.tds_amount>0 AND NEW.tds_revision IS NOT DISTINCT FROM OLD.tds_revision
          AND (draft->TG_ARGV[1] IS DISTINCT FROM to_jsonb(OLD)->TG_ARGV[1] OR NEW.tds_amount IS DISTINCT FROM OLD.tds_amount) THEN
          RAISE EXCEPTION 'Edit this TDS payment from its source module with gross amount and TDS details.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        payout:=COALESCE((draft->>TG_ARGV[1])::numeric,0);
        gross:=payout+NEW.tds_amount;
        IF NEW.tds_amount::text IN ('NaN','Infinity','-Infinity') OR NEW.tds_rate::text IN ('NaN','Infinity','-Infinity') OR payout::text IN ('NaN','Infinity','-Infinity') OR NEW.tds_amount<0 OR NEW.tds_rate<0 OR NEW.tds_rate>100 THEN
          RAISE EXCEPTION 'Invalid TDS amount or rate.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_amount=0 THEN RETURN NEW; END IF;
        IF payout<=0 OR COALESCE((draft->>'credit')::numeric,0)>0
          OR (TG_TABLE_NAME='misc_income_entries' AND draft->>'direction'<>'debit')
          OR NEW.tds_mode IS NULL OR NEW.tds_mode NOT IN ('manual','percentage')
          OR NEW.tds_section IS NULL OR NEW.tds_section NOT IN ('192','194C','194H','194I','194IA','194J','194Q','OTHER') THEN
          RAISE EXCEPTION 'TDS requires an outgoing payout, calculation mode and section.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_mode='percentage' AND (NEW.tds_rate<=0 OR NEW.tds_amount<>round(gross*NEW.tds_rate/100,2)) THEN
          RAISE EXCEPTION 'Edit this TDS payment from its source module using gross amount and TDS details.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_mode='manual' THEN NEW.tds_rate:=round(NEW.tds_amount/gross*100,2); END IF;
        module_key:=COALESCE(NEW.tds_module,TG_ARGV[0]);
        IF module_key<>TG_ARGV[0] AND NOT (TG_TABLE_NAME='expenses' AND module_key='imprest_expense') THEN
          RAISE EXCEPTION 'TDS module does not match the source payment.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        NEW.tds_module:=module_key;
        site:=(draft->>'site_id')::integer;
        IF TG_TABLE_NAME='farmer_payments' THEN SELECT to_jsonb(f) INTO parent FROM farmers f WHERE id=NEW.farmer_id; site:=(parent->>'site_id')::integer; END IF;
        IF site IS NULL THEN RAISE EXCEPTION 'A site is required for TDS.' USING ERRCODE='23514',CONSTRAINT='tds_workflow'; END IF;
        IF TG_OP='INSERT' OR OLD.tds_amount=0 THEN
          SELECT COALESCE((setting_value->module_key->>'enabled')::boolean,false) INTO allowed FROM application_settings WHERE site_id=site AND setting_key='tds_workflow';
          IF NOT COALESCE(allowed,false) THEN RAISE EXCEPTION 'Enable TDS for this module in Settings first.' USING ERRCODE='23514',CONSTRAINT='tds_workflow'; END IF;
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION sync_native_payment_tds() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE draft jsonb; parent jsonb; person jsonb; site integer; member integer; name text;
        payout numeric; state text; mode text; status text; cheque text; label text;
      BEGIN
        IF TG_OP='DELETE' THEN DELETE FROM tds_deductions WHERE source_table=TG_TABLE_NAME AND source_id=OLD.id; RETURN NULL; END IF;
        IF NEW.tds_amount=0 THEN DELETE FROM tds_deductions WHERE source_table=TG_TABLE_NAME AND source_id=NEW.id; RETURN NULL; END IF;
        draft:=to_jsonb(NEW); site:=(draft->>'site_id')::integer;
        payout:=(draft->>TG_ARGV[1])::numeric;
        name:=NULLIF(trim(NEW.tds_deductee_name),'');
        label:=TG_ARGV[0]||' #'||NEW.id;
        IF TG_TABLE_NAME='farmer_payments' THEN
          SELECT to_jsonb(f) INTO parent FROM farmers f WHERE id=NEW.farmer_id;
          site:=(parent->>'site_id')::integer; member:=(parent->>'member_id')::integer;
          name:=COALESCE(name,parent->>'name'); label:='Land purchase / '||COALESCE(parent->>'name','Farmer #'||NEW.farmer_id);
        ELSIF TG_TABLE_NAME='vendor_payments' THEN
          SELECT to_jsonb(v) INTO parent FROM vendor_commitments v WHERE id=NEW.commitment_id;
          member:=(parent->>'vendor_member_id')::integer; name:=COALESCE(name,parent->>'vendor_name'); label:='Vendor / '||COALESCE(parent->>'work_title','Commitment #'||NEW.commitment_id);
        ELSIF TG_TABLE_NAME='vendor_inventory_payments' THEN
          SELECT to_jsonb(v) INTO parent FROM vendor_inventory_orders v WHERE id=NEW.order_id;
          member:=(parent->>'vendor_member_id')::integer; name:=COALESCE(name,parent->>'vendor_name'); label:='Purchase order #'||NEW.order_id;
        ELSIF TG_TABLE_NAME='partner_profit_payments' THEN member:=NEW.member_id; label:='Partner profit payment #'||NEW.id;
        ELSIF TG_TABLE_NAME='cash_flow_entries' THEN
          SELECT to_jsonb(c) INTO parent FROM cash_flow_months c WHERE id=NEW.cash_flow_month_id;
          member:=(parent->>'linked_member_id')::integer; name:=COALESCE(name,parent->>'ledger_name'); label:='Personal ledger / '||COALESCE(parent->>'ledger_name',NEW.cash_flow_month_id::text);
        END IF;
        SELECT to_jsonb(m) INTO person FROM members m WHERE id=member AND site_id=site;
        IF person IS NULL THEN member:=NULL; END IF;
        name:=COALESCE(name,person->>'full_name',NULLIF(draft->>'party_name',''),NULLIF(draft->>'to_entity',''),NULLIF(draft->>'name',''),NULLIF(draft->>'particular',''),label);
        mode:=COALESCE(draft->>'payment_mode',draft->>'cash_type',CASE WHEN TG_TABLE_NAME='plot_commissions' AND upper(COALESCE(draft->>'by_note','')) LIKE '%CHEQUE%' THEN 'CHEQUE' WHEN TG_TABLE_NAME='plot_commissions' AND upper(COALESCE(draft->>'by_note','')) ~ '(BANK|ONLINE|NEFT|RTGS|UPI)' THEN 'BANK' ELSE 'CASH' END); status:=COALESCE(draft->>'status','approved'); cheque:=draft->>'cheque_status';
        state:=CASE WHEN lower(status) IN ('rejected','returned') OR upper(COALESCE(cheque,'')) IN ('BOUNCED','RETURNED') THEN 'reversed'
          WHEN financial_transaction_posts('debit',status,mode,cheque) THEN 'active' ELSE 'pending' END;
        INSERT INTO tds_deductions(site_id,member_id,deductee_name,pan,aadhaar,section,deduction_date,gross_amount,tds_rate,tds_amount,
          nature,notes,created_by,updated_by,source_module,calculation_mode,source_table,source_id,source_label,source_details,payment_state)
        VALUES(site,member,left(name,200),
          CASE WHEN COALESCE(NEW.tds_pan,upper(trim(person->>'pan_no'))) ~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN COALESCE(NEW.tds_pan,upper(trim(person->>'pan_no'))) END,
          CASE WHEN regexp_replace(COALESCE(person->>'aadhar_no',''),'[^0-9]','','g') ~ '^[0-9]{12}$' THEN regexp_replace(person->>'aadhar_no','[^0-9]','','g') END,
          NEW.tds_section,COALESCE(draft->>'date',draft->>'payment_date')::date,payout+NEW.tds_amount,NEW.tds_rate,NEW.tds_amount,
          left(label,200),left(COALESCE(draft->>'remarks',draft->>'remark',draft->>'note',''),2000),(draft->>'created_by')::integer,(draft->>'created_by')::integer,
          NEW.tds_module,NEW.tds_mode,TG_TABLE_NAME,NEW.id,label,
          jsonb_build_object('payment_mode',mode,'transaction_id',COALESCE(draft->>'transaction_id',draft->>'bank_reference',draft->>'reference_no'),
            'cheque_no',draft->>'cheque_no','cheque_status',cheque,'farmer_id',draft->'farmer_id','commitment_id',draft->'commitment_id','order_id',draft->'order_id','cash_flow_month_id',draft->'cash_flow_month_id','firm_id',draft->'firm_id'),state)
        ON CONFLICT(source_table,source_id) DO UPDATE SET site_id=EXCLUDED.site_id,member_id=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.member_id ELSE tds_deductions.member_id END,deductee_name=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.deductee_name ELSE tds_deductions.deductee_name END,
          pan=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.pan ELSE tds_deductions.pan END,aadhaar=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.aadhaar ELSE tds_deductions.aadhaar END,section=EXCLUDED.section,deduction_date=EXCLUDED.deduction_date,gross_amount=EXCLUDED.gross_amount,
          tds_rate=EXCLUDED.tds_rate,tds_amount=EXCLUDED.tds_amount,nature=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.nature ELSE tds_deductions.nature END,notes=EXCLUDED.notes,source_module=EXCLUDED.source_module,
          calculation_mode=EXCLUDED.calculation_mode,source_label=CASE WHEN tds_deductions.deposit_date IS NULL THEN EXCLUDED.source_label ELSE tds_deductions.source_label END,source_details=EXCLUDED.source_details,payment_state=EXCLUDED.payment_state,updated_at=NOW();
        RETURN NULL;
      END $$;`);
    const tables = new Map(Object.entries(TDS_SOURCES).filter(([key]) => key !== 'imprest_expense').map(([key, source]) => [source.table, [source.workflowModule || key, source.amount || 'amount']]));
    for (const [table, [module, amount]] of tables) {
      await client.query(`ALTER TABLE ${table}
        ADD COLUMN IF NOT EXISTS tds_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS tds_mode TEXT,
        ADD COLUMN IF NOT EXISTS tds_section VARCHAR(10),
        ADD COLUMN IF NOT EXISTS tds_module TEXT,
        ADD COLUMN IF NOT EXISTS tds_deductee_name VARCHAR(200),
        ADD COLUMN IF NOT EXISTS tds_pan VARCHAR(10),
        ADD COLUMN IF NOT EXISTS tds_revision UUID;
        DROP TRIGGER IF EXISTS native_payment_tds_guard ON ${table};
        CREATE TRIGGER native_payment_tds_guard BEFORE INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION guard_native_payment_tds('${module}','${amount}');
        DROP TRIGGER IF EXISTS native_payment_tds_sync ON ${table};
        CREATE TRIGGER native_payment_tds_sync AFTER INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION sync_native_payment_tds('${module}','${amount}');`);
    }
    const inventoryFunction = (await client.query("SELECT pg_get_functiondef(oid) AS definition FROM pg_proc WHERE proname='sync_vendor_inventory_order' AND pronamespace='public'::regnamespace")).rows[0];
    if (inventoryFunction) await client.query(inventoryFunction.definition.replace(/SUM\(amount\)/gi, 'SUM(amount + tds_amount)'));
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Payment module TDS workflow ready')).catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
