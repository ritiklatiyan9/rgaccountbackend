import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
export const VERSION = '241_plot_commission_allocations';
export const allocationSchemaSql = `
ALTER TABLE plot_commissions_v2 ADD COLUMN IF NOT EXISTS allocation_type TEXT,
  ADD COLUMN IF NOT EXISTS allocation_value NUMERIC(18,6), ADD COLUMN IF NOT EXISTS allocation_base NUMERIC(15,2);
ALTER TABLE plot_commissions_v2 DROP CONSTRAINT IF EXISTS commission_allocation_metadata;
ALTER TABLE plot_commissions_v2 ADD CONSTRAINT commission_allocation_metadata CHECK (
  (allocation_type IS NULL AND allocation_value IS NULL AND allocation_base IS NULL) OR
  (allocation_type IS NOT NULL AND allocation_value IS NOT NULL AND allocation_base IS NOT NULL
   AND allocation_type IN ('percentage','amount') AND allocation_value > 0 AND allocation_base > 0 AND total_commission > 0
   AND (allocation_type <> 'percentage' OR allocation_value <= 100)));
CREATE INDEX IF NOT EXISTS idx_pcv2_broker_property ON plot_commissions_v2(agent_id,site_id,plot_id);
CREATE INDEX IF NOT EXISTS idx_pcp_broker_transactions ON plot_commission_payments(plot_commission_id,site_id,date DESC,id DESC)
  INCLUDE(amount,tds_amount,status,payment_mode,cheque_status);
CREATE INDEX IF NOT EXISTS idx_members_directory_site_id ON members(site_id,id);

CREATE OR REPLACE FUNCTION guard_managed_commission_payment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE master plot_commissions_v2%ROWTYPE; candidate plot_commission_payments%ROWTYPE; committed NUMERIC; contribution NUMERIC:=0;
BEGIN
  candidate:=CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
  SELECT * INTO master FROM plot_commissions_v2 WHERE id=candidate.plot_commission_id FOR UPDATE;
  IF TG_OP='UPDATE' AND OLD.plot_commission_id IS DISTINCT FROM NEW.plot_commission_id
    AND (master.allocation_type IS NOT NULL OR EXISTS(SELECT 1 FROM plot_commissions_v2 WHERE id=OLD.plot_commission_id AND allocation_type IS NOT NULL)) THEN
    RAISE EXCEPTION 'A split commission payment cannot move to another dealer record' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  IF master.allocation_type IS NULL THEN RETURN candidate; END IF;
  IF candidate.site_id IS DISTINCT FROM master.site_id THEN
    RAISE EXCEPTION 'Commission payment must belong to the dealer commission site' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  SELECT COALESCE(SUM(CASE WHEN p.amount>=0 OR financial_transaction_posts('credit',p.status,p.payment_mode,p.cheque_status) THEN p.amount+COALESCE(p.tds_amount,0) ELSE 0 END),0) INTO committed FROM plot_commission_payments p
    WHERE p.plot_commission_id=master.id AND p.id IS DISTINCT FROM candidate.id
      AND LOWER(COALESCE(NULLIF(TRIM(p.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
      AND UPPER(TRIM(COALESCE(p.cheque_status,''))) NOT IN ('BOUNCED','RETURNED');
  IF TG_OP<>'DELETE' AND LOWER(COALESCE(NULLIF(TRIM(candidate.status),''),'approved')) NOT IN ('rejected','cancelled','canceled','deleted','void','voided')
    AND UPPER(TRIM(COALESCE(candidate.cheque_status,''))) NOT IN ('BOUNCED','RETURNED')
    AND (candidate.amount>=0 OR financial_transaction_posts('credit',candidate.status,candidate.payment_mode,candidate.cheque_status)) THEN
    contribution:=candidate.amount+COALESCE(candidate.tds_amount,0);
  END IF;
  IF committed+contribution>master.total_commission THEN
    RAISE EXCEPTION 'This payout or refund change exceeds the dealer commission, including paid and pending payments' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  RETURN candidate;
END $$;
DROP TRIGGER IF EXISTS commission_allocation_payment_guard ON plot_commission_payments;
CREATE TRIGGER commission_allocation_payment_guard BEFORE INSERT OR UPDATE OR DELETE ON plot_commission_payments
  FOR EACH ROW EXECUTE FUNCTION guard_managed_commission_payment();

CREATE OR REPLACE FUNCTION guard_managed_commission_master() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE committed NUMERIC;
BEGIN
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
DROP TRIGGER IF EXISTS commission_allocation_master_guard ON plot_commissions_v2;
CREATE TRIGGER commission_allocation_master_guard BEFORE UPDATE OR DELETE ON plot_commissions_v2
  FOR EACH ROW EXECUTE FUNCTION guard_managed_commission_master();

CREATE OR REPLACE FUNCTION mark_managed_commission_pool() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target INT;
BEGIN
  IF TG_TABLE_NAME='plots' THEN
    IF NEW.plot_commission IS NOT DISTINCT FROM OLD.plot_commission THEN RETURN NULL; END IF;
    target:=NEW.id;
  ELSIF TG_OP='DELETE' THEN target:=OLD.plot_id;
  ELSE target:=NEW.plot_id; END IF;
  IF target IS NULL THEN RETURN NULL; END IF;
  IF to_regclass('pg_temp.commission_allocation_dirty') IS NULL THEN
    CREATE TEMP TABLE commission_allocation_dirty(plot_id INT PRIMARY KEY) ON COMMIT DELETE ROWS;
  END IF;
  INSERT INTO pg_temp.commission_allocation_dirty VALUES(target) ON CONFLICT DO NOTHING;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS commission_allocation_mark_dirty ON plot_commissions_v2;
CREATE TRIGGER commission_allocation_mark_dirty AFTER INSERT OR UPDATE OR DELETE ON plot_commissions_v2
  FOR EACH ROW EXECUTE FUNCTION mark_managed_commission_pool();
DROP TRIGGER IF EXISTS commission_allocation_property_dirty ON plots;
CREATE TRIGGER commission_allocation_property_dirty AFTER UPDATE ON plots
  FOR EACH ROW EXECUTE FUNCTION mark_managed_commission_pool();

CREATE OR REPLACE FUNCTION check_managed_commission_pool() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target INT; decided NUMERIC; allocated NUMERIC; dirty INT;
BEGIN
  IF TG_TABLE_NAME='plots' THEN target:=NEW.id;
  ELSIF TG_OP='DELETE' THEN target:=OLD.plot_id;
  ELSE target:=NEW.plot_id; END IF;
  IF target IS NULL OR to_regclass('pg_temp.commission_allocation_dirty') IS NULL THEN RETURN NULL; END IF;
  DELETE FROM pg_temp.commission_allocation_dirty WHERE plot_id=target RETURNING plot_id INTO dirty;
  IF dirty IS NULL OR NOT EXISTS(SELECT 1 FROM plot_commissions_v2 WHERE plot_id=target AND allocation_type IS NOT NULL) THEN RETURN NULL; END IF;
  SELECT COALESCE(plot_commission,0) INTO decided FROM plots WHERE id=target FOR UPDATE;
  IF EXISTS(SELECT 1 FROM plot_commissions_v2 WHERE plot_id=target AND allocation_type IS NOT NULL AND allocation_base IS DISTINCT FROM decided) THEN
    RAISE EXCEPTION 'Update the commission pool through the dealer breakdown so all shares stay consistent' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  SELECT COALESCE(SUM(total_commission),0) INTO allocated FROM plot_commissions_v2 WHERE plot_id=target;
  IF allocated>decided THEN
    RAISE EXCEPTION 'Dealer commissions exceed the property commission pool' USING ERRCODE='23514',CONSTRAINT='commission_allocation_guard';
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS commission_allocation_pool_guard ON plot_commissions_v2;
CREATE CONSTRAINT TRIGGER commission_allocation_pool_guard AFTER INSERT OR UPDATE OR DELETE ON plot_commissions_v2
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_managed_commission_pool();
DROP TRIGGER IF EXISTS commission_allocation_property_guard ON plots;
CREATE CONSTRAINT TRIGGER commission_allocation_property_guard AFTER UPDATE ON plots
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_managed_commission_pool();
`;
// Guard-only replay is used by revision 242 for installations that already applied the initial split schema.
export const allocationIntegritySql = allocationSchemaSql.slice(allocationSchemaSql.indexOf('CREATE OR REPLACE FUNCTION guard_managed_commission_payment'));
export const allocationMetadataConstraintSql = allocationSchemaSql.slice(allocationSchemaSql.indexOf('ALTER TABLE plot_commissions_v2 DROP CONSTRAINT'), allocationSchemaSql.indexOf('CREATE INDEX'));
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtext('241_plot_commission_allocations'))");
    await db.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY,applied_at TIMESTAMPTZ DEFAULT NOW())');
    if ((await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length) { await db.query('COMMIT'); return false; }
    await db.query(allocationSchemaSql);
    // Substring matching uses optional trigram indexes; browsing is always an
    // indexed keyset scan, and extension-limited databases remain usable.
    await db.query('SAVEPOINT commission_directory_trgm');
    try {
      await db.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await db.query('CREATE INDEX IF NOT EXISTS idx_members_directory_name_trgm ON members USING gin (lower(full_name) gin_trgm_ops)');
      await db.query("CREATE INDEX IF NOT EXISTS idx_members_directory_phone_trgm ON members USING gin ((regexp_replace(COALESCE(phone,''),'[^0-9]','','g')) gin_trgm_ops)");
      await db.query('RELEASE SAVEPOINT commission_directory_trgm');
    } catch { await db.query('ROLLBACK TO SAVEPOINT commission_directory_trgm'); await db.query('RELEASE SAVEPOINT commission_directory_trgm'); }
    await db.query('INSERT INTO app_schema_migrations(version) VALUES($1)',[VERSION]);
    await db.query('COMMIT');
    return true;
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Dealer commission split schema ready; existing amounts preserved' : 'Dealer commission split schema already installed'))
    .catch(error => { console.error(error.message); process.exitCode=1; }).finally(() => pool.end());
}
