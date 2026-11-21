import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {walletBalanceGuardsSql} from '../../src/migrations/210_wallet_balance_guards.js';
import {walletSiteProjectionSql} from '../../src/migrations/234_wallet_site_projection.js';
import {cashWalletReconciliationSql} from '../../src/migrations/203_unified_cash_wallet.js';
import {up} from '../../src/migrations/240_quick_personal_ledger_transfers.js';

export async function installFunding(db) {
 await db.query(`CREATE TABLE members(id integer PRIMARY KEY,full_name text);
  CREATE TABLE loyalty_vault_accounts(holder_key text PRIMARY KEY,organization_id integer,holder_type text,holder_id integer,balance numeric(15,2) DEFAULT 0,reserved_balance numeric DEFAULT 0,updated_at timestamptz);
  CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id integer,holder_key text,holder_type text,holder_id integer,amount numeric(15,2),balance_after numeric(15,2),kind text,
   description text,source_table text,source_id integer,cash_flow_entry_id integer,site_id integer,actor_id integer,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
  CREATE TABLE imprest_ledger(id serial PRIMARY KEY,user_id integer,type text,reference_id integer,amount numeric(15,2),balance_after numeric(15,2),remarks text,created_by integer,site_id integer,source_module text,proof_key text,created_at timestamptz DEFAULT now());
  CREATE UNIQUE INDEX imprest_source ON imprest_ledger(user_id,site_id,source_module,reference_id,type) WHERE source_module IS NOT NULL;
  CREATE TABLE imprest_debit_reservations(source_module text,reference_id integer,user_id integer,site_id integer,amount numeric(15,2),remarks text,proof_key text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),PRIMARY KEY(source_module,reference_id));
  CREATE TABLE imprest_allocations(id serial PRIMARY KEY,site_id integer,amount numeric(15,2),status text,from_own_float boolean,created_at timestamptz DEFAULT now());
  CREATE TABLE imprest_site_debit_reservations(site_id integer,amount numeric(15,2));
  CREATE FUNCTION imprest_financial_site_cash(p_site integer) RETURNS numeric LANGUAGE sql AS $$
   SELECT COALESCE((SELECT sum(credit-debit) FROM ledger_entries WHERE site_id=p_site AND bucket='cash'),0)
    -COALESCE((SELECT sum(amount) FROM imprest_ledger WHERE site_id=p_site),0)
    -COALESCE((SELECT sum(amount) FROM imprest_site_debit_reservations WHERE site_id=p_site),0) $$;`);
 await db.query(walletBalanceGuardsSql);await db.query(walletSiteProjectionSql);
 // Install the actual production staff reconciler and running balances without
 // migration125's unrelated application tables and historical backfill.
 const sql=await readFile(new URL('../../src/migrations/125_universal_imprest_enforcement.js',import.meta.url),'utf8');
 for(const name of ['refresh_imprest_balance_snapshots','reconcile_imprest_debit','reconcile_direct_cashflow_imprest']) {
  const start=sql.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`),end=sql.indexOf('$$',sql.indexOf('AS $$',start)+5)+2;
  assert.ok(start>=0&&end>start);
  await db.query(sql.slice(start,end).replace('FUNCTION reconcile_imprest_debit(','FUNCTION reconcile_staff_imprest_debit('));
 }
 await db.query(`CREATE FUNCTION reconcile_imprest_debit(text,integer,integer,integer,numeric,boolean,boolean,text DEFAULT NULL,text DEFAULT NULL) RETURNS void LANGUAGE sql AS $$
  SELECT reconcile_staff_imprest_debit($1,$2,$3,$4,$5,$6,$7,$8,$9) $$;
  CREATE TABLE firm_transactions(id integer,cash_flow_entry_id integer);
  CREATE TABLE loyalty_vault_sources(cash_flow_entry_id integer PRIMARY KEY,holder_key text,posted_amount numeric(15,2),organization_id integer,source_table text,source_id integer,site_id integer,updated_at timestamptz);
  CREATE TABLE loyalty_vault_settings(singleton boolean PRIMARY KEY,consolidated_at timestamptz);
  INSERT INTO loyalty_vault_settings VALUES(true,now());
  CREATE TABLE wallet_sources(cash_flow_entry_id integer,user_id integer);
  CREATE FUNCTION loyalty_vault_source_site(text,jsonb) RETURNS integer LANGUAGE sql AS $$ SELECT ($2->>'site_id')::integer $$;`);
 await db.query(cashWalletReconciliationSql);
 await up(db);await up(db);
}
