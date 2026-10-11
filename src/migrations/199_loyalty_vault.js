import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';

// An attribution ledger over existing financial postings. No receipt, expense,
// cash-wallet record or dashboard total is created by this migration.
export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('199_loyalty_vault'))");
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query(`
      CREATE TABLE IF NOT EXISTS loyalty_vault_settings(singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton), tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT now());
      INSERT INTO loyalty_vault_settings(singleton) VALUES(true) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS loyalty_vault_accounts(
        holder_key TEXT PRIMARY KEY, organization_id INTEGER NOT NULL,
        holder_type TEXT NOT NULL CHECK(holder_type IN ('user','member')), holder_id INTEGER NOT NULL CHECK(holder_id>0),
        balance NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(balance <> 'NaN'::numeric),
        reserved_balance NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(reserved_balance>=0 AND reserved_balance <> 'NaN'::numeric),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(holder_type,holder_id), CHECK(holder_key=holder_type||':'||holder_id::text)
      );
      CREATE TABLE IF NOT EXISTS loyalty_vault_transfers(
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(), organization_id INTEGER NOT NULL, site_id INTEGER REFERENCES sites(id),
        from_holder_type TEXT NOT NULL CHECK(from_holder_type IN ('user','member')), from_holder_id INTEGER NOT NULL,
        to_holder_type TEXT NOT NULL DEFAULT 'user' CHECK(to_holder_type='user'), to_holder_id INTEGER NOT NULL REFERENCES users(id),
        sender_id INTEGER NOT NULL REFERENCES users(id), recipient_id INTEGER NOT NULL REFERENCES users(id),
        amount NUMERIC(15,2) NOT NULL CHECK(amount>0 AND amount <> 'NaN'::numeric),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected','cancelled')),
        note TEXT NOT NULL DEFAULT '', idempotency_key UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ, resolved_by INTEGER REFERENCES users(id), resolution_note TEXT,
        UNIQUE(sender_id,idempotency_key), CHECK(recipient_id=to_holder_id), CHECK(from_holder_type<>'user' OR from_holder_id<>to_holder_id)
      );
      CREATE TABLE IF NOT EXISTS loyalty_vault_entries(
        id BIGSERIAL PRIMARY KEY, organization_id INTEGER NOT NULL, holder_key TEXT NOT NULL REFERENCES loyalty_vault_accounts(holder_key),
        holder_type TEXT NOT NULL CHECK(holder_type IN ('user','member')), holder_id INTEGER NOT NULL,
        amount NUMERIC(15,2) NOT NULL CHECK(amount<>0 AND amount <> 'NaN'::numeric), balance_after NUMERIC(15,2) NOT NULL CHECK(balance_after <> 'NaN'::numeric),
        kind TEXT NOT NULL CHECK(kind IN ('credit','debit','adjustment','reversal','transfer_in','transfer_out')),
        description TEXT, source_table TEXT, source_id INTEGER, cash_flow_entry_id INTEGER, site_id INTEGER REFERENCES sites(id),
        transfer_id UUID REFERENCES loyalty_vault_transfers(id), actor_id INTEGER REFERENCES users(id), details JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS loyalty_vault_sources(
        cash_flow_entry_id INTEGER PRIMARY KEY, holder_key TEXT, posted_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK(posted_amount <> 'NaN'::numeric),
        organization_id INTEGER, source_table TEXT NOT NULL, source_id INTEGER NOT NULL, site_id INTEGER,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS loyalty_vault_cash_source ON cash_flow_entries(source_module,source_id);
      CREATE INDEX IF NOT EXISTS loyalty_vault_account_org ON loyalty_vault_accounts(organization_id,holder_type,holder_id);
      CREATE INDEX IF NOT EXISTS loyalty_vault_history ON loyalty_vault_entries(organization_id,id DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_holder_history ON loyalty_vault_entries(holder_key,id DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_site_history ON loyalty_vault_entries(site_id,id DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_source_history ON loyalty_vault_entries(source_table,source_id,id DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_transfer_sender ON loyalty_vault_transfers(sender_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_transfer_recipient ON loyalty_vault_transfers(recipient_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS loyalty_vault_transfer_org ON loyalty_vault_transfers(organization_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS loyalty_vault_transfer_once ON loyalty_vault_entries(transfer_id,kind) WHERE transfer_id IS NOT NULL;
      CREATE OR REPLACE FUNCTION loyalty_vault_guard_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'Loyalty Vault history is immutable; use a compensating entry' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_immutable_history';
      END $$;
      DROP TRIGGER IF EXISTS loyalty_vault_immutable_history ON loyalty_vault_entries;
      CREATE TRIGGER loyalty_vault_immutable_history BEFORE UPDATE OR DELETE ON loyalty_vault_entries FOR EACH ROW EXECUTE FUNCTION loyalty_vault_guard_history();

      CREATE OR REPLACE FUNCTION loyalty_vault_guard_holder_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_table TEXT; v_bound BOOLEAN; v_type TEXT:=CASE WHEN TG_TABLE_NAME='members' THEN 'member' ELSE 'user' END;
      BEGIN
        IF EXISTS(SELECT 1 FROM loyalty_vault_accounts WHERE holder_key=(CASE WHEN TG_TABLE_NAME='members' THEN 'member:' ELSE 'user:' END)||OLD.id::text
          AND (balance<>0 OR reserved_balance>0)) THEN
          RAISE EXCEPTION 'Transfer or clear this holder’s Loyalty Vault balance and pending handovers before deleting the holder'
            USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds';
        END IF;
        FOR v_table IN SELECT unnest(ARRAY['cash_flow_entries','day_book','expenses','farmer_payments','firm_transactions','plot_payments','plot_installment_payments','plot_commission_payments','vendor_payments','vendor_inventory_payments','land_deal_payments','misc_income_entries','partner_profit_payments']) LOOP
          IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=v_table AND column_name='loyalty_vault_holder_id') THEN
            EXECUTE format($binding$SELECT EXISTS(SELECT 1 FROM %I t WHERE loyalty_vault_holder_type=$1 AND loyalty_vault_holder_id=$2
              AND COALESCE(to_jsonb(t)->>'entry_transfer_id','')='' AND COALESCE(to_jsonb(t)->>'money_transfer_id','')=''
              AND NOT COALESCE((to_jsonb(t)->>'is_imprest_internal')::boolean,false)
              AND NOT COALESCE((to_jsonb(t)->>'is_firm_to_firm_transfer')::boolean,false)
              AND COALESCE(to_jsonb(t)->>'transfer_group_id','')=''
              AND ($3<>'cash_flow_entries' OR COALESCE(to_jsonb(t)->>'source_module','')='')
              AND ($3<>'vendor_inventory_payments' OR COALESCE(to_jsonb(t)->>'source_vendor_payment_id','')='')
              AND ($3<>'day_book' OR (UPPER(COALESCE(to_jsonb(t)->>'entry_type',''))<>'IMPREST'
                AND NOT COALESCE((to_jsonb(t)->>'is_financial_projection')::boolean,false)
                AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id','firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field WHERE NULLIF(to_jsonb(t)->>field,'') IS NOT NULL))))$binding$,v_table) INTO v_bound USING v_type,OLD.id,v_table;
            IF v_bound THEN RAISE EXCEPTION 'Clear this holder’s Loyalty Vault assignments on existing transactions before deleting the holder'
              USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds'; END IF;
          END IF;
        END LOOP;
        RETURN OLD;
      END $$;
      DROP TRIGGER IF EXISTS loyalty_vault_holder_funds ON members;
      CREATE TRIGGER loyalty_vault_holder_funds BEFORE DELETE ON members FOR EACH ROW EXECUTE FUNCTION loyalty_vault_guard_holder_delete();
      DROP TRIGGER IF EXISTS loyalty_vault_holder_funds ON users;
      CREATE TRIGGER loyalty_vault_holder_funds BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION loyalty_vault_guard_holder_delete();

      CREATE OR REPLACE FUNCTION loyalty_vault_source_site(p_table TEXT,p_row JSONB) RETURNS INTEGER LANGUAGE plpgsql STABLE AS $$
      DECLARE v_site INTEGER; BEGIN
        v_site:=NULLIF(p_row->>'site_id','')::integer;
        IF v_site IS NULL AND p_table='farmer_payments' THEN SELECT site_id INTO v_site FROM farmers WHERE id=(p_row->>'farmer_id')::integer; END IF;
        IF v_site IS NULL AND p_table='plot_installment_payments' THEN
          SELECT p.site_id INTO v_site FROM plot_installments i JOIN plots p ON p.id=i.plot_id WHERE i.id=(p_row->>'installment_id')::integer;
        END IF;
        IF v_site IS NULL AND p_table='cash_flow_entries' THEN SELECT site_id INTO v_site FROM cash_flow_months WHERE id=(p_row->>'cash_flow_month_id')::integer; END IF;
        IF v_site IS NULL AND p_table='firm_transactions' THEN SELECT site_id INTO v_site FROM firms WHERE id=(p_row->>'firm_id')::integer; END IF;
        RETURN v_site;
      END $$;
      CREATE OR REPLACE FUNCTION loyalty_vault_validate_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_row JSONB:=to_jsonb(NEW); v_site INTEGER; v_org INTEGER; v_actor users%ROWTYPE; v_holder_type TEXT; v_holder_id INTEGER;
      BEGIN
        v_holder_type:=v_row->>'loyalty_vault_holder_type'; v_holder_id:=NULLIF(v_row->>'loyalty_vault_holder_id','')::integer;
        IF TG_OP='UPDATE' AND NEW.loyalty_vault_holder_type IS NOT DISTINCT FROM OLD.loyalty_vault_holder_type
          AND NEW.loyalty_vault_holder_id IS NOT DISTINCT FROM OLD.loyalty_vault_holder_id
          AND NEW.loyalty_vault_assigned_by IS NOT DISTINCT FROM OLD.loyalty_vault_assigned_by
          AND loyalty_vault_source_site(TG_TABLE_NAME,to_jsonb(NEW)) IS NOT DISTINCT FROM loyalty_vault_source_site(TG_TABLE_NAME,to_jsonb(OLD))
          AND (NEW.loyalty_vault_holder_type IS DISTINCT FROM 'member' OR EXISTS(SELECT 1 FROM members WHERE id=NEW.loyalty_vault_holder_id)) THEN RETURN NEW; END IF;
        IF v_holder_type IS NULL AND v_holder_id IS NULL AND NEW.loyalty_vault_assigned_by IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO v_actor FROM users WHERE id=NEW.loyalty_vault_assigned_by AND is_active=true AND role IN ('admin','super_admin','sub_admin');
        IF v_actor.id IS NULL THEN RAISE EXCEPTION 'An active account must assign Loyalty Vault custody' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_assignment_access'; END IF;
        v_site:=loyalty_vault_source_site(TG_TABLE_NAME,v_row);
        SELECT organization_id INTO v_org FROM sites WHERE id=v_site;
        IF v_org IS NULL OR v_org<>v_actor.organization_id OR (v_actor.role='sub_admin' AND NOT EXISTS(SELECT 1 FROM user_sites WHERE user_id=v_actor.id AND site_id=v_site)) THEN
          RAISE EXCEPTION 'Choose a transaction in your accessible organization and site' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_assignment_access';
        END IF;
        IF v_holder_type IS NULL AND v_holder_id IS NULL THEN RETURN NEW; END IF;
        IF v_holder_type='user' THEN
          IF NOT EXISTS(SELECT 1 FROM users WHERE id=v_holder_id AND organization_id=v_org AND is_active=true AND role IN ('admin','super_admin','sub_admin')) THEN
            RAISE EXCEPTION 'Choose an active Loyalty Vault user in this organization' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope'; END IF;
        ELSIF v_holder_type='member' THEN
          IF NOT EXISTS(SELECT 1 FROM members WHERE id=v_holder_id AND site_id=v_site) THEN
            RAISE EXCEPTION 'Choose a known client from this transaction site' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope'; END IF;
        ELSE RAISE EXCEPTION 'Choose a valid Loyalty Vault holder' USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope'; END IF;
        RETURN NEW;
      END $$;

      CREATE OR REPLACE FUNCTION loyalty_vault_apply_delta(p_key TEXT,p_org INTEGER,p_amount NUMERIC,p_kind TEXT,p_description TEXT,
        p_table TEXT DEFAULT NULL,p_source_id INTEGER DEFAULT NULL,p_cash_id INTEGER DEFAULT NULL,p_site INTEGER DEFAULT NULL,
        p_actor INTEGER DEFAULT NULL,p_transfer UUID DEFAULT NULL,p_details JSONB DEFAULT '{}') RETURNS NUMERIC LANGUAGE plpgsql AS $$
      DECLARE v_balance NUMERIC(15,2); v_type TEXT:=split_part(p_key,':',1); v_id INTEGER:=split_part(p_key,':',2)::integer; v_name TEXT;
      BEGIN
        IF p_amount IS NULL OR p_amount=0 THEN SELECT balance INTO v_balance FROM loyalty_vault_accounts WHERE holder_key=p_key; RETURN COALESCE(v_balance,0); END IF;
        IF p_amount::text IN ('NaN','Infinity','-Infinity') THEN RAISE EXCEPTION 'Vault amounts must be finite' USING ERRCODE='23514'; END IF;
        INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id) VALUES(p_key,p_org,v_type,v_id) ON CONFLICT DO NOTHING;
        UPDATE loyalty_vault_accounts SET balance=balance+p_amount,updated_at=now() WHERE holder_key=p_key AND organization_id=p_org RETURNING balance INTO v_balance;
        IF v_balance IS NULL THEN RAISE EXCEPTION 'Vault organization mismatch' USING ERRCODE='23514'; END IF;
        IF v_type='user' THEN SELECT name INTO v_name FROM users WHERE id=v_id; ELSE SELECT full_name INTO v_name FROM members WHERE id=v_id; END IF;
        INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,amount,balance_after,kind,description,source_table,source_id,cash_flow_entry_id,site_id,actor_id,transfer_id,details)
        VALUES(p_org,p_key,v_type,v_id,p_amount,v_balance,p_kind,p_description,p_table,p_source_id,p_cash_id,p_site,p_actor,p_transfer,COALESCE(p_details,'{}')||jsonb_build_object('holder_name',COALESCE(v_name,'Former holder')));
        RETURN v_balance;
      END $$;

      CREATE OR REPLACE FUNCTION reconcile_loyalty_vault_entry(p_id INTEGER) RETURNS VOID LANGUAGE plpgsql AS $$
      DECLARE v_entry JSONB; v_source JSONB; v_old loyalty_vault_sources%ROWTYPE; v_table TEXT; v_id INTEGER; v_site INTEGER; v_org INTEGER;
        v_key TEXT; v_type TEXT; v_holder INTEGER; v_mode TEXT; v_amount NUMERIC(15,2):=0; v_credit NUMERIC; v_debit NUMERIC;
        v_excluded BOOLEAN:=false; v_linked BOOLEAN:=false; v_description TEXT; v_actor INTEGER; v_details JSONB;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('loyalty_vault_entry'),p_id);
        SELECT * INTO v_old FROM loyalty_vault_sources WHERE cash_flow_entry_id=p_id FOR UPDATE;
        SELECT to_jsonb(c) INTO v_entry FROM cash_flow_entries c WHERE c.id=p_id;
        IF v_entry IS NOT NULL THEN
          v_table:=COALESCE(NULLIF(v_entry->>'source_module',''),'cash_flow_entries');
          v_id:=CASE WHEN v_table='cash_flow_entries' THEN p_id ELSE NULLIF(v_entry->>'source_id','')::integer END;
          IF v_old.cash_flow_entry_id IS NULL AND v_table='cash_flow_entries' AND NULLIF(v_entry->>'loyalty_vault_holder_type','') IS NULL THEN RETURN; END IF;
          IF v_table='cash_flow_entries' THEN
            v_source:=v_entry;
            IF to_regclass('firm_transactions') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM firm_transactions f WHERE f.cash_flow_entry_id=$1)' INTO v_linked USING p_id; END IF;
          ELSIF v_table=ANY(ARRAY['day_book','expenses','farmer_payments','firm_transactions','plot_payments','plot_installment_payments','plot_commission_payments','vendor_payments','vendor_inventory_payments','land_deal_payments','misc_income_entries','partner_profit_payments']) AND to_regclass(v_table) IS NOT NULL THEN
            EXECUTE format('SELECT to_jsonb(s) FROM %I s WHERE id=$1',v_table) INTO v_source USING v_id;
          END IF;
          IF v_old.cash_flow_entry_id IS NULL AND NULLIF(v_source->>'loyalty_vault_holder_type','') IS NULL THEN RETURN; END IF;
          v_excluded:=v_source IS NULL OR v_linked OR COALESCE((v_source->>'is_imprest_internal')::boolean,false)
            OR NULLIF(v_source->>'entry_transfer_id','') IS NOT NULL OR NULLIF(v_source->>'money_transfer_id','') IS NOT NULL
            OR COALESCE((v_source->>'is_firm_to_firm_transfer')::boolean,false) OR NULLIF(v_source->>'transfer_group_id','') IS NOT NULL
            OR (v_table='cash_flow_entries' AND COALESCE((v_source->>'is_firm_transaction')::boolean,false) AND NULLIF(v_source->>'to_firm_id','') IS NOT NULL)
            OR (v_table='vendor_inventory_payments' AND NULLIF(v_source->>'source_vendor_payment_id','') IS NOT NULL);
          IF v_table='day_book' THEN v_excluded:=v_excluded OR UPPER(COALESCE(v_source->>'entry_type',''))='IMPREST'
            OR COALESCE((v_source->>'is_financial_projection')::boolean,false)
            OR EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id','firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field WHERE NULLIF(v_source->>field,'') IS NOT NULL); END IF;
          v_type:=v_source->>'loyalty_vault_holder_type'; v_holder:=NULLIF(v_source->>'loyalty_vault_holder_id','')::integer;
          v_site:=COALESCE(NULLIF(v_entry->>'site_id','')::integer,loyalty_vault_source_site(v_table,v_source));
          SELECT organization_id INTO v_org FROM sites WHERE id=v_site;
          v_actor:=NULLIF(v_source->>'loyalty_vault_assigned_by','')::integer;
          v_description:=COALESCE(NULLIF(v_entry->>'particular',''),'Assigned transaction');
          v_mode:=UPPER(COALESCE(NULLIF(TRIM(v_source->>'payment_mode'),''),NULLIF(TRIM(v_source->>'payment_type'),''),NULLIF(TRIM(v_source->>'by_note'),''),NULLIF(TRIM(v_entry->>'cash_type'),''),'CASH'));
          IF NOT v_excluded AND v_org IS NOT NULL AND v_type IN ('user','member') AND v_holder>0 THEN
            v_key:=v_type||':'||v_holder::text;
            v_credit:=GREATEST(COALESCE((v_entry->>'credit')::numeric,0),0)+GREATEST(-COALESCE((v_entry->>'debit')::numeric,0),0);
            v_debit:=GREATEST(COALESCE((v_entry->>'debit')::numeric,0),0)+GREATEST(-COALESCE((v_entry->>'credit')::numeric,0),0);
            IF financial_transaction_posts('credit',COALESCE(v_source->>'status',v_entry->>'status'),v_mode,COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status')) THEN v_amount:=v_amount+v_credit; END IF;
            IF financial_transaction_posts('debit',COALESCE(v_source->>'status',v_entry->>'status'),v_mode,COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status')) THEN v_amount:=v_amount-v_debit; END IF;
          END IF;
          v_details:=jsonb_strip_nulls(jsonb_build_object('payment_mode',v_mode,'status',COALESCE(v_source->>'status',v_entry->>'status'),'cheque_status',COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status'),
            'transaction_date',v_entry->>'date','transaction_time',COALESCE(v_source->>'transaction_time',v_entry->>'transaction_time'),'credit',v_entry->>'credit','debit',v_entry->>'debit',
            'reference',COALESCE(v_source->>'reference_no',v_source->>'bank_reference',v_source->>'transaction_id',v_source->>'cheque_no'),'remarks',COALESCE(v_source->>'remarks',v_source->>'note',v_entry->>'remarks'),
            'created_by',v_source->>'created_by','assigned_by',v_actor,'bank_account_id',v_entry->>'bank_account_id'));
        END IF;
        IF v_old.cash_flow_entry_id IS NULL AND v_amount=0 THEN RETURN; END IF;
        INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
          SELECT key,org,split_part(key,':',1),split_part(key,':',2)::integer FROM (VALUES(v_old.holder_key,v_old.organization_id),(v_key,v_org)) owner(key,org)
          WHERE key IS NOT NULL AND org IS NOT NULL ORDER BY key ON CONFLICT DO NOTHING;
        PERFORM holder_key FROM loyalty_vault_accounts WHERE holder_key IN (v_old.holder_key,v_key) ORDER BY holder_key FOR UPDATE;
        IF v_old.posted_amount<>0 AND (v_old.holder_key IS DISTINCT FROM v_key OR v_amount=0) THEN
          PERFORM loyalty_vault_apply_delta(v_old.holder_key,v_old.organization_id,-v_old.posted_amount,'reversal',COALESCE(v_description,'Transaction removed'),v_old.source_table,v_old.source_id,p_id,v_old.site_id,v_actor,NULL,v_details);
        END IF;
        IF v_amount<>0 THEN
          IF v_old.holder_key IS NOT DISTINCT FROM v_key AND v_old.posted_amount<>0 THEN
            PERFORM loyalty_vault_apply_delta(v_key,v_org,v_amount-v_old.posted_amount,'adjustment',v_description,v_table,v_id,p_id,v_site,v_actor,NULL,v_details);
          ELSE PERFORM loyalty_vault_apply_delta(v_key,v_org,v_amount,CASE WHEN v_amount>0 THEN 'credit' ELSE 'debit' END,v_description,v_table,v_id,p_id,v_site,v_actor,NULL,v_details); END IF;
        END IF;
        INSERT INTO loyalty_vault_sources(cash_flow_entry_id,holder_key,posted_amount,organization_id,source_table,source_id,site_id)
          VALUES(p_id,v_key,v_amount,COALESCE(v_org,v_old.organization_id),COALESCE(v_table,v_old.source_table),COALESCE(v_id,v_old.source_id),COALESCE(v_site,v_old.site_id))
          ON CONFLICT(cash_flow_entry_id) DO UPDATE SET holder_key=EXCLUDED.holder_key,posted_amount=EXCLUDED.posted_amount,organization_id=EXCLUDED.organization_id,source_table=EXCLUDED.source_table,source_id=EXCLUDED.source_id,site_id=EXCLUDED.site_id,updated_at=now();
      END $$;
      CREATE OR REPLACE FUNCTION loyalty_vault_sync_cash() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        PERFORM reconcile_loyalty_vault_entry(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END); RETURN NULL;
      END $$;
      CREATE OR REPLACE FUNCTION loyalty_vault_sync_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_id INTEGER; v_cash INTEGER; v_previous INTEGER; v_current INTEGER;
      BEGIN
        v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
        IF TG_TABLE_NAME<>'firm_transactions'
          AND (TG_OP='INSERT' OR NULLIF(to_jsonb(OLD)->>'loyalty_vault_holder_type','') IS NULL)
          AND (TG_OP='DELETE' OR NULLIF(to_jsonb(NEW)->>'loyalty_vault_holder_type','') IS NULL) THEN RETURN NULL; END IF;
        FOR v_cash IN SELECT id FROM cash_flow_entries WHERE source_module=TG_TABLE_NAME AND source_id=v_id ORDER BY id LOOP PERFORM reconcile_loyalty_vault_entry(v_cash); END LOOP;
        IF TG_TABLE_NAME='firm_transactions' THEN
          IF TG_OP<>'INSERT' THEN v_previous:=NULLIF(to_jsonb(OLD)->>'cash_flow_entry_id','')::integer; END IF;
          IF TG_OP<>'DELETE' THEN v_current:=NULLIF(to_jsonb(NEW)->>'cash_flow_entry_id','')::integer; END IF;
          IF v_previous IS NOT NULL THEN PERFORM reconcile_loyalty_vault_entry(v_previous); END IF;
          IF v_current IS NOT NULL AND v_current IS DISTINCT FROM v_previous THEN PERFORM reconcile_loyalty_vault_entry(v_current); END IF;
        END IF;
        RETURN NULL;
      END $$;
    `);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) {
      const { rows } = await db.query('SELECT to_regclass($1) AS name', [table]);
      if (!rows[0]?.name) continue;
      if(table==='firm_transactions') await db.query('CREATE INDEX IF NOT EXISTS loyalty_vault_firm_cash_link ON firm_transactions(cash_flow_entry_id) WHERE cash_flow_entry_id IS NOT NULL');
      await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS loyalty_vault_holder_type TEXT,
        ADD COLUMN IF NOT EXISTS loyalty_vault_holder_id INTEGER,
        ADD COLUMN IF NOT EXISTS loyalty_vault_assigned_by INTEGER REFERENCES users(id);
        DO $constraint$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='${table}_loyalty_vault_holder_pair') THEN
            ALTER TABLE ${table} ADD CONSTRAINT ${table}_loyalty_vault_holder_pair CHECK(
              (loyalty_vault_holder_type IS NULL AND loyalty_vault_holder_id IS NULL)
              OR (loyalty_vault_holder_type IS NOT NULL AND loyalty_vault_holder_type IN ('user','member') AND loyalty_vault_holder_id IS NOT NULL AND loyalty_vault_holder_id>0));
          END IF;
        END $constraint$;
        CREATE INDEX IF NOT EXISTS ${table}_loyalty_holder ON ${table}(loyalty_vault_holder_type,loyalty_vault_holder_id) WHERE loyalty_vault_holder_id IS NOT NULL;
        DROP TRIGGER IF EXISTS loyalty_vault_validate ON ${table};
        CREATE TRIGGER loyalty_vault_validate BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION loyalty_vault_validate_assignment();
        DROP TRIGGER IF EXISTS loyalty_vault_reconcile ON ${table};
        CREATE CONSTRAINT TRIGGER loyalty_vault_reconcile AFTER INSERT OR UPDATE OR DELETE ON ${table}
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${table === 'cash_flow_entries' ? 'loyalty_vault_sync_cash' : 'loyalty_vault_sync_source'}();`);
    }
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('199_loyalty_vault') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 199: Loyalty Vault ready'))
    .catch(error => { console.error('Migration 199 failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
