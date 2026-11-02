import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {inlineWalletLedgerDefinition,up,down,ensureWalletLedgerInlining,VERSION} from '../src/migrations/233_wallet_ledger_inlining.js';

const definition=`WITH raw_base AS (SELECT * FROM source_rows),
 base AS MATERIALIZED (SELECT * FROM raw_base WHERE status='approved'),
 posted AS (SELECT *,CASE WHEN mode='SPLIT' THEN cash_amount ELSE amount END AS effective FROM base)
 SELECT id::text AS id,site_id,created_by,effective AS amount,GREATEST(effective,0) AS credit,GREATEST(-effective,0) AS debit,'cash'::text AS bucket FROM posted WHERE mode IN ('CASH','SPLIT')
 UNION ALL SELECT id||':bank',site_id,created_by,CASE WHEN mode='SPLIT' THEN bank_amount ELSE amount END,GREATEST(CASE WHEN mode='SPLIT' THEN bank_amount ELSE amount END,0),GREATEST(-CASE WHEN mode='SPLIT' THEN bank_amount ELSE amount END,0),'bank' FROM posted WHERE mode IN ('BANK','SPLIT')`;

test('ledger optimization changes only trusted CTE directives, preserves literals and fails closed on unexpected policy shapes',()=>{
 const source=definition.replace('SELECT * FROM source_rows',()=>"SELECT *, 'base AS (', '₹ label', E'raw_base AS (', $$posted AS ($$ FROM source_rows");
 const optimized=inlineWalletLedgerDefinition(source);
 assert.equal(optimized.changed,true);
 assert.equal((optimized.definition.match(/AS NOT MATERIALIZED \(/g)||[]).length,3);
 assert.ok(optimized.definition.includes("'base AS ('"));assert.ok(optimized.definition.includes('$$posted AS ($$'));
 assert.equal(inlineWalletLedgerDefinition(optimized.definition).changed,false);
 assert.throws(()=>inlineWalletLedgerDefinition('WITH base AS (SELECT 1) SELECT * FROM base'),/exactly one raw_base/);
 assert.throws(()=>inlineWalletLedgerDefinition(definition+', raw_base AS (SELECT 1)'),/exactly one raw_base/);
});

test('120000 transactions retain exact financial results, view schema, source fingerprints and safe reversible startup',async()=>{
 const pg=new PGlite();let writes=0;
 const query=async(sql,args)=>{if(!/^SELECT|^EXPLAIN/i.test(sql))writes++;const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[]};};
 const db={query,connect:async()=>({query,release(){}})};
 const financial=async()=> (await query('SELECT site_id,bucket,count(*)::int AS count,sum(amount)::text AS balance FROM ledger_entries GROUP BY site_id,bucket ORDER BY site_id,bucket')).rows;
 const fingerprint=async()=> (await query("SELECT count(*)::int AS count,md5(string_agg(to_jsonb(s)::text,'|' ORDER BY id)) AS hash FROM source_rows s")).rows;
 const columns=async()=> (await query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='ledger_entries' ORDER BY ordinal_position")).rows;
 try{
  await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE source_rows(id integer PRIMARY KEY,site_id integer,created_by integer,status text,mode text,amount numeric(15,2),cash_amount numeric(15,2),bank_amount numeric(15,2));
    INSERT INTO source_rows SELECT i,(i%20)+1,(i%51)+1,CASE WHEN i%7=0 THEN 'pending' WHEN i%11=0 THEN 'rejected' ELSE 'approved' END,
      CASE WHEN i%5=0 THEN 'SPLIT' WHEN i%3=0 THEN 'BANK' ELSE 'CASH' END,((i%997)-499)::numeric/100,((i%307)-154)::numeric/100,((i%251)-126)::numeric/100 FROM generate_series(1,120000)i;
    CREATE VIEW ledger_entries AS ${definition};ANALYZE source_rows;`);
  const before=await financial(),sourceBefore=await fingerprint(),columnsBefore=await columns();
  const installed=await up(db,{verifyProjection:true});
  assert.deepEqual(installed.verification.before,installed.verification.after);
  assert.ok(Number(installed.verification.before.count)>100000);
  assert.deepEqual(await financial(),before,'cash/bank splits, negative amounts, makers, sites and posting statuses remain identical');
  assert.deepEqual(await fingerprint(),sourceBefore,'optimization never touches financial sources');assert.deepEqual(await columns(),columnsBefore);
  const artifact=(await query('SELECT * FROM app_schema_migration_artifacts WHERE version=$1',[VERSION])).rows[0];
  assert.ok(artifact.before_definition.includes('base AS MATERIALIZED'));assert.ok(artifact.after_definition.includes('AS NOT MATERIALIZED'));
  writes=0;assert.deepEqual(await ensureWalletLedgerInlining(db),{changed:false});assert.equal(writes,0,'a current startup performs only a catalog read');
  await down(db);assert.deepEqual(await financial(),before);
  assert.equal((await query('SELECT version FROM app_schema_migrations WHERE version=$1',[VERSION])).rows.length,0);
  assert.equal((await query("SELECT pg_get_viewdef('ledger_entries'::regclass,true) AS definition")).rows[0].definition,artifact.before_definition,'rollback restores the saved database definition verbatim');
  let fingerprints=0;
  const mismatched={connect:async()=>({release(){},query:async(sql,args)=>{
    const result=await query(sql,args);
    if(sql.includes('FROM ledger_entries l')&&sql.includes('string_agg')){fingerprints++;if(fingerprints===2)result.rows[0].hash='simulated-mismatch';}
    return result;
  }})};
  await assert.rejects(up(mismatched,{verifyProjection:true}),/verification failed/);
  assert.equal((await query("SELECT pg_get_viewdef('ledger_entries'::regclass,true) AS definition")).rows[0].definition,artifact.before_definition,'failed verification rolls back the view definition atomically');
  assert.deepEqual(await fingerprint(),sourceBefore);
  assert.equal((await ensureWalletLedgerInlining(db)).changed,true,'an older repeatable migration is repaired without replaying sources');
  assert.deepEqual(await fingerprint(),sourceBefore);
  await query('CREATE OR REPLACE VIEW ledger_entries AS '+inlineWalletLedgerDefinition(definition).definition.replace("status='approved'","status IN ('approved','pending')"));
  await assert.rejects(down(db),/policy changed/,'rollback must never overwrite a later financial policy change');
 }finally{await pg.close();}
});
