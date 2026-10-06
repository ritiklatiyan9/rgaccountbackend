import assert from 'node:assert/strict';
import test from 'node:test';
import { up } from '../src/migrations/195_imprest_cash_funding_guard.js';

test('database cash funding guard preserves history and blocks unfunded imprest', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const db = { query: (sql, args) => args?.length ? pg.query(sql,args) : pg.exec(sql).then(r=>r.at(-1)), release() {} };
  const pool = { connect: async () => db };
  const available = async site => Number((await pg.query('SELECT imprest_available_site_cash($1) AS amount',[site])).rows[0].amount);
  const rejectsCash = async sql => assert.rejects(pg.query(sql), e => e.constraint === 'imprest_site_cash_funding');
  try {
    await pg.exec(`
      CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,role text);
      INSERT INTO users VALUES(1,'admin'),(2,'sub_admin'),(3,'sub_admin');
      CREATE TABLE ledger_entries(site_id integer,bucket text,credit numeric,debit numeric,entry_date date);
      INSERT INTO ledger_entries VALUES(1,'cash',100,0,current_date),(3,'bank',1000000,0,current_date),
        (4,'cash',100,0,current_date),(5,'cash',50,0,current_date),(7,'cash',100,0,current_date),
        (8,'cash',100,0,current_date),(9,'cash',100,0,current_date),
        (10,'cash',1000000,0,current_date+10);
      CREATE TABLE imprest_allocations(id serial PRIMARY KEY,site_id integer,admin_id integer,sub_admin_id integer,
        amount numeric,status text,from_own_float boolean DEFAULT false,created_at timestamptz DEFAULT now(),override_reason text);
      INSERT INTO imprest_allocations(id,site_id,admin_id,sub_admin_id,amount,status) VALUES
        (51,5,1,2,100,'PENDING_RECEIPT'),(71,7,1,2,100,'PENDING_RECEIPT');
      CREATE TABLE imprest_ledger(id serial PRIMARY KEY,site_id integer,user_id integer,created_by integer,amount numeric,
        type text,source_module text,created_at timestamptz DEFAULT now());
      INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(4,2,1,200,'ALLOCATION');
      CREATE TABLE imprest_transfers(id serial PRIMARY KEY,site_id integer,from_user_id integer,to_user_id integer,amount numeric);
      CREATE TABLE imprest_expense_requests(id serial PRIMARY KEY,site_id integer,assigned_admin_id integer,amount numeric,request_type text,status text);
    `);
    const before = (await pg.query('SELECT * FROM imprest_ledger ORDER BY id')).rows;
    await up(pool); await up(pool);
    await t.test('migration is idempotent and does not rewrite existing balances',async()=> {
      assert.deepEqual((await pg.query('SELECT * FROM imprest_ledger ORDER BY id')).rows,before);
      assert.equal(await available(4),-100);
    });
    await t.test('zero cash, bank-only funds, existing deficits and future cash cannot fund new handovers',async()=> {
      for(const site of [2,3,4,10]) {
        await rejectsCash(`INSERT INTO imprest_allocations(site_id,admin_id,sub_admin_id,amount,status,override_reason)
          VALUES(${site},1,2,1,'PENDING_RECEIPT','temporary override')`);
        await rejectsCash(`INSERT INTO imprest_expense_requests(site_id,amount,request_type,status) VALUES(${site},1,'IMPREST','PENDING')`);
      }
    });
    await t.test('reservations stop a second handover from spending the same cash',async()=> {
      await pg.query("INSERT INTO imprest_allocations(site_id,admin_id,sub_admin_id,amount,status) VALUES(1,1,2,100,'PENDING_RECEIPT')");
      assert.equal(await available(1),0);
      await rejectsCash("INSERT INTO imprest_allocations(site_id,admin_id,sub_admin_id,amount,status) VALUES(1,1,3,1,'PENDING_RECEIPT')");
    });
    await t.test('a covered pending receipt can consume its own reservation exactly once',async()=> {
      await pg.exec("BEGIN; UPDATE imprest_allocations SET status='RECEIVED' WHERE id=71; INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(7,2,1,100,'ALLOCATION'); COMMIT;");
      assert.equal(await available(7),0);
      await rejectsCash("INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(7,2,1,1,'ALLOCATION')");
    });
    await t.test('an underfunded legacy receipt is blocked but cancellation remains available',async()=> {
      await rejectsCash("UPDATE imprest_allocations SET status='RECEIVED' WHERE id=51");
      assert.equal((await pg.query('SELECT status FROM imprest_allocations WHERE id=51')).rows[0].status,'PENDING_RECEIPT');
      await pg.query("UPDATE imprest_allocations SET status='CANCELLED' WHERE id=51");
      assert.equal(await available(5),50);
    });
    await t.test('manual credits and Admin transfers also obey cash and allow the exact balance',async()=> {
      await rejectsCash("INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(8,2,1,101,'ADJUSTMENT')");
      await pg.query("INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(8,2,1,100,'ADJUSTMENT')");
      await rejectsCash("INSERT INTO imprest_transfers(site_id,from_user_id,to_user_id,amount) VALUES(8,1,3,1)");
      await rejectsCash("INSERT INTO imprest_transfers(site_id,from_user_id,to_user_id,amount) VALUES(9,1,3,101)");
      await pg.query("INSERT INTO imprest_transfers(site_id,from_user_id,to_user_id,amount) VALUES(9,1,3,100)");
    });
    await t.test('staff transfers, cash returns and source reversals remain possible on a shortfall site',async()=> {
      await pg.query("INSERT INTO imprest_allocations(site_id,admin_id,sub_admin_id,amount,status,from_own_float) VALUES(4,2,3,10,'PENDING_RECEIPT',true)");
      await pg.query("INSERT INTO imprest_expense_requests(site_id,assigned_admin_id,amount,request_type,status) VALUES(4,2,10,'IMPREST','PENDING')");
      await pg.query("INSERT INTO imprest_transfers(site_id,from_user_id,to_user_id,amount) VALUES(4,2,1,10)");
      await pg.query("INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type,source_module) VALUES(4,2,1,10,'ADJUSTMENT','expenses')");
      await pg.query("INSERT INTO imprest_ledger(site_id,user_id,created_by,amount,type) VALUES(4,2,1,-10,'REFUND')");
      await pg.query("UPDATE imprest_ledger SET source_module=source_module WHERE site_id=4");
    });
  } finally { await pg.close(); }
});
