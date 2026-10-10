import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// A challan is evidence of settlement, not a second operating expense. Old
// reference-only deposits are deliberately not backfilled into cash movements.
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('198_tds_financial_settlements'))");
    await db.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const applied=await db.query("SELECT 1 FROM app_schema_migrations WHERE version='198_tds_financial_settlements'");
    if(applied.rows.length) { await db.query('COMMIT'); return; }
    await db.query("SET LOCAL lock_timeout = '10s'");
    await db.query(`
      CREATE TABLE IF NOT EXISTS tds_settlements (
        id SERIAL PRIMARY KEY,
        site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
        kind TEXT NOT NULL CHECK (kind IN ('government_direct','government_via_ca','ca_transfer','existing')),
        date DATE NOT NULL CHECK (date >= DATE '1900-01-01' AND date <= (NOW() AT TIME ZONE 'Asia/Kolkata')::date),
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
        payment_mode TEXT CHECK (payment_mode IN ('CASH','BANK','UPI','NEFT','RTGS','IMPS','TRANSFER')),
        bank_account_id INTEGER REFERENCES bank_accounts(id) ON DELETE RESTRICT,
        cash_wallet_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
        transaction_id TEXT NOT NULL DEFAULT '',
        challan_no VARCHAR(40),
        ca_name VARCHAR(200),
        notes TEXT NOT NULL DEFAULT '',
        existing_entry_id INTEGER UNIQUE REFERENCES cash_flow_entries(id) ON DELETE RESTRICT,
        request_id UUID NOT NULL,
        request_fingerprint TEXT NOT NULL,
        created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(site_id,created_by,request_id),
        UNIQUE(id,site_id),
        CHECK ((kind='existing') = (existing_entry_id IS NOT NULL)),
        CHECK (kind='government_via_ca' OR payment_mode IS NOT NULL),
        CHECK (kind<>'government_via_ca' OR (payment_mode IS NULL AND bank_account_id IS NULL AND cash_wallet_id IS NULL)),
        CHECK (kind NOT IN ('government_direct','ca_transfer') OR
          ((payment_mode='CASH' AND bank_account_id IS NULL AND cash_wallet_id IS NULL) OR
           (payment_mode<>'CASH' AND bank_account_id IS NOT NULL AND cash_wallet_id IS NULL))),
        CHECK (kind='ca_transfer' OR length(trim(COALESCE(challan_no,'')))>0),
        CHECK (kind<>'ca_transfer' OR length(trim(COALESCE(ca_name,'')))>0)
      );
      CREATE INDEX IF NOT EXISTS tds_settlements_site_date ON tds_settlements(site_id,date,id);
      ALTER TABLE tds_deductions
        ADD COLUMN IF NOT EXISTS ca_sent_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS ca_name VARCHAR(200),
        ADD COLUMN IF NOT EXISTS ca_transfer_id INTEGER,
        ADD COLUMN IF NOT EXISTS settlement_id INTEGER;
      DO $$ BEGIN
        IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='tds_ca_transfer_site_fk') THEN
          ALTER TABLE tds_deductions ADD CONSTRAINT tds_ca_transfer_site_fk
            FOREIGN KEY(ca_transfer_id,site_id) REFERENCES tds_settlements(id,site_id) ON DELETE RESTRICT;
          ALTER TABLE tds_deductions ADD CONSTRAINT tds_settlement_site_fk
            FOREIGN KEY(settlement_id,site_id) REFERENCES tds_settlements(id,site_id) ON DELETE RESTRICT;
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS tds_deductions_ca_transfer ON tds_deductions(ca_transfer_id) WHERE ca_transfer_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS tds_deductions_settlement ON tds_deductions(settlement_id) WHERE settlement_id IS NOT NULL;

      CREATE OR REPLACE FUNCTION sync_tds_settlement_cashflow() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE month_id INTEGER;
      BEGIN
        IF NEW.kind NOT IN ('government_direct','ca_transfer') THEN RETURN NEW; END IF;
        month_id := ensure_site_cashflow_month(NEW.site_id,NEW.date,NEW.created_by);
        INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,particular,debit,credit,cash_type,
          bank_account_id,remarks,created_by,source_module,source_id,status,approved_by,approved_at)
        VALUES(month_id,NEW.site_id,NEW.date,
          CASE WHEN NEW.kind='ca_transfer' THEN 'TDS FUNDS TO CA - '||NEW.ca_name ELSE 'TDS GOVERNMENT DEPOSIT - '||NEW.challan_no END,
          NEW.amount,0,lower(NEW.payment_mode),NEW.bank_account_id,
          CONCAT_WS(' · ',NULLIF(NEW.transaction_id,''),NULLIF(NEW.notes,'')),NEW.created_by,
          'tds_settlements',NEW.id,'approved',NEW.created_by,NEW.created_at);
        RETURN NEW;
      END $$;
      DROP TRIGGER IF EXISTS tds_settlement_cashflow ON tds_settlements;
      CREATE TRIGGER tds_settlement_cashflow AFTER INSERT ON tds_settlements
        FOR EACH ROW EXECUTE FUNCTION sync_tds_settlement_cashflow();

      CREATE OR REPLACE FUNCTION guard_tds_settlement_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'TDS settlement history is locked; do not edit or delete a paid settlement'
          USING ERRCODE='23514',CONSTRAINT='tds_settlement_history';
      END $$;
      DROP TRIGGER IF EXISTS tds_settlement_history ON tds_settlements;
      CREATE TRIGGER tds_settlement_history BEFORE UPDATE OR DELETE ON tds_settlements
        FOR EACH ROW EXECUTE FUNCTION guard_tds_settlement_history();

      CREATE OR REPLACE FUNCTION guard_tds_ledger_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.source_module='tds_settlements' OR EXISTS(SELECT 1 FROM tds_settlements WHERE existing_entry_id=OLD.id) THEN
          IF TG_OP='DELETE' OR to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD) THEN
            RAISE EXCEPTION 'This ledger entry is linked to a TDS settlement and is locked'
              USING ERRCODE='23514',CONSTRAINT='tds_settlement_history';
          END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$;
      DROP TRIGGER IF EXISTS tds_ledger_history ON cash_flow_entries;
      CREATE TRIGGER tds_ledger_history BEFORE UPDATE OR DELETE ON cash_flow_entries
        FOR EACH ROW EXECUTE FUNCTION guard_tds_ledger_history();

      CREATE OR REPLACE FUNCTION guard_funded_tds_deduction() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.ca_transfer_id IS NOT NULL OR OLD.settlement_id IS NOT NULL THEN
          IF TG_OP='DELETE' OR (to_jsonb(NEW)-ARRAY['updated_at','updated_by','notes','source_label','source_details','nature','ca_sent_at','ca_name','settlement_id','deposit_date','challan_no'])
            IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','updated_by','notes','source_label','source_details','nature','ca_sent_at','ca_name','settlement_id','deposit_date','challan_no'])
            OR NEW.ca_transfer_id IS DISTINCT FROM OLD.ca_transfer_id
            OR (OLD.settlement_id IS NOT NULL AND (NEW.settlement_id IS DISTINCT FROM OLD.settlement_id
              OR NEW.deposit_date IS DISTINCT FROM OLD.deposit_date OR NEW.challan_no IS DISTINCT FROM OLD.challan_no)) THEN
            RAISE EXCEPTION 'TDS with transferred or deposited funds is locked'
              USING ERRCODE='23514',CONSTRAINT='tds_settlement_history';
          END IF;
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$;
      DROP TRIGGER IF EXISTS funded_tds_deduction_history ON tds_deductions;
      CREATE TRIGGER funded_tds_deduction_history BEFORE UPDATE OR DELETE ON tds_deductions
        FOR EACH ROW EXECUTE FUNCTION guard_funded_tds_deduction();

      CREATE OR REPLACE FUNCTION guard_funded_tds_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE funded BOOLEAN;
      BEGIN
        SELECT EXISTS(SELECT 1 FROM tds_deductions t WHERE
          ((t.source_table=TG_TABLE_NAME AND t.source_id=OLD.id) OR
           (TG_TABLE_NAME='plot_commission_payments' AND t.commission_payment_id=OLD.id))
          AND (t.ca_transfer_id IS NOT NULL OR t.settlement_id IS NOT NULL))
          OR EXISTS(SELECT 1 FROM tds_settlements settlement
            JOIN cash_flow_entries linked ON linked.id=settlement.existing_entry_id
            WHERE linked.source_module=TG_TABLE_NAME AND linked.source_id=OLD.id) INTO funded;
        IF funded AND (TG_OP='DELETE' OR
          (to_jsonb(NEW)-ARRAY['updated_at','tds_revision','remark','note','remarks','notes','voucher_url','customer_signature_url','authority_signature_url'])
          IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_at','tds_revision','remark','note','remarks','notes','voucher_url','customer_signature_url','authority_signature_url'])) THEN
          RAISE EXCEPTION 'The source payment has funded TDS and cannot be changed or reversed'
            USING ERRCODE='23514',CONSTRAINT='tds_settlement_history';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$;
      DO $$ DECLARE tab TEXT; BEGIN
        FOREACH tab IN ARRAY ARRAY['plot_commission_payments','day_book','expenses','farmer_payments','cash_flow_entries',
          'firm_transactions','vendor_payments','vendor_inventory_payments','misc_income_entries','partner_profit_payments','plot_commissions'] LOOP
          IF to_regclass(tab) IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS funded_tds_source_history ON %I',tab);
            EXECUTE format('CREATE TRIGGER funded_tds_source_history BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_funded_tds_source()',tab);
          END IF;
        END LOOP;
      END $$;

      CREATE OR REPLACE FUNCTION check_tds_settlement_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE s tds_settlements%ROWTYPE; allocated NUMERIC; sid INTEGER;
      BEGIN
        IF TG_TABLE_NAME='tds_settlements' THEN
          IF NEW.kind<>'ca_transfer' THEN sid:=NEW.id; ELSE sid:=NULL; END IF;
        ELSE sid:=NEW.settlement_id; END IF;
        IF sid IS NOT NULL THEN
          SELECT * INTO s FROM tds_settlements WHERE id=sid;
          SELECT COALESCE(sum(tds_amount),0) INTO allocated FROM tds_deductions WHERE settlement_id=sid;
          IF s.kind='ca_transfer' OR allocated<>s.amount OR EXISTS(SELECT 1 FROM tds_accounting_deductions t WHERE t.settlement_id=sid AND
            (t.accounting_state IS DISTINCT FROM 'active' OR t.deposit_date IS DISTINCT FROM s.date OR t.challan_no IS DISTINCT FROM s.challan_no OR t.deduction_date>s.date
             OR (s.kind='government_via_ca' AND (t.ca_transfer_id IS NULL OR NOT EXISTS(
               SELECT 1 FROM tds_settlements ca WHERE ca.id=t.ca_transfer_id AND ca.kind='ca_transfer'
                 AND ca.date<=s.date AND ca.ca_name IS NOT DISTINCT FROM s.ca_name)))
             OR (s.kind<>'government_via_ca' AND t.ca_transfer_id IS NOT NULL))) THEN
            RAISE EXCEPTION 'TDS deposit allocations do not match the settlement' USING ERRCODE='23514',CONSTRAINT='tds_settlement_allocation';
          END IF;
        END IF;
        IF TG_TABLE_NAME='tds_settlements' THEN
          IF NEW.kind='ca_transfer' THEN sid:=NEW.id; ELSE sid:=NULL; END IF;
        ELSIF TG_TABLE_NAME='tds_deductions' THEN sid:=NEW.ca_transfer_id; ELSE sid:=NULL; END IF;
        IF sid IS NOT NULL THEN
          SELECT * INTO s FROM tds_settlements WHERE id=sid;
          SELECT COALESCE(sum(tds_amount),0) INTO allocated FROM tds_deductions WHERE ca_transfer_id=sid;
          IF s.kind<>'ca_transfer' OR allocated<>s.amount OR EXISTS(SELECT 1 FROM tds_accounting_deductions WHERE ca_transfer_id=sid
            AND (deduction_date>s.date OR accounting_state IS DISTINCT FROM 'active')) THEN
            RAISE EXCEPTION 'TDS CA allocations do not match the transfer' USING ERRCODE='23514',CONSTRAINT='tds_settlement_allocation';
          END IF;
        END IF;
        RETURN NULL;
      END $$;
      DROP TRIGGER IF EXISTS tds_settlement_allocation ON tds_settlements;
      CREATE CONSTRAINT TRIGGER tds_settlement_allocation AFTER INSERT ON tds_settlements
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_tds_settlement_allocation();
      DROP TRIGGER IF EXISTS tds_deduction_allocation ON tds_deductions;
      CREATE CONSTRAINT TRIGGER tds_deduction_allocation AFTER INSERT OR UPDATE ON tds_deductions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_tds_settlement_allocation();
    `);
    // New commission table reference; keep legacy sections and records intact.
    await db.query(`DO $$ DECLARE tab TEXT; fn RECORD; BEGIN
      FOREACH tab IN ARRAY ARRAY['tds_deductions','plot_commission_payments','day_book','expenses','farmer_payments','cash_flow_entries',
        'firm_transactions','vendor_payments','vendor_inventory_payments','misc_income_entries','partner_profit_payments','plot_commissions'] LOOP
        IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=tab AND column_name='tds_section') THEN
          EXECUTE format('ALTER TABLE %I ALTER COLUMN tds_section TYPE VARCHAR(20)',tab);
        END IF;
      END LOOP;
      ALTER TABLE tds_deductions ALTER COLUMN section TYPE VARCHAR(20);
      FOR fn IN SELECT pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname=current_schema() AND p.proname IN ('guard_commission_tds','guard_native_payment_tds') LOOP
        EXECUTE replace(fn.definition,'''194H''','''194H'',''393_1_1ii''');
      END LOOP;
    END $$;`);
    await db.query(`      CREATE OR REPLACE VIEW tds_accounting_deductions AS
        SELECT t.*, CASE
          WHEN t.source_id IS NOT NULL THEN t.payment_state
          WHEN t.commission_payment_id IS NULL THEN 'active'
          WHEN lower(COALESCE(p.status,'approved'))='rejected' OR COALESCE(p.cheque_status,'') IN ('BOUNCED','RETURNED') THEN 'reversed'
          WHEN financial_transaction_posts(CASE WHEN p.amount<0 THEN 'credit' ELSE 'debit' END,p.status,p.payment_mode,p.cheque_status) THEN 'active'
          ELSE 'pending' END AS accounting_state
        FROM tds_deductions t LEFT JOIN plot_commission_payments p ON p.id=t.commission_payment_id;

`);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('198_tds_financial_settlements') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('TDS financial settlements ready')).catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
