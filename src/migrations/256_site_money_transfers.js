import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

export const VERSION = '256_site_money_transfers';

// Main Site Balance → another site, once the chosen approver agrees. The
// request row is the authority; approval posts one debit leg in the sending
// site and one credit leg in the receiving site under source_module
// 'cashflow_transfers', which every KPI already treats as an internal transfer
// (never income or expense) while Site Balance, Day Book and Balance Sheet move.
// ponytail: re-running 240 by hand would drop the site-leg branch below and
// fail on existing legs; startup only runs 240 on a fresh install.
export const siteMoneyTransfersSql = `
CREATE TABLE site_money_transfers (
  id serial PRIMARY KEY,
  organization_id integer NOT NULL,
  source_site_id integer NOT NULL REFERENCES sites(id),
  destination_site_id integer NOT NULL REFERENCES sites(id),
  amount numeric(15,2) NOT NULL CHECK (amount > 0),
  mode text NOT NULL CHECK (mode IN ('cash','bank')),
  source_bank_account_id integer REFERENCES bank_accounts(id),
  destination_bank_account_id integer REFERENCES bank_accounts(id),
  transfer_date date NOT NULL,
  transfer_time time NOT NULL,
  remarks text NOT NULL DEFAULT '' CHECK (length(remarks) <= 1000),
  requested_by integer NOT NULL REFERENCES users(id),
  approver_id integer NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by integer REFERENCES users(id),
  decided_at timestamptz,
  decision_note text CHECK (length(decision_note) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_site_id <> destination_site_id),
  CHECK (approver_id <> requested_by),
  CHECK ((status = 'pending') = (decided_at IS NULL)),
  CHECK (mode = 'bank' OR (source_bank_account_id IS NULL AND destination_bank_account_id IS NULL))
);
CREATE INDEX site_money_transfers_approver ON site_money_transfers(approver_id, created_at DESC) WHERE status = 'pending';
CREATE INDEX site_money_transfers_requester ON site_money_transfers(requested_by, created_at DESC);

ALTER TABLE cash_flow_entries
  ADD COLUMN site_transfer_id integer REFERENCES site_money_transfers(id),
  ADD COLUMN site_transfer_leg text;
ALTER TABLE cash_flow_entries DROP CONSTRAINT IF EXISTS cashflow_money_transfer_link;
ALTER TABLE cash_flow_entries ADD CONSTRAINT cashflow_money_transfer_link CHECK(
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND COALESCE(source_module,'')<>'cashflow_transfers') OR
 (money_transfer_id IS NOT NULL AND money_transfer_leg IS NOT NULL AND money_transfer_leg IN ('debit','credit') AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL AND quick_transfer_id IS NULL) OR
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND quick_transfer_id IS NOT NULL AND quick_transfer_leg IS NOT NULL
  AND quick_transfer_leg IN ('debit','credit') AND source_module IS NOT NULL AND source_module='cashflow_transfers' AND source_id IS NULL) OR
 (money_transfer_id IS NULL AND money_transfer_leg IS NULL AND quick_transfer_id IS NULL AND site_transfer_id IS NOT NULL
  AND source_module='cashflow_transfers' AND source_id IS NULL)
);
ALTER TABLE cash_flow_entries ADD CONSTRAINT cashflow_site_transfer_link CHECK(
 (site_transfer_id IS NULL AND site_transfer_leg IS NULL) OR
 (site_transfer_id IS NOT NULL AND site_transfer_leg IN ('debit','credit') AND source_module='cashflow_transfers'
  AND source_id IS NULL AND money_transfer_id IS NULL AND quick_transfer_id IS NULL)
);
CREATE UNIQUE INDEX cashflow_site_transfer_one_leg ON cash_flow_entries(site_transfer_id, site_transfer_leg) WHERE site_transfer_id IS NOT NULL;

-- Money columns of a posted leg never change. Bank mapping and user FKs
-- (ON DELETE SET NULL) stay writable so unrelated deletions keep working.
CREATE FUNCTION protect_site_money_transfer_leg() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Approved site transfers are immutable' USING ERRCODE = '23514', CONSTRAINT = 'cashflow_transfer_immutable';
  END IF;
  IF ROW(OLD.site_transfer_id, OLD.site_transfer_leg, OLD.site_id, OLD.cash_flow_month_id, OLD.date,
       OLD.debit, OLD.credit, OLD.cash_type, OLD.status, OLD.source_module, OLD.source_id)
     IS DISTINCT FROM ROW(NEW.site_transfer_id, NEW.site_transfer_leg, NEW.site_id, NEW.cash_flow_month_id, NEW.date,
       NEW.debit, NEW.credit, NEW.cash_type, NEW.status, NEW.source_module, NEW.source_id) THEN
    RAISE EXCEPTION 'Approved site transfers are immutable' USING ERRCODE = '23514', CONSTRAINT = 'cashflow_transfer_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER site_money_transfer_leg_immutable BEFORE UPDATE OR DELETE ON cash_flow_entries
  FOR EACH ROW WHEN (OLD.site_transfer_id IS NOT NULL) EXECUTE FUNCTION protect_site_money_transfer_leg();
`;

export async function up(database = pool) {
  const db = await database.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    if (!(await db.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length) {
      await db.query(siteMoneyTransfersSql);
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
  up().then(() => console.log('Site money transfer schema ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
