import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

const MODULES = {
  personal_ledger: ['cash_flow_entries','cash_flow_month_id'], expense: ['expenses',null],
  farmer_payment: ['farmer_payments','farmer_id'], plot_payment: ['plot_payments','plot_id'],
  plot_commission: ['plot_commission_payments','plot_commission_id'], vendor_payment: ['vendor_payments','commitment_id'],
  vendor_inventory_payment: ['vendor_inventory_payments','order_id'],
  misc_income: ['misc_income_entries','category_id'], land_sale: ['land_deal_payments','land_deal_id'], daybook: ['day_book',null],
};
// Add inside migration163 after transfer columns exist, using its transaction client.
// No rows are updated. Reclassification retains the original expense's float
// ownership; generated legs create neither new reservations nor new spending.
export async function patchTransferImprestFunctions(db) {
  const patches = [
    {
      name: 'sync_universal_imprest_from_source()',
      marker: '-- Generated transfer adjustments do not spend imprest.',
      from: "v_reference_id := NULLIF(v_row->>'id', '')::integer;",
      to: `v_reference_id := NULLIF(v_row->>'id', '')::integer;
        -- Generated transfer adjustments do not spend imprest.
        -- The transfer FK/pair constraint authorizes these immutable legs.
        IF NULLIF(v_row->>'entry_transfer_id', '') IS NOT NULL THEN
          IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
          RETURN NEW;
        END IF;`,
    },
    {
      name: 'reconcile_direct_cashflow_imprest(integer)',
      marker: "to_jsonb(v_entry)->>'entry_transfer_id'",
      from: 'IF v_entry.source_module IS NOT NULL OR v_is_firm_mirror THEN',
      to: `IF v_entry.source_module IS NOT NULL OR v_is_firm_mirror
          OR NULLIF(to_jsonb(v_entry)->>'entry_transfer_id', '') IS NOT NULL THEN`,
    },
  ];
  for (const patch of patches) {
    const { rows } = await db.query(
      'SELECT pg_get_functiondef(to_regprocedure($1)) AS definition', [patch.name],
    );
    const definition = rows[0]?.definition;
    // Missing functions are allowed only for minimal test installations.
    if (!definition || definition.includes(patch.marker)) continue;
    if (definition.split(patch.from).length !== 2) {
      throw new Error(`Unexpected ${patch.name} definition; refusing to change imprest posting`);
    }
    await db.query(definition.replace(patch.from, patch.to));
  }
}

export async function up(database=pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('163_paired_transaction_transfers'))");
    await db.query(`CREATE TABLE IF NOT EXISTS transaction_transfer_batches (
      request_id UUID PRIMARY KEY,request_hash TEXT NOT NULL,transferred_by INTEGER NOT NULL REFERENCES users(id),response JSONB,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const types=Object.keys(MODULES).map(s=>`'${s}'`).join(',');
    await db.query(`CREATE TABLE IF NOT EXISTS transaction_money_transfers (
      id UUID PRIMARY KEY, request_id UUID NOT NULL REFERENCES transaction_transfer_batches(request_id) ON DELETE RESTRICT,
      site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
      source_type TEXT NOT NULL CHECK(source_type IN (${types})),source_record_id INTEGER NOT NULL,source_offset_id INTEGER NOT NULL,source_parent_id INTEGER,
      target_type TEXT NOT NULL CHECK(target_type IN (${types})),target_record_id INTEGER NOT NULL,target_parent_id INTEGER,
      amount NUMERIC(15,2) NOT NULL CHECK(amount>0),date DATE NOT NULL,direction TEXT NOT NULL CHECK(direction IN ('debit','credit')),
      bucket TEXT NOT NULL CHECK(bucket IN ('cash','bank')),bank_account_id INTEGER REFERENCES bank_accounts(id),reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 5 AND 500),
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,source_snapshot JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK(source_record_id<>source_offset_id),CHECK(source_type<>target_type OR source_offset_id<>target_record_id)
    )`);
    await db.query('CREATE INDEX IF NOT EXISTS transaction_money_transfers_source ON transaction_money_transfers(source_type,source_record_id)');
    await db.query('CREATE INDEX IF NOT EXISTS transaction_money_transfers_offset ON transaction_money_transfers(source_type,source_offset_id)');
    await db.query('CREATE INDEX IF NOT EXISTS transaction_money_transfers_target ON transaction_money_transfers(target_type,target_record_id)');
    for(const [type,[table,parent]] of Object.entries(MODULES)) {
      await db.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS entry_transfer_id UUID REFERENCES transaction_money_transfers(id) DEFERRABLE INITIALLY DEFERRED,
        ADD COLUMN IF NOT EXISTS entry_transfer_role TEXT CHECK(entry_transfer_role IN ('source_offset','destination'))`);
      await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${table}_entry_transfer_leg ON ${table}(entry_transfer_id,entry_transfer_role) WHERE entry_transfer_id IS NOT NULL`);
      await db.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_entry_transfer_link_check`);
      await db.query(`ALTER TABLE ${table} ADD CONSTRAINT ${table}_entry_transfer_link_check CHECK ((entry_transfer_id IS NULL)=(entry_transfer_role IS NULL))`);
    }
    await patchTransferImprestFunctions(db);
    // Preserve positive-only ordinary payments. Sign-encoded refund postings are
    // permitted only with a deferred, balanced, immutable transfer reference.
    await db.query(`DO $$ DECLARE r RECORD; BEGIN
      FOR r IN SELECT c.conname,t.relname,pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
        WHERE c.contype='c' AND t.relname IN ('farmer_payments','vendor_payments','vendor_inventory_payments','land_deal_payments','plot_payments','plot_commission_payments')
          AND cardinality(c.conkey)=1 AND pg_get_constraintdef(c.oid) ~ '^CHECK \\(\\(amount >=? \\(?0'
      LOOP EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I',r.relname,r.conname);
        EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I CHECK (amount > 0 OR (amount < 0 AND entry_transfer_id IS NOT NULL))',r.relname,r.conname);
      END LOOP;
    END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION transfer_owner_table(p_type TEXT) RETURNS TEXT LANGUAGE SQL IMMUTABLE AS $$ SELECT CASE p_type
      ${Object.entries(MODULES).map(([type,[table]])=>`WHEN '${type}' THEN '${table}'`).join('\n')}
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION protect_transaction_transfer_record() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v_linked BOOLEAN; v_data JSONB;
      BEGIN
        v_data:=to_jsonb(OLD);
        SELECT EXISTS(SELECT 1 FROM transaction_money_transfers t WHERE
          (transfer_owner_table(t.source_type)=TG_TABLE_NAME AND OLD.id IN (t.source_record_id,t.source_offset_id)) OR
          (transfer_owner_table(t.target_type)=TG_TABLE_NAME AND OLD.id=t.target_record_id) OR
          (TG_TABLE_NAME='vendor_inventory_payments' AND ((t.source_type='vendor_payment' AND (v_data->>'source_vendor_payment_id')::int IN (t.source_record_id,t.source_offset_id)) OR (t.target_type='vendor_payment' AND (v_data->>'source_vendor_payment_id')::int=t.target_record_id))) OR
          (TG_TABLE_NAME='cash_flow_entries' AND (
            (transfer_owner_table(t.source_type)=v_data->>'source_module' AND (v_data->>'source_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (transfer_owner_table(t.target_type)=v_data->>'source_module' AND (v_data->>'source_id')::int=t.target_record_id))) OR
          (TG_TABLE_NAME='day_book' AND (
            (t.source_type='expense' AND (v_data->>'expense_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (t.target_type='expense' AND (v_data->>'expense_id')::int=t.target_record_id) OR
            (t.source_type='personal_ledger' AND (v_data->>'cash_flow_entry_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (t.target_type='personal_ledger' AND (v_data->>'cash_flow_entry_id')::int=t.target_record_id) OR
            (t.source_type='farmer_payment' AND (v_data->>'farmer_payment_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (t.target_type='farmer_payment' AND (v_data->>'farmer_payment_id')::int=t.target_record_id) OR
            (t.source_type='plot_payment' AND (v_data->>'plot_payment_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (t.target_type='plot_payment' AND (v_data->>'plot_payment_id')::int=t.target_record_id) OR
            (t.source_type='vendor_payment' AND (v_data->>'vendor_payment_id')::int IN (t.source_record_id,t.source_offset_id)) OR
            (t.target_type='vendor_payment' AND (v_data->>'vendor_payment_id')::int=t.target_record_id))
          )) INTO v_linked;
        IF v_linked AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'updated_at')) THEN
          RAISE EXCEPTION 'This transaction belongs to a balanced transfer and its accounting history is protected' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
        END IF;
        IF TG_OP='DELETE' THEN RETURN OLD; END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION normalize_transaction_transfer_mirror() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE v JSONB:=to_jsonb(NEW); v_net NUMERIC; v_mode TEXT;
      BEGIN
        IF NEW.entry_transfer_id IS NULL THEN RETURN NEW; END IF;
        IF TG_TABLE_NAME IN ('expenses','day_book') THEN v_net:=COALESCE((v->>'credit')::numeric,0)-COALESCE((v->>'debit')::numeric,0);
        ELSIF TG_TABLE_NAME IN ('plot_payments','land_deal_payments') THEN v_net:=(v->>'amount')::numeric;
        ELSIF TG_TABLE_NAME='misc_income_entries' THEN v_net:=(v->>'amount')::numeric*CASE WHEN v->>'direction'='credit' THEN 1 ELSE -1 END;
        ELSE v_net:=-(v->>'amount')::numeric; END IF;
        v_mode:=CASE WHEN UPPER(COALESCE(v->>'payment_mode',v->>'payment_type','BANK'))='CASH' THEN 'cash' ELSE 'bank' END;
        UPDATE cash_flow_entries SET debit=GREATEST(-v_net,0),credit=GREATEST(v_net,0),cash_type=v_mode,
          status='approved',cheque_status=NULL,cheque_no=NULL,assigned_admin_id=NULL,created_by=(v->>'created_by')::int,
          approved_by=(v->>'approved_by')::int,approved_at=(v->>'approved_at')::timestamptz
          WHERE source_module=TG_TABLE_NAME AND source_id=NEW.id;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION check_transaction_transfer_pair() RETURNS TRIGGER LANGUAGE plpgsql AS $$
      DECLARE t transaction_money_transfers%ROWTYPE; v_id UUID; leg RECORD; v JSONB; v_table TEXT; v_net NUMERIC; v_count INTEGER; v_expected NUMERIC; v_parent TEXT;
      BEGIN
        IF TG_TABLE_NAME='transaction_money_transfers' THEN v_id:=NEW.id; ELSE v_id:=NEW.entry_transfer_id; END IF;
        IF v_id IS NULL THEN RETURN NEW; END IF;
        SELECT * INTO t FROM transaction_money_transfers WHERE id=v_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Transfer header is missing' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected'; END IF;
        IF TG_TABLE_NAME<>'transaction_money_transfers' THEN
        IF NOT (
          (TG_TABLE_NAME=transfer_owner_table(t.source_type) AND NEW.id=t.source_offset_id AND NEW.entry_transfer_role='source_offset') OR
          (TG_TABLE_NAME=transfer_owner_table(t.target_type) AND NEW.id=t.target_record_id AND NEW.entry_transfer_role='destination')) THEN
          RAISE EXCEPTION 'A transfer can contain only its two registered entries' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
        END IF;
        END IF;
        EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE id=$1',transfer_owner_table(t.source_type)) INTO v USING t.source_record_id;
        IF v IS NULL OR COALESCE(v->>'date',v->>'payment_date')::date>t.date OR v->>'status'<>'approved' THEN
          RAISE EXCEPTION 'Transfer original is missing, unapproved or later than its transfer' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
        END IF;
        FOR leg IN SELECT t.source_type AS kind,t.source_offset_id AS id,t.source_parent_id AS parent_id,'source_offset' AS role,-1 AS sign
          UNION ALL SELECT t.target_type,t.target_record_id,t.target_parent_id,'destination',1
        LOOP
          v_table:=transfer_owner_table(leg.kind);
          EXECUTE format('SELECT to_jsonb(r) FROM %I r WHERE id=$1',v_table) INTO v USING leg.id;
          v_parent:=CASE leg.kind ${Object.entries(MODULES).filter(([,v])=>v[1]).map(([type,[,parent]])=>`WHEN '${type}' THEN '${parent}'`).join(' ')} END;
          IF v IS NULL OR v->>'entry_transfer_id'<>v_id::text OR v->>'entry_transfer_role'<>leg.role OR v->>'status'<>'approved'
            OR COALESCE(v->>'date',v->>'payment_date')::date<>t.date OR (v->>'cheque_status') IS NOT NULL
            OR (v_parent IS NOT NULL AND (v->>v_parent)::int IS DISTINCT FROM leg.parent_id) THEN
            RAISE EXCEPTION 'Transfer requires two approved matching entries' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected';
          END IF;
          SELECT COUNT(*),COALESCE(SUM(credit-debit),0) INTO v_count,v_net FROM cash_flow_entries c
            WHERE ((leg.kind='personal_ledger' AND c.id=leg.id AND c.source_module IS NULL) OR (leg.kind<>'personal_ledger' AND c.source_module=v_table AND c.source_id=leg.id))
              AND c.site_id=t.site_id AND c.date=t.date AND c.status='approved' AND c.cheque_status IS NULL AND c.cash_type=t.bucket AND c.bank_account_id IS NOT DISTINCT FROM t.bank_account_id;
          v_expected:=t.amount*leg.sign*CASE WHEN t.direction='credit' THEN 1 ELSE -1 END;
          IF v_count<>1 OR v_net<>v_expected THEN RAISE EXCEPTION 'Transfer ledger projections must be equal and opposite in the same cash or bank balance' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected'; END IF;
        END LOOP;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION protect_transaction_transfer_audit() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'Posted transfer history cannot be edited or deleted' USING ERRCODE='23514',CONSTRAINT='transaction_transfer_protected'; END $$`);
    await db.query('DROP TRIGGER IF EXISTS transaction_transfer_immutable ON transaction_money_transfers');
    await db.query('CREATE TRIGGER transaction_transfer_immutable BEFORE UPDATE OR DELETE ON transaction_money_transfers FOR EACH ROW EXECUTE FUNCTION protect_transaction_transfer_audit()');
    await db.query('DROP TRIGGER IF EXISTS transaction_transfer_pair ON transaction_money_transfers');
    await db.query('CREATE CONSTRAINT TRIGGER transaction_transfer_pair AFTER INSERT ON transaction_money_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_transfer_pair()');
    for(const [, [table]] of Object.entries(MODULES)) {
      await db.query(`DROP TRIGGER IF EXISTS transaction_transfer_protection ON ${table}`);
      await db.query(`CREATE TRIGGER transaction_transfer_protection BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION protect_transaction_transfer_record()`);
      await db.query(`DROP TRIGGER IF EXISTS transaction_transfer_pair ON ${table}`);
      await db.query(`CREATE CONSTRAINT TRIGGER transaction_transfer_pair AFTER INSERT OR UPDATE ON ${table} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_transaction_transfer_pair()`);
      if(table!=='cash_flow_entries') {
        await db.query(`DROP TRIGGER IF EXISTS zzzzz_transaction_transfer_mirror ON ${table}`);
        await db.query(`CREATE TRIGGER zzzzz_transaction_transfer_mirror AFTER INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION normalize_transaction_transfer_mirror()`);
      }
    }
    await db.query("INSERT INTO app_schema_migrations(version) VALUES ('163_paired_transaction_transfers') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally {db.release();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) up().then(()=>console.log('Paired transaction transfer schema ready')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
