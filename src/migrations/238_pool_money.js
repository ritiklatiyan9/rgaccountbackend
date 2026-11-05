import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { cashWalletReceiptDetailsSql } from './209_cash_wallet_receipt_details.js';

// Source receipts remain the authority. This projection gives unallotted money
// a real accounting entry and retains that entry's identity on allotment.
export const poolMoneySql = `
CREATE TABLE IF NOT EXISTS pool_money_receipts (
 id SERIAL PRIMARY KEY, source_kind TEXT NOT NULL CHECK(source_kind IN ('booking','draw')),
 source_id INTEGER NOT NULL, owner_id INTEGER NOT NULL, site_id INTEGER NOT NULL REFERENCES sites(id),
 reference TEXT NOT NULL, buyer_name TEXT, amount NUMERIC(15,2) NOT NULL CHECK(amount>0),
 date DATE NOT NULL, payment_from TEXT NOT NULL, payment_type TEXT NOT NULL,
 bank_name TEXT, branch TEXT, bank_details TEXT, bank_account_id INTEGER,
 cheque_no TEXT, cheque_status TEXT, received_by TEXT, narration TEXT,
 status TEXT NOT NULL DEFAULT 'pending', approved_by INTEGER REFERENCES users(id), approved_at TIMESTAMPTZ, assigned_admin_id INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 loyalty_vault_holder_type TEXT, loyalty_vault_holder_id INTEGER, loyalty_vault_assigned_by INTEGER,
 plot_payment_id INTEGER UNIQUE REFERENCES plot_payments(id) ON DELETE RESTRICT,
 UNIQUE(source_kind,source_id)
);
CREATE INDEX IF NOT EXISTS pool_money_site_owner ON pool_money_receipts(site_id,source_kind,owner_id);
CREATE TABLE IF NOT EXISTS pool_money_results (
 source_kind TEXT NOT NULL CHECK(source_kind IN ('booking','draw')), owner_id INTEGER NOT NULL,
 site_id INTEGER NOT NULL REFERENCES sites(id), result TEXT NOT NULL CHECK(result IN ('WINNER','NOT_SELECTED')),
 note TEXT NOT NULL, recorded_by INTEGER NOT NULL REFERENCES users(id), recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(source_kind,owner_id)
);
CREATE TABLE IF NOT EXISTS pool_money_events (
 id BIGSERIAL PRIMARY KEY, source_kind TEXT NOT NULL, owner_id INTEGER NOT NULL,
 site_id INTEGER NOT NULL REFERENCES sites(id), event_type TEXT NOT NULL, detail JSONB NOT NULL DEFAULT '{}',
 actor_user_id INTEGER REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_money_events_owner ON pool_money_events(source_kind,owner_id,id);
CREATE OR REPLACE FUNCTION project_pool_money_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cash_id INTEGER; linked cash_flow_entries%ROWTYPE; previous cash_flow_entries%ROWTYPE; month_id INTEGER;
BEGIN
 SELECT * INTO previous FROM cash_flow_entries WHERE source_module='pool_money_receipts' AND source_id=NEW.id FOR UPDATE;
 IF previous.id IS NOT NULL AND (SELECT is_locked FROM cash_flow_months WHERE id=previous.cash_flow_month_id FOR SHARE) THEN
   RAISE EXCEPTION 'The receipt belongs to a locked accounting period' USING ERRCODE='23514',CONSTRAINT='pool_money_period_locked';
 END IF;
 IF NEW.plot_payment_id IS NOT NULL THEN
   IF previous.id IS NOT NULL THEN
     SELECT * INTO linked FROM cash_flow_entries WHERE source_module='plot_payments' AND source_id=NEW.plot_payment_id FOR UPDATE;
     IF linked.id IS NULL THEN RAISE EXCEPTION 'The plot payment accounting entry is missing; allocation was rolled back'; END IF;
     IF linked.site_id<>NEW.site_id OR linked.credit<>NEW.amount OR linked.debit<>0 THEN
       RAISE EXCEPTION 'Pool receipt and plot payment do not match; allocation was rolled back';
     END IF;
     -- Keep the original entry, cash holder and posting. The new mirror has not
     -- escaped this transaction. Deferred wallet reconciliation sees one credit.
     DELETE FROM cash_flow_entries WHERE id=linked.id;
     UPDATE cash_flow_entries SET source_module='plot_payments',source_id=NEW.plot_payment_id,
       particular=linked.particular,remarks=linked.remarks,updated_at=now() WHERE id=previous.id;
   END IF;
   RETURN NEW;
 END IF;
 month_id:=ensure_site_cashflow_month(NEW.site_id,NEW.date,NEW.created_by);
 IF (SELECT is_locked FROM cash_flow_months WHERE id=month_id FOR SHARE) THEN
   RAISE EXCEPTION 'The receipt belongs to a locked accounting period' USING ERRCODE='23514',CONSTRAINT='pool_money_period_locked';
 END IF;
 INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,particular,debit,credit,cash_type,
   remarks,status,source_module,source_id,created_by,created_at,cheque_no,cheque_status,bank_account_id,approved_by,approved_at,assigned_admin_id)
 VALUES(month_id,NEW.site_id,NEW.date,left('POOL MONEY · '||NEW.reference||' · '||COALESCE(NEW.buyer_name,''),500),0,NEW.amount,
   CASE WHEN NEW.payment_type='CASH' THEN 'cash' WHEN NEW.payment_type='CHEQUE' THEN 'cheque' ELSE 'bank' END,
   NEW.narration,NEW.status,'pool_money_receipts',NEW.id,NEW.created_by,NEW.created_at,NEW.cheque_no,NEW.cheque_status,NEW.bank_account_id,NEW.approved_by,NEW.approved_at,NEW.assigned_admin_id)
 ON CONFLICT(source_module,source_id) DO UPDATE SET date=EXCLUDED.date,cash_flow_month_id=EXCLUDED.cash_flow_month_id,
   particular=EXCLUDED.particular,credit=EXCLUDED.credit,cash_type=EXCLUDED.cash_type,remarks=EXCLUDED.remarks,
   bank_account_id=cash_flow_entries.bank_account_id,status=EXCLUDED.status,cheque_status=EXCLUDED.cheque_status,cheque_no=EXCLUDED.cheque_no,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at,assigned_admin_id=EXCLUDED.assigned_admin_id,updated_at=now();
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS pool_money_project ON pool_money_receipts;
CREATE TRIGGER pool_money_project AFTER INSERT OR UPDATE ON pool_money_receipts FOR EACH ROW EXECUTE FUNCTION project_pool_money_receipt();
CREATE OR REPLACE FUNCTION guard_pool_plot_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pool_money_receipts WHERE plot_payment_id=OLD.id) THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'An allocated pool receipt cannot be deleted' USING ERRCODE='23514',CONSTRAINT='pool_money_receipt_locked'; END IF;
   IF (NEW.plot_id,NEW.site_id,NEW.amount,NEW.date,NEW.payment_from,NEW.payment_type,NEW.created_by,NEW.bank_name,NEW.bank_details,NEW.cheque_no)
     IS DISTINCT FROM (OLD.plot_id,OLD.site_id,OLD.amount,OLD.date,OLD.payment_from,OLD.payment_type,OLD.created_by,OLD.bank_name,OLD.bank_details,OLD.cheque_no) THEN
     RAISE EXCEPTION 'Original pool receipt details cannot change after allotment' USING ERRCODE='23514',CONSTRAINT='pool_money_receipt_locked';
   END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS pool_money_receipt_guard ON plot_payments;
CREATE TRIGGER pool_money_receipt_guard BEFORE UPDATE OR DELETE ON plot_payments FOR EACH ROW EXECUTE FUNCTION guard_pool_plot_receipt();
CREATE OR REPLACE FUNCTION guard_pool_cashflow_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.source_module='pool_money_receipts' THEN
   IF TG_OP='DELETE' THEN RAISE EXCEPTION 'A pool collection cannot be deleted; review its source receipt' USING ERRCODE='23514',CONSTRAINT='pool_money_receipt_locked'; END IF;
   IF (NEW.site_id,NEW.date,NEW.credit,NEW.debit,NEW.cash_type,NEW.created_by) IS DISTINCT FROM
      (OLD.site_id,OLD.date,OLD.credit,OLD.debit,OLD.cash_type,OLD.created_by) THEN
     RAISE EXCEPTION 'Pool collection amounts and original payment details cannot be edited through a ledger mirror' USING ERRCODE='23514',CONSTRAINT='pool_money_receipt_locked';
   END IF;
   IF (NEW.source_module,NEW.source_id) IS DISTINCT FROM (OLD.source_module,OLD.source_id) AND NOT EXISTS(
     SELECT 1 FROM pool_money_receipts r WHERE r.id=OLD.source_id AND r.plot_payment_id=NEW.source_id AND NEW.source_module='plot_payments') THEN
     RAISE EXCEPTION 'Pool receipt source can only change during allotment' USING ERRCODE='23514',CONSTRAINT='pool_money_receipt_locked';
   END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS pool_money_cashflow_guard ON cash_flow_entries;
CREATE TRIGGER pool_money_cashflow_guard BEFORE UPDATE OR DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION guard_pool_cashflow_receipt();
CREATE OR REPLACE FUNCTION capture_pool_money_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payload JSONB; kind TEXT; owner INTEGER; site INTEGER; amount NUMERIC; ref TEXT; buyer TEXT;
 payment INTEGER; pay_date DATE; mode TEXT; bank INTEGER; existing pool_money_receipts%ROWTYPE; parent JSONB;
BEGIN
 kind:=CASE WHEN TG_TABLE_NAME='bookings' THEN 'booking' ELSE 'draw' END;
 payload:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
 SELECT * INTO existing FROM pool_money_receipts WHERE source_kind=kind AND source_id=(payload->>'id')::integer FOR UPDATE;
 IF TG_OP='DELETE' THEN
   IF existing.id IS NOT NULL THEN RAISE EXCEPTION 'This receipt is held in Pool Money. Recorded collections cannot be deleted.' USING ERRCODE='23514'; END IF;
   RETURN OLD;
 END IF;
 IF kind='booking' THEN
   parent:=payload; owner:=(payload->>'id')::integer; site:=(payload->>'site_id')::integer;
   amount:=COALESCE((payload->>'token_amount')::numeric,0); ref:=COALESCE(payload->>'booking_no','Booking #'||owner);
   payment:=NULLIF(payload->>'token_payment_id','')::integer;
   IF existing.id IS NULL AND ((payload->>'plot_id') IS NOT NULL OR payment IS NOT NULL) THEN RETURN NEW; END IF;
   pay_date:=COALESCE(NULLIF(payload->>'token_payment_date','')::date,(payload->>'booking_date')::date);
   mode:=upper(COALESCE(NULLIF(payload->>'token_payment_from',''),'CASH'));
 ELSE
   owner:=(payload->>'draw_registration_id')::integer;
   SELECT to_jsonb(r) INTO parent FROM draw_registrations r WHERE id=owner FOR UPDATE;
   IF TG_OP='INSERT' AND parent->>'status' IN ('ALLOTTED','CANCELLED') THEN RAISE EXCEPTION 'This draw ledger is closed; record further money against the allotted unit'; END IF;
   site:=(parent->>'site_id')::integer; amount:=(payload->>'amount')::numeric;
   ref:=COALESCE(payload->>'receipt_no',parent->>'registration_no','Draw #'||owner);
   payment:=NULLIF(payload->>'plot_payment_id','')::integer;
   IF existing.id IS NULL AND payment IS NOT NULL THEN RETURN NEW; END IF;
   pay_date:=(payload->>'payment_date')::date;
   mode:=upper(COALESCE(NULLIF(payload->>'payment_from',''),'CASH'));
 END IF;
 IF mode NOT IN ('CASH','BANK','TRANSFER','CHEQUE','UPI','NEFT','RTGS','IMPS') THEN
   RAISE EXCEPTION 'Select a supported cash, bank or cheque payment mode before recording in Accounts';
 END IF;
 IF existing.id IS NOT NULL AND (existing.amount<>amount OR existing.site_id<>site OR existing.owner_id<>owner OR existing.date<>pay_date OR existing.payment_from<>mode OR existing.bank_name IS DISTINCT FROM COALESCE(payload->>'token_bank_name',payload->>'bank_name') OR existing.bank_details IS DISTINCT FROM COALESCE(payload->>'token_bank_details',payload->>'bank_details') OR existing.cheque_no IS DISTINCT FROM COALESCE(payload->>'token_cheque_no',payload->>'cheque_no') OR existing.created_by IS DISTINCT FROM NULLIF(payload->>'created_by','')::integer) THEN
   RAISE EXCEPTION 'Pool money has already been recorded. Correct the receipt in Accounting before changing its collection details' USING ERRCODE='23514';
 END IF;
 IF existing.id IS NOT NULL AND payment IS NOT NULL THEN
   IF existing.plot_payment_id IS NOT NULL AND existing.plot_payment_id<>payment THEN RAISE EXCEPTION 'Pool receipt was already allocated to another payment'; END IF;
   UPDATE pool_money_receipts SET plot_payment_id=payment,updated_at=now() WHERE id=existing.id;
   RETURN NEW;
 END IF;
 IF existing.plot_payment_id IS NOT NULL THEN RETURN NEW; END IF;
 IF amount<=0 THEN
   IF existing.id IS NOT NULL THEN RAISE EXCEPTION 'A collected pool receipt cannot be removed; record its refund through Accounting'; END IF;
   RETURN NEW;
 END IF;
 SELECT full_name INTO buyer FROM members WHERE id=(parent->>'client_member_id')::integer;
 bank:=NULLIF(payload->>'bank_account_id','')::integer;
 IF bank IS NOT NULL AND NOT EXISTS(SELECT 1 FROM bank_accounts WHERE id=bank AND site_id=site) THEN
   RAISE EXCEPTION 'The receipt bank account belongs to a different site';
 END IF;
 INSERT INTO pool_money_receipts(source_kind,source_id,owner_id,site_id,reference,buyer_name,amount,date,payment_from,payment_type,
 bank_name,branch,bank_details,bank_account_id,cheque_no,cheque_status,received_by,narration,created_by,created_at)
 VALUES(kind,(payload->>'id')::integer,owner,site,ref,COALESCE(buyer,parent->>'buyer_name'),amount,pay_date,mode,
 CASE WHEN mode='CHEQUE' THEN 'CHEQUE' WHEN mode IN ('BANK','TRANSFER','UPI','NEFT','RTGS','IMPS') THEN 'BANK' ELSE 'CASH' END,
 COALESCE(payload->>'token_bank_name',payload->>'bank_name'),COALESCE(payload->>'token_branch',payload->>'branch'),
 COALESCE(payload->>'token_bank_details',payload->>'bank_details'),bank,COALESCE(payload->>'token_cheque_no',payload->>'cheque_no'),
 CASE WHEN mode='CHEQUE' THEN 'PENDING' END,COALESCE(payload->>'token_received_by',payload->>'received_by'),
 COALESCE(payload->>'token_narration',payload->>'narration'),NULLIF(payload->>'created_by','')::integer,
 COALESCE(NULLIF(payload->>'created_at','')::timestamptz,now()))
 ON CONFLICT(source_kind,source_id) DO UPDATE SET reference=EXCLUDED.reference,buyer_name=EXCLUDED.buyer_name
 WHERE (pool_money_receipts.reference,pool_money_receipts.buyer_name) IS DISTINCT FROM (EXCLUDED.reference,EXCLUDED.buyer_name);
 RETURN NEW;
END $$;
`;

export async function up(database=pool) {
 const db=await database.connect();
 try {
  await db.query('BEGIN');
  await db.query("SELECT pg_advisory_xact_lock(hashtext('238_pool_money'))");
  await db.query("SET LOCAL lock_timeout='5s'");
  await db.query(poolMoneySql);
  // Extend the established collector/cutover rules instead of assigning imported
  // historic cash to the administrator who installs this module.
  for(const [name,fn] of [['cash_wallet_collector_lock','cash_wallet_lock_source_collector'],['cash_wallet_holder_site','cash_wallet_guard_holder_site'],['loyalty_vault_validate','loyalty_vault_validate_assignment']]) {
   if((await db.query('SELECT to_regprocedure($1) AS name',[`${fn}()`])).rows[0]?.name) await db.query(`DROP TRIGGER IF EXISTS ${name} ON pool_money_receipts; CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON pool_money_receipts FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
  }
  await db.query(cashWalletReceiptDetailsSql.replace("ARRAY['day_book'", "ARRAY['pool_money_receipts','day_book'"));
  for (const table of ['bookings','draw_payments']) {
   if (!(await db.query('SELECT to_regclass($1) AS name',[table])).rows[0]?.name) continue;
   await db.query(`DROP TRIGGER IF EXISTS pool_money_capture ON ${table}; CREATE TRIGGER pool_money_capture AFTER INSERT OR UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source()`);
  }
  await db.query("INSERT INTO app_schema_migrations(version) VALUES('238_pool_money') ON CONFLICT DO NOTHING");
  await db.query('COMMIT');
 } catch(error) { await db.query('ROLLBACK'); throw error; }
 finally { db.release(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) up().then(()=>console.log('Pool Money accounting ready')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
