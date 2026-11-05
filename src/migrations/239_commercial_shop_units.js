import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Adds commercial inventory without relabelling or recalculating any existing
// property, receipt, registry or project profile.
export const migrationSql = `
ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_unit_type_check;
ALTER TABLE plots ADD CONSTRAINT plots_unit_type_check CHECK (unit_type IN ('plot', 'flat', 'shop'));

CREATE OR REPLACE FUNCTION project_inventory_unit_types(inventory TEXT)
RETURNS TEXT[] LANGUAGE SQL IMMUTABLE AS $$
  SELECT CASE COALESCE(inventory, 'plots')
    WHEN 'plots' THEN ARRAY['plot']
    WHEN 'flats' THEN ARRAY['flat']
    WHEN 'shops' THEN ARRAY['shop']
    WHEN 'plots_shops' THEN ARRAY['plot', 'shop']
    WHEN 'mixed' THEN ARRAY['plot', 'flat']
    ELSE ARRAY[]::TEXT[] END
$$;

CREATE OR REPLACE FUNCTION guard_project_unit_profile() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.unit_type IS DISTINCT FROM OLD.unit_type THEN
    RAISE EXCEPTION 'Existing unit type cannot change' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
  END IF;
  SELECT project_profile->>'inventory_type' INTO inventory FROM sites WHERE id = NEW.site_id FOR SHARE;
  IF NOT (NEW.unit_type = ANY(project_inventory_unit_types(inventory))) THEN
    RAISE EXCEPTION 'Unit type is not enabled in the destination site profile' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS project_unit_profile_guard ON plots;
CREATE TRIGGER project_unit_profile_guard BEFORE INSERT OR UPDATE OF unit_type, site_id ON plots
  FOR EACH ROW EXECUTE FUNCTION guard_project_unit_profile();

CREATE OR REPLACE FUNCTION guard_site_project_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE inventory TEXT;
BEGIN
  inventory := NEW.project_profile->>'inventory_type';
  IF inventory IS NULL OR cardinality(project_inventory_unit_types(inventory)) = 0 THEN
    RAISE EXCEPTION 'Invalid project inventory profile' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
  END IF;
  IF EXISTS (SELECT 1 FROM plots WHERE site_id = NEW.id AND NOT (unit_type = ANY(project_inventory_unit_types(inventory)))) THEN
    RAISE EXCEPTION 'Project profile must include every existing unit type' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS site_project_inventory_guard ON sites;
CREATE TRIGGER site_project_inventory_guard BEFORE INSERT OR UPDATE OF project_profile ON sites
  FOR EACH ROW EXECUTE FUNCTION guard_site_project_inventory();

CREATE OR REPLACE FUNCTION normalize_plot_square_metres()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(NEW.unit_type, 'plot') = 'plot' AND NEW.plot_size > 0 THEN
    NEW.plot_size_mtr := ROUND(NEW.plot_size * 0.8364, 4);
  ELSIF NEW.unit_type = 'shop' AND NEW.plot_size > 0 THEN
    NEW.plot_size_mtr := ROUND(NEW.plot_size * 0.09290304, 4);
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION normalize_plot_bank_target()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE metres NUMERIC;
BEGIN
  metres := CASE WHEN NEW.plot_size_mtr > 0 THEN NEW.plot_size_mtr
    WHEN NEW.plot_size > 0 THEN ROUND(NEW.plot_size *
      CASE WHEN NEW.unit_type IN ('flat', 'shop') THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL END;
  NEW.to_receive_bank := CASE WHEN metres > 0 AND NEW.circle_rate > 0
    THEN CEIL(metres * NEW.circle_rate / 1000) * 1000 ELSE 0 END;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION sync_registry_area_from_plot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE yards NUMERIC; metres NUMERIC;
BEGIN
  yards := CASE WHEN NEW.plot_size > 0 THEN
    CASE WHEN NEW.unit_type IN ('flat', 'shop') THEN ROUND(NEW.plot_size / 9, 4)
      ELSE NEW.plot_size END ELSE NULL END;
  metres := CASE WHEN NEW.plot_size_mtr > 0 THEN NEW.plot_size_mtr
    WHEN NEW.plot_size > 0 THEN ROUND(NEW.plot_size *
      CASE WHEN NEW.unit_type IN ('flat', 'shop') THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL END;
  UPDATE plot_registries pr SET size_sqyard = yards, size_meter = metres
    WHERE pr.plot_id = NEW.id AND pr.site_id = NEW.site_id
      AND (pr.size_sqyard IS DISTINCT FROM yards OR pr.size_meter IS DISTINCT FROM metres);
  RETURN NEW;
END; $$;

-- Registry workspaces may be created by older imports or the automatic
-- REGISTRY-status trigger. Correct a linked shop's units at this boundary too.
CREATE OR REPLACE FUNCTION normalize_registry_square_metres()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_metres NUMERIC; source_area NUMERIC; source_type TEXT;
BEGIN
  IF NEW.plot_id IS NOT NULL THEN
    SELECT plot_size_mtr, plot_size, unit_type INTO source_metres, source_area, source_type
      FROM plots WHERE id = NEW.plot_id AND site_id = NEW.site_id;
    IF FOUND THEN
      NEW.size_meter := source_metres;
      IF source_type = 'shop' THEN
        NEW.size_sqyard := CASE WHEN source_area > 0 THEN ROUND(source_area / 9, 4) ELSE NULL END;
      END IF;
    END IF;
  ELSIF NEW.size_sqyard > 0 THEN
    NEW.size_meter := ROUND(NEW.size_sqyard * 0.8364, 4);
  END IF;
  RETURN NEW;
END; $$;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('239_commercial_shop_units'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '239_commercial_shop_units'");
    if (!existing.rows.length) {
      await client.query(migrationSql);
      await client.query("INSERT INTO app_schema_migrations(version) VALUES ('239_commercial_shop_units')");
    }
    await client.query('COMMIT');
    return !existing.rows.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Commercial shops enabled; existing inventory preserved' : 'Commercial shops already enabled'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
