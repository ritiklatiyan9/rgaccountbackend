import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { VERSION as directStatusVersion } from './258_direct_plot_status.js';

export const VERSION = '259_finalize_pending_bookings';

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [VERSION]);
    const { rows: [versions] } = await client.query(`
      SELECT
        EXISTS (SELECT 1 FROM app_schema_migrations WHERE version=$1) AS direct_status_live,
        EXISTS (SELECT 1 FROM app_schema_migrations WHERE version=$2) AS finalized
    `, [directStatusVersion, VERSION]);
    if (!versions.direct_status_live) throw new Error('Deploy direct plot status updates first.');
    if (versions.finalized) {
      await client.query('COMMIT');
      return { finalized: 0, alreadyApplied: true };
    }

    const { rows: [result] } = await client.query(`
      WITH finalized AS (
        UPDATE plots p SET approval_status='approved', approved_by=NULL, approved_at=NOW(), updated_at=NOW()
        FROM sites s
        WHERE p.site_id=s.id AND upper(btrim(p.status))='BOOKED'
          AND p.approval_status='pending' AND p.booking_cancelled_at IS NULL
        RETURNING p.id, p.site_id, p.status, s.organization_id
      ), audited AS (
        INSERT INTO audit_logs (
          organization_id, site_id, action, event_type, module, entity_type, entity_id,
          outcome, description, old_values, new_values, metadata
        )
        SELECT organization_id, site_id, 'UPDATE', 'SYSTEM', 'plot_payments', 'plot', id::text,
          'SUCCESS', 'Closed the pending booking review during the direct status rollout',
          jsonb_build_object('status', status, 'approval_status', 'pending'),
          jsonb_build_object('status', status, 'approval_status', 'approved'),
          jsonb_build_object('migration', $1::text)
        FROM finalized RETURNING id
      )
      SELECT count(*)::int AS finalized FROM audited
    `, [VERSION]);
    await client.query('INSERT INTO app_schema_migrations (version) VALUES ($1)', [VERSION]);
    await client.query('COMMIT');
    return { finalized: result.finalized, alreadyApplied: false };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
