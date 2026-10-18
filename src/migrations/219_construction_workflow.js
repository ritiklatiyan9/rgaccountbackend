import { pathToFileURL } from 'node:url';

// Additive migration: existing lifecycle values and financial history are retained.
export const constructionWorkflowSchemaSql = `
ALTER TABLE construction_projects DROP CONSTRAINT IF EXISTS construction_projects_status_check;
ALTER TABLE construction_projects ADD CONSTRAINT construction_projects_status_check CHECK(status IN
 ('NEED','REVIEW','APPROVED','COMMITTED','IN_PROGRESS','ON_HOLD','COMPLETED','CLOSED','CANCELLED','PLANNING','ACTIVE','DELAYED'));
ALTER TABLE construction_projects ALTER COLUMN status SET DEFAULT 'NEED';
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS scope text;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS priority varchar(12) NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT'));
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS assigned_approver_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS requested_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS approved_by integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE construction_projects ADD COLUMN IF NOT EXISTS actual_start_date date;
ALTER TABLE construction_tasks ADD COLUMN IF NOT EXISTS owner_user_id integer REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE construction_tasks ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE construction_tasks ADD COLUMN IF NOT EXISTS is_milestone boolean NOT NULL DEFAULT false;
ALTER TABLE vendor_commitments ADD COLUMN IF NOT EXISTS terms text;
CREATE TABLE IF NOT EXISTS construction_project_quotes (
 id serial PRIMARY KEY,project_id integer NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
 vendor_member_id integer REFERENCES members(id) ON DELETE SET NULL,vendor_name varchar(200) NOT NULL,
 amount numeric(14,2) NOT NULL CHECK(amount>0),scope text,terms text,quote_date date NOT NULL DEFAULT CURRENT_DATE,
 valid_until date,status varchar(16) NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','SHORTLISTED','REJECTED','SELECTED')),
 commitment_id integer REFERENCES vendor_commitments(id) ON DELETE RESTRICT,
 created_by integer REFERENCES users(id) ON DELETE SET NULL,updated_by integer REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_until IS NULL OR valid_until>=quote_date),CHECK((status='SELECTED')=(commitment_id IS NOT NULL))
);
ALTER TABLE vendor_commitments ADD COLUMN IF NOT EXISTS selected_quote_id integer REFERENCES construction_project_quotes(id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX IF NOT EXISTS construction_commitment_selected_quote ON vendor_commitments(selected_quote_id) WHERE selected_quote_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS construction_project_activity (
 id bigserial PRIMARY KEY,project_id integer NOT NULL REFERENCES construction_projects(id) ON DELETE RESTRICT,
 actor_id integer REFERENCES users(id) ON DELETE SET NULL,action varchar(80) NOT NULL,
 entity_type varchar(30) NOT NULL DEFAULT 'project',entity_id integer,details jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS construction_project_activity_project ON construction_project_activity(project_id,id DESC);
CREATE INDEX IF NOT EXISTS construction_quotes_project ON construction_project_quotes(project_id,status,id DESC);
CREATE INDEX IF NOT EXISTS construction_project_owner ON construction_projects(site_id,owner_user_id);
CREATE INDEX IF NOT EXISTS construction_task_owner ON construction_tasks(project_id,owner_user_id);
`;
export async function up(pool) {
 const client=await pool.connect();
 try { await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('219_construction_workflow'))");await client.query(constructionWorkflowSchemaSql);await client.query("INSERT INTO app_schema_migrations(version) VALUES('219_construction_workflow') ON CONFLICT DO NOTHING");await client.query('COMMIT'); }
 catch(error) { await client.query('ROLLBACK');throw error; } finally {client.release();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
 const {default:pool}=await import('../config/db.js');
 try {await up(pool);console.log('Construction workflow schema ready.');} finally {await pool.end();}
}
