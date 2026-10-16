import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { up, CUTOFF, MAX_HISTORICAL_ENTRY_ID, VERSION } from '../src/migrations/216_historical_cheque_entry_dates.js';

async function fixture() {
  const embedded = new PGlite();
  const client = { query: async (sql, params) => params?.length ? embedded.query(sql, params) : (await embedded.exec(sql)).at(-1), release() {} };
  await client.query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,date date,created_at timestamptz,
      updated_at timestamptz,cheque_status text,cheque_transaction_date date,credit numeric,debit numeric,source_module text);
    INSERT INTO cash_flow_entries VALUES
      (1,8,'2025-01-12','2026-10-01',now(),'CLEARED',NULL,100,0,'plot_payments'),
      (2,5,'2025-02-13','2026-10-01',now(),'CLEARED','2025-02-20',0,200,'expenses'),
      (3,8,'2026-10-02','2026-10-01',now(),'PENDING',NULL,300,0,'plot_payments'),
      (4,8,'2026-10-03','2026-10-01',now(),'BOUNCED',NULL,400,0,'plot_payments'),
      (5,8,'2026-10-04','2026-10-01',now(),'RETURNED',NULL,500,0,'plot_payments'),
      (6,8,'2026-10-04','2026-10-17',now(),'CLEARED',NULL,600,0,'plot_payments'),
      (7,8,'20225-12-02','2026-10-01',now(),'CLEARED',NULL,700,0,'plot_payments'),
      (8,8,'2026-10-27','2026-10-01',now(),'CLEARED',NULL,800,0,'plot_payments'),
      (9,5,'2026-10-10','2026-10-01',now(),'CLEARED',NULL,0,900,'expenses'),
      (10,5,'2026-10-11','2026-10-01',now(),NULL,NULL,1000,0,'day_book'),
      (${MAX_HISTORICAL_ENTRY_ID + 1},8,'2026-10-04','2026-10-01',now(),'CLEARED',NULL,1100,0,'plot_payments');`);
  await client.query(`ALTER TABLE cash_flow_entries ADD COLUMN cheque_status_updated_at timestamptz;
    INSERT INTO cash_flow_entries(id,site_id,date,created_at,cheque_status_updated_at,cheque_status,credit,debit)
      VALUES(11,8,'2026-10-01','2026-10-01','2026-10-17','CLEARED',1200,0);`);
  return { embedded, client, adapter: { connect: async () => client } };
}

test('historical backfill copies entry dates only to existing cleared cheques, records provenance and runs once', async () => {
  const { embedded, client, adapter } = await fixture();
  try {
    const before = (await client.query('SELECT id,date::text,credit,debit,cheque_status FROM cash_flow_entries ORDER BY id')).rows;
    assert.deepEqual(await up(adapter), { applied: true, updated: 2, cutoff: CUTOFF });
    assert.deepEqual((await client.query('SELECT id,date::text,credit,debit,cheque_status FROM cash_flow_entries ORDER BY id')).rows,before);
    const dates = new Map((await client.query('SELECT id,cheque_transaction_date::text AS date FROM cash_flow_entries')).rows.map(row => [row.id,row.date]));
    assert.equal(dates.get(1),'2025-01-12');
    assert.equal(dates.get(9),'2026-10-10');
    assert.equal(dates.get(2),'2025-02-20','actual recorded clearing date is preserved');
    for (const id of [3,4,5,6,7,8,10,11,MAX_HISTORICAL_ENTRY_ID+1]) assert.equal(dates.get(id),null);
    const history = (await client.query('SELECT * FROM cheque_date_backfill_history ORDER BY entry_id')).rows;
    assert.equal(history.length,2);
    assert.equal(history[0].before_row.cheque_transaction_date,null);
    assert.equal(history[0].basis,'user_requested_historical_entry_date');
    // Clearing an old pending row after the cutover cannot pick up the fallback.
    await client.query("UPDATE cash_flow_entries SET cheque_status='CLEARED' WHERE id=3");
    assert.deepEqual(await up(adapter), { applied:false,updated:0 });
    assert.equal((await client.query('SELECT cheque_transaction_date FROM cash_flow_entries WHERE id=3')).rows[0].cheque_transaction_date,null);
  } finally { await embedded.close(); }
});

test('an unexpected accounting trigger change rolls back both the dates and audit history', async () => {
  const { embedded, client, adapter } = await fixture();
  try {
    await client.query(`CREATE FUNCTION bad_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.credit:=NEW.credit+1; RETURN NEW; END $$;
      CREATE TRIGGER bad_backfill BEFORE UPDATE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION bad_trigger();`);
    await assert.rejects(up(adapter),/changed unexpected source fields/);
    assert.equal((await client.query('SELECT cheque_transaction_date,credit FROM cash_flow_entries WHERE id=1')).rows[0].cheque_transaction_date,null);
    assert.equal(Number((await client.query('SELECT credit FROM cash_flow_entries WHERE id=1')).rows[0].credit),100);
    assert.equal((await client.query('SELECT 1 FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length,0);
    assert.equal((await client.query("SELECT to_regclass('cheque_date_backfill_history') AS name")).rows[0].name,null);
  } finally { await embedded.close(); }
});
