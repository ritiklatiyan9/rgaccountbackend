import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// A linked plot and registry must use one circle rate. Keep the derived bank
// target and rounded registry amount in step when either page changes it.
export const migrationSql = `
CREATE OR REPLACE FUNCTION sync_registry_circle_rate_from_plot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  metres NUMERIC;
  bank_target NUMERIC;
BEGIN
  metres := CASE
    WHEN NEW.plot_size_mtr > 0 THEN NEW.plot_size_mtr
    WHEN NEW.plot_size > 0 THEN ROUND(NEW.plot_size *
      CASE WHEN NEW.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL
  END;
  bank_target := CASE WHEN metres > 0 AND NEW.circle_rate > 0
    THEN ROUND(metres * NEW.circle_rate, 2) ELSE 0 END;

  UPDATE plots SET to_receive_bank = bank_target, updated_at = NOW()
   WHERE id = NEW.id AND to_receive_bank IS DISTINCT FROM bank_target;

  UPDATE plot_registries
     SET circle_rate = NEW.circle_rate,
         registry_payment = CASE
           WHEN metres > 0 AND NEW.circle_rate > 0
             THEN CEIL(metres * NEW.circle_rate / 1000) * 1000
           ELSE 0
         END,
         updated_at = NOW()
   WHERE plot_id = NEW.id AND site_id = NEW.site_id
     AND circle_rate IS DISTINCT FROM NEW.circle_rate;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_registry_circle_rate_from_plot ON plots;
CREATE TRIGGER trg_sync_registry_circle_rate_from_plot
AFTER UPDATE OF circle_rate ON plots
FOR EACH ROW
WHEN (OLD.circle_rate IS DISTINCT FROM NEW.circle_rate)
EXECUTE FUNCTION sync_registry_circle_rate_from_plot();

CREATE OR REPLACE FUNCTION sync_plot_circle_rate_from_registry()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  metres NUMERIC;
BEGIN
  IF NEW.plot_id IS NULL THEN RETURN NEW; END IF;

  SELECT CASE
    WHEN p.plot_size_mtr > 0 THEN p.plot_size_mtr
    WHEN p.plot_size > 0 THEN ROUND(p.plot_size *
      CASE WHEN p.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL
  END INTO metres
  FROM plots p WHERE p.id = NEW.plot_id AND p.site_id = NEW.site_id;

  UPDATE plots p
     SET circle_rate = NEW.circle_rate,
         to_receive_bank = CASE WHEN metres > 0 AND NEW.circle_rate > 0
           THEN ROUND(metres * NEW.circle_rate, 2) ELSE 0 END,
         updated_at = NOW()
   WHERE p.id = NEW.plot_id AND p.site_id = NEW.site_id
     AND p.circle_rate IS DISTINCT FROM NEW.circle_rate;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_plot_circle_rate_from_registry ON plot_registries;
CREATE TRIGGER trg_sync_plot_circle_rate_from_registry
AFTER INSERT OR UPDATE OF circle_rate ON plot_registries
FOR EACH ROW
EXECUTE FUNCTION sync_plot_circle_rate_from_registry();
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('181_plot_registry_circle_rate_sync'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '181_plot_registry_circle_rate_sync'");
    if (existing.rows.length) {
      await client.query('COMMIT');
      return false;
    }
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('181_plot_registry_circle_rate_sync') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Plot and registry circle rates now sync' : 'Circle-rate sync already applied'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
