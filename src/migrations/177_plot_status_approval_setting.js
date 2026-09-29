import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// A status-only edit may skip review per site. New plots and changes to other
// plot fields still follow the existing approval queue.
export const migrationSql = `
CREATE OR REPLACE FUNCTION queue_plot_status_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  review_required BOOLEAN;
  ignored_fields TEXT[] := ARRAY[
    'approval_status', 'approved_by', 'approved_at',
    'approval_requested_by', 'approval_requested_at', 'updated_at',
    'plot_tag', 'approval_original_data', 'approval_proposed_data'
  ];
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
     AND (to_jsonb(NEW) - ignored_fields - 'status')
         IS NOT DISTINCT FROM (to_jsonb(OLD) - ignored_fields - 'status') THEN
    SELECT COALESCE((
      SELECT setting_value = 'true'::jsonb
      FROM application_settings
      WHERE site_id = NEW.site_id AND setting_key = 'plot_status_approval_required'
    ), true) INTO review_required;

    IF NOT review_required THEN
      -- Preserve an existing pending review for earlier plot edits.
      NEW.approval_status := CASE WHEN OLD.approval_status = 'pending'
        THEN 'pending' ELSE 'approved' END;
      NEW.approval_requested_by := OLD.approval_requested_by;
      NEW.approval_requested_at := OLD.approval_requested_at;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      RETURN NEW;
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.approval_status := 'pending';
  ELSIF NEW.approval_requested_at IS DISTINCT FROM OLD.approval_requested_at
    OR (to_jsonb(NEW) - ignored_fields)
       IS DISTINCT FROM (to_jsonb(OLD) - ignored_fields) THEN
    NEW.approval_status := 'pending';
  ELSE
    RETURN NEW;
  END IF;
  NEW.approved_by := NULL;
  NEW.approved_at := NULL;
  NEW.approval_requested_at := NOW();
  NEW.approval_requested_by := COALESCE(NEW.approval_requested_by, NEW.created_by);
  RETURN NEW;
END $$;
`;

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('177_plot_status_approval_setting'))");
    // Migration 158 still runs on every startup and defines the original
    // trigger function. Reapply this replacement after it, even once stamped.
    await client.query(migrationSql);
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('177_plot_status_approval_setting') ON CONFLICT DO NOTHING");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Plot status approval setting ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
