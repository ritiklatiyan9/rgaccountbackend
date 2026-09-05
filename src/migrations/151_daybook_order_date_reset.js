import { pathToFileURL } from 'node:url';
import pool from '../config/db.js';

// A re-dated entry must take its place under the new date instead of keeping
// the slot it held under the old one. Dropping its saved positions lets the
// shared sequence order (SEQUENCE_ORDER_BY) slot it in by its new date.
export async function up(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('151_daybook_order_date_reset'))");
    await client.query("SET LOCAL lock_timeout = '5s'");
    const applied = await client.query("SELECT 1 FROM app_schema_migrations WHERE version = '151_daybook_order_date_reset'");
    if (applied.rowCount) { await client.query('COMMIT'); return; }
    await client.query(`CREATE OR REPLACE FUNCTION reset_daybook_order_on_date_change() RETURNS trigger AS $$
      DECLARE target_key text := COALESCE(NEW.source_module, 'personal_ledger') || ':' || COALESCE(NEW.source_id::text, NEW.id::text);
      BEGIN
        DELETE FROM daybook_global_order WHERE site_id = NEW.site_id AND entry_key = target_key;
        DELETE FROM daybook_entry_order WHERE site_id = NEW.site_id AND entry_key = target_key AND entry_date IN (OLD.date, NEW.date);
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql`);
    await client.query('DROP TRIGGER IF EXISTS trg_reset_daybook_order_on_date_change ON cash_flow_entries');
    await client.query(`CREATE TRIGGER trg_reset_daybook_order_on_date_change
      AFTER UPDATE OF date ON cash_flow_entries FOR EACH ROW
      WHEN (OLD.date IS DISTINCT FROM NEW.date)
      EXECUTE FUNCTION reset_daybook_order_on_date_change()`);
    await client.query("INSERT INTO app_schema_migrations (version) VALUES ('151_daybook_order_date_reset')");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  up().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
}
