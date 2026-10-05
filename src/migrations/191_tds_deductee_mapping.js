import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { TDS_SOURCES } from '../services/paymentTds.service.js';

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('191_tds_deductee_mapping'))");
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const applied = await client.query("SELECT 1 FROM app_schema_migrations WHERE version='191_tds_deductee_mapping'");
    if (applied.rows.length) { await client.query('COMMIT'); return; }
    await client.query("SET LOCAL lock_timeout = '5s'");
    // Older Commission entries use the same Project Commission setting and
    // native net-payout contract as the newer master/payment workflow.
    await client.query(`ALTER TABLE plot_commissions
      ADD COLUMN IF NOT EXISTS tds_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tds_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tds_mode TEXT,
      ADD COLUMN IF NOT EXISTS tds_section VARCHAR(10),
      ADD COLUMN IF NOT EXISTS tds_module TEXT,
      ADD COLUMN IF NOT EXISTS tds_revision UUID;
      DROP TRIGGER IF EXISTS native_payment_tds_guard ON plot_commissions;
      CREATE TRIGGER native_payment_tds_guard BEFORE INSERT OR UPDATE OR DELETE ON plot_commissions
        FOR EACH ROW EXECUTE FUNCTION guard_native_payment_tds('plot_commission','amount');
      DROP TRIGGER IF EXISTS native_payment_tds_sync ON plot_commissions;
      CREATE TRIGGER native_payment_tds_sync AFTER INSERT OR UPDATE OR DELETE ON plot_commissions
        FOR EACH ROW EXECUTE FUNCTION sync_native_payment_tds('plot_commission','amount');`);
    const tables = [...new Set([...Object.values(TDS_SOURCES).map(source => source.table), 'plot_commission_payments'])];
    for (const table of tables) await client.query(`ALTER TABLE ${table}
      ADD COLUMN IF NOT EXISTS tds_member_id INTEGER,
      ADD COLUMN IF NOT EXISTS tds_deductee_name VARCHAR(200),
      ADD COLUMN IF NOT EXISTS tds_pan VARCHAR(10),
      ADD COLUMN IF NOT EXISTS tds_aadhaar VARCHAR(12)`);
    const sync = (await client.query("SELECT pg_get_functiondef('sync_native_payment_tds()'::regprocedure) AS definition")).rows[0];
    const oldMode = "mode:=COALESCE(draft->>'payment_mode',draft->>'cash_type','CASH')";
    const newMode = "mode:=COALESCE(draft->>'payment_mode',draft->>'cash_type',CASE WHEN TG_TABLE_NAME='plot_commissions' AND upper(COALESCE(draft->>'by_note','')) LIKE '%CHEQUE%' THEN 'CHEQUE' WHEN TG_TABLE_NAME='plot_commissions' AND upper(COALESCE(draft->>'by_note','')) ~ '(BANK|ONLINE|NEFT|RTGS|UPI)' THEN 'BANK' ELSE 'CASH' END)";
    if (sync.definition.includes(oldMode)) await client.query(sync.definition.replace(oldMode, newMode));
    await client.query(`
      CREATE OR REPLACE FUNCTION guard_tds_deductee_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE site integer; deposited boolean;
      BEGIN
        IF TG_OP='UPDATE' THEN
          SELECT deposit_date IS NOT NULL INTO deposited FROM tds_deductions
            WHERE (source_table=TG_TABLE_NAME AND source_id=OLD.id)
              OR (TG_TABLE_NAME='plot_commission_payments' AND commission_payment_id=OLD.id);
          IF deposited AND (NEW.tds_member_id IS DISTINCT FROM OLD.tds_member_id
            OR NEW.tds_deductee_name IS DISTINCT FROM OLD.tds_deductee_name
            OR NEW.tds_pan IS DISTINCT FROM OLD.tds_pan OR NEW.tds_aadhaar IS DISTINCT FROM OLD.tds_aadhaar) THEN
            RAISE EXCEPTION 'TDS has been deposited. The deductee and KYC snapshot are locked.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        IF NEW.tds_member_id IS NOT NULL AND (TG_OP='INSERT' OR NEW.tds_member_id IS DISTINCT FROM OLD.tds_member_id
          OR to_jsonb(NEW)->>'site_id' IS DISTINCT FROM to_jsonb(OLD)->>'site_id') THEN
          site:=(to_jsonb(NEW)->>'site_id')::integer;
          IF site IS NULL AND TG_TABLE_NAME='farmer_payments' THEN SELECT site_id INTO site FROM farmers WHERE id=NEW.farmer_id; END IF;
          IF NOT EXISTS(SELECT 1 FROM members WHERE id=NEW.tds_member_id AND site_id=site) THEN
            RAISE EXCEPTION 'The selected TDS client does not belong to this site.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
          END IF;
        END IF;
        IF NEW.tds_pan IS NOT NULL AND NEW.tds_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' THEN
          RAISE EXCEPTION 'Enter a valid deductee PAN.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        IF NEW.tds_aadhaar IS NOT NULL AND NEW.tds_aadhaar !~ '^[0-9]{12}$' THEN
          RAISE EXCEPTION 'Enter a valid 12-digit deductee Aadhaar.' USING ERRCODE='23514',CONSTRAINT='tds_workflow';
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION sync_tds_deductee_mapping() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.tds_amount<=0 OR (NEW.tds_member_id IS NULL AND NEW.tds_deductee_name IS NULL
          AND NEW.tds_pan IS NULL AND NEW.tds_aadhaar IS NULL) THEN RETURN NULL; END IF;
        -- The existing source trigger creates the financial deduction first.
        -- This trigger only enriches its taxpayer snapshot, never posts money.
        UPDATE tds_deductions SET member_id=NEW.tds_member_id,
          deductee_name=COALESCE(NULLIF(trim(NEW.tds_deductee_name),''),deductee_name),
          pan=NEW.tds_pan,aadhaar=NEW.tds_aadhaar,updated_at=NOW()
        WHERE deposit_date IS NULL AND ((source_table=TG_TABLE_NAME AND source_id=NEW.id)
          OR (TG_TABLE_NAME='plot_commission_payments' AND commission_payment_id=NEW.id));
        RETURN NULL;
      END $$;
    `);
    for (const table of tables) await client.query(`
      DROP TRIGGER IF EXISTS tds_deductee_guard ON ${table};
      CREATE TRIGGER tds_deductee_guard BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION guard_tds_deductee_mapping();
      DROP TRIGGER IF EXISTS tds_deductee_sync ON ${table};
      CREATE TRIGGER tds_deductee_sync AFTER INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION sync_tds_deductee_mapping();
    `);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES('191_tds_deductee_mapping') ON CONFLICT(version) DO NOTHING");
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('TDS client mapping ready')).catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
