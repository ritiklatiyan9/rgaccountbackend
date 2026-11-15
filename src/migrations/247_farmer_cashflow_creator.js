import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { lockedCashCollectorSql } from './211_locked_cash_collector.js';

export const VERSION = '247_farmer_cashflow_creator';

// Keep the owner-derived identity even if a legacy repeatable migration
// reinstalls the old module-sync function that supplied a NULL creator.
export const migrationSql = `
CREATE OR REPLACE FUNCTION sync_farmer_cashflow_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source_creator integer;
BEGIN
  SELECT fp.created_by INTO source_creator
  FROM farmer_payments fp JOIN farmers f ON f.id=fp.farmer_id
  WHERE fp.id=NEW.source_id AND f.site_id=NEW.site_id;
  IF FOUND THEN
    NEW.created_by := source_creator;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS aa_farmer_cashflow_creator ON cash_flow_entries;
CREATE TRIGGER aa_farmer_cashflow_creator
BEFORE INSERT OR UPDATE ON cash_flow_entries
FOR EACH ROW WHEN (NEW.source_module='farmer_payments')
EXECUTE FUNCTION sync_farmer_cashflow_creator();
`;

export async function installInTransaction(client) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext('247_farmer_cashflow_creator'))");
  await client.query('CREATE TABLE IF NOT EXISTS app_schema_migrations(version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  // Repeatable legacy wallet migrations may reinstall this shared function.
  // Restore its narrowly source-verified repair rule on every startup too.
  await client.query(lockedCashCollectorSql);
  const installed = (await client.query('SELECT 1 FROM app_schema_migrations WHERE version=$1', [VERSION])).rows.length;
  if (installed) return false;
  await client.query(migrationSql);
  await client.query('INSERT INTO app_schema_migrations(version) VALUES($1)', [VERSION]);
  return true;
}

export async function up(database = pool) {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    const applied = await installInTransaction(client);
    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().then(applied => console.log(applied ? 'Farmer cash-flow creator protection installed' : 'Farmer cash-flow creator protection already installed'))
    .catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
