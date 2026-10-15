import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Pending handovers are requests only. Existing postings and historical
// deficits remain intact; new debits must be funded in the selected site.
export const walletBalanceGuardsSql = `
  CREATE OR REPLACE FUNCTION loyalty_vault_apply_delta(p_key TEXT,p_org INTEGER,p_amount NUMERIC,p_kind TEXT,p_description TEXT,
    p_table TEXT DEFAULT NULL,p_source_id INTEGER DEFAULT NULL,p_cash_id INTEGER DEFAULT NULL,p_site INTEGER DEFAULT NULL,
    p_actor INTEGER DEFAULT NULL,p_transfer UUID DEFAULT NULL,p_details JSONB DEFAULT '{}') RETURNS NUMERIC LANGUAGE plpgsql AS $$
  DECLARE v_balance NUMERIC(15,2); v_site_balance NUMERIC; v_type TEXT:=split_part(p_key,':',1);
    v_id INTEGER:=split_part(p_key,':',2)::integer; v_name TEXT;
  BEGIN
    IF p_amount IS NULL OR p_amount=0 THEN
      SELECT balance INTO v_balance FROM loyalty_vault_accounts WHERE holder_key=p_key AND organization_id=p_org;
      RETURN COALESCE(v_balance,0);
    END IF;
    IF p_amount::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Wallet amounts must be finite' USING ERRCODE='23514';
    END IF;
    INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
      VALUES(p_key,p_org,v_type,v_id) ON CONFLICT DO NOTHING;
    -- Every receipt correction and transfer uses this same account lock. Read
    -- the site ledger only after taking it so competing debits cannot overspend.
    SELECT balance INTO v_balance FROM loyalty_vault_accounts
      WHERE holder_key=p_key AND organization_id=p_org FOR UPDATE;
    IF v_balance IS NULL THEN RAISE EXCEPTION 'Wallet organization mismatch' USING ERRCODE='23514'; END IF;
    IF p_amount<0 THEN
      SELECT COALESCE(sum(amount),0) INTO v_site_balance FROM loyalty_vault_entries
        WHERE holder_key=p_key AND organization_id=p_org AND site_id IS NOT DISTINCT FROM p_site;
      IF v_balance+p_amount<0 OR v_site_balance+p_amount<0 THEN
        RAISE EXCEPTION 'Insufficient cash wallet balance. Return transferred cash or restore funds before changing or removing this receipt.'
          USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_funds';
      END IF;
    END IF;
    -- Positive receipts may recover an existing historical deficit without
    -- inventing an opening balance or rewriting immutable movements.
    UPDATE loyalty_vault_accounts SET balance=balance+p_amount,reserved_balance=0,updated_at=now()
      WHERE holder_key=p_key AND organization_id=p_org RETURNING balance INTO v_balance;
    IF v_type='user' THEN SELECT name INTO v_name FROM users WHERE id=v_id;
    ELSE SELECT full_name INTO v_name FROM members WHERE id=v_id; END IF;
    INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,amount,balance_after,kind,description,
      source_table,source_id,cash_flow_entry_id,site_id,actor_id,transfer_id,details)
    VALUES(p_org,p_key,v_type,v_id,p_amount,v_balance,p_kind,p_description,p_table,p_source_id,p_cash_id,p_site,p_actor,p_transfer,
      COALESCE(p_details,'{}')||jsonb_build_object('holder_name',COALESCE(v_name,'Former holder')));
    RETURN v_balance;
  END $$;
  UPDATE loyalty_vault_accounts SET reserved_balance=0 WHERE reserved_balance<>0;
`;

export async function up(database = pool) {
  const db=await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('210_wallet_balance_guards'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    // Earlier repeatable migrations reinstall apply_delta; restore this final
    // definition on every startup, after those migrations complete.
    await db.query(walletBalanceGuardsSql);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('210_wallet_balance_guards') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch(error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Migration 210: unreserved cash handovers and wallet balance guards ready'))
    .catch(error=>{console.error('Migration 210 failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
