import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import {cashflowMoneyTransfersSql} from './237_cashflow_money_transfers.js';

export const VERSION='240_quick_personal_ledger_transfers';
// Existing installations skip already-applied migration 237 at startup, so
// install its source-allocation guard with the new quick-transfer protection.
const legacyGuardStart=cashflowMoneyTransfersSql.indexOf('CREATE OR REPLACE FUNCTION guard_cashflow_legacy_transfer()');
const legacyGuardEnd=cashflowMoneyTransfersSql.indexOf('$$;',legacyGuardStart)+3;
if(legacyGuardStart<0||legacyGuardEnd<=legacyGuardStart)throw Error('Cashflow source-allocation guard missing');
const legacyGuardSql=cashflowMoneyTransfersSql.slice(legacyGuardStart,legacyGuardEnd);
export const quickPersonalLedgerTransfersSql=`
${legacyGuardSql}
CREATE TABLE IF NOT EXISTS cashflow_quick_transfers (
 id uuid PRIMARY KEY, reference text NOT NULL UNIQUE, organization_id integer NOT NULL,
 source_site_id integer NOT NULL REFERENCES sites(id), source_ledger_id integer NOT NULL REFERENCES cash_flow_months(id),
 destination_site_id integer NOT NULL REFERENCES sites(id), destination_ledger_id integer NOT NULL REFERENCES cash_flow_months(id),
 amount numeric(15,2) NOT NULL CHECK(amount>0 AND amount::text NOT IN ('NaN','Infinity','-Infinity')),
 transfer_type text NOT NULL CHECK(transfer_type IN ('same_site','cross_site')),
 funding_type text NOT NULL CHECK(funding_type IN ('wallet','imprest')),
 initiated_by integer NOT NULL REFERENCES users(id), idempotency_key uuid NOT NULL, request_hash text NOT NULL,
 approval_limit numeric(15,2) NOT NULL CHECK(approval_limit>=0), authorized_by integer REFERENCES users(id), authorized_at timestamptz,
 entry_date date NOT NULL, remarks text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'completed' CHECK(status='completed'),
 funding_balance_before numeric(15,2) NOT NULL, funding_balance_after numeric(15,2) NOT NULL,
 source_balance_before numeric(15,2) NOT NULL, source_balance_after numeric(15,2) NOT NULL,
 destination_balance_before numeric(15,2) NOT NULL, destination_balance_after numeric(15,2) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id,initiated_by,idempotency_key),
 CHECK(source_ledger_id<>destination_ledger_id),
 CHECK((authorized_by IS NULL)=(authorized_at IS NULL)),
 CHECK(amount<=approval_limit OR authorized_by IS NOT NULL),
 CHECK((transfer_type='same_site')=(source_site_id=destination_site_id)),
 CHECK(funding_balance_after=funding_balance_before-amount AND funding_balance_after>=0),
 CHECK(source_balance_after=source_balance_before-amount),
 CHECK(destination_balance_after=destination_balance_before+amount)
);
CREATE INDEX IF NOT EXISTS cashflow_quick_transfer_source ON cashflow_quick_transfers(source_ledger_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS cashflow_quick_transfer_destination ON cashflow_quick_transfers(destination_ledger_id,created_at DESC,id DESC);
ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS quick_transfer_id uuid REFERENCES cashflow_quick_transfers(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE cash_flow_entries ADD COLUMN IF NOT EXISTS quick_transfer_leg text;
ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cashflow_money_transfer_link;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cashflow_money_transfer_link CHECK(
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND COALESCE(source_module,'')<>'cashflow_transfers') OR
 (money_transfer_id IS NOT NULL AND money_transfer_leg IS NOT NULL AND money_transfer_leg IN ('debit','credit') AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL AND quick_transfer_id IS NULL) OR
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND quick_transfer_id IS NOT NULL AND quick_transfer_leg IS NOT NULL
  AND quick_transfer_leg IN ('debit','credit') AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL)
);
ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cashflow_quick_transfer_link;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cashflow_quick_transfer_link CHECK(
 (quick_transfer_id IS NULL AND quick_transfer_leg IS NULL AND COALESCE(source_module,'')<>'cashflow_quick_transfers') OR
 (quick_transfer_id IS NOT NULL AND quick_transfer_leg IS NOT NULL AND quick_transfer_leg IN ('debit','credit')
  AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL AND money_transfer_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS cashflow_quick_transfer_leg ON cash_flow_entries(quick_transfer_id,quick_transfer_leg) WHERE quick_transfer_id IS NOT NULL;
CREATE OR REPLACE FUNCTION protect_quick_personal_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='cashflow_quick_transfers' THEN
  RAISE EXCEPTION 'Completed personal ledger transfers are immutable' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF;
 IF OLD.quick_transfer_id IS NOT NULL OR (TG_OP='UPDATE' AND NEW.quick_transfer_id IS NOT NULL) THEN
  RAISE EXCEPTION 'Completed personal ledger transfers are immutable' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS cashflow_quick_transfer_immutable ON cashflow_quick_transfers;
CREATE TRIGGER cashflow_quick_transfer_immutable BEFORE UPDATE OR DELETE ON cashflow_quick_transfers FOR EACH ROW EXECUTE FUNCTION protect_quick_personal_transfer();
DROP TRIGGER IF EXISTS cashflow_quick_posting_immutable ON cash_flow_entries;
CREATE TRIGGER cashflow_quick_posting_immutable BEFORE UPDATE OR DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION protect_quick_personal_transfer();
CREATE OR REPLACE FUNCTION protect_quick_transfer_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(OLD.site_id,OLD.month,OLD.year,OLD.opening_balance,OLD.ledger_name,OLD.ledger_type)
  IS DISTINCT FROM ROW(NEW.site_id,NEW.month,NEW.year,NEW.opening_balance,NEW.ledger_name,NEW.ledger_type)
  AND EXISTS(SELECT 1 FROM cashflow_quick_transfers WHERE source_ledger_id=OLD.id OR destination_ledger_id=OLD.id) THEN
  RAISE EXCEPTION 'A transferred ledger cannot be reparented or have its opening balance rewritten' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_quick_ledger_guard ON cash_flow_months;
CREATE TRIGGER cashflow_quick_ledger_guard BEFORE UPDATE ON cash_flow_months FOR EACH ROW EXECUTE FUNCTION protect_quick_transfer_ledger();
CREATE OR REPLACE FUNCTION protect_quick_transfer_imprest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.source_module='quick_personal_transfer' THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Completed transfer funding is immutable' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable'; END IF;
  IF ROW(OLD.user_id,OLD.site_id,OLD.type,OLD.reference_id,OLD.amount,OLD.source_module)
   IS DISTINCT FROM ROW(NEW.user_id,NEW.site_id,NEW.type,NEW.reference_id,NEW.amount,NEW.source_module) THEN
   RAISE EXCEPTION 'Completed transfer funding is immutable' USING ERRCODE='23514',CONSTRAINT='cashflow_transfer_immutable';
  END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS cashflow_quick_imprest_guard ON imprest_ledger;
CREATE TRIGGER cashflow_quick_imprest_guard BEFORE UPDATE OR DELETE ON imprest_ledger FOR EACH ROW EXECUTE FUNCTION protect_quick_transfer_imprest();
CREATE OR REPLACE FUNCTION check_quick_personal_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE transfer_uuid uuid; t cashflow_quick_transfers%ROWTYPE; debit_id integer; posted record;
BEGIN
 IF TG_TABLE_NAME='cashflow_quick_transfers' THEN transfer_uuid:=NEW.id; ELSE transfer_uuid:=NEW.quick_transfer_id; END IF;
 IF transfer_uuid IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT t FROM cashflow_quick_transfers WHERE id=transfer_uuid;
 IF NOT EXISTS(SELECT 1 FROM cash_flow_months m JOIN sites s ON s.id=m.site_id WHERE m.id=t.source_ledger_id AND m.ledger_type='person' AND m.site_id=t.source_site_id AND s.organization_id=t.organization_id)
 OR NOT EXISTS(SELECT 1 FROM cash_flow_months m JOIN sites s ON s.id=m.site_id WHERE m.id=t.destination_ledger_id AND m.site_id=t.destination_site_id AND s.organization_id=t.organization_id)
 THEN RAISE EXCEPTION 'Transfer ledger or organization mismatch' USING ERRCODE='23514'; END IF;
 SELECT count(*) AS n,COALESCE(sum(debit),0) AS debit,COALESCE(sum(credit),0) AS credit INTO posted FROM cash_flow_entries WHERE quick_transfer_id=t.id;
 IF posted.n<>2 OR posted.debit<>t.amount OR posted.credit<>t.amount THEN RAISE EXCEPTION 'Personal transfer requires equal linked debit and credit entries' USING ERRCODE='23514'; END IF;
 IF EXISTS(SELECT 1 FROM cash_flow_entries e WHERE e.quick_transfer_id=t.id AND (
  e.status IS DISTINCT FROM 'approved' OR e.cash_type IS DISTINCT FROM 'cash' OR e.created_by IS DISTINCT FROM t.initiated_by
  OR e.approved_by IS DISTINCT FROM t.initiated_by OR e.approved_at IS NULL OR e.date IS DISTINCT FROM t.entry_date
  OR e.source_module IS DISTINCT FROM 'cashflow_transfers' OR e.source_id IS NOT NULL OR e.cheque_status IS NOT NULL
  OR (e.quick_transfer_leg='debit' AND (e.cash_flow_month_id<>t.source_ledger_id OR e.site_id<>t.source_site_id OR e.credit<>0 OR e.debit<>t.amount))
  OR (e.quick_transfer_leg='credit' AND (e.cash_flow_month_id<>t.destination_ledger_id OR e.site_id<>t.destination_site_id OR e.debit<>0 OR e.credit<>t.amount))))
 THEN RAISE EXCEPTION 'Invalid personal transfer accounting leg' USING ERRCODE='23514'; END IF;
 SELECT id INTO debit_id FROM cash_flow_entries WHERE quick_transfer_id=t.id AND quick_transfer_leg='debit';
 IF t.funding_type='wallet' THEN
  IF NOT EXISTS(SELECT 1 FROM loyalty_vault_entries e WHERE e.organization_id=t.organization_id AND e.holder_key='user:'||t.initiated_by::text
   AND e.site_id=t.source_site_id AND e.amount=-t.amount AND e.source_table='cashflow_quick_transfers'
   AND e.source_id=debit_id AND e.details->>'quick_transfer_id'=t.id::text)
  THEN RAISE EXCEPTION 'Transfer wallet funding missing' USING ERRCODE='23514'; END IF;
 ELSE
  IF NOT EXISTS(SELECT 1 FROM imprest_ledger il WHERE il.user_id=t.initiated_by AND il.site_id=t.source_site_id
   AND il.amount=-t.amount AND il.type='EXPENSE' AND il.source_module='quick_personal_transfer' AND il.reference_id=debit_id)
  THEN RAISE EXCEPTION 'Transfer imprest funding missing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS cashflow_quick_transfer_balanced ON cashflow_quick_transfers;
CREATE CONSTRAINT TRIGGER cashflow_quick_transfer_balanced AFTER INSERT ON cashflow_quick_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_quick_personal_transfer();
DROP TRIGGER IF EXISTS cashflow_quick_posting_balanced ON cash_flow_entries;
CREATE CONSTRAINT TRIGGER cashflow_quick_posting_balanced AFTER INSERT ON cash_flow_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_quick_personal_transfer();
`;

export async function up(database=pool) {
 const db=await database.connect();
 try {
  await db.query('BEGIN');
  await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
  await db.query("SELECT pg_advisory_xact_lock(hashtext('240_quick_personal_ledger_transfers'))");
  await db.query(quickPersonalLedgerTransfersSql);
  await db.query('INSERT INTO app_schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING',[VERSION]);
  await db.query('COMMIT');
 } catch(error) {await db.query('ROLLBACK');throw error;} finally {db.release();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) up().then(()=>console.log('Quick personal ledger transfer schema ready'))
 .catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
