import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '237_cashflow_money_transfers';
export const cashflowMoneyTransfersSql = `
CREATE TABLE IF NOT EXISTS cashflow_transfers (
 id UUID PRIMARY KEY, reference TEXT NOT NULL UNIQUE, organization_id INTEGER NOT NULL,
 source_site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
 source_ledger_id INTEGER NOT NULL REFERENCES cash_flow_months(id) ON DELETE RESTRICT,
 destination_site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
 destination_ledger_id INTEGER NOT NULL REFERENCES cash_flow_months(id) ON DELETE RESTRICT,
 amount NUMERIC(15,2) NOT NULL CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 transfer_type TEXT NOT NULL CHECK(transfer_type IN ('same_site','cross_site')),
 currency TEXT NOT NULL DEFAULT 'INR' CHECK(currency='INR'),
 status TEXT NOT NULL DEFAULT 'completed' CHECK(status='completed'),
 source_transaction_ids INTEGER[] NOT NULL CHECK(cardinality(source_transaction_ids) BETWEEN 1 AND 200),
 remarks TEXT NOT NULL DEFAULT '' CHECK(length(remarks)<=1000),
 initiated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 authorized_by INTEGER REFERENCES users(id) ON DELETE RESTRICT, authorized_at TIMESTAMPTZ,
 approval_limit NUMERIC(15,2) NOT NULL CHECK(approval_limit>=0 AND approval_limit::text NOT IN ('NaN','Infinity','-Infinity')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 idempotency_key UUID NOT NULL, request_hash TEXT NOT NULL,
 source_balance_before NUMERIC(15,2) NOT NULL, source_balance_after NUMERIC(15,2) NOT NULL,
 destination_balance_before NUMERIC(15,2) NOT NULL, destination_balance_after NUMERIC(15,2) NOT NULL,
 UNIQUE(organization_id,initiated_by,idempotency_key),
 CHECK(source_ledger_id<>destination_ledger_id),
 CHECK((transfer_type='same_site')=(source_site_id=destination_site_id)),
 CHECK((authorized_by IS NULL)=(authorized_at IS NULL)),
 CHECK(amount<=approval_limit OR authorized_by IS NOT NULL),
 CHECK(source_balance_after=source_balance_before-amount AND source_balance_after>=0),
 CHECK(destination_balance_after=destination_balance_before+amount),
 CHECK(source_balance_before::text NOT IN ('NaN','Infinity','-Infinity') AND source_balance_after::text NOT IN ('NaN','Infinity','-Infinity')
  AND destination_balance_before::text NOT IN ('NaN','Infinity','-Infinity') AND destination_balance_after::text NOT IN ('NaN','Infinity','-Infinity'))
);
CREATE INDEX IF NOT EXISTS cashflow_transfer_org_history ON cashflow_transfers(organization_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cashflow_transfer_source_history ON cashflow_transfers(source_ledger_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cashflow_transfer_destination_history ON cashflow_transfers(destination_ledger_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cashflow_transfer_source_site ON cashflow_transfers(source_site_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cashflow_transfer_destination_site ON cashflow_transfers(destination_site_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS cashflow_transfer_allocations (
 transfer_id UUID NOT NULL REFERENCES cashflow_transfers(id) ON DELETE RESTRICT,
 source_entry_id INTEGER NOT NULL REFERENCES cash_flow_entries(id) ON DELETE RESTRICT,
 amount NUMERIC(15,2) NOT NULL CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 bucket TEXT NOT NULL CHECK(bucket IN ('cash','bank')), PRIMARY KEY(transfer_id,source_entry_id)
);
CREATE INDEX IF NOT EXISTS cashflow_transfer_allocated_entry ON cashflow_transfer_allocations(source_entry_id) INCLUDE(amount);
CREATE TABLE IF NOT EXISTS cashflow_transfer_audit (
 id BIGSERIAL PRIMARY KEY, transfer_id UUID NOT NULL REFERENCES cashflow_transfers(id) ON DELETE RESTRICT,
 actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 event TEXT NOT NULL CHECK(event='completed'), payload JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(transfer_id,event)
);
ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS money_transfer_id UUID REFERENCES cashflow_transfers(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS money_transfer_leg TEXT;
-- Migration 240 extends this constraint for direct wallet/imprest transfers.
-- A repeat installation of 237 must retain that newer, stricter link shape.
DO $migration$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='cash_flow_entries'::regclass AND attname='quick_transfer_id' AND NOT attisdropped) THEN
ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cashflow_money_transfer_link;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cashflow_money_transfer_link CHECK(
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND COALESCE(source_module,'')<>'cashflow_transfers') OR
 (money_transfer_id IS NOT NULL AND money_transfer_leg IS NOT NULL AND money_transfer_leg IN ('debit','credit') AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL)
);
END IF;
END $migration$;
CREATE UNIQUE INDEX IF NOT EXISTS cashflow_money_transfer_one_leg ON cash_flow_entries(money_transfer_id,money_transfer_leg,cash_type) WHERE money_transfer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS cashflow_money_transfer_ledger_entries ON cash_flow_entries(cash_flow_month_id,id);

-- Legacy Shift Entries / plot reclassification owns its source receipts. Do
-- not let the two allocation systems spend the same historical receipt.
DO $migration$ DECLARE branches TEXT:='SELECT NULL::integer AS id WHERE false'; BEGIN
 IF to_regclass('transaction_money_transfers') IS NOT NULL THEN
  branches:=branches || ' UNION ALL SELECT e.id FROM cash_flow_entries e JOIN transaction_money_transfers t ON
   (t.source_type=''personal_ledger'' AND t.source_record_id=e.id) OR
   (e.source_id=t.source_record_id AND e.source_module=CASE t.source_type
    WHEN ''plot_payment'' THEN ''plot_payments'' WHEN ''expense'' THEN ''expenses''
    WHEN ''farmer_payment'' THEN ''farmer_payments'' WHEN ''plot_commission'' THEN ''plot_commission_payments''
    WHEN ''vendor_payment'' THEN ''vendor_payments'' WHEN ''vendor_inventory_payment'' THEN ''vendor_inventory_payments''
    WHEN ''misc_income'' THEN ''misc_income_entries'' WHEN ''land_sale'' THEN ''land_deal_payments''
    WHEN ''daybook'' THEN ''day_book'' END)';
 END IF;
 IF to_regclass('plot_money_transfers') IS NOT NULL THEN
  branches:=branches || ' UNION ALL SELECT e.id FROM cash_flow_entries e JOIN plot_money_transfers t
   ON e.source_module=''plot_payments'' AND e.source_id=t.source_payment_id';
 END IF;
 EXECUTE 'CREATE OR REPLACE VIEW cashflow_transfer_legacy_sources AS ' || branches;
END $migration$;
CREATE OR REPLACE FUNCTION guard_cashflow_legacy_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_table TEXT; legacy_source_id INTEGER; direct BOOLEAN:=false; source_ids INTEGER[];
BEGIN
 IF TG_TABLE_NAME='plot_money_transfers' THEN owner_table:='plot_payments'; legacy_source_id:=NEW.source_payment_id;
 ELSE
  legacy_source_id:=NEW.source_record_id; direct:=NEW.source_type='personal_ledger';
  owner_table:=CASE NEW.source_type WHEN 'plot_payment' THEN 'plot_payments' WHEN 'expense' THEN 'expenses'
   WHEN 'farmer_payment' THEN 'farmer_payments' WHEN 'plot_commission' THEN 'plot_commission_payments'
   WHEN 'vendor_payment' THEN 'vendor_payments' WHEN 'vendor_inventory_payment' THEN 'vendor_inventory_payments'
   WHEN 'misc_income' THEN 'misc_income_entries' WHEN 'land_sale' THEN 'land_deal_payments' WHEN 'daybook' THEN 'day_book' END;
 END IF;
 SELECT array_agg(e.id) INTO source_ids FROM cash_flow_entries e WHERE (direct AND e.id=legacy_source_id) OR (e.source_module=owner_table AND e.source_id=legacy_source_id);
 PERFORM m.id FROM cash_flow_months m WHERE m.id IN(SELECT cash_flow_month_id FROM cash_flow_entries WHERE id=ANY(source_ids)) ORDER BY m.id FOR UPDATE;
 PERFORM id FROM cash_flow_entries WHERE id=ANY(source_ids) ORDER BY id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM cash_flow_entries e WHERE e.id=ANY(source_ids) AND (e.money_transfer_id IS NOT NULL
  OR NULLIF(to_jsonb(e)->>'quick_transfer_id','') IS NOT NULL
  OR EXISTS(SELECT 1 FROM cashflow_transfer_allocations a WHERE a.source_entry_id=e.id))) THEN
  RAISE EXCEPTION 'This receipt is already allocated to a Cashflow money transfer' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF;
 RETURN NEW;
END $$;
DO $migration$ DECLARE relation TEXT; BEGIN
 FOREACH relation IN ARRAY ARRAY['transaction_money_transfers','plot_money_transfers'] LOOP
  IF to_regclass(relation) IS NOT NULL THEN
   EXECUTE format('DROP TRIGGER IF EXISTS cashflow_legacy_source_guard ON %I',relation);
   EXECUTE format('CREATE TRIGGER cashflow_legacy_source_guard BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION guard_cashflow_legacy_transfer()',relation);
  END IF;
 END LOOP;
END $migration$;

CREATE OR REPLACE FUNCTION protect_cashflow_money_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Completed money transfers are immutable; create a separately authorized compensating transaction' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable'; END $$;
DROP TRIGGER IF EXISTS cashflow_transfer_immutable ON cashflow_transfers;
CREATE TRIGGER cashflow_transfer_immutable BEFORE UPDATE OR DELETE ON cashflow_transfers FOR EACH ROW EXECUTE FUNCTION protect_cashflow_money_transfer();
DROP TRIGGER IF EXISTS cashflow_allocation_immutable ON cashflow_transfer_allocations;
CREATE TRIGGER cashflow_allocation_immutable BEFORE UPDATE OR DELETE ON cashflow_transfer_allocations FOR EACH ROW EXECUTE FUNCTION protect_cashflow_money_transfer();
DROP TRIGGER IF EXISTS cashflow_audit_immutable ON cashflow_transfer_audit;
CREATE TRIGGER cashflow_audit_immutable BEFORE UPDATE OR DELETE ON cashflow_transfer_audit FOR EACH ROW EXECUTE FUNCTION protect_cashflow_money_transfer();

-- The same parent lock is acquired by ordinary entry writers, not only the
-- transfer endpoint. Balance rechecks therefore see committed ledger changes.
CREATE OR REPLACE FUNCTION lock_cashflow_money_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ids INTEGER[]; site_ids INTEGER[]; locked_site INTEGER;
BEGIN
 IF TG_OP='INSERT' THEN ids:=ARRAY[NEW.cash_flow_month_id]; site_ids:=ARRAY[NEW.site_id];
 ELSIF TG_OP='DELETE' THEN ids:=ARRAY[OLD.cash_flow_month_id]; site_ids:=ARRAY[OLD.site_id];
 ELSE ids:=ARRAY[OLD.cash_flow_month_id,NEW.cash_flow_month_id]; site_ids:=ARRAY[OLD.site_id,NEW.site_id]; END IF;
 FOR locked_site IN SELECT DISTINCT unnest(site_ids) ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtext('imprest-site-' || locked_site::text));
 END LOOP;
 PERFORM id FROM cash_flow_months WHERE id=ANY(ids) ORDER BY id FOR UPDATE;
 IF TG_OP<>'INSERT' AND (OLD.money_transfer_id IS NOT NULL OR EXISTS(
   SELECT 1 FROM cashflow_transfer_allocations WHERE source_entry_id=OLD.id)) THEN
   RAISE EXCEPTION 'This entry is part of an immutable money transfer' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_money_balance_lock ON cash_flow_entries;
CREATE TRIGGER cashflow_money_balance_lock BEFORE INSERT OR UPDATE OR DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION lock_cashflow_money_balance();

CREATE OR REPLACE FUNCTION lock_cashflow_ledger_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('imprest-site-' || NEW.site_id::text));
 PERFORM pg_advisory_xact_lock(hashtext('cashflow-ledger-lineage'),hashtext(NEW.site_id::text || ':' || COALESCE(NEW.ledger_name,'')));
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_ledger_lineage_lock ON cash_flow_months;
CREATE TRIGGER cashflow_ledger_lineage_lock BEFORE INSERT ON cash_flow_months FOR EACH ROW EXECUTE FUNCTION lock_cashflow_ledger_lineage();

CREATE OR REPLACE FUNCTION protect_cashflow_transferred_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.site_id,OLD.month,OLD.year,OLD.opening_balance,OLD.ledger_name,OLD.ledger_type)
    IS DISTINCT FROM ROW(NEW.site_id,NEW.month,NEW.year,NEW.opening_balance,NEW.ledger_name,NEW.ledger_type)
    AND EXISTS(SELECT 1 FROM cashflow_transfers WHERE source_ledger_id=OLD.id OR destination_ledger_id=OLD.id) THEN
   RAISE EXCEPTION 'A transferred ledger cannot be reparented or have its opening balance rewritten' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_transferred_ledger_guard ON cash_flow_months;
CREATE TRIGGER cashflow_transferred_ledger_guard BEFORE UPDATE ON cash_flow_months FOR EACH ROW EXECUTE FUNCTION protect_cashflow_transferred_ledger();

-- Deferred validation permits the header, allocations and both accounting
-- sides to be inserted in any order inside ONE transaction, never separately.
CREATE OR REPLACE FUNCTION check_cashflow_money_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_uuid UUID; t cashflow_transfers%ROWTYPE; allocation_total NUMERIC; posted RECORD;
BEGIN
 IF TG_TABLE_NAME='cashflow_transfers' THEN transfer_uuid:=NEW.id;
 ELSIF TG_TABLE_NAME='cash_flow_entries' THEN transfer_uuid:=NEW.money_transfer_id;
 ELSE transfer_uuid:=NEW.transfer_id; END IF;
 IF transfer_uuid IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM cashflow_transfers WHERE id=transfer_uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'Transfer header missing' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM cash_flow_months m JOIN sites s ON s.id=m.site_id WHERE m.id=t.source_ledger_id AND m.site_id=t.source_site_id AND s.organization_id=t.organization_id)
 OR NOT EXISTS(SELECT 1 FROM cash_flow_months m JOIN sites s ON s.id=m.site_id WHERE m.id=t.destination_ledger_id AND m.site_id=t.destination_site_id AND s.organization_id=t.organization_id)
 THEN RAISE EXCEPTION 'Transfer ledger or organization mismatch' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(sum(amount),0) INTO allocation_total FROM cashflow_transfer_allocations WHERE transfer_id=t.id;
 IF allocation_total<>t.amount THEN RAISE EXCEPTION 'Transfer allocation total does not match' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM cashflow_transfer_allocations a JOIN cash_flow_entries e ON e.id=a.source_entry_id
   WHERE a.transfer_id=t.id AND (e.cash_flow_month_id<>t.source_ledger_id OR e.site_id<>t.source_site_id
    OR NOT(e.id=ANY(t.source_transaction_ids)) OR e.credit<=0 OR e.debit<>0
    OR e.status<>'approved' OR NOT financial_transaction_posts('credit',e.status,e.cash_type,e.cheque_status)
    OR EXISTS(SELECT 1 FROM cashflow_transfer_legacy_sources legacy WHERE legacy.id=e.id)
    OR e.date>(t.created_at AT TIME ZONE 'Asia/Kolkata')::date
    OR NULLIF(to_jsonb(e)->>'entry_transfer_id','') IS NOT NULL
    OR NULLIF(to_jsonb(e)->>'reversed_at','') IS NOT NULL OR COALESCE(to_jsonb(e)->>'is_reversed','false')='true'
    OR NOT EXISTS(SELECT 1 FROM ledger_entries l WHERE l.id=e.id::text AND l.cash_flow_month_id=e.cash_flow_month_id AND l.credit>0)
    OR a.bucket<>CASE WHEN e.cash_type='cash' THEN 'cash' ELSE 'bank' END
    OR (SELECT sum(other.amount) FROM cashflow_transfer_allocations other WHERE other.source_entry_id=e.id)>e.credit))
 THEN RAISE EXCEPTION 'Transfer exceeds eligible source receipt' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM cash_flow_entries e WHERE e.money_transfer_id=t.id AND (
   e.status IS DISTINCT FROM 'approved' OR e.cash_type NOT IN ('cash','bank') OR e.created_by IS DISTINCT FROM t.initiated_by
   OR e.source_module IS DISTINCT FROM 'cashflow_transfers' OR e.source_id IS NOT NULL
   OR e.money_transfer_leg IS NULL OR e.cheque_status IS NOT NULL
   OR e.date IS DISTINCT FROM (t.created_at AT TIME ZONE 'Asia/Kolkata')::date
   OR e.approved_by IS DISTINCT FROM t.initiated_by OR e.approved_at IS NULL
   OR (e.money_transfer_leg='debit' AND (e.cash_flow_month_id<>t.source_ledger_id OR e.site_id<>t.source_site_id OR e.credit<>0 OR e.debit<=0))
   OR (e.money_transfer_leg='credit' AND (e.cash_flow_month_id<>t.destination_ledger_id OR e.site_id<>t.destination_site_id OR e.debit<>0 OR e.credit<=0))))
 THEN RAISE EXCEPTION 'Invalid transfer accounting leg' USING ERRCODE='23514'; END IF;
 FOR posted IN SELECT buckets.bucket,COALESCE(a.amount,0) AS amount,COALESCE(e.debit,0) AS debit,COALESCE(e.credit,0) AS credit,COALESCE(e.n,0) AS n
  FROM (VALUES('cash'),('bank')) buckets(bucket)
  LEFT JOIN (SELECT bucket,sum(amount) amount FROM cashflow_transfer_allocations WHERE transfer_id=t.id GROUP BY bucket) a USING(bucket)
  LEFT JOIN (SELECT cash_type AS bucket,sum(debit) debit,sum(credit) credit,count(*) n FROM cash_flow_entries WHERE money_transfer_id=t.id GROUP BY cash_type) e USING(bucket)
 LOOP
  IF posted.debit<>posted.amount OR posted.credit<>posted.amount OR posted.n<>(CASE WHEN posted.amount>0 THEN 2 ELSE 0 END)
  THEN RAISE EXCEPTION 'Transfer must contain equal linked debit and credit entries for every payment mode' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF NOT EXISTS(SELECT 1 FROM cashflow_transfer_audit WHERE transfer_id=t.id AND actor_id=t.initiated_by AND event='completed')
 THEN RAISE EXCEPTION 'Transfer audit missing' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_transfer_balanced ON cashflow_transfers;
CREATE CONSTRAINT TRIGGER cashflow_transfer_balanced AFTER INSERT ON cashflow_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cashflow_money_transfer();
DROP TRIGGER IF EXISTS cashflow_allocation_balanced ON cashflow_transfer_allocations;
CREATE CONSTRAINT TRIGGER cashflow_allocation_balanced AFTER INSERT ON cashflow_transfer_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cashflow_money_transfer();
DROP TRIGGER IF EXISTS cashflow_posting_balanced ON cash_flow_entries;
CREATE CONSTRAINT TRIGGER cashflow_posting_balanced AFTER INSERT OR UPDATE ON cash_flow_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_cashflow_money_transfer();
`;

export async function up(database=pool) {
 const db=await database.connect();
 try {
  await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('237_cashflow_money_transfers'))");
  await db.query(cashflowMoneyTransfersSql);
  await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
  await db.query('COMMIT');
 } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}

// Financial history is never removed by rollback. Roll back an unused install
// only; an installation with completed transfers must retain its safeguards.
export async function down(database=pool) {
 const db=await database.connect();
 try {
  await db.query("BEGIN; SET LOCAL lock_timeout='5s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('237_cashflow_money_transfers'))");
  await db.query('LOCK TABLE cashflow_transfers IN ACCESS EXCLUSIVE MODE');
  if((await db.query('SELECT 1 FROM cashflow_transfers LIMIT 1')).rows.length) throw Error('Rollback refused: completed transfers must retain their immutable accounting history.');
  await db.query(`DO $$ DECLARE relation TEXT; BEGIN
    FOREACH relation IN ARRAY ARRAY['transaction_money_transfers','plot_money_transfers'] LOOP
      IF to_regclass(relation) IS NOT NULL THEN EXECUTE format('DROP TRIGGER IF EXISTS cashflow_legacy_source_guard ON %I',relation); END IF;
    END LOOP; END $$;
    DROP VIEW cashflow_transfer_legacy_sources; DROP FUNCTION guard_cashflow_legacy_transfer();`);
  await db.query(`DROP TRIGGER IF EXISTS cashflow_posting_balanced ON cash_flow_entries;
   DROP TRIGGER IF EXISTS cashflow_money_balance_lock ON cash_flow_entries;
   DROP TRIGGER IF EXISTS cashflow_ledger_lineage_lock ON cash_flow_months;
   DROP TRIGGER IF EXISTS cashflow_transferred_ledger_guard ON cash_flow_months;
   ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cashflow_money_transfer_link;
   ALTER TABLE cash_flow_entries DROP COLUMN IF EXISTS money_transfer_id, DROP COLUMN IF EXISTS money_transfer_leg;
   DROP INDEX IF EXISTS cashflow_money_transfer_ledger_entries;
   DROP TABLE cashflow_transfer_audit,cashflow_transfer_allocations,cashflow_transfers;
   DROP FUNCTION check_cashflow_money_transfer(),lock_cashflow_money_balance(),lock_cashflow_ledger_lineage(),protect_cashflow_money_transfer(),protect_cashflow_transferred_ledger();`);
  await db.query('DELETE FROM app_schema_migrations WHERE version=$1',[VERSION]);
  await db.query('COMMIT');
 } catch(error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
 (process.argv.includes('--down')?down():up()).then(()=>console.log('Cashflow transfer schema ready'))
  .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
}
