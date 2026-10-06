import { pathToFileURL } from 'node:url';

// Installs protection only. Existing financial rows are intentionally preserved.
export async function up(pool) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('195_imprest_cash_funding_guard'))");
    await db.query(`CREATE OR REPLACE FUNCTION imprest_available_site_cash(p_site integer, p_exclude_pending integer DEFAULT NULL)
      RETURNS numeric LANGUAGE sql VOLATILE AS $$
      WITH cutoff AS (SELECT ((now() AT TIME ZONE 'Asia/Kolkata')::date + 1) AS day_end),
      cash AS (SELECT COALESCE(SUM(credit-debit),0) AS amount FROM ledger_entries,cutoff
        WHERE site_id=p_site AND bucket='cash' AND entry_date < day_end),
      holders AS (SELECT il.user_id,SUM(il.amount) AS amount FROM imprest_ledger il
        JOIN users u ON u.id=il.user_id CROSS JOIN cutoff
        WHERE il.site_id=p_site AND LOWER(COALESCE(u.role,'')) NOT IN ('admin','super_admin')
          AND il.created_at < day_end GROUP BY il.user_id),
      pending AS (SELECT COALESCE(SUM(ia.amount),0) AS amount FROM imprest_allocations ia,cutoff
        WHERE ia.site_id=p_site AND ia.status='PENDING_RECEIPT' AND ia.from_own_float=false
          AND ia.created_at < day_end AND ia.id IS DISTINCT FROM p_exclude_pending)
      SELECT cash.amount - COALESCE((SELECT SUM(GREATEST(amount,0)) FROM holders),0) - pending.amount
      FROM cash,pending
      $$`);
    await db.query(`CREATE OR REPLACE FUNCTION require_imprest_site_cash(p_site integer, p_amount numeric, p_exclude_pending integer DEFAULT NULL)
      RETURNS void LANGUAGE plpgsql AS $$
      DECLARE available numeric;
      BEGIN
        IF p_site IS NULL OR p_amount IS NULL OR p_amount <= 0 THEN RETURN; END IF;
        PERFORM pg_advisory_xact_lock(hashtext('imprest-site-' || p_site::text));
        available := imprest_available_site_cash(p_site,p_exclude_pending);
        IF p_amount > available THEN
          RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='imprest_site_cash_funding',
            MESSAGE='Insufficient site cash. Record a cash receipt or accept a staff cash return before giving more imprest.',
            DETAIL=json_build_object('site_id',p_site,'available',available,'required',p_amount,
              'shortfall',p_amount-GREATEST(available,0))::text;
        END IF;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION guard_imprest_allocation_cash() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE giver_role text;
      BEGIN
        IF NEW.status NOT IN ('PENDING_RECEIPT','RECEIVED') OR NEW.amount <= 0 THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' THEN
          IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id AND NEW.admin_id=OLD.admin_id
            AND NEW.amount <= OLD.amount AND NEW.from_own_float IS NOT DISTINCT FROM OLD.from_own_float
            AND NEW.status=OLD.status THEN RETURN NEW; END IF;
        END IF;
        SELECT role INTO giver_role FROM users WHERE id=NEW.admin_id;
        IF giver_role IN ('admin','super_admin') THEN
          PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount,CASE WHEN TG_OP='UPDATE' THEN OLD.id ELSE NULL END);
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION guard_imprest_manual_credit_cash() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE owner_role text; creator_role text;
      BEGIN
        IF NEW.amount <= 0 OR NEW.type NOT IN ('ALLOCATION','ADJUSTMENT') THEN RETURN NEW; END IF;
        -- Source-owned restoring adjustments (expense deletion/edit) are reversals,
        -- not new handovers. Blocking them would corrupt the original accounting.
        IF NEW.type='ADJUSTMENT' AND NEW.source_module IS NOT NULL THEN RETURN NEW; END IF;
        SELECT role INTO owner_role FROM users WHERE id=NEW.user_id;
        SELECT role INTO creator_role FROM users WHERE id=NEW.created_by;
        IF owner_role IN ('admin','super_admin') OR creator_role NOT IN ('admin','super_admin') THEN RETURN NEW; END IF;
        IF TG_OP='UPDATE' THEN
          IF NEW.site_id IS NOT DISTINCT FROM OLD.site_id AND NEW.user_id=OLD.user_id
            AND NEW.type=OLD.type AND NEW.amount <= OLD.amount THEN RETURN NEW; END IF;
          PERFORM require_imprest_site_cash(NEW.site_id,CASE
            WHEN NEW.site_id IS NOT DISTINCT FROM OLD.site_id AND NEW.user_id=OLD.user_id AND NEW.type=OLD.type
            THEN GREATEST(NEW.amount-GREATEST(OLD.amount,0),0) ELSE NEW.amount END);
        ELSE
          PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount);
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION guard_imprest_transfer_cash() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE source_role text;
      BEGIN
        SELECT role INTO source_role FROM users WHERE id=NEW.from_user_id;
        IF source_role IN ('admin','super_admin') THEN
          PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount);
        END IF;
        RETURN NEW;
      END $$`);
    await db.query(`CREATE OR REPLACE FUNCTION guard_imprest_refill_request_cash() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE reviewer_role text;
      BEGIN
        IF NEW.request_type IS DISTINCT FROM 'IMPREST' OR NEW.status <> 'PENDING' THEN RETURN NEW; END IF;
        SELECT role INTO reviewer_role FROM users WHERE id=NEW.assigned_admin_id;
        IF reviewer_role IS DISTINCT FROM 'sub_admin' THEN
          PERFORM require_imprest_site_cash(NEW.site_id,NEW.amount);
        END IF;
        RETURN NEW;
      END $$`);
    for (const [table, name, fn, events] of [
      ['imprest_allocations','imprest_allocation_cash_guard','guard_imprest_allocation_cash','INSERT OR UPDATE'],
      ['imprest_ledger','imprest_manual_credit_cash_guard','guard_imprest_manual_credit_cash','INSERT OR UPDATE'],
      ['imprest_transfers','imprest_transfer_cash_guard','guard_imprest_transfer_cash','INSERT'],
      ['imprest_expense_requests','imprest_refill_request_cash_guard','guard_imprest_refill_request_cash','INSERT'],
    ]) {
      await db.query(`DROP TRIGGER IF EXISTS ${name} ON ${table}`);
      await db.query(`CREATE TRIGGER ${name} BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
    }
    await db.query("INSERT INTO app_schema_migrations(version) VALUES('195_imprest_cash_funding_guard') ON CONFLICT DO NOTHING");
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { db.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pool } = await import('../config/db.js');
  try { await up(pool); console.log('Imprest cash funding guard installed; existing financial records preserved.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
