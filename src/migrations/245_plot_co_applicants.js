import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
export const VERSION = '245_plot_co_applicants';
export const migrationSql = `
ALTER TABLE plots ADD COLUMN IF NOT EXISTS co_applicants JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE plots DROP CONSTRAINT IF EXISTS plots_co_applicants_array;
ALTER TABLE plots ADD CONSTRAINT plots_co_applicants_array CHECK (jsonb_typeof(co_applicants)='array' AND jsonb_array_length(co_applicants)<=50);
CREATE INDEX IF NOT EXISTS idx_plots_co_applicants ON plots USING gin(co_applicants jsonb_path_ops);

`;
export async function up(database=pool) {
  const client=await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('245_plot_co_applicants'))");
    await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    const installed=(await client.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length;
    if(!installed) { await client.query(migrationSql); await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)',[VERSION]); }
    await client.query('COMMIT'); return !installed;
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) up().then(applied=>console.log(applied?'Plot co-applicants installed; existing details preserved':'Plot co-applicants already installed')).catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>pool.end());
