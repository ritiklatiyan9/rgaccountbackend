import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// A registry-status plot always owns a registry workspace, including writes
// made by old API deployments and imports. No NOC, legal date or new money is issued.
export const workspaceFunctionSql = `CREATE OR REPLACE FUNCTION ensure_registered_plot_workspace(target_plot_id integer)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  p plots%ROWTYPE;
  registry_id integer;
  gaz numeric;
  metres numeric;
  actor_id integer;
BEGIN
  SELECT * INTO p FROM plots WHERE id = target_plot_id FOR UPDATE;
  IF NOT FOUND OR UPPER(TRIM(COALESCE(p.status, ''))) <> 'REGISTRY'
    OR UPPER(TRIM(COALESCE(p.plot_tag, ''))) = 'OLD' THEN RETURN NULL; END IF;

  SELECT pr.id INTO registry_id FROM plot_registries pr
    WHERE pr.site_id = p.site_id AND (pr.plot_id = p.id OR
      (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER(p.plot_no)))
    ORDER BY CASE WHEN pr.plot_id = p.id THEN 0 ELSE 1 END, pr.id DESC LIMIT 1;
  IF registry_id IS NOT NULL THEN RETURN registry_id; END IF;

  gaz := CASE WHEN p.plot_size > 0 THEN CASE
    WHEN to_jsonb(p)->>'unit_type' = 'flat' THEN ROUND(p.plot_size / 9, 4)
    ELSE p.plot_size END ELSE NULL END;
  metres := CASE WHEN p.plot_size_mtr > 0 THEN p.plot_size_mtr
    WHEN p.plot_size > 0 THEN ROUND(p.plot_size * CASE
      WHEN to_jsonb(p)->>'unit_type' = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL END;
  actor_id := COALESCE((to_jsonb(p)->>'approval_requested_by')::integer,
    (to_jsonb(p)->>'created_by')::integer);
  INSERT INTO plot_registries(site_id, plot_id, plot_no, customer_name, size_meter,
    size_sqyard, circle_rate, created_entry_date, bank_amount, registry_payment,
    notes, assigned_admin_id, created_by)
  VALUES (p.site_id, p.id, p.plot_no, NULLIF(UPPER(TRIM(p.buyer_name)), ''), metres,
    gaz, NULLIF(p.circle_rate, 0), CURRENT_DATE, COALESCE(p.to_receive_bank, 0),
    CASE WHEN metres > 0 AND p.circle_rate > 0 THEN ROUND(metres * p.circle_rate, 2) ELSE 0 END,
    'Registry workspace created automatically from Plot Payments REGISTRY status.',
    p.assigned_admin_id, actor_id)
  RETURNING id INTO registry_id;

  INSERT INTO plot_registry_payments(registry_id, site_id, payment_date, amount,
    payment_mode, tally_date, tally_amount, notes, source_plot_payment_id,
    include_in_noc, cheque_no, cheque_status, status, approved_by, approved_at, created_by)
  SELECT registry_id, p.site_id, pp.date, pp.amount,
    UPPER(TRIM(COALESCE(NULLIF(pp.payment_from, ''), pp.payment_type, 'CASH'))),
    pp.date, pp.amount, UPPER(TRIM(COALESCE(NULLIF(pp.narration, ''), NULLIF(pp.bank_details, ''), 'LINKED FROM PLOT PAYMENT'))),
    pp.id, TRUE, pp.cheque_no, pp.cheque_status, pp.status, pp.approved_by, pp.approved_at, actor_id
  FROM plot_payments pp WHERE pp.plot_id = p.id
    AND financial_transaction_posts('credit', pp.status, pp.payment_type, pp.cheque_status)
    AND COALESCE(NULLIF(UPPER(TRIM(pp.payment_type)), ''), 'CASH') <> 'CASH'
    AND pp.date BETWEEN DATE '1900-01-01' AND DATE '2100-12-31'
    AND NOT EXISTS (SELECT 1 FROM plot_registry_payments linked WHERE linked.source_plot_payment_id = pp.id);
  RETURN registry_id;
END; $$;`;

export const migrationSql = `
-- A resold plot number can have multiple bookings and registry histories.
-- Uniqueness belongs to the booking link; unlinked legacy rows remain unique by number.
ALTER TABLE plot_registries DROP CONSTRAINT IF EXISTS plot_registries_site_id_plot_no_key;
CREATE UNIQUE INDEX IF NOT EXISTS plot_registries_booking_unique
  ON plot_registries(site_id, plot_id) WHERE plot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS plot_registries_unlinked_number_unique
  ON plot_registries(site_id, plot_no) WHERE plot_id IS NULL;
${workspaceFunctionSql}

CREATE OR REPLACE FUNCTION registered_plot_workspace_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM ensure_registered_plot_workspace(NEW.id);
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_registered_plot_workspace ON plots;
CREATE TRIGGER trg_registered_plot_workspace AFTER INSERT OR UPDATE OF status, plot_tag ON plots
  FOR EACH ROW WHEN (UPPER(TRIM(COALESCE(NEW.status, ''))) = 'REGISTRY'
    AND UPPER(TRIM(COALESCE(NEW.plot_tag, ''))) <> 'OLD')
  EXECUTE FUNCTION registered_plot_workspace_trigger();

-- Repair pre-existing gaps without changing plot status, approvals or existing registries.
SELECT ensure_registered_plot_workspace(p.id) FROM plots p
WHERE UPPER(TRIM(COALESCE(p.status, ''))) = 'REGISTRY'
  AND UPPER(TRIM(COALESCE(p.plot_tag, ''))) <> 'OLD'
  AND NOT EXISTS (SELECT 1 FROM plot_registries pr WHERE pr.site_id = p.site_id
    AND (pr.plot_id = p.id OR (pr.plot_id IS NULL AND UPPER(pr.plot_no) = UPPER(p.plot_no))))
ORDER BY p.id;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('174_registered_plot_workspace'))");
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('174_registered_plot_workspace') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Registered plots now automatically have registry workspaces'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
