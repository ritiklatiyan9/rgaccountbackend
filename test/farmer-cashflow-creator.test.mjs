import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { up } from '../src/migrations/247_farmer_cashflow_creator.js';
import { lockedCashCollectorSql } from '../src/migrations/211_locked_cash_collector.js';

test('farmer mirrors retain the real creator through creation, approval, date edits and legacy sync reinstalls', { skip: !process.env.PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, values) => values?.length ? pg.query(sql, values) : (await pg.exec(sql)).at(-1);
  const database = { connect: async () => ({ query, release() {} }) };
  try {
    await pg.exec(await readFile(new URL('./fixtures/transaction-transfer-schema.sql', import.meta.url), 'utf8'));
    await pg.exec(`CREATE TABLE farmers(id int PRIMARY KEY,site_id int,name text);
      INSERT INTO farmers VALUES(51,5,'NEERAJ RANA'),(52,6,'Other farmer');
      CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
      INSERT INTO cash_flow_months(id,site_id,month,year,ledger_name,ledger_type) VALUES(1,5,11,2026,'','site');`);
    for (const table of ['farmer_payments', 'cash_flow_entries']) await pg.exec(`ALTER TABLE ${table}
      ADD COLUMN loyalty_vault_holder_type text,ADD COLUMN loyalty_vault_holder_id integer,ADD COLUMN loyalty_vault_assigned_by integer;`);
    await pg.exec(lockedCashCollectorSql);
    for (const table of ['farmer_payments', 'cash_flow_entries']) await pg.exec(`CREATE TRIGGER cash_wallet_collector_lock
      BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION cash_wallet_lock_source_collector()`);
    const baseline = await readFile(new URL('../src/migrations/086_cashflow_mode_bucket.js', import.meta.url), 'utf8');
    const syncSql = baseline.match(/const SYNC_FN = `([\s\S]*?)`;/)[1];
    const legacySql = syncSql.replace(/(v_remarks := NEW\.remarks;\s*)v_created_by := NEW\.created_by;/, '$1v_created_by := NULL;');
    assert.notEqual(legacySql, syncSql, 'reproduce the historical farmer-specific bug');
    await pg.exec(baseline.match(/const BUCKET_FN = `([\s\S]*?)`;/)[1]);
    await pg.exec(legacySql);
    await pg.exec('CREATE TRIGGER farmer_sync AFTER INSERT OR UPDATE OR DELETE ON farmer_payments FOR EACH ROW EXECUTE FUNCTION sync_cashflow_from_modules()');
    await pg.exec(`INSERT INTO farmer_payments(id,farmer_id,date,particular,amount,payment_mode,bank_amount,created_by,status,approved_by,approved_at,remarks)
      VALUES(1214,51,'2026-11-14','NEFT',-935000,'BANK',-935000,5,'approved',7,'2026-11-14T09:53:13Z','CASH TO BNK');`);
    const mirror = async () => (await pg.query("SELECT * FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=1214")).rows[0];
    assert.equal((await mirror()).created_by, null, 'the historical sync loses Ravi');
    const original = await mirror();
    assert.equal(await up(database), true);
    assert.equal(await up(database), false, 'installation is idempotent');
    await pg.exec("UPDATE farmer_payments SET date='2026-11-05' WHERE id=1214");
    const corrected = await mirror();
    assert.equal(corrected.created_by, 5);
    assert.equal(new Date(corrected.date).toISOString().slice(0, 10), '2026-11-05');
    for (const key of ['id','debit','credit','cash_type','status','approved_by','approved_at','created_at','remarks']) assert.deepEqual(corrected[key], original[key], key);
    await pg.exec(syncSql);
    await pg.exec(legacySql); // A repeatable old migration cannot reintroduce the bug.
    await pg.exec("UPDATE farmer_payments SET status='pending',approved_by=NULL,approved_at=NULL WHERE id=1214");
    assert.equal((await mirror()).created_by, 5);
    await pg.exec("UPDATE farmer_payments SET status='approved',approved_by=7,approved_at='2026-11-14T09:53:13Z' WHERE id=1214");
    assert.equal((await mirror()).created_by, 5);
    await pg.exec("UPDATE cash_flow_entries SET created_by=NULL WHERE source_module='farmer_payments' AND source_id=1214");
    assert.equal((await mirror()).created_by, 5, 'direct mirror writes cannot clear the real creator');
    await pg.exec(`INSERT INTO farmer_payments(id,farmer_id,date,particular,amount,payment_mode,created_by)
      VALUES(1215,52,'2026-11-15','CASH',25,'CASH',8),(1216,51,'2026-11-15','CASH',10,'CASH',NULL);`);
    assert.equal((await pg.query("SELECT created_by FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=1215")).rows[0].created_by, 8);
    assert.equal((await pg.query("SELECT created_by FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=1216")).rows[0].created_by, null, 'unknown historical creators are never invented');
    await pg.exec("DELETE FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=1215");
    await pg.exec(`INSERT INTO cash_flow_entries(cash_flow_month_id,site_id,date,particular,created_by,source_module,source_id)
      VALUES(1,5,'2026-11-15','Unrelated',7,'expenses',999),(1,5,'2026-11-15','Wrong site',NULL,'farmer_payments',1215);`);
    const foreign = (await pg.query("SELECT created_by FROM cash_flow_entries WHERE source_module='farmer_payments' AND source_id=1215 AND site_id=5")).rows;
    assert.equal(foreign[0]?.created_by, null, 'a source ID from a different site cannot supply an identity');
    assert.equal((await pg.query("SELECT created_by FROM cash_flow_entries WHERE source_module='expenses' AND source_id=999")).rows[0].created_by, 7);
    await assert.rejects(pg.exec('UPDATE farmer_payments SET created_by=7 WHERE id=1214'), /original transaction maker cannot be changed/);
    await assert.rejects(pg.exec("UPDATE cash_flow_entries SET created_by=8 WHERE source_module='expenses' AND source_id=999"), /original transaction maker cannot be changed/);
    await assert.rejects(pg.exec("UPDATE farmer_payments SET loyalty_vault_holder_type='user',loyalty_vault_holder_id=7 WHERE id=1214"), /original cash collector cannot be changed/);
  } finally { await pg.close(); }
});
