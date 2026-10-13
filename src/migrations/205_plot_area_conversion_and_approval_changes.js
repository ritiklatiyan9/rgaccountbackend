import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { plotSnapshotFunctionSql } from './172_approval_change_snapshots.js';
import { migrationSql as approvalSettingSql } from './177_plot_status_approval_setting.js';

// Normalize before the approval queue runs; capture the resulting measurements
// afterwards. Only area edits touch measurements, and flats keep their own units.
export const migrationSql = `
ALTER TABLE plots
  ALTER COLUMN plot_size TYPE NUMERIC(14,4),
  ALTER COLUMN plot_size_mtr TYPE NUMERIC(14,4),
  ADD COLUMN IF NOT EXISTS approval_original_data JSONB,
  ADD COLUMN IF NOT EXISTS approval_proposed_data JSONB;
ALTER TABLE plot_registries
  ALTER COLUMN size_meter TYPE NUMERIC(14,4),
  ALTER COLUMN size_sqyard TYPE NUMERIC(14,4);

${approvalSettingSql}
${plotSnapshotFunctionSql};
DROP TRIGGER IF EXISTS trg_approval_change_snapshot ON plots;
CREATE TRIGGER trg_approval_change_snapshot BEFORE UPDATE ON plots
FOR EACH ROW EXECUTE FUNCTION capture_plot_approval_change();

CREATE OR REPLACE VIEW plot_status_approvals AS
SELECT id, site_id, id AS plot_id, plot_no, buyer_name, scheme,
  status AS plot_status, approval_status AS status, assigned_admin_id,
  approval_requested_by AS created_by, approval_requested_at AS created_at,
  approval_requested_at::date AS date, approved_by, approved_at, updated_at,
  0::numeric AS amount, approval_original_data, approval_proposed_data
FROM plots;

CREATE OR REPLACE FUNCTION normalize_plot_square_metres()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.unit_type, 'plot') = 'plot' AND NEW.plot_size > 0 THEN
    NEW.plot_size_mtr := ROUND(NEW.plot_size * 0.8364, 4);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS plots_00_normalize_area ON plots;
CREATE TRIGGER plots_00_normalize_area
BEFORE INSERT OR UPDATE OF plot_size, plot_size_mtr, unit_type ON plots
FOR EACH ROW EXECUTE FUNCTION normalize_plot_square_metres();

CREATE OR REPLACE FUNCTION sync_registry_square_metres()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE plot_registries SET size_meter = NEW.plot_size_mtr
  WHERE plot_id = NEW.id AND site_id = NEW.site_id
    AND size_meter IS DISTINCT FROM NEW.plot_size_mtr;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_sync_registry_square_metres ON plots;
CREATE TRIGGER trg_sync_registry_square_metres
AFTER UPDATE OF plot_size, plot_size_mtr, unit_type ON plots
FOR EACH ROW EXECUTE FUNCTION sync_registry_square_metres();

CREATE OR REPLACE FUNCTION normalize_registry_square_metres()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_metres NUMERIC;
BEGIN
  IF NEW.plot_id IS NOT NULL THEN
    SELECT plot_size_mtr INTO source_metres FROM plots
    WHERE id = NEW.plot_id AND site_id = NEW.site_id;
    IF FOUND THEN NEW.size_meter := source_metres; END IF;
  ELSIF NEW.size_sqyard > 0 THEN
    NEW.size_meter := ROUND(NEW.size_sqyard * 0.8364, 4);
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_registry_20_normalize_area ON plot_registries;
CREATE TRIGGER trg_registry_20_normalize_area
BEFORE INSERT OR UPDATE OF size_meter, size_sqyard, plot_id ON plot_registries
FOR EACH ROW EXECUTE FUNCTION normalize_registry_square_metres();
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('205_plot_area_conversion_and_approval_changes'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '205_plot_area_conversion_and_approval_changes'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('205_plot_area_conversion_and_approval_changes')");
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Plot area conversion and approval changes installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
