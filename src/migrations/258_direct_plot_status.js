import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { AVAILABLE_BOOKING_STATUSES, BOOKING_INSTALLMENT_FIELDS, PLOT_BOOKING_FIELDS } from '../services/plotApproval.service.js';

export const VERSION = '258_direct_plot_status';
const sqlValues = values => values.map(value => `'${value}'`).join(', ');

export const migrationSql = `
CREATE OR REPLACE FUNCTION queue_plot_status_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  metadata TEXT[] := ARRAY[
    'approval_status', 'approved_by', 'approved_at', 'approval_requested_by', 'approval_requested_at',
    'updated_at', 'plot_tag', 'approval_original_data', 'approval_proposed_data'
  ];
  status_fields TEXT[] := ARRAY['status', 'booking_date', 'assigned_admin_id'];
  booking_fields TEXT[] := ARRAY[${sqlValues([...PLOT_BOOKING_FIELDS, ...BOOKING_INSTALLMENT_FIELDS, 'assigned_admin_id'])}];
  old_details JSONB;
  new_details JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF upper(btrim(NEW.status)) = 'BOOKED' THEN
      NEW.approval_status := 'approved';
      NEW.approval_requested_by := NULL;
      NEW.approval_requested_at := NULL;
      RETURN NEW;
    END IF;
  ELSE
    old_details := to_jsonb(OLD) - metadata;
    new_details := to_jsonb(NEW) - metadata;
    IF (NEW.status IS DISTINCT FROM OLD.status
        AND (new_details - status_fields) IS NOT DISTINCT FROM (old_details - status_fields))
       OR (current_setting('accounts.direct_plot_booking', true) = NEW.id::text
        AND upper(btrim(NEW.status)) = 'BOOKED'
        AND NULLIF(btrim(NEW.buyer_name), '') IS NOT NULL
        AND (upper(btrim(OLD.status)) IN (${sqlValues(AVAILABLE_BOOKING_STATUSES)})
          OR (upper(btrim(OLD.status)) = 'BOOKED'
            AND NULLIF(btrim(OLD.buyer_name), '') IS NULL AND old_details->>'buyer_member_id' IS NULL))
        AND (new_details - booking_fields) IS NOT DISTINCT FROM (old_details - booking_fields)) THEN
      -- A status change does not replace a review already attached to the plot.
      NEW.approval_status := OLD.approval_status;
      NEW.approved_by := OLD.approved_by;
      NEW.approved_at := OLD.approved_at;
      NEW.approval_requested_by := OLD.approval_requested_by;
      NEW.approval_requested_at := OLD.approval_requested_at;
      NEW.assigned_admin_id := OLD.assigned_admin_id;
      RETURN NEW;
    END IF;
    IF new_details IS NOT DISTINCT FROM old_details
       AND NEW.approval_requested_at IS NOT DISTINCT FROM OLD.approval_requested_at THEN
      RETURN NEW;
    END IF;
  END IF;

  NEW.approval_status := 'pending';
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
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    await client.query(migrationSql);
    await client.query('INSERT INTO app_schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [VERSION]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(() => console.log('Direct plot status changes are ready'))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
