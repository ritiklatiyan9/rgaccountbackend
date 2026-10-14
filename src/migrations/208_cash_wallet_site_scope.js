import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { cashWalletReconciliationSql } from './203_unified_cash_wallet.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../services/loyaltyVaultContext.service.js';

// A receipt moved between sites must reverse its old site's custody and post
// to its new site, even if its holder and amount stay the same. Keep global
// caches and all old immutable history; no historical row is relabelled here.
export const cashWalletSiteReconciliationSql = cashWalletReconciliationSql
  .replace('v_old.holder_key IS DISTINCT FROM v_key OR v_amount=0',
    'v_old.holder_key IS DISTINCT FROM v_key OR v_old.site_id IS DISTINCT FROM v_site OR v_amount=0')
  .replace('v_old.holder_key IS NOT DISTINCT FROM v_key AND v_old.posted_amount<>0',
    'v_old.holder_key IS NOT DISTINCT FROM v_key AND v_old.site_id IS NOT DISTINCT FROM v_site AND v_old.posted_amount<>0');

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('208_cash_wallet_site_scope'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    // Older repeatable startup migrations reinstall their own reconciliation
    // definition, so reinstall the corrected definition after them each time.
    await db.query(cashWalletSiteReconciliationSql);
    await db.query(`CREATE OR REPLACE FUNCTION cash_wallet_guard_holder_site() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE v_site integer; v_holder integer;
      BEGIN
        IF NEW.loyalty_vault_holder_type IS DISTINCT FROM 'user' THEN RETURN NEW; END IF;
        v_site:=loyalty_vault_source_site(TG_TABLE_NAME,to_jsonb(NEW));
        IF TG_OP='UPDATE' AND NEW.loyalty_vault_holder_type IS NOT DISTINCT FROM OLD.loyalty_vault_holder_type
          AND NEW.loyalty_vault_holder_id IS NOT DISTINCT FROM OLD.loyalty_vault_holder_id
          AND v_site IS NOT DISTINCT FROM loyalty_vault_source_site(TG_TABLE_NAME,to_jsonb(OLD)) THEN RETURN NEW; END IF;
        v_holder:=NEW.loyalty_vault_holder_id;
        IF EXISTS(SELECT 1 FROM users WHERE id=v_holder AND role='sub_admin')
          AND NOT EXISTS(SELECT 1 FROM user_sites WHERE user_id=v_holder AND site_id=v_site) THEN
          RAISE EXCEPTION 'Choose a cash holder assigned to this transaction site'
            USING ERRCODE='23514',CONSTRAINT='cash_wallet_holder_site';
        END IF;
        RETURN NEW;
      END $$;`);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) {
      const {rows}=await db.query('SELECT to_regclass($1) AS name',[table]);
      if(!rows[0]?.name) continue;
      await db.query(`DROP TRIGGER IF EXISTS cash_wallet_holder_site ON ${table};
        CREATE TRIGGER cash_wallet_holder_site BEFORE INSERT OR UPDATE ON ${table}
        FOR EACH ROW EXECUTE FUNCTION cash_wallet_guard_holder_site();`);
    }
    await db.query(`CREATE INDEX IF NOT EXISTS cash_wallet_site_holder_balance
      ON loyalty_vault_entries(organization_id,site_id,holder_key,id) INCLUDE(amount,created_at);
      CREATE INDEX IF NOT EXISTS cash_wallet_site_pending_holds
      ON loyalty_vault_transfers(organization_id,site_id,from_holder_type,from_holder_id) INCLUDE(amount) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS cash_wallet_site_pending_inbox
      ON loyalty_vault_transfers(organization_id,site_id,recipient_id,created_at DESC,id DESC) WHERE status='pending';
      INSERT INTO app_schema_migrations(version) VALUES('208_cash_wallet_site_scope') ON CONFLICT DO NOTHING;`);
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 208: Cash Wallet site scope ready'))
    .catch(error => { console.error('Migration 208 failed:',error.message);process.exitCode=1; }).finally(() => pool.end());
}
