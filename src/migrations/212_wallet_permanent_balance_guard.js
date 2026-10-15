import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const permanentWalletGuardSql = `
  CREATE TABLE IF NOT EXISTS cash_wallet_voided_receipt_entries (
    original_entry_id BIGINT PRIMARY KEY,
    organization_id INTEGER NOT NULL, holder_key TEXT NOT NULL, site_id INTEGER NOT NULL,
    cash_flow_entry_id INTEGER NOT NULL UNIQUE, source_table TEXT NOT NULL, source_id INTEGER NOT NULL,
    retained_amount NUMERIC(15,2) NOT NULL CHECK(retained_amount>0),
    original_entry JSONB NOT NULL, reason TEXT NOT NULL, authorized_instruction TEXT NOT NULL,
    voided_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  DROP TRIGGER IF EXISTS cash_wallet_voided_receipt_immutable ON cash_wallet_voided_receipt_entries;
  CREATE TRIGGER cash_wallet_voided_receipt_immutable BEFORE UPDATE OR DELETE ON cash_wallet_voided_receipt_entries
    FOR EACH ROW EXECUTE FUNCTION loyalty_vault_guard_history();

  -- This trigger survives older repeatable migrations replacing apply_delta.
  -- It also guards direct ledger inserts, with the same account lock used by
  -- receipt reconciliation and transfer acceptance. No reservations change.
  CREATE OR REPLACE FUNCTION cash_wallet_guard_nonnegative_entry() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_global NUMERIC; v_site NUMERIC; v_cached NUMERIC; v_actual NUMERIC; v_posted NUMERIC;
    v_delta NUMERIC; v_original NUMERIC; v_void cash_wallet_voided_receipt_entries%ROWTYPE;
  BEGIN
    IF NEW.cash_flow_entry_id IS NOT NULL THEN
      SELECT * INTO v_void FROM cash_wallet_voided_receipt_entries WHERE cash_flow_entry_id=NEW.cash_flow_entry_id;
      IF FOUND THEN
        IF NEW.organization_id IS DISTINCT FROM v_void.organization_id OR NEW.site_id IS DISTINCT FROM v_void.site_id
          OR NEW.holder_key IS DISTINCT FROM v_void.holder_key OR NEW.source_table IS DISTINCT FROM v_void.source_table
          OR NEW.source_id IS DISTINCT FROM v_void.source_id OR NEW.kind NOT IN ('credit','debit','adjustment','reversal') THEN
          RAISE EXCEPTION 'This corrected cash receipt cannot be reassigned automatically. Use a wallet transfer.'
            USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds';
        END IF;
        SELECT balance INTO v_cached FROM loyalty_vault_accounts
          WHERE holder_key=NEW.holder_key AND organization_id=NEW.organization_id FOR UPDATE;
        SELECT COALESCE(sum(amount),0),COALESCE(sum(amount) FILTER(WHERE cash_flow_entry_id=NEW.cash_flow_entry_id),0)
          INTO v_global,v_actual FROM loyalty_vault_entries
          WHERE holder_key=NEW.holder_key AND organization_id=NEW.organization_id;
        -- apply_delta has already changed the account cache. Require that
        -- exact transactional shape before normalizing an archived source.
        IF v_cached IS DISTINCT FROM v_global+NEW.amount THEN
          RAISE EXCEPTION 'Post corrected receipt changes through the wallet reconciliation transaction.'
            USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds';
        END IF;
        SELECT posted_amount INTO v_posted FROM loyalty_vault_sources WHERE cash_flow_entry_id=NEW.cash_flow_entry_id;
        v_delta:=COALESCE(v_posted,0)+NEW.amount-v_actual;
        v_original:=NEW.amount;
        IF v_delta IS DISTINCT FROM NEW.amount THEN
          UPDATE loyalty_vault_accounts SET balance=balance+v_delta-NEW.amount,updated_at=now()
            WHERE holder_key=NEW.holder_key AND organization_id=NEW.organization_id;
          IF v_delta=0 THEN RETURN NULL; END IF;
          NEW.amount:=v_delta;NEW.balance_after:=v_cached+v_delta-v_original;NEW.kind:='adjustment';
          NEW.details:=NEW.details||jsonb_build_object('voided_entry_id',v_void.original_entry_id,
            'recorded_delta_before_correction',v_original);
        END IF;
      END IF;
    END IF;
    IF NEW.amount>=0 THEN RETURN NEW; END IF;
    PERFORM holder_key FROM loyalty_vault_accounts
      WHERE holder_key=NEW.holder_key AND organization_id=NEW.organization_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Wallet holder is outside this organization'
        USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope';
    END IF;
    SELECT COALESCE(sum(amount),0),COALESCE(sum(amount) FILTER(WHERE site_id IS NOT DISTINCT FROM NEW.site_id),0)
      INTO v_global,v_site FROM loyalty_vault_entries
      WHERE organization_id=NEW.organization_id AND holder_key=NEW.holder_key;
    IF v_global+NEW.amount<0 OR v_site+NEW.amount<0 THEN
      RAISE EXCEPTION 'Insufficient cash wallet balance. Return transferred cash or restore funds before changing or removing this receipt.'
        USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds';
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS cash_wallet_nonnegative_entry ON loyalty_vault_entries;
  CREATE TRIGGER cash_wallet_nonnegative_entry BEFORE INSERT ON loyalty_vault_entries
    FOR EACH ROW EXECUTE FUNCTION cash_wallet_guard_nonnegative_entry();
`;

export async function installPermanentWalletGuards(db) {
  await db.query(permanentWalletGuardSql);
  await db.query("INSERT INTO app_schema_migrations(version) VALUES('212_wallet_permanent_balance_guard') ON CONFLICT DO NOTHING");
}

export async function up(database = pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('212_wallet_permanent_balance_guard'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await installPermanentWalletGuards(db);
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Migration 212: permanent wallet balance protection ready'))
    .catch(error=>{console.error('Migration 212 failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
