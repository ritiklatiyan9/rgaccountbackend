import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Apply CEILING(m² × Circle Rate, 1000) before approvals capture a plot edit.
// Existing targets stay intact until an amount, measurement or rate is edited.
export const migrationSql = `
CREATE OR REPLACE FUNCTION normalize_plot_bank_target()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE metres NUMERIC;
BEGIN
  metres := CASE
    WHEN NEW.plot_size_mtr > 0 THEN NEW.plot_size_mtr
    WHEN NEW.plot_size > 0 THEN ROUND(NEW.plot_size *
      CASE WHEN NEW.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL END;
  NEW.to_receive_bank := CASE WHEN metres > 0 AND NEW.circle_rate > 0
    THEN CEIL(metres * NEW.circle_rate / 1000) * 1000 ELSE 0 END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS plots_01_normalize_bank_target ON plots;
CREATE TRIGGER plots_01_normalize_bank_target
BEFORE INSERT OR UPDATE OF plot_size, plot_size_mtr, unit_type, circle_rate, to_receive_bank ON plots
FOR EACH ROW EXECUTE FUNCTION normalize_plot_bank_target();

CREATE OR REPLACE FUNCTION sync_registry_circle_rate_from_plot()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE plot_registries
     SET circle_rate = NEW.circle_rate,
         bank_amount = NEW.to_receive_bank,
         registry_payment = NEW.to_receive_bank,
         updated_at = NOW()
   WHERE plot_id = NEW.id AND site_id = NEW.site_id
     AND (circle_rate IS DISTINCT FROM NEW.circle_rate
       OR bank_amount IS DISTINCT FROM NEW.to_receive_bank
       OR registry_payment IS DISTINCT FROM NEW.to_receive_bank);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_registry_circle_rate_from_plot ON plots;
CREATE TRIGGER trg_sync_registry_circle_rate_from_plot
AFTER INSERT OR UPDATE OF plot_size, plot_size_mtr, unit_type, circle_rate, to_receive_bank ON plots
FOR EACH ROW EXECUTE FUNCTION sync_registry_circle_rate_from_plot();

CREATE OR REPLACE FUNCTION sync_plot_circle_rate_from_registry()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.plot_id IS NULL THEN RETURN NEW; END IF;
  -- The plot's BEFORE trigger calculates its rounded bank target; the forward
  -- sync then copies that amount to the registry. Distinct rates stop recursion.
  UPDATE plots p SET circle_rate = NEW.circle_rate, updated_at = NOW()
   WHERE p.id = NEW.plot_id AND p.site_id = NEW.site_id
     AND p.circle_rate IS DISTINCT FROM NEW.circle_rate;
  RETURN NEW;
END; $$;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('206_plot_bank_target_rounding'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '206_plot_bank_target_rounding'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('206_plot_bank_target_rounding')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Plot bank targets now round up to ₹1,000 and sync to Registry' : 'Plot bank rounding already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
