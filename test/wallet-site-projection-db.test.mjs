import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { up,down,verifyWalletSiteProjection,VERSION } from '../src/migrations/234_wallet_site_projection.js';

async function fixture() {
  const {PGlite}=await import(process.env.PGLITE_MODULE);
  const pg=new PGlite();
  const query=async(sql,args)=>{const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[]};};
  let connection=Promise.resolve();
  const db={query,connect:async()=>{const before=connection;let release;connection=new Promise(resolve=>{release=resolve;});await before;return {query,release};}};
  await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
    CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer);
    INSERT INTO sites VALUES(10,1),(11,1),(12,1),(20,2),(30,1);
    CREATE TABLE loyalty_vault_entries(id bigserial PRIMARY KEY,organization_id integer NOT NULL,site_id integer,
      holder_key text,holder_type text,holder_id integer,amount numeric(15,2),kind text,source_table text,created_at timestamptz DEFAULT now());
    CREATE TABLE loyalty_vault_accounts(holder_key text PRIMARY KEY,balance numeric(15,2),reserved_balance numeric(15,2));
    INSERT INTO loyalty_vault_accounts VALUES('user:900',123456.78,42.01);
    CREATE TABLE financial_sources(id integer PRIMARY KEY,credit numeric(15,2),status text);
    INSERT INTO financial_sources VALUES(1,123456.78,'approved');
    CREATE FUNCTION immutable_financial_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable financial fixture'; END $$;
    CREATE TRIGGER ledger_immutable BEFORE UPDATE OR DELETE ON loyalty_vault_entries FOR EACH ROW EXECUTE FUNCTION immutable_financial_fixture();
    CREATE TRIGGER accounts_unchanged BEFORE UPDATE OR DELETE ON loyalty_vault_accounts FOR EACH ROW EXECUTE FUNCTION immutable_financial_fixture();
    CREATE TRIGGER sources_unchanged BEFORE UPDATE OR DELETE ON financial_sources FOR EACH ROW EXECUTE FUNCTION immutable_financial_fixture();`);
  const transaction=async run=>{const client=await db.connect();try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  const append=async({id=null,amount='1.01',kind='credit',org=1,site=30,key='user:900',source=null,created='2026-11-01T00:00:00Z'}={},client=db)=>client.query(`INSERT INTO loyalty_vault_entries
    (id,organization_id,site_id,holder_key,holder_type,holder_id,amount,kind,source_table,created_at)
    VALUES(COALESCE($1::bigint,nextval('loyalty_vault_entries_id_seq')),$2,$3,$4,split_part($4,':',1),split_part($4,':',2)::int,$5,$6,$7,$8)
    ON CONFLICT(id) DO NOTHING RETURNING id`,[id,org,site,key,amount,kind,source,created]);
  return {pg,db,query,transaction,append,close:()=>pg.close()};
}

test('derived site projection backfills 100,000 postings, captures committed appends once, and rolls back with the ledger', {skip:!process.env.PGLITE_MODULE,timeout:60000},async t=>{
  const f=await fixture();
  const known=()=>f.query(`SELECT balance::text,total_in::text,total_received::text,total_handover::text,total_imprest_out::text,
    total_adjustments::text,entry_count::text,last_entry_id::text,aligned_id::text,updated_at,total_transfer_in::text FROM loyalty_vault_site_accounts
    WHERE organization_id=1 AND site_id=30 AND holder_key='user:900'`).then(result=>result.rows[0]);
  const fingerprint=()=>f.query(`SELECT count(*)::text AS entries,
    md5(string_agg(md5(row_to_json(e)::text),'' ORDER BY id)) AS ledger_hash FROM loyalty_vault_entries e`).then(result=>result.rows[0]);
  const financial=async()=>({accounts:(await f.query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows,sources:(await f.query('SELECT * FROM financial_sources ORDER BY id')).rows});
  try {
    await f.query(`INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,amount,kind,source_table,created_at)
      SELECT CASE WHEN i%10=0 THEN 2 ELSE 1 END,CASE WHEN i%997=0 THEN NULL WHEN i%10=0 THEN 20 ELSE 10+i%3 END,
        CASE WHEN i%7=0 THEN 'member:' ELSE 'user:' END||(i%50+1)::text,
        CASE WHEN i%7=0 THEN 'member' ELSE 'user' END,i%50+1,
        (CASE WHEN i%6 IN(2,3,5) THEN -1 ELSE 1 END)*(i%991+1)::numeric/100,
        CASE i%6 WHEN 0 THEN 'credit' WHEN 1 THEN 'transfer_in' WHEN 2 THEN 'transfer_out'
          WHEN 3 THEN 'imprest_out' WHEN 4 THEN 'adjustment' ELSE 'reversal' END,
        CASE WHEN i%809=0 THEN 'manual_wallet_site_cash_alignment' ELSE NULL END,
        '2026-01-01'::timestamptz+i*interval '1 second'
      FROM generate_series(1,100000) i`);
    for(const [amount,kind] of [['100.05','credit'],['40.01','transfer_in'],['-10.02','transfer_out'],['-5.03','imprest_out'],['-2.04','adjustment'],['-0.05','reversal']])await f.append({amount,kind});
    await f.append({key:'member:901',site:30,amount:'-5.23',kind:'adjustment'});
    const ledgerBefore=await fingerprint(),financialBefore=await financial();
    const started=performance.now();
    const installed=await up(f.db);
    t.diagnostic(`100,007 immutable rows; migration backfill/reconciliation ${(performance.now()-started).toFixed(1)} ms in isolated PGlite (not a production PostgreSQL latency benchmark).`);
    assert.equal(installed.applied,true);assert.equal(installed.verification.mismatches,0);
    assert.deepEqual(await fingerprint(),ledgerBefore);assert.deepEqual(await financial(),financialBefore);
    const row=await known();
    assert.deepEqual(Object.fromEntries(Object.entries(row).slice(0,7)),{
      balance:'122.92',total_in:'137.97',total_received:'140.01',total_handover:'10.02',total_imprest_out:'5.03',total_adjustments:'-2.04',entry_count:'6',
    });
    assert.equal(row.total_transfer_in,'40.01');
    assert.equal(Number((await f.query("SELECT balance FROM loyalty_vault_site_accounts WHERE holder_key='member:901'")).rows[0].balance),-5.23,'historical deficits are preserved');
    assert.equal(Number((await f.query('SELECT sum(entry_count) AS count FROM loyalty_vault_site_accounts')).rows[0].count),100007-100,'unallocated legacy entries stay outside every site');
    assert.equal((await up(f.db)).applied,false,'repeat startup does not rebuild or replay installed projections');
    assert.deepEqual(await fingerprint(),ledgerBefore);assert.deepEqual(await financial(),financialBefore);

    await t.test('whole-transaction retry bursts update the projection once per committed posting',async()=>{
      // PGlite exposes one connection, so the fixture serializes complete
      // transactions. Real PostgreSQL lock contention requires a separate run.
      await Promise.all(Array.from({length:32},()=>f.transaction(client=>f.append({},client))));
      const duplicate=await Promise.all(Array.from({length:32},()=>f.transaction(client=>f.append({id:10000000,amount:'0.01'},client))));
      assert.equal(duplicate.filter(result=>result.rows.length).length,1);
      const committed=await known();
      assert.equal(committed.balance,'155.25');assert.equal(committed.entry_count,'39');
      assert.equal((await verifyWalletSiteProjection(f.db)).mismatches,0);
      const beforeFailed=await known(),beforeLedger=await fingerprint();
      await assert.rejects(f.transaction(async client=>{
        await f.append({amount:'9.99'},client);
        await f.append({org:2,site:30,amount:'1.00'},client);
      }),/organization and site differ/);
      assert.deepEqual(await known(),beforeFailed);assert.deepEqual(await fingerprint(),beforeLedger);
      assert.equal((await verifyWalletSiteProjection(f.db)).mismatches,0);
    });

    await t.test('latest alignment metadata and transaction rollback use the final immutable entries',async()=>{
      const earlier=await known();
      const alignment=(await f.append({amount:'0.00',kind:'adjustment',source:'manual_wallet_site_cash_alignment',created:'2026-11-02T00:00:00Z'})).rows[0].id;
      const aligned=await known();assert.equal(aligned.aligned_id,String(alignment));assert.equal(aligned.entry_count,String(Number(earlier.entry_count)+1));
      assert.equal(new Date(aligned.updated_at).toISOString(),'2026-11-02T00:00:00.000Z');
      const marker=new Error('Abort after append');
      await assert.rejects(f.transaction(async client=>{await f.append({amount:'-1.01',kind:'transfer_out'},client);throw marker;}),error=>error===marker);
      assert.deepEqual(await known(),aligned);assert.equal((await verifyWalletSiteProjection(f.db)).mismatches,0);
      assert.deepEqual(await financial(),financialBefore);
    });

    await t.test('cumulative counters retain precision beyond the single-account amount limit',async()=>{
      const before=await known();
      // Cash may be collected and handed over repeatedly without ever holding
      // the lifetime aggregate at once. Per-entry values remain valid (15,2).
      for(let cycle=0;cycle<3;cycle++) {
        await f.append({amount:'5000000000000.00',kind:'credit'});
        await f.append({amount:'-5000000000000.00',kind:'transfer_out'});
      }
      const after=await known();assert.equal(after.balance,before.balance);
      const changes=(await f.query(`SELECT (total_received-$1::numeric)::text AS received,
        (total_handover-$2::numeric)::text AS handed FROM loyalty_vault_site_accounts
        WHERE organization_id=1 AND site_id=30 AND holder_key='user:900'`,[before.total_received,before.total_handover])).rows[0];
      assert.deepEqual(changes,{received:'15000000000000.00',handed:'15000000000000.00'});
      assert.equal((await verifyWalletSiteProjection(f.db)).mismatches,0);
    });

    await t.test('full-vector reconciliation rejects balanced corruption and down/up never changes financial records',async()=>{
      const beforeLedger=await fingerprint(),beforeFinancial=await financial();
      await f.query("UPDATE loyalty_vault_site_accounts SET total_received=total_received+0.01 WHERE organization_id=1 AND site_id=30 AND holder_key='user:900'");
      await assert.rejects(verifyWalletSiteProjection(f.db),error=>error.code==='WALLET_PROJECTION_MISMATCH'&&error.details.mismatches===1);
      await f.query("INSERT INTO loyalty_vault_site_accounts(organization_id,site_id,holder_key,holder_type,holder_id,last_entry_id) VALUES(1,30,'user:99999','user',99999,0)");
      await f.query("DELETE FROM loyalty_vault_site_accounts WHERE organization_id=1 AND site_id=30 AND holder_key='member:901'");
      await assert.rejects(verifyWalletSiteProjection(f.db),error=>error.code==='WALLET_PROJECTION_MISMATCH'&&error.details.mismatches===3,'full outer reconciliation detects zero-value orphan and missing rows too');
      await down(f.db);
      assert.equal((await f.query("SELECT to_regclass('loyalty_vault_site_accounts') AS name")).rows[0].name,null);
      assert.deepEqual(await fingerprint(),beforeLedger);assert.deepEqual(await financial(),beforeFinancial);
      assert.equal((await up(f.db)).applied,true);assert.equal((await verifyWalletSiteProjection(f.db)).mismatches,0);
      assert.deepEqual(await fingerprint(),beforeLedger);assert.deepEqual(await financial(),beforeFinancial);
      await assert.rejects(f.query('UPDATE loyalty_vault_entries SET amount=0 WHERE id=1'),/Immutable financial fixture/);
      await assert.rejects(f.query("UPDATE loyalty_vault_accounts SET balance=0 WHERE holder_key='user:900'"),/Immutable financial fixture/);
    });
  }finally{await f.close();}
});

test('projection migration rejects invalid historical scope atomically before installing derived state',{skip:!process.env.PGLITE_MODULE},async()=>{
  const f=await fixture();
  try {
    await f.append({org:2,site:30,amount:'1.01'});
    await assert.rejects(up(f.db),/invalid site or holder scope/);
    assert.equal((await f.query("SELECT to_regclass('loyalty_vault_site_accounts') AS name")).rows[0].name,null);
    assert.equal((await f.query('SELECT count(*)::int AS count FROM app_schema_migrations WHERE version=$1',[VERSION])).rows[0].count,0);
    assert.equal((await f.query('SELECT count(*)::int AS count FROM loyalty_vault_entries')).rows[0].count,1);
  }finally{await f.close();}
});

test('projection backfill takes an INSERT-conflicting lock before installing or scanning derived state',async()=>{
  const statements=[];
  const client={query:async(sql)=>{
    statements.push(sql);
    if(sql.startsWith('SELECT 1 FROM app_schema_migrations'))return {rows:[]};
    if(sql.includes('FROM loyalty_vault_entries e LEFT JOIN sites'))return {rows:[{count:0}]};
    if(sql.startsWith('SELECT count(*)::text AS count'))return {rows:[{count:'0',amount:'0',hash:'empty-ledger'}]};
    if(sql.includes("SELECT 'expected'::text AS kind"))return {rows:[{kind:'expected',count:'0',balance:'0',hash:'empty-projection'},{kind:'projected',count:'0',balance:'0',hash:'empty-projection'}]};
    if(sql.includes('AS mismatches,'))return {rows:[{mismatches:0,examples:[]}]};
    if(sql.startsWith('SELECT count(*)::text AS accounts'))return {rows:[{accounts:'0',entries:'0'}]};
    return {rows:[]};
  },release(){}};
  await up({connect:async()=>client});
  assert.ok(statements[0].startsWith('BEGIN ISOLATION LEVEL READ COMMITTED; SET LOCAL'),'backfill must explicitly override a role/database default isolation level');
  assert.ok(!statements.some(sql=>sql.includes('REPEATABLE READ')),'the backfill snapshot must be taken after waiting for preceding writers');
  const lock=statements.findIndex(sql=>sql==='LOCK TABLE loyalty_vault_entries IN SHARE ROW EXCLUSIVE MODE');
  const install=statements.findIndex(sql=>sql.startsWith('CREATE TABLE IF NOT EXISTS loyalty_vault_site_accounts'));
  const backfill=statements.findIndex(sql=>sql.startsWith('INSERT INTO loyalty_vault_site_accounts('));
  const verify=statements.findIndex(sql=>sql.includes('AS mismatches,'));
  assert.ok(lock>0&&install>lock&&backfill>install&&verify>backfill);
});
