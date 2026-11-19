import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '255_site_cash_receipts';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    if (!(await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length) {
      await db.query(`
        ALTER TABLE cash_flow_months ADD COLUMN cash_receipt_source_site_id integer REFERENCES sites(id);
        CREATE FUNCTION validate_cash_receipt_source_site() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP='INSERT' AND NEW.ledger_type='person' AND NEW.cash_receipt_source_site_id IS NULL THEN
            SELECT m.cash_receipt_source_site_id INTO NEW.cash_receipt_source_site_id
            FROM cash_flow_months m WHERE m.site_id=NEW.site_id AND m.ledger_type='person'
              AND m.ledger_name=NEW.ledger_name ORDER BY m.year DESC,m.month DESC,m.id DESC LIMIT 1;
          END IF;
          IF NEW.cash_receipt_source_site_id IS NOT NULL AND
             (NEW.ledger_type IS DISTINCT FROM 'person' OR NEW.cash_receipt_source_site_id=NEW.site_id OR NOT EXISTS (
                SELECT 1 FROM sites s JOIN sites d ON d.organization_id=s.organization_id
                WHERE s.id=NEW.cash_receipt_source_site_id AND d.id=NEW.site_id
             )) THEN
            RAISE EXCEPTION 'Choose a different source site within this organization' USING ERRCODE='23514';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER cash_receipt_source_site BEFORE INSERT OR UPDATE OF site_id,ledger_type,cash_receipt_source_site_id
          ON cash_flow_months FOR EACH ROW EXECUTE FUNCTION validate_cash_receipt_source_site();

        CREATE FUNCTION require_paired_site_cash_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF TG_OP='UPDATE' AND ROW(OLD.cash_flow_month_id,OLD.credit,OLD.cash_type,OLD.source_module)
               IS NOT DISTINCT FROM ROW(NEW.cash_flow_month_id,NEW.credit,NEW.cash_type,NEW.source_module) THEN
            RETURN NEW;
          END IF;
          IF EXISTS (SELECT 1 FROM cash_flow_months m WHERE m.id=NEW.cash_flow_month_id
                     AND m.cash_receipt_source_site_id IS NOT NULL) THEN
            IF TG_OP='INSERT' AND to_regclass('public.recycle_bin_entries') IS NOT NULL THEN
              IF EXISTS (SELECT 1 FROM recycle_bin_entries b
                WHERE b.source_schema='public' AND b.source_table='cash_flow_entries'
                  AND b.record_id=NEW.id::text AND b.restored_at IS NULL
                  AND b.row_data @> jsonb_build_object('id',NEW.id,'cash_flow_month_id',NEW.cash_flow_month_id,
                    'credit',NEW.credit,'cash_type',NEW.cash_type,'created_at',NEW.created_at)) THEN
                RETURN NEW;
              END IF;
            END IF;
            RAISE EXCEPTION 'Record this inter-site cash receipt as a linked transfer from its sending site'
              USING ERRCODE='23514', CONSTRAINT='site_cash_receipt_requires_transfer';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER require_paired_site_cash_receipt BEFORE INSERT OR UPDATE OF cash_flow_month_id,credit,cash_type,source_module
          ON cash_flow_entries FOR EACH ROW
          WHEN (NEW.source_module IS NULL AND NEW.credit>0 AND lower(NEW.cash_type)='cash')
          EXECUTE FUNCTION require_paired_site_cash_receipt();

        CREATE TABLE cashflow_site_debit_notices (
          transfer_id uuid PRIMARY KEY,
          site_id integer NOT NULL REFERENCES sites(id),
          destination_site_id integer NOT NULL REFERENCES sites(id),
          source_ledger_id integer NOT NULL REFERENCES cash_flow_months(id),
          initiated_by integer NOT NULL REFERENCES users(id),
          amount numeric(15,2) NOT NULL CHECK (amount>0),
          reference text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX cashflow_site_debit_inbox ON cashflow_site_debit_notices(site_id,created_at DESC,transfer_id);
        CREATE TABLE cashflow_site_debit_notice_reads (
          transfer_id uuid NOT NULL REFERENCES cashflow_site_debit_notices(transfer_id),
          user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          PRIMARY KEY(transfer_id,user_id)
        );
        CREATE FUNCTION notify_cross_site_debit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO cashflow_site_debit_notices
            (transfer_id,site_id,destination_site_id,source_ledger_id,initiated_by,amount,reference)
          VALUES(NEW.id,NEW.source_site_id,NEW.destination_site_id,NEW.source_ledger_id,NEW.initiated_by,NEW.amount,NEW.reference);
          RETURN NEW;
        END $$;
        CREATE TRIGGER quick_transfer_debit_notice AFTER INSERT ON cashflow_quick_transfers
          FOR EACH ROW WHEN (NEW.source_site_id<>NEW.destination_site_id) EXECUTE FUNCTION notify_cross_site_debit();
        CREATE TRIGGER money_transfer_debit_notice AFTER INSERT ON cashflow_transfers
          FOR EACH ROW WHEN (NEW.source_site_id<>NEW.destination_site_id) EXECUTE FUNCTION notify_cross_site_debit();
      `);
      await db.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [VERSION]);
    }
    await db.query('COMMIT');
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
