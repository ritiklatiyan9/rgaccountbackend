import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createRequestHistoryReader,requestHistoryOptions} from '../src/services/requestHistory.service.js';
import {decodeHistoryCursor} from '../src/services/requestHistoryCursor.js';
import {up,down} from '../src/migrations/236_history_keyset_order.js';

test('cursor pages preserve microseconds, numeric/UUID ties and null dates while excluding new/backdated arrivals',async()=>{
  const db=new PGlite();const sql=[];
  const measured={query(text,values){sql.push(text);return db.query(text,values);}};
  try{
    await db.exec(`CREATE TABLE users(id int PRIMARY KEY,name text,email text);INSERT INTO users VALUES(7,'Reviewer','fixture@test');
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,status text,approved_at timestamptz,created_at timestamptz,approved_by int,amount numeric,original_data jsonb,notes text,voucher_url text);
      INSERT INTO expenses VALUES(2,1,'approved','2021-01-01 00:00:00.000002Z','2020-01-01',7,10.25,'{"private":"large snapshot"}','Invoice 50%_',NULL),
        (10,1,'approved','2021-01-01 00:00:00.000002Z','2020-01-01',7,20.50,'{}','Other',NULL),
        (3,1,'rejected','2021-01-01 00:00:00.000001Z','2020-01-01',7,30,'{}','Other',NULL),(4,1,'approved',NULL,NULL,7,40,'{}','Undated',NULL);
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,site_id int,status text,resolved_at timestamptz,created_at timestamptz,amount numeric);
      INSERT INTO loyalty_vault_transfers VALUES('10000000-0000-0000-0000-000000000001',1,'accepted','2021-01-01 00:00:00.000002Z','2020-01-01',5);`);
    const read=async(query={},scope='user-7')=>{
      const options=requestHistoryOptions({site_id:'1',pagination:'cursor',view:'summary',include_total:'false',page_size:'1',...query});
      options.authorizationScope=scope;const reader=createRequestHistoryReader(measured,options);
      reader.add("SELECT e.*,'expense' AS source FROM expenses e WHERE site_id=$1",[1]);
      reader.add("SELECT t.*,'wallet_transfer' AS source FROM loyalty_vault_transfers t WHERE site_id=$1",[1]);
      return reader.read();
    };
    let page=await read(),cursor=page.nextCursor;
    assert.equal(page.rows[0].id,10);assert.equal(page.total,null);
    assert.equal(decodeHistoryCursor(cursor).key.time.includes('000002'),true,'the cursor never rounds database microseconds');
    assert.equal(page.rows[0].amount,'20.50');assert.ok(!('original_data'in page.rows[0]));assert.ok(!('voucher_url'in page.rows[0]));
    const started=[];started.push(...page.rows.map(row=>`${row.source}:${row.id}`));
    const future=new Date(Date.now()+10000).toISOString();
    await db.query(`INSERT INTO expenses VALUES(100,1,'approved',$1,$1,7,100,'{}','New',NULL),
      (101,1,'approved','2020-01-01',$1,7,100,'{}','Backdated new arrival',NULL)`,[future]);
    while(cursor){page=await read({after:cursor});started.push(...page.rows.map(row=>`${row.source}:${row.id}`));cursor=page.nextCursor;}
    assert.deepEqual(started,['expense:10','expense:2','wallet_transfer:10000000-0000-0000-0000-000000000001','expense:3','expense:4']);
    assert.ok(!sql.at(-1).includes('sum(n)'),'cursor reads skip global counts when not requested');
    // OFFSET is used only on the fixed, one-row lookahead to select the last
    // returned key, never to scan preceding archive pages.
    assert.ok(!/FROM matched[\s\S]*?OFFSET/.test(sql.at(-1).split('page AS MATERIALIZED')[0]));
    const first=await read();
    await assert.rejects(read({after:first.nextCursor},'other-user'),error=>error.code==='HISTORY_CURSOR_INVALID');
    await assert.rejects(read({after:first.nextCursor,status:'rejected'}),error=>error.code==='HISTORY_CURSOR_INVALID');
    assert.throws(()=>requestHistoryOptions({site_id:'1',pagination:'cursor',after:first.nextCursor+'x'}),error=>error.code==='HISTORY_CURSOR_INVALID');
    const full=await read({source:'expense',record_id:'2',view:'full',pagination:'offset'});
    assert.equal(full.rows.length,1);assert.equal(full.rows[0].original_data.private,'large snapshot');
    const found=await read({q:'50%_'});assert.equal(found.rows[0].id,2);
  }finally{await db.close();}
});

test('ordering index migration replaces rather than duplicates archive indexes and can roll back',async()=>{
  const db=new PGlite();try{
    await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE expenses(id int PRIMARY KEY,site_id int,status text,approved_at timestamp,updated_at timestamptz,created_at timestamptz,date date);
      CREATE INDEX request_history_expenses ON expenses(site_id,lower(status),id DESC);
      CREATE VIEW plot_status_approvals AS SELECT * FROM expenses;`);
    const pool={connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
    assert.equal((await up(pool,{concurrently:false})).length,1);
    assert.deepEqual(await up(pool,{concurrently:false}),[]);
    let rows=(await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='request_history_expenses'")).rows;
    assert.match(rows[0].indexdef,/COALESCE/);assert.match(rows[0].indexdef,/AT TIME ZONE/);
    assert.equal((await down(pool,{concurrently:false})).length,1);
    rows=(await db.query("SELECT indexdef FROM pg_indexes WHERE indexname='request_history_expenses'")).rows;
    assert.ok(!rows[0].indexdef.includes('COALESCE'));
    assert.equal((await db.query("SELECT indexname FROM pg_indexes WHERE indexname LIKE 'rh_%' AND tablename='expenses'")).rows.length,0);
  }finally{await db.close();}
});
