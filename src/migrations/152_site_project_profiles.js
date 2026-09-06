import 'dotenv/config';
import pool from '../config/db.js';

// Constant defaults use PostgreSQL's fast ADD COLUMN path. No existing business
// row, amount, measurement, status, timestamp or relationship is updated.
async function up() {
const client = await pool.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('152_site_project_profiles'))");
  const { rows: applied } = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '152_site_project_profiles'");
  if (applied.length) { await client.query('COMMIT'); console.log('Migration 152 already applied'); return; }
  await client.query("SET LOCAL lock_timeout = '5s'");
  // Hold writes briefly so the before/after comparison is exact even when the
  // application is in use. Lock timeout makes this fail safely on a busy DB.
  await client.query('LOCK TABLE sites, plots IN SHARE ROW EXCLUSIVE MODE');
  const fingerprint = async () => {
    const result = {};
    for (const [table, excluded] of [['sites', ['project_profile']], ['plots', ['unit_type', 'unit_details']]]) {
      const { rows: [row] } = await client.query(
        `SELECT COUNT(*)::int AS count, md5(COALESCE(string_agg(md5((to_jsonb(t) - $1::text[])::text), '' ORDER BY id), '')) AS fingerprint FROM ${table} t`,
        [excluded],
      );
      result[table] = row;
    }
    return result;
  };
  const before = await fingerprint();
  await client.query(`ALTER TABLE sites ADD COLUMN IF NOT EXISTS project_profile JSONB NOT NULL
    DEFAULT '{"inventory_type":"plots","authority_type":"unconfigured","rera_status":"unconfigured"}'::jsonb`);
  await client.query(`ALTER TABLE plots
    ADD COLUMN IF NOT EXISTS unit_type TEXT NOT NULL DEFAULT 'plot' CHECK (unit_type IN ('plot', 'flat')),
    ADD COLUMN IF NOT EXISTS unit_details JSONB NOT NULL DEFAULT '{}'::jsonb`);
  // Serialize inventory creation/transfers with profile changes for this site.
  // FOR SHARE permits concurrent unit creation but conflicts with profile UPDATE.
  await client.query(`CREATE OR REPLACE FUNCTION guard_project_unit_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE inventory TEXT;
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.unit_type IS DISTINCT FROM OLD.unit_type THEN
        RAISE EXCEPTION 'Existing unit type cannot change' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
      END IF;
      SELECT project_profile->>'inventory_type' INTO inventory FROM sites WHERE id = NEW.site_id FOR SHARE;
      IF (COALESCE(inventory, 'plots') = 'plots' AND NEW.unit_type <> 'plot') OR (inventory = 'flats' AND NEW.unit_type <> 'flat') THEN
        RAISE EXCEPTION 'Unit type is not enabled in the destination site profile' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
      END IF;
      RETURN NEW;
    END $$`);
  await client.query('DROP TRIGGER IF EXISTS project_unit_profile_guard ON plots');
  await client.query(`CREATE TRIGGER project_unit_profile_guard BEFORE INSERT OR UPDATE OF unit_type, site_id ON plots
    FOR EACH ROW EXECUTE FUNCTION guard_project_unit_profile()`);
  await client.query(`CREATE OR REPLACE FUNCTION guard_site_project_inventory() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE inventory TEXT;
    BEGIN
      inventory := NEW.project_profile->>'inventory_type';
      IF inventory IS NULL OR inventory NOT IN ('plots', 'flats', 'mixed') THEN
        RAISE EXCEPTION 'Invalid project inventory profile' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
      END IF;
      IF inventory <> 'mixed' AND EXISTS (SELECT 1 FROM plots WHERE site_id = NEW.id AND unit_type <> CASE inventory WHEN 'flats' THEN 'flat' ELSE 'plot' END) THEN
        RAISE EXCEPTION 'Existing inventory requires Flats + Plots' USING ERRCODE = '23514', CONSTRAINT = 'project_unit_profile';
      END IF;
      RETURN NEW;
    END $$`);
  await client.query('DROP TRIGGER IF EXISTS site_project_inventory_guard ON sites');
  await client.query(`CREATE TRIGGER site_project_inventory_guard BEFORE UPDATE OF project_profile ON sites
    FOR EACH ROW EXECUTE FUNCTION guard_site_project_inventory()`);
  await client.query("INSERT INTO app_schema_migrations (version) VALUES ('152_site_project_profiles') ON CONFLICT (version) DO NOTHING");
  const after = await fingerprint();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Existing data changed; rolling back migration');
  await client.query('COMMIT');
  console.log(`Verified unchanged: ${after.sites.count} sites and ${after.plots.count} units (all pre-existing columns)`);
  console.log('Migration 152: site profiles ready; existing business data unchanged');
} catch (error) {
  await client.query('ROLLBACK');
  console.error('Project profile migration failed:', error.message);
  process.exitCode = 1;
} finally { client.release(); await pool.end(); }

}
up().catch(error => { console.error(error.message); process.exitCode = 1; });
