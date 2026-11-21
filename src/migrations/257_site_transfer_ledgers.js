import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '257_site_transfer_ledgers';

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    if (!(await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length) {
      // NULL ledger IDs retain the original main-site routing, which creates
      // the site's month on approval. Named selections point at exact periods.
      await db.query(`
        ALTER TABLE site_money_transfers
          ADD COLUMN source_ledger_id integer REFERENCES cash_flow_months(id),
          ADD COLUMN destination_ledger_id integer REFERENCES cash_flow_months(id),
          ADD COLUMN source_ledger_name text NOT NULL DEFAULT 'Main site ledger',
          ADD COLUMN destination_ledger_name text NOT NULL DEFAULT 'Main site ledger',
          ADD COLUMN idempotency_key uuid,
          ADD COLUMN request_hash text;
        CREATE UNIQUE INDEX site_money_transfer_request_key
          ON site_money_transfers(organization_id, requested_by, idempotency_key) WHERE idempotency_key IS NOT NULL;
        CREATE INDEX site_money_transfers_review_history ON site_money_transfers(approver_id, decided_at DESC, id DESC)
          WHERE status IN ('approved','rejected');

        CREATE FUNCTION validate_site_transfer_posting() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE request site_money_transfers%ROWTYPE; debit_leg boolean; ledger integer; site integer;
        BEGIN
          SELECT * INTO STRICT request FROM site_money_transfers WHERE id=NEW.site_transfer_id FOR UPDATE;
          debit_leg := NEW.site_transfer_leg='debit';
          ledger := CASE WHEN debit_leg THEN request.source_ledger_id ELSE request.destination_ledger_id END;
          site := CASE WHEN debit_leg THEN request.source_site_id ELSE request.destination_site_id END;
          IF request.status<>'pending' OR NEW.site_transfer_leg IS NULL OR NEW.site_transfer_leg NOT IN ('debit','credit')
             OR NEW.site_id IS DISTINCT FROM site OR (ledger IS NOT NULL AND NEW.cash_flow_month_id IS DISTINCT FROM ledger)
             OR NOT EXISTS (SELECT 1 FROM cash_flow_months m WHERE m.id=NEW.cash_flow_month_id AND m.site_id=site)
             OR NEW.debit IS DISTINCT FROM (CASE WHEN debit_leg THEN request.amount ELSE 0 END)
             OR NEW.credit IS DISTINCT FROM (CASE WHEN debit_leg THEN 0 ELSE request.amount END)
             OR NEW.cash_type IS DISTINCT FROM request.mode OR NEW.date IS DISTINCT FROM request.transfer_date
             OR NEW.status IS DISTINCT FROM 'approved' OR NEW.approved_by IS DISTINCT FROM request.approver_id THEN
            RAISE EXCEPTION 'The site transfer entry does not match its approval request'
              USING ERRCODE='23514', CONSTRAINT='site_transfer_posting_mismatch';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER validate_site_transfer_posting BEFORE INSERT ON cash_flow_entries FOR EACH ROW
          WHEN (NEW.site_transfer_id IS NOT NULL) EXECUTE FUNCTION validate_site_transfer_posting();

        CREATE FUNCTION validate_site_transfer_decision() RETURNS trigger LANGUAGE plpgsql AS $$
        DECLARE transfer_id integer; decision text; leg_count integer;
        BEGIN
          IF TG_TABLE_NAME='site_money_transfers' THEN transfer_id:=NEW.id;
          ELSE transfer_id:=NEW.site_transfer_id; END IF;
          SELECT status INTO decision FROM site_money_transfers WHERE id=transfer_id;
          SELECT count(*) INTO leg_count FROM cash_flow_entries WHERE site_transfer_id=transfer_id;
          IF leg_count <> (CASE WHEN decision='approved' THEN 2 ELSE 0 END) THEN
            RAISE EXCEPTION 'Approval requires both site transfer entries'
              USING ERRCODE='23514', CONSTRAINT='site_transfer_posting_mismatch';
          END IF;
          RETURN NEW;
        END $$;
        CREATE CONSTRAINT TRIGGER site_transfer_decision_pair AFTER INSERT OR UPDATE OF status ON site_money_transfers
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_site_transfer_decision();
        CREATE CONSTRAINT TRIGGER site_transfer_posting_pair AFTER INSERT ON cash_flow_entries
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.site_transfer_id IS NOT NULL)
          EXECUTE FUNCTION validate_site_transfer_decision();
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
  up().then(() => console.log(`Applied ${VERSION}`))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
