import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { cashWalletReconciliationSql } from './203_unified_cash_wallet.js';

// Staff continue using their existing source-qualified imprest ledger. Admins
// use the same site cash shown by /imprest/balance, without a personal float.
// Pending Admin cash spending needs its own hold so it cannot also fund a
// second expense or a staff handover while waiting for approval.
export const siteCashDebitSql = `
CREATE TABLE IF NOT EXISTS imprest_site_debit_reservations (
  source_module TEXT NOT NULL, reference_id INTEGER NOT NULL,
  site_id INTEGER NOT NULL REFERENCES sites(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount NUMERIC(15,2) NOT NULL CHECK (amount>0 AND amount<>'NaN'::numeric),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(source_module,reference_id)
);
CREATE INDEX IF NOT EXISTS imprest_site_debit_reservations_site
  ON imprest_site_debit_reservations(site_id);

CREATE OR REPLACE FUNCTION imprest_available_site_cash(p_site integer, p_exclude_pending integer DEFAULT NULL)
RETURNS numeric LANGUAGE sql VOLATILE AS $$
  WITH cutoff AS (SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date+1) AS day_end),
  cash AS (SELECT COALESCE(SUM(credit-debit),0) AS amount FROM ledger_entries,cutoff
    WHERE site_id=p_site AND bucket='cash' AND entry_date<day_end),
  holders AS (SELECT il.user_id,SUM(il.amount) AS amount FROM imprest_ledger il
    JOIN users u ON u.id=il.user_id CROSS JOIN cutoff
    WHERE il.site_id=p_site AND LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin')
      AND il.created_at<day_end GROUP BY il.user_id),
  pending AS (SELECT COALESCE(SUM(ia.amount),0) AS amount FROM imprest_allocations ia,cutoff
    WHERE ia.site_id=p_site AND ia.status='PENDING_RECEIPT' AND ia.from_own_float=false
      AND ia.created_at<day_end AND ia.id IS DISTINCT FROM p_exclude_pending),
  spending AS (SELECT COALESCE(SUM(amount),0) AS amount FROM imprest_site_debit_reservations WHERE site_id=p_site)
  SELECT cash.amount-COALESCE((SELECT SUM(GREATEST(amount,0)) FROM holders),0)-pending.amount-spending.amount
  FROM cash,pending,spending
$$;

CREATE OR REPLACE FUNCTION reconcile_site_cash_debit(
  p_source_module TEXT,p_reference_id INTEGER,p_user_id INTEGER,p_site_id INTEGER,
  p_amount NUMERIC,p_active BOOLEAN,p_posted BOOLEAN
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE required NUMERIC(15,2):=CASE WHEN p_active THEN ROUND(GREATEST(COALESCE(p_amount,0),0),2) ELSE 0 END;
  owner_role TEXT; available NUMERIC; own_hold NUMERIC; own_posted NUMERIC; source_table TEXT;
BEGIN
  SELECT LOWER(role) INTO owner_role FROM users WHERE id=p_user_id;
  IF owner_role NOT IN ('admin','super_admin') OR owner_role IS NULL THEN required:=0; END IF;
  IF required<=0 THEN
    DELETE FROM imprest_site_debit_reservations WHERE source_module=p_source_module AND reference_id=p_reference_id;
    RETURN;
  END IF;
  SELECT COALESCE(SUM(amount),0) INTO own_hold FROM imprest_site_debit_reservations
    WHERE source_module=p_source_module AND reference_id=p_reference_id AND site_id=p_site_id;
  source_table:=CASE p_source_module
    WHEN 'expense' THEN 'expenses' WHEN 'farmer_payment' THEN 'farmer_payments'
    WHEN 'plot_commission' THEN 'plot_commissions' WHEN 'plot_commission_payment' THEN 'plot_commission_payments'
    WHEN 'vendor_payment' THEN 'vendor_payments' WHEN 'vendor_inventory_payment' THEN 'vendor_inventory_payments'
    WHEN 'firm_transaction' THEN 'firm_transactions' WHEN 'misc_income_entry' THEN 'misc_income_entries'
    WHEN 'plot_payment' THEN 'plot_payments' WHEN 'plot_installment_payment' THEN 'plot_installment_payments'
    WHEN 'land_deal_payment' THEN 'land_deal_payments' WHEN 'partner_profit_payment' THEN 'partner_profit_payments'
    WHEN 'daybook' THEN 'day_book' END;
  -- Source posting triggers have already projected the proposed transaction.
  -- Add back only its currently posted cash outflow, and its own pending hold,
  -- before validating the desired amount. Edits and approvals charge a delta;
  -- every other source's posted spend/reservation remains unavailable.
  SELECT COALESCE(SUM(GREATEST(le.debit,0)+GREATEST(-le.credit,0)),0) INTO own_posted
    FROM ledger_entries le
    WHERE le.site_id=p_site_id AND le.bucket='cash'
      AND le.entry_date<((now() AT TIME ZONE 'Asia/Kolkata')::date+1)
      AND ((le.source_key=source_table AND le.source_id=p_reference_id)
        OR (p_source_module='cash_flow_entry' AND le.id=p_reference_id::text)
        OR (p_source_module='firm_transaction' AND le.id IN (
          SELECT cash_flow_entry_id::text FROM firm_transactions WHERE id=p_reference_id)));
  available:=imprest_available_site_cash(p_site_id)+own_hold+own_posted;
  IF available+0.005<required THEN
    RAISE EXCEPTION USING ERRCODE='P0001',CONSTRAINT='imprest_site_cash_funding',
      MESSAGE=format('Insufficient site cash for this cash debit. Available: ₹%s, required: ₹%s. Add site cash before recording this expense.',
        to_char(available,'FM999999999990.00'),to_char(required,'FM999999999990.00')),
      DETAIL=jsonb_build_object('available',available,'required',required,'shortfall',ROUND(required-GREATEST(available,0),2),
        'user_id',p_user_id,'site_id',p_site_id,'source_module',p_source_module,'reference_id',p_reference_id)::text;
  END IF;
  IF p_posted THEN
    DELETE FROM imprest_site_debit_reservations WHERE source_module=p_source_module AND reference_id=p_reference_id;
  ELSE
    INSERT INTO imprest_site_debit_reservations(source_module,reference_id,site_id,user_id,amount)
      VALUES(p_source_module,p_reference_id,p_site_id,p_user_id,required)
      ON CONFLICT(source_module,reference_id) DO UPDATE SET site_id=EXCLUDED.site_id,user_id=EXCLUDED.user_id,
        amount=EXCLUDED.amount,updated_at=now();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION reconcile_imprest_debit(
  p_source_module TEXT,p_reference_id INTEGER,p_user_id INTEGER,p_site_id INTEGER,p_amount NUMERIC,
  p_active BOOLEAN,p_posted BOOLEAN,p_remarks TEXT DEFAULT NULL,p_proof_key TEXT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE lock_site INTEGER;
BEGIN
  -- Match allocation/transfer lock ordering: site custody before user float.
  -- Also lock the old site when a pending debit is moved, deleted or reassigned.
  FOR lock_site IN SELECT DISTINCT site_id FROM (
    SELECT r.site_id FROM imprest_site_debit_reservations r
      WHERE r.source_module=p_source_module AND r.reference_id=p_reference_id
    UNION ALL SELECT p_site_id WHERE p_site_id IS NOT NULL AND p_active AND p_amount>0
      AND EXISTS(SELECT 1 FROM users WHERE id=p_user_id AND LOWER(role) IN ('admin','super_admin'))
  ) locked ORDER BY site_id LOOP
    PERFORM pg_advisory_xact_lock(hashtext('imprest-site-'||lock_site::text));
  END LOOP;
  PERFORM reconcile_staff_imprest_debit(p_source_module,p_reference_id,p_user_id,p_site_id,p_amount,p_active,p_posted,p_remarks,p_proof_key);
  PERFORM reconcile_site_cash_debit(p_source_module,p_reference_id,p_user_id,p_site_id,p_amount,p_active,p_posted);
END $$;

CREATE OR REPLACE FUNCTION sync_additional_imprest_debits() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source JSONB:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  source_module TEXT; source_id INTEGER; site_id INTEGER; user_id INTEGER; amount NUMERIC; active BOOLEAN; mode TEXT;
BEGIN
  source_module:=CASE TG_TABLE_NAME WHEN 'land_deal_payments' THEN 'land_deal_payment'
    WHEN 'partner_profit_payments' THEN 'partner_profit_payment' ELSE 'plot_installment_payment' END;
  source_id:=(source->>'id')::integer;
  site_id:=loyalty_vault_source_site(TG_TABLE_NAME,source);
  user_id:=NULLIF(source->>'created_by','')::integer;
  amount:=CASE WHEN TG_TABLE_NAME IN ('plot_installment_payments','land_deal_payments')
    THEN GREATEST(-COALESCE((source->>'amount')::numeric,0),0)
    ELSE GREATEST(COALESCE((source->>'amount')::numeric,0),0) END;
  mode:=UPPER(TRIM(COALESCE(source->>'payment_mode','')));
  active:=TG_OP<>'DELETE' AND mode='CASH' AND amount>0
    AND NULLIF(source->>'entry_transfer_id','') IS NULL
    AND NULLIF(source->>'money_transfer_id','') IS NULL
    AND imprest_debit_is_active(source->>'status',source->>'cheque_status',source->>'deleted_at');
  PERFORM reconcile_imprest_debit(source_module,source_id,user_id,site_id,amount,active,
    active AND financial_transaction_posts('debit',source->>'status',mode,source->>'cheque_status'),
    COALESCE(source->>'remarks',source_module),source->>'voucher_url');
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;

CREATE OR REPLACE FUNCTION sync_farmer_cash_imprest() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source JSONB:=CASE WHEN TG_OP='DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END;
  v_source_id INTEGER; v_site_id INTEGER; v_user_id INTEGER; v_amount NUMERIC; v_active BOOLEAN; v_mode TEXT;
BEGIN
  v_source_id:=(source->>'id')::integer;
  v_site_id:=loyalty_vault_source_site('farmer_payments',source);
  v_user_id:=NULLIF(source->>'created_by','')::integer;
  IF v_site_id IS NULL OR v_user_id IS NULL THEN
    SELECT COALESCE(v_site_id,c.site_id),COALESCE(v_user_id,c.created_by) INTO v_site_id,v_user_id
      FROM cash_flow_entries c WHERE c.source_module='farmer_payments' AND c.source_id=v_source_id ORDER BY c.id LIMIT 1;
  END IF;
  v_mode:=UPPER(TRIM(COALESCE(source->>'payment_mode','')));
  v_amount:=GREATEST(COALESCE((CASE WHEN v_mode='SPLIT' THEN source->>'cash_amount' ELSE source->>'amount' END)::numeric,0),0);
  v_active:=TG_OP<>'DELETE' AND v_mode IN ('CASH','SPLIT') AND v_amount>0
    AND NULLIF(source->>'entry_transfer_id','') IS NULL
    AND imprest_debit_is_active(source->>'status',source->>'cheque_status',source->>'deleted_at');
  PERFORM reconcile_imprest_debit('farmer_payment',v_source_id,v_user_id,v_site_id,v_amount,v_active,
    v_active AND financial_transaction_posts('debit',source->>'status','CASH',source->>'cheque_status'),
    COALESCE(source->>'remarks','FARMER PAYMENT'),source->>'voucher_url');
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $$;
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('207_credit_wallet_imprest_debits'))");
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query('LOCK TABLE cash_flow_entries,loyalty_vault_accounts,loyalty_vault_sources IN SHARE ROW EXCLUSIVE MODE');
    // Preserve the canonical staff reconciler under a stable internal name.
    // Migration 125 may reinstall it during startup; rerunning this migration
    // then wraps that implementation again instead of wrapping itself.
    const { rows: [definition] } = await db.query(`SELECT pg_get_functiondef(
      'reconcile_imprest_debit(text,integer,integer,integer,numeric,boolean,boolean,text,text)'::regprocedure) AS sql`);
    if (!definition.sql.includes('PERFORM reconcile_staff_imprest_debit(')) {
      await db.query(definition.sql.replace(/(FUNCTION\s+(?:[\w]+\.)?)reconcile_imprest_debit\(/i, '$1reconcile_staff_imprest_debit('));
    }
    await db.query(siteCashDebitSql);
    await db.query('DROP TRIGGER IF EXISTS trg_zz_universal_imprest_farmer_payments ON farmer_payments');
    await db.query(`CREATE TRIGGER trg_zz_universal_imprest_farmer_payments AFTER INSERT OR UPDATE OR DELETE ON farmer_payments
      FOR EACH ROW EXECUTE FUNCTION sync_farmer_cash_imprest()`);
    for (const table of ['land_deal_payments', 'partner_profit_payments', 'plot_installment_payments']) {
      if ((await db.query('SELECT to_regclass($1) AS relation', [table])).rows[0].relation) {
        await db.query(`DROP TRIGGER IF EXISTS trg_zz_universal_imprest_${table} ON ${table}`);
        await db.query(`CREATE TRIGGER trg_zz_universal_imprest_${table} AFTER INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION sync_additional_imprest_debits()`);
      }
    }
    await db.query(cashWalletReconciliationSql);
    // An older migration in the startup chain can release generated SPLIT
    // debits. Reapply only previously-owned sources, never untracked history.
    const { rows: splitOwners } = await db.query(`SELECT f.id,
      COALESCE(f.created_by,(SELECT created_by FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=f.id ORDER BY id LIMIT 1)) AS created_by,
      COALESCE(NULLIF(to_jsonb(f)->>'site_id','')::integer,farmer.site_id,
        (SELECT site_id FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=f.id ORDER BY id LIMIT 1)) AS site_id,
      f.cash_amount,f.status,f.cheque_status,to_jsonb(f)->>'deleted_at' AS deleted_at
      FROM farmer_payments f LEFT JOIN farmers farmer ON farmer.id=f.farmer_id
      WHERE UPPER(TRIM(f.payment_mode))='SPLIT' AND f.cash_amount>0
        AND NULLIF(to_jsonb(f)->>'entry_transfer_id','') IS NULL
        AND (EXISTS(SELECT 1 FROM imprest_ledger il WHERE il.source_module='farmer_payment' AND il.reference_id=f.id)
          OR EXISTS(SELECT 1 FROM imprest_debit_reservations r WHERE r.source_module='farmer_payment' AND r.reference_id=f.id)
          OR EXISTS(SELECT 1 FROM imprest_site_debit_reservations r WHERE r.source_module='farmer_payment' AND r.reference_id=f.id))`);
    for (const source of splitOwners) await db.query(`SELECT reconcile_imprest_debit('farmer_payment',$1,$2,$3,$4,
      imprest_debit_is_active($5,$6,$7),imprest_debit_is_active($5,$6,$7) AND financial_transaction_posts('debit',$5,'CASH',$6),'FARMER CASH COMPONENT',NULL)`,
    [source.id,source.created_by,source.site_id,source.cash_amount,source.status,source.cheque_status,source.deleted_at]);
    const applied = (await db.query("SELECT 1 FROM app_schema_migrations WHERE version='207_credit_wallet_imprest_debits'")).rows.length>0;
    if (!applied) {
      // Restore only already-tracked business outflows. Immutable original
      // wallet history and all source financial rows remain untouched.
      const { rows } = await db.query(`SELECT s.cash_flow_entry_id FROM loyalty_vault_sources s
        LEFT JOIN cash_flow_entries c ON c.id=s.cash_flow_entry_id
        WHERE s.posted_amount<0 OR c.debit>0 OR c.credit<0
          OR (c.source_module='farmer_payments' AND EXISTS(SELECT 1 FROM farmer_payments f
            WHERE f.id=c.source_id AND UPPER(TRIM(f.payment_mode))='SPLIT' AND f.cash_amount>0))
        ORDER BY s.cash_flow_entry_id`);
      for (const row of rows) await db.query('SELECT reconcile_loyalty_vault_entry($1)', [row.cash_flow_entry_id]);
      await db.query("INSERT INTO app_schema_migrations(version) VALUES('207_credit_wallet_imprest_debits')");
    }
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  up().then(()=>console.log('Migration 207: cash credits use wallets; cash spending uses imprest'))
    .catch(error=>{console.error('Migration 207 failed:',error.message);process.exitCode=1;}).finally(()=>pool.end());
}
