import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';

// This guard changes future writes only. Existing assignments and immutable
// movements are retained; physical custody changes use the wallet transfer API.
export const lockedCashCollectorSql = `
  CREATE OR REPLACE FUNCTION cash_wallet_lock_source_collector() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_row JSONB:=to_jsonb(NEW); v_maker INTEGER; v_excluded BOOLEAN; v_restore BOOLEAN:=false;
  BEGIN
    IF TG_OP='UPDATE' THEN
      IF NEW.loyalty_vault_holder_type IS DISTINCT FROM OLD.loyalty_vault_holder_type
        OR NEW.loyalty_vault_holder_id IS DISTINCT FROM OLD.loyalty_vault_holder_id
        OR NEW.loyalty_vault_assigned_by IS DISTINCT FROM OLD.loyalty_vault_assigned_by THEN
        RAISE EXCEPTION 'The original cash collector cannot be changed. Use a wallet transfer to hand over cash.'
          USING ERRCODE='23514',CONSTRAINT='cash_wallet_collector_locked';
      END IF;
      IF v_row->>'created_by' IS DISTINCT FROM to_jsonb(OLD)->>'created_by' THEN
        RAISE EXCEPTION 'The original transaction maker cannot be changed.'
          USING ERRCODE='23514',CONSTRAINT='cash_wallet_collector_locked';
      END IF;
      RETURN NEW;
    END IF;

    -- Derived financial mirrors and internal transfers never own cash receipts.
    -- Their existing reconciliation exclusions remain the source of truth.
    v_excluded:=COALESCE((v_row->>'is_imprest_internal')::boolean,false)
      OR NULLIF(v_row->>'entry_transfer_id','') IS NOT NULL OR NULLIF(v_row->>'money_transfer_id','') IS NOT NULL
      OR COALESCE((v_row->>'is_firm_to_firm_transfer')::boolean,false) OR NULLIF(v_row->>'transfer_group_id','') IS NOT NULL
      OR (TG_TABLE_NAME='cash_flow_entries' AND NULLIF(v_row->>'source_module','') IS NOT NULL)
      OR (TG_TABLE_NAME='cash_flow_entries' AND COALESCE((v_row->>'is_firm_transaction')::boolean,false) AND NULLIF(v_row->>'to_firm_id','') IS NOT NULL)
      OR (TG_TABLE_NAME='vendor_inventory_payments' AND NULLIF(v_row->>'source_vendor_payment_id','') IS NOT NULL)
      OR (TG_TABLE_NAME='day_book' AND (UPPER(COALESCE(v_row->>'entry_type',''))='IMPREST'
        OR COALESCE((v_row->>'is_financial_projection')::boolean,false)
        OR EXISTS(SELECT 1 FROM unnest(ARRAY['expense_id','farmer_payment_id','commission_id','cash_flow_entry_id','firm_transaction_id','plot_payment_id','vendor_payment_id','imprest_allocation_id']) field
          WHERE NULLIF(v_row->>field,'') IS NOT NULL)));
    IF v_excluded THEN
      NEW.loyalty_vault_holder_type:=NULL; NEW.loyalty_vault_holder_id:=NULL; NEW.loyalty_vault_assigned_by:=NULL;
      RETURN NEW;
    END IF;

    -- A recycle-bin replay is the same archived row at its original primary
    -- key, not a new collection. Require the complete saved record to match;
    -- neither a client flag nor a supplied old timestamp can bypass this rule.
    IF to_regclass('recycle_bin_entries') IS NOT NULL THEN
      EXECUTE 'SELECT EXISTS(SELECT 1 FROM recycle_bin_entries r WHERE r.source_schema=$1 AND r.source_table=$2
        AND r.restored_at IS NULL AND $3 @> r.row_data AND r.row_data->>''id''=$3->>''id'')'
        INTO v_restore USING TG_TABLE_SCHEMA,TG_TABLE_NAME,v_row;
      IF v_restore THEN RETURN NEW; END IF;
    END IF;

    v_maker:=NULLIF(v_row->>'created_by','')::integer;
    IF v_maker IS NULL THEN
      -- A noncash legacy import may lack a maker. Never invent custody for it.
      IF NEW.loyalty_vault_holder_type IS NOT NULL OR NEW.loyalty_vault_holder_id IS NOT NULL THEN
        RAISE EXCEPTION 'A cash collector must be the signed-in transaction maker.'
          USING ERRCODE='23514',CONSTRAINT='cash_wallet_collector_locked';
      END IF;
      RETURN NEW;
    END IF;
    IF (NEW.loyalty_vault_holder_type IS NOT NULL OR NEW.loyalty_vault_holder_id IS NOT NULL)
      AND (NEW.loyalty_vault_holder_type IS DISTINCT FROM 'user' OR NEW.loyalty_vault_holder_id IS DISTINCT FROM v_maker) THEN
      RAISE EXCEPTION 'Cash collected by is locked to the transaction maker. Use a wallet transfer to hand over cash.'
        USING ERRCODE='23514',CONSTRAINT='cash_wallet_collector_locked';
    END IF;
    -- Omitted custody keeps the existing receipt reconciler's creator/cutover
    -- fallback. Do not turn historical imports, noncash or business debits
    -- into newly explicit assignments merely because they are inserted now.
    IF NEW.loyalty_vault_holder_type IS NULL AND NEW.loyalty_vault_holder_id IS NULL THEN RETURN NEW; END IF;
    NEW.loyalty_vault_assigned_by:=v_maker;
    RETURN NEW;
  END $$;
`;

export async function up(database = pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('211_locked_cash_collector'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query(lockedCashCollectorSql);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) {
      if (!(await db.query('SELECT to_regclass($1) AS name',[table])).rows[0]?.name) continue;
      // Trigger names are alphabetical: normalize/lock before site/assignment
      // validation and before deferred reconciliation sees a new source.
      await db.query(`DROP TRIGGER IF EXISTS cash_wallet_collector_lock ON ${table};
        CREATE TRIGGER cash_wallet_collector_lock BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION cash_wallet_lock_source_collector();`);
    }
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('211_locked_cash_collector') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Migration 211: Cash collection locked to the transaction maker'))
    .catch(error=>{console.error('Migration 211 failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
