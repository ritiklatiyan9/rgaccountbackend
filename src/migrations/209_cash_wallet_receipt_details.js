import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { cashWalletSiteReconciliationSql } from './208_cash_wallet_site_scope.js';

// Keep the module's own narration with every immutable wallet movement. In
// particular, expenses use singular `remark`, while plot receipts use
// `narration`; a generic Cash Flow label loses that useful source context.
// Receipt signs, collector selection, cutover and posting policy stay shared
// with the existing site-scoped cash reconciliation.
export const cashWalletReceiptDetailsSql = cashWalletSiteReconciliationSql
  .replace("v_description:=COALESCE(NULLIF(v_entry->>'particular',''),'Assigned transaction');", `v_description:=COALESCE(
            NULLIF(TRIM(v_source->>'description'),''),NULLIF(TRIM(v_source->>'particular'),''),
            NULLIF(TRIM(v_source->>'narration'),''),NULLIF(TRIM(v_source->>'remarks'),''),
            NULLIF(TRIM(v_source->>'remark'),''),NULLIF(TRIM(v_source->>'note'),''),
            NULLIF(TRIM(v_entry->>'particular'),''),'Cash receipt');`)
  .replace("'reference',COALESCE(v_source->>'reference_no'", "'source_description',v_description,'category',v_source->>'category','sub_category',v_source->>'sub_category',\n            'party_name',COALESCE(v_source->>'party_name',v_source->>'from_entity',v_source->>'to_entity'),'payment_from',v_source->>'payment_from',\n            'reference',COALESCE(v_source->>'reference_no'")
  .replace("'remarks',COALESCE(v_source->>'remarks',v_source->>'note',v_entry->>'remarks')", "'remarks',COALESCE(NULLIF(v_source->>'remarks',''),NULLIF(v_source->>'remark',''),NULLIF(v_source->>'narration',''),NULLIF(v_source->>'note',''),v_entry->>'remarks')")
  .replace('IF v_old.cash_flow_entry_id IS NULL AND v_amount=0 THEN RETURN; END IF;', `IF v_entry IS NULL AND v_old.cash_flow_entry_id IS NOT NULL THEN
          SELECT description,details INTO v_description,v_details FROM loyalty_vault_entries
            WHERE cash_flow_entry_id=p_id ORDER BY id DESC LIMIT 1;
          v_details:=COALESCE(v_details,'{}'::jsonb)||jsonb_build_object('source_deleted',true);
        END IF;
        IF v_old.cash_flow_entry_id IS NULL AND v_amount=0 THEN RETURN; END IF;`);

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('209_cash_wallet_receipt_details'))");
    await db.query("SET LOCAL lock_timeout='5s'");
    // Earlier startup migrations restore their definitions, so reinstall on
    // every run. Historical finance and immutable wallet rows are untouched.
    await db.query(cashWalletReceiptDetailsSql);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('209_cash_wallet_receipt_details') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 209: Cash Wallet source receipt details ready'))
    .catch(error => { console.error('Migration 209 failed:',error.message);process.exitCode=1; }).finally(() => pool.end());
}
