import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';
import { TRANSACTION_TIME_TABLES } from '../services/transactionTime.service.js';

export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('148_transaction_time'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const applied = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '148_transaction_time'");
    if (applied.rowCount) { await client.query('COMMIT'); return; }
    for (const table of TRANSACTION_TIME_TABLES) {
      // Separate ADD and SET DEFAULT deliberately leaves legacy times unknown.
      await client.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS transaction_time TIME(0)`);
      await client.query(`ALTER TABLE ${table} ALTER COLUMN transaction_time SET DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::time(0)`);
    }
    const sourceTables = [...TRANSACTION_TIME_TABLES].filter(table => table !== 'cash_flow_entries');
    await client.query(`CREATE OR REPLACE FUNCTION sync_cashflow_transaction_time() RETURNS trigger AS $$
      DECLARE source_table text := regexp_replace(NEW.source_module, '_person$', '');
      BEGIN
        IF source_table = ANY(ARRAY[${sourceTables.map(table => `'${table}'`).join(',')}]) AND NEW.source_id IS NOT NULL THEN
          EXECUTE format('SELECT transaction_time FROM %I WHERE id = $1', source_table)
            INTO NEW.transaction_time USING NEW.source_id;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await client.query(`CREATE TRIGGER sync_cashflow_transaction_time
      BEFORE INSERT OR UPDATE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION sync_cashflow_transaction_time()`);
    await client.query(`CREATE OR REPLACE FUNCTION sync_source_transaction_time() RETURNS trigger AS $$
      BEGIN
        UPDATE cash_flow_entries SET transaction_time = NEW.transaction_time
          WHERE source_module IN (TG_TABLE_NAME, TG_TABLE_NAME || '_person') AND source_id = NEW.id
            AND transaction_time IS DISTINCT FROM NEW.transaction_time;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    for (const table of sourceTables) {
      await client.query(`CREATE TRIGGER zz_sync_source_transaction_time
        AFTER UPDATE OF transaction_time ON ${table}
        FOR EACH ROW WHEN (OLD.transaction_time IS DISTINCT FROM NEW.transaction_time)
        EXECUTE FUNCTION sync_source_transaction_time()`);
    }
    // A linked receipt/allocation is a copy of an existing payment. Its time
    // follows that payment, including NULL for legacy records.
    await client.query(`CREATE OR REPLACE FUNCTION inherit_linked_transaction_time() RETURNS trigger AS $$
      DECLARE source_id integer;
      BEGIN
        source_id := (to_jsonb(NEW)->>TG_ARGV[1])::integer;
        IF source_id IS NOT NULL THEN
          EXECUTE format('SELECT transaction_time FROM %I WHERE id = $1', TG_ARGV[0])
            INTO NEW.transaction_time USING source_id;
        END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    for (const [copy, source, foreignKey] of [
      ['plot_registry_payments', 'plot_payments', 'source_plot_payment_id'],
      ['vendor_inventory_payments', 'vendor_payments', 'source_vendor_payment_id'],
    ]) {
      await client.query(`CREATE TRIGGER inherit_linked_transaction_time
        BEFORE INSERT OR UPDATE ON ${copy} FOR EACH ROW
        EXECUTE FUNCTION inherit_linked_transaction_time('${source}', '${foreignKey}')`);
      await client.query(`CREATE OR REPLACE FUNCTION sync_${copy}_time() RETURNS trigger AS $$
        BEGIN
          UPDATE ${copy} SET transaction_time = NEW.transaction_time
            WHERE ${foreignKey} = NEW.id AND transaction_time IS DISTINCT FROM NEW.transaction_time;
          RETURN NEW;
        END;
      $$ LANGUAGE plpgsql`);
      await client.query(`CREATE TRIGGER zz_sync_linked_transaction_time AFTER UPDATE OF transaction_time ON ${source}
        FOR EACH ROW WHEN (OLD.transaction_time IS DISTINCT FROM NEW.transaction_time)
        EXECUTE FUNCTION sync_${copy}_time()`);
    }
    await client.query("INSERT INTO app_schema_migrations(version) VALUES ('148_transaction_time')");
    await client.query('COMMIT');
    console.log('Migration 148: transaction time is ready');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
