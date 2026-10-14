import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Keep the original tables/history intact; the existing custody ledger is the
// single live Cash Wallet. Financial source rows are never rewritten.
export const cashWalletReconciliationSql = `
      CREATE OR REPLACE FUNCTION reconcile_loyalty_vault_entry(p_id INTEGER) RETURNS VOID LANGUAGE plpgsql AS $$
      DECLARE v_entry JSONB; v_source JSONB; v_old loyalty_vault_sources%ROWTYPE; v_table TEXT; v_id INTEGER; v_site INTEGER; v_org INTEGER;
        v_key TEXT; v_type TEXT; v_holder INTEGER; v_mode TEXT; v_amount NUMERIC(15,2):=0; v_credit NUMERIC; v_debit NUMERIC;
        v_excluded BOOLEAN:=false; v_linked BOOLEAN:=false; v_description TEXT; v_actor INTEGER; v_details JSONB; v_created TIMESTAMPTZ; v_started TIMESTAMPTZ;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtext('loyalty_vault_entry'),p_id);
        SELECT * INTO v_old FROM loyalty_vault_sources WHERE cash_flow_entry_id=p_id FOR UPDATE;
        SELECT to_jsonb(c) INTO v_entry FROM cash_flow_entries c WHERE c.id=p_id;
        IF v_entry IS NOT NULL THEN
          v_table:=COALESCE(NULLIF(v_entry->>'source_module',''),'cash_flow_entries');
          v_id:=CASE WHEN v_table='cash_flow_entries' THEN p_id ELSE NULLIF(v_entry->>'source_id','')::integer END;
          IF v_table='cash_flow_entries' THEN
            v_source:=v_entry;
            IF to_regclass('firm_transactions') IS NOT NULL THEN EXECUTE 'SELECT EXISTS(SELECT 1 FROM firm_transactions f WHERE f.cash_flow_entry_id=$1)' INTO v_linked USING p_id; END IF;
          ELSIF v_table=ANY(ARRAY['day_book','expenses','farmer_payments','firm_transactions','plot_payments','plot_installment_payments','plot_commission_payments','vendor_payments','vendor_inventory_payments','land_deal_payments','misc_income_entries','partner_profit_payments']) AND to_regclass(v_table) IS NOT NULL THEN
            EXECUTE format('SELECT to_jsonb(s) FROM %I s WHERE id=$1',v_table) INTO v_source USING v_id;
          END IF;
          v_excluded:=v_source IS NULL OR v_linked OR COALESCE((v_source->>'is_imprest_internal')::boolean,false)
            OR NULLIF(v_source->>'entry_transfer_id','') IS NOT NULL OR NULLIF(v_source->>'money_transfer_id','') IS NOT NULL
            OR COALESCE((v_source->>'is_firm_to_firm_transfer')::boolean,false) OR NULLIF(v_source->>'transfer_group_id','') IS NOT NULL
            OR (v_table='cash_flow_entries' AND COALESCE((v_source->>'is_firm_transaction')::boolean,false) AND NULLIF(v_source->>'to_firm_id','') IS NOT NULL)
            OR (v_table='vendor_inventory_payments' AND NULLIF(v_source->>'source_vendor_payment_id','') IS NOT NULL);
          IF v_table='day_book' THEN v_excluded:=v_excluded OR UPPER(COALESCE(v_source->>'entry_type',''))='IMPREST'
            OR COALESCE((v_source->>'is_financial_projection')::boolean,false)
            OR EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id','firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field WHERE NULLIF(v_source->>field,'') IS NOT NULL); END IF;
          v_type:=v_source->>'loyalty_vault_holder_type'; v_holder:=NULLIF(v_source->>'loyalty_vault_holder_id','')::integer;
          v_created:=COALESCE(NULLIF(v_source->>'created_at','')::timestamptz,NULLIF(v_entry->>'created_at','')::timestamptz);
          SELECT consolidated_at INTO v_started FROM loyalty_vault_settings WHERE singleton;
          -- Preserve explicit historical assignments and already tracked cash.
          -- Unassigned historical company finances never become opening cash.
          IF v_type IS NULL AND (v_old.cash_flow_entry_id IS NOT NULL OR v_created>=v_started
            OR EXISTS(SELECT 1 FROM wallet_sources WHERE cash_flow_entry_id=p_id)) THEN
            v_type:='user'; v_holder:=COALESCE(NULLIF(v_source->>'created_by','')::integer,NULLIF(v_entry->>'created_by','')::integer);
          END IF;
          v_site:=COALESCE(NULLIF(v_entry->>'site_id','')::integer,loyalty_vault_source_site(v_table,v_source));
          SELECT organization_id INTO v_org FROM sites WHERE id=v_site;
          v_actor:=NULLIF(v_source->>'loyalty_vault_assigned_by','')::integer;
          v_description:=COALESCE(NULLIF(v_entry->>'particular',''),'Assigned transaction');
          v_mode:=UPPER(COALESCE(NULLIF(TRIM(v_source->>'payment_mode'),''),NULLIF(TRIM(v_source->>'payment_type'),''),NULLIF(TRIM(v_source->>'by_note'),''),NULLIF(TRIM(v_entry->>'cash_type'),''),'CASH'));
          IF NOT v_excluded AND v_org IS NOT NULL AND v_type IN ('user','member') AND v_holder>0
            AND (v_type<>'user' OR EXISTS(SELECT 1 FROM users WHERE id=v_holder AND organization_id=v_org
              AND (role IN ('admin','super_admin','sub_admin') OR NULLIF(v_source->>'loyalty_vault_holder_type','') IS NOT NULL
                OR v_old.holder_key='user:'||v_holder::text
                OR EXISTS(SELECT 1 FROM wallet_sources WHERE cash_flow_entry_id=p_id AND user_id=v_holder))))
            AND (v_mode='CASH' OR (v_table='farmer_payments' AND v_mode='SPLIT')) THEN
            v_key:=v_type||':'||v_holder::text;
            v_credit:=GREATEST(COALESCE((v_entry->>'credit')::numeric,0),0)+GREATEST(-COALESCE((v_entry->>'debit')::numeric,0),0);
            v_debit:=GREATEST(COALESCE((v_entry->>'debit')::numeric,0),0)+GREATEST(-COALESCE((v_entry->>'credit')::numeric,0),0);
            IF v_table='farmer_payments' AND v_mode='SPLIT' THEN
              v_credit:=GREATEST(-COALESCE((v_source->>'cash_amount')::numeric,0),0);
              v_debit:=GREATEST(COALESCE((v_source->>'cash_amount')::numeric,0),0);
            END IF;
            IF financial_transaction_posts('credit',COALESCE(v_source->>'status',v_entry->>'status'),v_mode,COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status')) THEN v_amount:=v_amount+v_credit; END IF;
            -- Business outflows use imprest (or Admin site cash). Wallet
            -- custody receives cash credits and moves out only by handover.
          END IF;
          v_details:=jsonb_strip_nulls(jsonb_build_object('payment_mode',CASE WHEN v_mode='SPLIT' THEN 'CASH' ELSE v_mode END,'source_payment_mode',v_mode,'status',COALESCE(v_source->>'status',v_entry->>'status'),'cheque_status',COALESCE(v_source->>'cheque_status',v_entry->>'cheque_status'),
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
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('203_unified_cash_wallet'))");
    await db.query("SET LOCAL lock_timeout = '5s'");
    // Read requests and movements from one state, including an acceptance
    // finishing on an older API process while this migration is requested.
    await db.query(`LOCK TABLE cash_flow_entries,wallet_transfers,wallet_accounts,wallet_entries,
      loyalty_vault_transfers,loyalty_vault_accounts,loyalty_vault_entries IN SHARE ROW EXCLUSIVE MODE`);
    await db.query(`ALTER TABLE loyalty_vault_settings ADD COLUMN IF NOT EXISTS consolidated_at TIMESTAMPTZ;
      UPDATE loyalty_vault_settings SET consolidated_at=now() WHERE consolidated_at IS NULL;
      DROP TRIGGER IF EXISTS wallet_cash_receipt_sync ON cash_flow_entries;
      DROP TRIGGER IF EXISTS wallet_firm_link_sync ON firm_transactions;`);
    // Reinstall even on a repeat run: older idempotent migrations may have
    // restored their original function definitions earlier in a startup chain.
    await db.query(cashWalletReconciliationSql);
    await db.query(`CREATE OR REPLACE FUNCTION guard_legacy_cash_wallet_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF EXISTS(SELECT 1 FROM app_schema_migrations WHERE version='203_unified_cash_wallet') THEN
          RAISE EXCEPTION 'Cash Wallet has been consolidated; use the current Cash Wallet API'
            USING ERRCODE='23514',CONSTRAINT='cash_wallet_legacy_read_only';
        END IF;
        RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
      END $$;
      DROP TRIGGER IF EXISTS cash_wallet_legacy_read_only ON wallet_accounts;
      CREATE TRIGGER cash_wallet_legacy_read_only BEFORE INSERT OR UPDATE OR DELETE ON wallet_accounts
        FOR EACH ROW EXECUTE FUNCTION guard_legacy_cash_wallet_write();
      DROP TRIGGER IF EXISTS cash_wallet_legacy_read_only ON wallet_transfers;
      CREATE TRIGGER cash_wallet_legacy_read_only BEFORE INSERT OR UPDATE OR DELETE ON wallet_transfers
        FOR EACH ROW EXECUTE FUNCTION guard_legacy_cash_wallet_write();
      DROP TRIGGER IF EXISTS cash_wallet_legacy_read_only ON wallet_entries;
      CREATE TRIGGER cash_wallet_legacy_read_only BEFORE INSERT ON wallet_entries
        FOR EACH ROW EXECUTE FUNCTION guard_legacy_cash_wallet_write();`);
    await db.query(`CREATE OR REPLACE FUNCTION loyalty_vault_sync_source() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_id INTEGER; v_cash INTEGER; v_previous INTEGER; v_current INTEGER;
      BEGIN
        v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END;
        FOR v_cash IN SELECT id FROM cash_flow_entries WHERE source_module=TG_TABLE_NAME AND source_id=v_id ORDER BY id LOOP
          PERFORM reconcile_loyalty_vault_entry(v_cash);
        END LOOP;
        IF TG_TABLE_NAME='firm_transactions' THEN
          IF TG_OP<>'INSERT' THEN v_previous:=NULLIF(to_jsonb(OLD)->>'cash_flow_entry_id','')::integer; END IF;
          IF TG_OP<>'DELETE' THEN v_current:=NULLIF(to_jsonb(NEW)->>'cash_flow_entry_id','')::integer; END IF;
          IF v_previous IS NOT NULL THEN PERFORM reconcile_loyalty_vault_entry(v_previous); END IF;
          IF v_current IS NOT NULL AND v_current IS DISTINCT FROM v_previous THEN PERFORM reconcile_loyalty_vault_entry(v_current); END IF;
        END IF;
        RETURN NULL;
      END $$;`);
    const applied = (await db.query("SELECT 1 FROM app_schema_migrations WHERE version='203_unified_cash_wallet'")).rows.length > 0;
    if (!applied) {
      // Reconcile the union once; overlapping source receipts are never summed.
      // Noncash custody receives an immutable compensating reversal.
      const sources = await db.query(`SELECT cash_flow_entry_id FROM loyalty_vault_sources
        UNION SELECT cash_flow_entry_id FROM wallet_sources ORDER BY cash_flow_entry_id`);
      for (const row of sources.rows) await db.query('SELECT reconcile_loyalty_vault_entry($1)', [row.cash_flow_entry_id]);

      const transfers = (await db.query(`SELECT t.*,u.organization_id FROM wallet_transfers t
        JOIN users u ON u.id=t.sender_id ORDER BY t.created_at,t.id`)).rows;
      for (const transfer of transfers) {
        const inserted = await db.query(`INSERT INTO loyalty_vault_transfers(id,organization_id,from_holder_type,from_holder_id,
          to_holder_id,sender_id,recipient_id,amount,status,note,idempotency_key,created_at,resolved_at,resolved_by,resolution_note)
          VALUES($1,$2,'user',$3,$4,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT(id) DO NOTHING RETURNING id`, [transfer.id,transfer.organization_id,transfer.sender_id,transfer.recipient_id,
          transfer.amount,transfer.status,transfer.note||'',transfer.idempotency_key,transfer.created_at,transfer.resolved_at,transfer.resolved_by,transfer.resolution_note]);
        if (!inserted.rows.length) throw new Error('An existing custody transfer conflicts with a legacy Cash Wallet transfer. Consolidation was rolled back.');
        // Import actual completed debit/credit movements, retaining their
        // timestamps, snapshots and original immutable history IDs.
        const movements = (await db.query(`SELECT e.*,COALESCE(d.details,'{}'::jsonb) AS details FROM wallet_entries e
          LEFT JOIN wallet_entry_details d ON d.wallet_entry_id=e.id WHERE e.transfer_id=$1 ORDER BY e.id`, [transfer.id])).rows;
        for (const movement of movements) {
          const key = `user:${movement.user_id}`;
          await db.query(`INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
            VALUES($1,$2,'user',$3) ON CONFLICT DO NOTHING`,[key,transfer.organization_id,movement.user_id]);
          const balance = (await db.query(`UPDATE loyalty_vault_accounts SET balance=balance+$2::numeric,updated_at=now()
            WHERE holder_key=$1 AND organization_id=$3 RETURNING balance`,[key,movement.amount,transfer.organization_id])).rows[0];
          if (!balance) throw new Error('Legacy cash transfer organization mismatch.');
          await db.query(`INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,amount,balance_after,
            kind,description,transfer_id,actor_id,details,created_at)
            VALUES($1,$2,'user',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[transfer.organization_id,key,movement.user_id,movement.amount,
            balance.balance,movement.kind,movement.description,transfer.id,transfer.resolved_by,
            {...movement.details,payment_mode:'CASH',legacy_wallet_entry_id:movement.id,holder_name:movement.details.collector_name},movement.created_at]);
        }
      }
      await db.query(`INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
        SELECT 'user:'||u.id::text,u.organization_id,'user',u.id FROM users u WHERE EXISTS(
          SELECT 1 FROM loyalty_vault_transfers t WHERE t.status='pending' AND t.from_holder_type='user' AND t.from_holder_id=u.id)
        ON CONFLICT DO NOTHING;
        UPDATE loyalty_vault_accounts a SET reserved_balance=COALESCE((SELECT sum(t.amount) FROM loyalty_vault_transfers t
          WHERE t.status='pending' AND t.organization_id=a.organization_id AND t.from_holder_type=a.holder_type AND t.from_holder_id=a.holder_id),0),updated_at=now();
        INSERT INTO app_schema_migrations(version) VALUES('203_unified_cash_wallet');`);
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 203: unified Cash Wallet ready'))
    .catch(error => { console.error('Migration 203 failed:', error.message); process.exitCode = 1; }).finally(() => pool.end());
}
