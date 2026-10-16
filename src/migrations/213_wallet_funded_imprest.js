import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const walletFundedImprestSql = `
  CREATE TABLE IF NOT EXISTS imprest_cash_wallet_settings (
    organization_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id)
  );
  -- The requested site cash custodian is the existing Kuldeep account. Other
  -- organizations with a single Admin can use that account without guessing.
  INSERT INTO imprest_cash_wallet_settings(organization_id,user_id)
    SELECT DISTINCT ON (u.organization_id) u.organization_id,u.id FROM users u
    WHERE u.role='admin' AND (lower(trim(u.name))='kuldeep tomar'
      OR (SELECT count(*) FROM users other WHERE other.organization_id=u.organization_id AND other.role='admin')=1)
    ORDER BY u.organization_id,CASE WHEN lower(trim(u.name))='kuldeep tomar' THEN 0 ELSE 1 END,u.id
    ON CONFLICT DO NOTHING;
  CREATE OR REPLACE FUNCTION imprest_site_wallet_holder(p_site INTEGER) RETURNS INTEGER
    LANGUAGE sql STABLE AS $$
    SELECT u.id FROM sites s JOIN imprest_cash_wallet_settings config ON config.organization_id=s.organization_id
      JOIN users u ON u.id=config.user_id AND u.organization_id=s.organization_id WHERE s.id=p_site
  $$;
  ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS wallet_funded BOOLEAN NOT NULL DEFAULT false;
  ALTER TABLE imprest_allocations ADD COLUMN IF NOT EXISTS wallet_holder_id INTEGER REFERENCES users(id);
  CREATE INDEX IF NOT EXISTS cash_wallet_imprest_source ON loyalty_vault_entries(source_table,source_id)
    WHERE source_table IN ('imprest_allocations','imprest_transfers','imprest_returns','imprest_ledger');

  -- The source row serializes decisions; the wallet account lock serializes
  -- these movements with wallet transfers and receipt corrections.
  CREATE OR REPLACE FUNCTION reconcile_imprest_wallet(
    p_table TEXT,p_id INTEGER,p_user INTEGER,p_site INTEGER,p_amount NUMERIC,
    p_actor INTEGER,p_description TEXT,p_counterparty INTEGER DEFAULT NULL,p_note TEXT DEFAULT NULL
  ) RETURNS VOID LANGUAGE plpgsql AS $$
  DECLARE v_org INTEGER; v_site_org INTEGER; v_posted NUMERIC; v_name TEXT;
  BEGIN
    IF p_amount IS NULL OR p_amount::text IN ('NaN','Infinity','-Infinity') THEN
      RAISE EXCEPTION 'Imprest amounts must be finite' USING ERRCODE='23514';
    END IF;
    SELECT organization_id INTO v_org FROM users WHERE id=p_user;
    SELECT organization_id INTO v_site_org FROM sites WHERE id=p_site;
    IF v_org IS NULL OR v_org IS DISTINCT FROM v_site_org
      OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND organization_id=v_org) THEN
      RAISE EXCEPTION 'Imprest wallet is outside this organization and site'
        USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope';
    END IF;
    INSERT INTO loyalty_vault_accounts(holder_key,organization_id,holder_type,holder_id)
      VALUES('user:'||p_user::text,v_org,'user',p_user) ON CONFLICT DO NOTHING;
    PERFORM holder_key FROM loyalty_vault_accounts WHERE holder_key='user:'||p_user::text
      AND organization_id=v_org FOR UPDATE;
    SELECT COALESCE(sum(amount),0) INTO v_posted FROM loyalty_vault_entries
      WHERE source_table=p_table AND source_id=p_id;
    IF EXISTS(SELECT 1 FROM loyalty_vault_entries WHERE source_table=p_table AND source_id=p_id
      AND (holder_key IS DISTINCT FROM 'user:'||p_user::text OR site_id IS DISTINCT FROM p_site)) THEN
      RAISE EXCEPTION 'A posted imprest handover cannot change wallet or site'
        USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope';
    END IF;
    IF v_posted=p_amount THEN RETURN; END IF;
    SELECT name INTO v_name FROM users WHERE id=p_counterparty;
    PERFORM loyalty_vault_apply_delta('user:'||p_user::text,v_org,p_amount-v_posted,
      CASE WHEN p_amount-v_posted<0 THEN 'debit' WHEN v_posted=0 THEN 'credit' ELSE 'reversal' END,p_description,
      p_table,p_id,NULL,p_site,p_actor,NULL,jsonb_build_object(
        'module_name','Imprest','source_description',p_description,'remarks',p_note,
        'counterparty_name',v_name,'counterparty_id',p_counterparty,'payment_mode','CASH',
        'transaction_date',(now() AT TIME ZONE 'Asia/Kolkata')::date));
  END $$;

  CREATE OR REPLACE FUNCTION sync_allocation_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_admin BOOLEAN; v_amount NUMERIC;
  BEGIN
    IF TG_OP='DELETE' THEN
      IF OLD.wallet_funded THEN
        PERFORM reconcile_imprest_wallet('imprest_allocations',OLD.id,OLD.wallet_holder_id,OLD.site_id,0,
          OLD.admin_id,'Imprest handover removed',OLD.sub_admin_id,OLD.remark);
      END IF;
      RETURN OLD;
    END IF;
    SELECT role='admin' INTO v_admin FROM users WHERE id=NEW.admin_id;
    IF TG_OP='INSERT' THEN
      NEW.wallet_funded:=COALESCE(v_admin,false) AND NOT COALESCE(NEW.from_own_float,false);
      NEW.wallet_holder_id:=CASE WHEN NEW.wallet_funded THEN imprest_site_wallet_holder(NEW.site_id) END;
    ELSE
      NEW.wallet_funded:=OLD.wallet_funded;
      NEW.wallet_holder_id:=OLD.wallet_holder_id;
      -- Historical completed handovers are preserved. An old pending handover
      -- must obtain wallet funding when it is accepted for the first time.
      IF NOT OLD.wallet_funded AND OLD.status='PENDING_RECEIPT' AND NEW.status='RECEIVED'
        AND COALESCE(v_admin,false) THEN
        NEW.wallet_funded:=true; NEW.wallet_holder_id:=imprest_site_wallet_holder(NEW.site_id);
      END IF;
      IF OLD.wallet_funded AND (NEW.admin_id IS DISTINCT FROM OLD.admin_id
        OR NEW.site_id IS DISTINCT FROM OLD.site_id OR NEW.sub_admin_id IS DISTINCT FROM OLD.sub_admin_id
        OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.from_own_float IS DISTINCT FROM OLD.from_own_float) THEN
        RAISE EXCEPTION 'Cancel the pending handover before changing its recipient or amount'
          USING ERRCODE='23514',CONSTRAINT='loyalty_vault_holder_scope';
      END IF;
    END IF;
    IF NEW.wallet_funded THEN
      v_amount:=CASE WHEN NEW.status IN ('PENDING_RECEIPT','RECEIVED') THEN -NEW.amount ELSE 0 END;
      PERFORM reconcile_imprest_wallet('imprest_allocations',NEW.id,NEW.wallet_holder_id,NEW.site_id,v_amount,
        NEW.admin_id,CASE WHEN v_amount<0 THEN 'Cash given as imprest' ELSE 'Imprest handover cancelled or declined' END,
        NEW.sub_admin_id,NEW.remark);
    ELSIF TG_OP='UPDATE' THEN
      IF OLD.status='PENDING_RECEIPT' AND NEW.status='RECEIVED'
        AND NOT COALESCE(v_admin,false)
        AND EXISTS(SELECT 1 FROM users WHERE id=NEW.sub_admin_id AND role='admin') THEN
        NEW.wallet_holder_id:=imprest_site_wallet_holder(NEW.site_id);
        PERFORM reconcile_imprest_wallet('imprest_allocations',NEW.id,NEW.wallet_holder_id,NEW.site_id,NEW.amount,
          NEW.sub_admin_id,'Staff imprest returned to Admin cash',NEW.admin_id,NEW.remark);
      END IF;
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS cash_wallet_imprest_allocation ON imprest_allocations;
  CREATE TRIGGER cash_wallet_imprest_allocation BEFORE INSERT OR UPDATE OR DELETE ON imprest_allocations
    FOR EACH ROW EXECUTE FUNCTION sync_allocation_wallet();

  CREATE OR REPLACE FUNCTION sync_other_imprest_wallet() RETURNS trigger LANGUAGE plpgsql AS $$
  DECLARE v_holder INTEGER:=imprest_site_wallet_holder(NEW.site_id); v_amount NUMERIC; v_counterparty INTEGER; v_actor INTEGER;
  BEGIN
    IF TG_TABLE_NAME='imprest_transfers' THEN
      v_actor:=NEW.initiated_by;
      IF EXISTS(SELECT 1 FROM users WHERE id=NEW.from_user_id AND role='admin') THEN
        v_amount:=-NEW.amount; v_counterparty:=NEW.to_user_id;
      ELSIF EXISTS(SELECT 1 FROM users WHERE id=NEW.to_user_id AND role='admin') THEN
        v_amount:=NEW.amount; v_counterparty:=NEW.from_user_id;
      END IF;
    ELSIF TG_TABLE_NAME='imprest_returns' THEN
      IF NEW.status='ACCEPTED' AND OLD.status='PENDING' AND UPPER(COALESCE(NEW.payment_mode,'CASH'))='CASH' THEN
        v_amount:=NEW.amount; v_counterparty:=NEW.sub_admin_id; v_actor:=NEW.reviewed_by;
      END IF;
    ELSIF TG_TABLE_NAME='imprest_ledger' THEN
      IF NEW.type='ADJUSTMENT' AND NEW.source_module IS NULL AND NEW.amount>0
        AND EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND role='admin')
        AND EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role='sub_admin') THEN
        v_amount:=-NEW.amount; v_counterparty:=NEW.user_id; v_actor:=NEW.created_by;
      END IF;
    END IF;
    IF v_amount IS NOT NULL THEN
      PERFORM reconcile_imprest_wallet(TG_TABLE_NAME,NEW.id,v_holder,NEW.site_id,v_amount,v_actor,
        CASE WHEN v_amount<0 THEN 'Cash given as imprest' ELSE 'Staff imprest returned to Admin cash' END,
        v_counterparty,COALESCE(to_jsonb(NEW)->>'remark',to_jsonb(NEW)->>'reason',to_jsonb(NEW)->>'remarks'));
    END IF;
    RETURN NEW;
  END $$;
  DROP TRIGGER IF EXISTS cash_wallet_imprest_transfer ON imprest_transfers;
  CREATE TRIGGER cash_wallet_imprest_transfer AFTER INSERT ON imprest_transfers
    FOR EACH ROW EXECUTE FUNCTION sync_other_imprest_wallet();
  DROP TRIGGER IF EXISTS cash_wallet_imprest_return ON imprest_returns;
  CREATE TRIGGER cash_wallet_imprest_return AFTER UPDATE ON imprest_returns
    FOR EACH ROW EXECUTE FUNCTION sync_other_imprest_wallet();
  DROP TRIGGER IF EXISTS cash_wallet_imprest_adjustment ON imprest_ledger;
  CREATE TRIGGER cash_wallet_imprest_adjustment AFTER INSERT ON imprest_ledger
    FOR EACH ROW EXECUTE FUNCTION sync_other_imprest_wallet();

  -- Older site funding guards must use custody cash as well. A funded
  -- allocation has already paid once, so its confirmation needs no new funds.
  CREATE OR REPLACE FUNCTION require_imprest_site_cash(p_site integer,p_amount numeric,p_exclude_pending integer DEFAULT NULL)
    RETURNS void LANGUAGE plpgsql AS $$
  DECLARE v_available NUMERIC;
  BEGIN
    IF p_site IS NULL OR p_amount IS NULL OR p_amount<=0 THEN RETURN; END IF;
    PERFORM pg_advisory_xact_lock(hashtext('imprest-site-'||p_site::text));
    SELECT COALESCE(sum(amount),0) INTO v_available FROM loyalty_vault_entries
      WHERE site_id=p_site AND holder_key='user:'||imprest_site_wallet_holder(p_site)::text;
    IF p_amount>v_available THEN
      RAISE EXCEPTION 'Insufficient Admin cash wallet balance to give imprest.'
        USING ERRCODE='23514',CONSTRAINT='imprest_site_cash_funding',
        DETAIL=jsonb_build_object('available',v_available,'required',p_amount,'site_id',p_site)::text;
    END IF;
  END $$;
  CREATE OR REPLACE FUNCTION guard_imprest_allocation_cash() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.wallet_funded THEN RETURN NEW; END IF;
    IF NEW.status IN ('PENDING_RECEIPT','RECEIVED') AND NEW.amount>0
      AND EXISTS(SELECT 1 FROM users WHERE id=NEW.admin_id AND role IN ('admin','super_admin')) THEN
      PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount);
    END IF;
    RETURN NEW;
  END $$;
  CREATE OR REPLACE FUNCTION guard_imprest_manual_credit_cash() RETURNS trigger LANGUAGE plpgsql AS $$
  BEGIN
    IF NEW.amount<=0 OR NEW.type NOT IN ('ALLOCATION','ADJUSTMENT') THEN RETURN NEW; END IF;
    IF NEW.source_module IS NOT NULL THEN RETURN NEW; END IF;
    IF NEW.type='ALLOCATION' AND EXISTS(SELECT 1 FROM imprest_allocations
      WHERE id=NEW.reference_id AND wallet_funded AND sub_admin_id=NEW.user_id AND site_id=NEW.site_id) THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role IN ('admin','super_admin')) THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM users WHERE id=NEW.created_by AND role IN ('admin','super_admin')) THEN
      IF TG_OP='UPDATE' THEN
        IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id AND NEW.user_id=OLD.user_id
          AND NEW.type=OLD.type AND NEW.amount<=OLD.amount THEN RETURN NEW; END IF;
      END IF;
      PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount);
    END IF;
    RETURN NEW;
  END $$;
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('213_wallet_funded_imprest'))");
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'");
    await db.query(walletFundedImprestSql);
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('213_wallet_funded_imprest') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Migration 213: admin imprest uses cash wallet funding'))
    .catch(error => { console.error('Migration 213 failed:', error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
