import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// Plot Payments owns both measurements. Preserve its saved metres, including
// values entered in metres, and use 0.8364 only when metres are absent.
export const migrationSql = `
ALTER TABLE plots
  ALTER COLUMN plot_size TYPE NUMERIC(14,4),
  ALTER COLUMN plot_size_mtr TYPE NUMERIC(14,4);
ALTER TABLE plot_registries
  ALTER COLUMN size_meter TYPE NUMERIC(14,4),
  ALTER COLUMN size_sqyard TYPE NUMERIC(14,4);

CREATE OR REPLACE FUNCTION sync_registry_area_from_plot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  yards NUMERIC;
  metres NUMERIC;
BEGIN
  yards := CASE WHEN NEW.plot_size > 0 THEN
    CASE WHEN NEW.unit_type = 'flat' THEN ROUND(NEW.plot_size / 9, 4)
         ELSE NEW.plot_size END
    ELSE NULL END;
  metres := CASE WHEN NEW.plot_size_mtr > 0 THEN NEW.plot_size_mtr
    WHEN NEW.plot_size > 0 THEN ROUND(NEW.plot_size *
      CASE WHEN NEW.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
    ELSE NULL END;
  UPDATE plot_registries pr
     SET size_sqyard = yards, size_meter = metres
   WHERE pr.plot_id = NEW.id AND pr.site_id = NEW.site_id
     AND (pr.size_sqyard IS DISTINCT FROM yards OR pr.size_meter IS DISTINCT FROM metres);
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_sync_registry_area_from_plot ON plots;
CREATE TRIGGER trg_sync_registry_area_from_plot
AFTER UPDATE OF plot_size, plot_size_mtr, unit_type ON plots
FOR EACH ROW EXECUTE FUNCTION sync_registry_area_from_plot();

UPDATE plot_registries pr
   SET size_sqyard = CASE WHEN p.plot_size > 0 THEN
         CASE WHEN p.unit_type = 'flat' THEN ROUND(p.plot_size / 9, 4)
              ELSE p.plot_size END ELSE NULL END,
       size_meter = CASE WHEN p.plot_size_mtr > 0 THEN p.plot_size_mtr
         WHEN p.plot_size > 0 THEN ROUND(p.plot_size *
           CASE WHEN p.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
         ELSE NULL END
  FROM plots p
 WHERE pr.plot_id = p.id AND pr.site_id = p.site_id
   AND (pr.size_sqyard IS DISTINCT FROM CASE WHEN p.plot_size > 0 THEN
          CASE WHEN p.unit_type = 'flat' THEN ROUND(p.plot_size / 9, 4)
               ELSE p.plot_size END ELSE NULL END
     OR pr.size_meter IS DISTINCT FROM CASE WHEN p.plot_size_mtr > 0 THEN p.plot_size_mtr
          WHEN p.plot_size > 0 THEN ROUND(p.plot_size *
            CASE WHEN p.unit_type = 'flat' THEN 0.09290304 ELSE 0.8364 END, 4)
          ELSE NULL END);
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('176_registry_plot_area_sync'))");
    const existing = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '176_registry_plot_area_sync'");
    if (existing.rows.length) {
      await client.query('COMMIT');
      return;
    }
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('176_registry_plot_area_sync') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Registry areas now follow Plot Payments'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
