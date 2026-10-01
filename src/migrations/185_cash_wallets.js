import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Wallets track custody of newly collected physical cash. Existing receipts
// deliberately have no opening balance: historical books are not proof of who
// currently holds that cash. Corrections append deltas; history is never erased.
export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('185_cash_wallets'))");
    // Define the cutover with receipt writes paused. Lock the firm owner first,
    // in its normal owner -> cash-flow write order, because it receives a link
    // trigger below too. A receipt cannot slip between the cutover and trigger.
    await client.query(`DO $$ BEGIN
      IF to_regclass('firm_transactions') IS NOT NULL THEN
        LOCK TABLE firm_transactions IN SHARE ROW EXCLUSIVE MODE;
      END IF;
    END $$;
    LOCK TABLE cash_flow_entries IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_settings (
        singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
        tracking_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      INSERT INTO wallet_settings(singleton,tracking_started_at) VALUES (TRUE,clock_timestamp()) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS wallet_accounts (
        user_id INTEGER PRIMARY KEY REFERENCES users(id),
        balance NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (balance <> 'NaN'::NUMERIC),
        reserved_balance NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (reserved_balance >= 0 AND reserved_balance <> 'NaN'::NUMERIC),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wallet_transfers (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        recipient_id INTEGER NOT NULL REFERENCES users(id),
        amount NUMERIC(15,2) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::NUMERIC),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','cancelled')),
        note TEXT,
        idempotency_key UUID NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMPTZ,
        resolved_by INTEGER REFERENCES users(id),
        resolution_note TEXT,
        CHECK (sender_id <> recipient_id),
        UNIQUE (sender_id,idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS wallet_entries (
        id BIGSERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        amount NUMERIC(15,2) NOT NULL CHECK (amount <> 0 AND amount <> 'NaN'::NUMERIC),
        balance_after NUMERIC(15,2) NOT NULL CHECK (balance_after <> 'NaN'::NUMERIC),
        kind TEXT NOT NULL CHECK (kind IN ('receipt','adjustment','reversal','transfer_in','transfer_out')),
        description TEXT,
        source_table TEXT,
        source_id INTEGER,
        transfer_id UUID REFERENCES wallet_transfers(id),
        counterparty_id INTEGER REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wallet_sources (
        cash_flow_entry_id INTEGER PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        posted_amount NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (posted_amount >= 0 AND posted_amount <> 'NaN'::NUMERIC),
        source_table TEXT NOT NULL,
        source_id INTEGER NOT NULL,
        source_created_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS wallet_entries_user_history ON wallet_entries(user_id,id DESC);
      CREATE INDEX IF NOT EXISTS wallet_entries_source ON wallet_entries(source_table,source_id);
      CREATE INDEX IF NOT EXISTS wallet_transfers_sender_history ON wallet_transfers(sender_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS wallet_transfers_recipient_history ON wallet_transfers(recipient_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS wallet_entries_transfer_once ON wallet_entries(transfer_id,kind) WHERE transfer_id IS NOT NULL;

      CREATE OR REPLACE FUNCTION guard_wallet_entry_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Wallet history is immutable; record a compensating entry instead'
          USING ERRCODE='23514', CONSTRAINT='wallet_immutable_history';
      END $$;
      DROP TRIGGER IF EXISTS wallet_immutable_history ON wallet_entries;
      CREATE TRIGGER wallet_immutable_history BEFORE UPDATE OR DELETE ON wallet_entries
        FOR EACH ROW EXECUTE FUNCTION guard_wallet_entry_history();

      CREATE OR REPLACE FUNCTION wallet_apply_delta(
        p_user_id INTEGER, p_amount NUMERIC, p_kind TEXT, p_description TEXT,
        p_source_table TEXT, p_source_id INTEGER,
        p_transfer_id UUID DEFAULT NULL, p_counterparty_id INTEGER DEFAULT NULL
      ) RETURNS NUMERIC LANGUAGE plpgsql AS $$
      DECLARE v_balance NUMERIC(15,2); v_amount NUMERIC(15,2);
      BEGIN
        IF p_amount::TEXT IN ('NaN','Infinity','-Infinity') THEN
          RAISE EXCEPTION 'Wallet amounts must be finite' USING ERRCODE='23514',CONSTRAINT='wallet_finite_amount';
        END IF;
        v_amount := p_amount;
        IF v_amount IS NULL OR v_amount = 0 THEN
          SELECT balance INTO v_balance FROM wallet_accounts WHERE user_id=p_user_id;
          RETURN COALESCE(v_balance,0);
        END IF;
        INSERT INTO wallet_accounts(user_id) VALUES(p_user_id) ON CONFLICT DO NOTHING;
        UPDATE wallet_accounts SET balance=balance+v_amount,updated_at=NOW()
          WHERE user_id=p_user_id RETURNING balance INTO v_balance;
        INSERT INTO wallet_entries(user_id,amount,balance_after,kind,description,source_table,source_id,transfer_id,counterparty_id)
          VALUES(p_user_id,v_amount,v_balance,p_kind,p_description,p_source_table,p_source_id,p_transfer_id,p_counterparty_id);
        RETURN v_balance;
      END $$;

      CREATE OR REPLACE FUNCTION reconcile_wallet_cash_entry(p_entry_id INTEGER)
      RETURNS VOID LANGUAGE plpgsql AS $$
      DECLARE
        v_entry JSONB; v_source JSONB; v_old wallet_sources%ROWTYPE;
        v_table TEXT; v_source_id INTEGER; v_user INTEGER; v_mode TEXT;
        v_amount NUMERIC(15,2) := 0; v_started TIMESTAMPTZ; v_created TIMESTAMPTZ;
        v_description TEXT; v_excluded BOOLEAN := FALSE; v_linked BOOLEAN := FALSE;
      BEGIN
        -- Serialize reconciliation of one receipt, including repeated deferred
        -- events, source recreation and approvals racing with corrections.
        PERFORM pg_advisory_xact_lock(hashtext('wallet_cash_entry'),p_entry_id);
        SELECT * INTO v_old FROM wallet_sources WHERE cash_flow_entry_id=p_entry_id FOR UPDATE;
        SELECT to_jsonb(c) INTO v_entry FROM cash_flow_entries c WHERE c.id=p_entry_id;
        SELECT tracking_started_at INTO v_started FROM wallet_settings WHERE singleton;
        IF v_entry IS NOT NULL THEN
          v_table := COALESCE(NULLIF(v_entry->>'source_module',''),'cash_flow_entries');
          v_source_id := CASE WHEN v_table='cash_flow_entries' THEN p_entry_id ELSE (v_entry->>'source_id')::INTEGER END;
          IF v_table='cash_flow_entries' THEN
            v_source := v_entry;
            IF to_regclass('firm_transactions') IS NOT NULL THEN
              EXECUTE 'SELECT EXISTS(SELECT 1 FROM firm_transactions f WHERE (to_jsonb(f)->>''cash_flow_entry_id'')::integer=$1)'
                INTO v_linked USING p_entry_id;
            END IF;
          ELSIF v_table=ANY(ARRAY['day_book','expenses','firm_transactions','plot_payments',
            'plot_installment_payments','land_deal_payments','misc_income_entries','farmer_payments',
            'plot_commission_payments','vendor_payments','vendor_inventory_payments','partner_profit_payments'])
            AND to_regclass(v_table) IS NOT NULL THEN
            EXECUTE format('SELECT to_jsonb(s) FROM %I s WHERE id=$1',v_table) INTO v_source USING v_source_id;
          END IF;
          -- Unknown sources and synthetic allocations are not cash collections.
          v_excluded := v_source IS NULL OR v_linked
            OR COALESCE((v_source->>'is_imprest_internal')::BOOLEAN,FALSE)
            OR NULLIF(v_source->>'entry_transfer_id','') IS NOT NULL
            OR NULLIF(v_source->>'money_transfer_id','') IS NOT NULL
            OR COALESCE((v_source->>'is_firm_to_firm_transfer')::BOOLEAN,FALSE)
            OR NULLIF(v_source->>'transfer_group_id','') IS NOT NULL
            OR (v_table='cash_flow_entries' AND COALESCE((v_source->>'is_firm_transaction')::BOOLEAN,FALSE)
              AND NULLIF(v_source->>'to_firm_id','') IS NOT NULL)
            OR (v_table='vendor_inventory_payments' AND NULLIF(v_source->>'source_vendor_payment_id','') IS NOT NULL);
          IF v_table='day_book' THEN
            v_excluded := v_excluded OR UPPER(COALESCE(v_source->>'entry_type',''))='IMPREST'
              OR COALESCE((v_source->>'is_financial_projection')::BOOLEAN,FALSE)
              OR EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id',
                'firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field
                WHERE NULLIF(v_source->>field,'') IS NOT NULL);
          END IF;
          v_created := COALESCE(NULLIF(v_source->>'created_at','')::TIMESTAMPTZ,
            NULLIF(v_entry->>'created_at','')::TIMESTAMPTZ);
          -- A source's creation time survives mirror backfills and restored
          -- records. Entry date can be backdated and is intentionally irrelevant.
          IF v_old.cash_flow_entry_id IS NULL AND (v_created IS NULL OR v_created < v_started) THEN RETURN; END IF;
          v_user := COALESCE(NULLIF(v_source->>'created_by','')::INTEGER,NULLIF(v_entry->>'created_by','')::INTEGER);
          v_description := COALESCE(NULLIF(v_entry->>'particular',''),'Cash receipt');
          v_mode := UPPER(COALESCE(NULLIF(TRIM(v_source->>'payment_mode'),''),
            NULLIF(TRIM(v_source->>'payment_type'),''),NULLIF(TRIM(v_source->>'by_note'),''),
            NULLIF(TRIM(v_entry->>'cash_type'),''),'CASH'));
          IF NOT v_excluded AND EXISTS(SELECT 1 FROM users WHERE id=v_user AND role IN ('super_admin','admin','sub_admin'))
            AND financial_transaction_posts('credit',COALESCE(v_source->>'status',v_entry->>'status'),
              v_mode,COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status')) THEN
            IF v_mode='CASH' THEN
              v_amount := GREATEST(COALESCE((v_entry->>'credit')::NUMERIC,0),0)
                + GREATEST(-COALESCE((v_entry->>'debit')::NUMERIC,0),0);
            ELSIF v_table='farmer_payments' AND v_mode='SPLIT' THEN
              v_amount := GREATEST(-COALESCE((v_source->>'cash_amount')::NUMERIC,0),0);
            END IF;
          END IF;
        END IF;
        IF v_old.cash_flow_entry_id IS NULL AND v_amount=0 THEN RETURN; END IF;
        -- Lock both owners in a stable order when the source creator changes.
        INSERT INTO wallet_accounts(user_id)
          SELECT id FROM users WHERE id IN (v_old.user_id,v_user) ORDER BY id ON CONFLICT DO NOTHING;
        PERFORM user_id FROM wallet_accounts WHERE user_id IN (v_old.user_id,v_user) ORDER BY user_id FOR UPDATE;
        IF v_old.posted_amount > 0 AND (v_old.user_id IS DISTINCT FROM v_user OR v_amount=0) THEN
          PERFORM wallet_apply_delta(v_old.user_id,-v_old.posted_amount,'reversal',
            COALESCE(v_description,'Cash receipt removed'),v_old.source_table,v_old.source_id);
        END IF;
        IF v_amount > 0 THEN
          IF v_old.user_id IS NOT DISTINCT FROM v_user AND v_old.posted_amount > 0 THEN
            PERFORM wallet_apply_delta(v_user,v_amount-v_old.posted_amount,'adjustment',v_description,v_table,v_source_id);
          ELSE
            PERFORM wallet_apply_delta(v_user,v_amount,'receipt',v_description,v_table,v_source_id);
          END IF;
        END IF;
        INSERT INTO wallet_sources(cash_flow_entry_id,user_id,posted_amount,source_table,source_id,source_created_at)
          VALUES(p_entry_id,COALESCE(v_user,v_old.user_id),v_amount,COALESCE(v_table,v_old.source_table),
            COALESCE(v_source_id,v_old.source_id),COALESCE(v_created,v_old.source_created_at))
          ON CONFLICT(cash_flow_entry_id) DO UPDATE SET user_id=EXCLUDED.user_id,posted_amount=EXCLUDED.posted_amount,
            source_table=EXCLUDED.source_table,source_id=EXCLUDED.source_id,updated_at=NOW();
      END $$;

      CREATE OR REPLACE FUNCTION sync_wallet_cash_entry() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM reconcile_wallet_cash_entry(CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END);
        RETURN NULL;
      END $$;
      DROP TRIGGER IF EXISTS wallet_cash_receipt_sync ON cash_flow_entries;
      -- Firm entries and their personal-ledger copies are written together.
      -- Observe the final transaction state so those copies never double-credit.
      CREATE CONSTRAINT TRIGGER wallet_cash_receipt_sync AFTER INSERT OR UPDATE OR DELETE ON cash_flow_entries
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_wallet_cash_entry();
      CREATE OR REPLACE FUNCTION sync_wallet_firm_link() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_previous INTEGER; v_current INTEGER;
      BEGIN
        IF TG_OP <> 'INSERT' THEN v_previous := (to_jsonb(OLD)->>'cash_flow_entry_id')::INTEGER; END IF;
        IF TG_OP <> 'DELETE' THEN v_current := (to_jsonb(NEW)->>'cash_flow_entry_id')::INTEGER; END IF;
        IF v_previous IS NOT NULL THEN PERFORM reconcile_wallet_cash_entry(v_previous); END IF;
        IF v_current IS NOT NULL AND v_current IS DISTINCT FROM v_previous THEN
          PERFORM reconcile_wallet_cash_entry(v_current);
        END IF;
        RETURN NULL;
      END $$;
      DO $$ BEGIN
        IF to_regclass('firm_transactions') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS wallet_firm_link_sync ON firm_transactions;
          CREATE CONSTRAINT TRIGGER wallet_firm_link_sync AFTER INSERT OR UPDATE OR DELETE ON firm_transactions
            DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION sync_wallet_firm_link();
        END IF;
      END $$;
      INSERT INTO app_schema_migrations(version) VALUES('185_cash_wallets') ON CONFLICT DO NOTHING;
    `);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 185: cash wallets ready'))
    .catch(error => { console.error('Migration 185 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
