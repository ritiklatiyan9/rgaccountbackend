import 'dotenv/config';
import pool from '../config/db.js';

// Existing records remain approved. New records and subsequent edits require review.
export const migrationSql = `
ALTER TABLE plots ADD COLUMN IF NOT EXISTS scheme TEXT;
ALTER TABLE plots ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved'
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE plots ADD COLUMN IF NOT EXISTS approval_requested_by INTEGER REFERENCES users(id);
ALTER TABLE plots ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
ALTER TABLE plots ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id);
ALTER TABLE plots ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION queue_plot_status_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.approval_status := 'pending';
  ELSIF NEW.approval_requested_at IS DISTINCT FROM OLD.approval_requested_at
    OR (to_jsonb(NEW) - ARRAY['approval_status','approved_by','approved_at','approval_requested_by','approval_requested_at','updated_at','plot_tag'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['approval_status','approved_by','approved_at','approval_requested_by','approval_requested_at','updated_at','plot_tag']) THEN
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
DROP TRIGGER IF EXISTS plots_queue_status_approval ON plots;
CREATE TRIGGER plots_queue_status_approval BEFORE INSERT OR UPDATE ON plots
FOR EACH ROW EXECUTE FUNCTION queue_plot_status_approval();
CREATE INDEX IF NOT EXISTS plots_pending_approval_idx ON plots(site_id, assigned_admin_id) WHERE approval_status = 'pending';
-- An automatically updatable view adapts plot review to the shared approval API.
-- Its status is approval state, never the plot's business status.
CREATE OR REPLACE VIEW plot_status_approvals AS
SELECT id, site_id, id AS plot_id, plot_no, buyer_name, scheme,
  status AS plot_status, approval_status AS status, assigned_admin_id,
  approval_requested_by AS created_by, approval_requested_at AS created_at,
  approval_requested_at::date AS date, approved_by, approved_at, updated_at,
  0::numeric AS amount
FROM plots;
INSERT INTO app_schema_migrations(version) VALUES ('158_plot_status_approval') ON CONFLICT DO NOTHING;
`;

async function up() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('158_plot_status_approval'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(migrationSql);
    await client.query('COMMIT');
    console.log('Migration 158: plot scheme and status approval ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
if (process.argv[1]?.endsWith('158_plot_status_approval.js')) {
  up().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
