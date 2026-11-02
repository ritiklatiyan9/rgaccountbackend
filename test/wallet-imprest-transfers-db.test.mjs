import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up } from '../src/migrations/232_wallet_imprest_transfers.js';
import { up as projectionUp } from '../src/migrations/234_wallet_site_projection.js';
import { walletBalanceGuardsSql } from '../src/migrations/210_wallet_balance_guards.js';
import { createWalletImprestTransfer,resolveWalletImprestTransfer,listWalletImprestTransfers,walletImprestParticipants } from '../src/services/walletImprestTransfer.service.js';
import { siteVaultAccountsCte } from '../src/services/loyaltyVaultSite.service.js';
import { cacheGet,cacheSet,getCacheGeneration } from '../src/config/cache.js';

test('wallet imprest requires independent acceptance, posts once, and atomically preserves cash custody', {skip:!process.env.PGLITE_MODULE},async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};};
  // PGlite owns one connection. Queue complete API transactions so concurrent
  // promises cannot accidentally share BEGIN/ROLLBACK in this test adapter.
  // These bursts verify replay/rollback semantics, not PostgreSQL lock timing.
  let connection=Promise.resolve();
  const db={query,connect:async()=>{const before=connection;let release;connection=new Promise(resolve=>{release=resolve;});await before;return {query,release};}};
  const request=(amount='100.15',extra={})=>({site_id:10,from_user_id:1,to_user_id:2,amount,note:'Site work',idempotency_key:randomUUID(),...extra});
  const resolve=(user,id,action='accept',extra={})=>resolveWalletImprestTransfer({id:user},id,action,{site_id:10,...extra},db);
  const balance=async id=>(await query("SELECT COALESCE(sum(amount),0)::text AS amount FROM loyalty_vault_entries WHERE holder_id=$1 AND site_id=10",[id])).rows[0].amount;
  const float=async id=>(await query('SELECT COALESCE(sum(amount),0)::text AS amount FROM imprest_ledger WHERE user_id=$1 AND site_id=10',[id])).rows[0].amount;
  const errorStatus=code=>error=>error.statusCode===code;
  try {
    await query(`CREATE TABLE app_schema_migrations(version TEXT PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Ravi','sub_admin',1,true),(2,'Recipient','sub_admin',1,true),(3,'Requester','sub_admin',1,true),
        (4,'Admin','admin',1,true),(5,'Outside user','sub_admin',2,true),(6,'Observer','super_admin',1,true),(7,'Unassigned','sub_admin',1,true);
      CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer,name text);INSERT INTO sites VALUES(10,1,'Site'),(11,1,'Other site'),(20,2,'Outside');
      CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(1,10),(2,10),(3,10),(5,20),(1,11);
      CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_view_all boolean);
      CREATE TABLE members(id integer PRIMARY KEY,full_name text);
      CREATE TABLE ledger_entries(id text,site_id integer,entry_date date DEFAULT CURRENT_DATE,bucket text,
        credit numeric DEFAULT 0,debit numeric DEFAULT 0,source_key text,source_id integer,notes text,created_at timestamptz DEFAULT now());
      CREATE TABLE imprest_allocations(id serial PRIMARY KEY,site_id integer,admin_id integer,sub_admin_id integer,
        amount numeric,status text,from_own_float boolean DEFAULT false,created_at timestamptz DEFAULT now(),confirmed_at timestamptz);
      CREATE TABLE imprest_site_debit_reservations(site_id integer,amount numeric,created_at timestamptz DEFAULT now());
      CREATE TABLE loyalty_vault_accounts(holder_key text PRIMARY KEY,organization_id integer,holder_type text,holder_id integer,balance numeric(15,2) DEFAULT 0,reserved_balance numeric DEFAULT 0,updated_at timestamptz);
      CREATE TABLE loyalty_vault_entries(id SERIAL PRIMARY KEY,organization_id integer,holder_key text,holder_type text,holder_id integer,amount numeric(15,2),balance_after numeric(15,2),kind text,
        description text,source_table text,source_id integer,cash_flow_entry_id integer,site_id integer,actor_id integer,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz DEFAULT now());
      CREATE TABLE imprest_ledger(id SERIAL PRIMARY KEY,user_id integer,type text,reference_id integer,amount numeric(15,2),balance_after numeric(15,2),remarks text,created_by integer,site_id integer,source_module text,created_at timestamptz DEFAULT now());`);
    await query(`CREATE TABLE test_financial_cash(site_id int PRIMARY KEY,amount numeric);INSERT INTO test_financial_cash VALUES(10,1000.25);
      CREATE FUNCTION imprest_financial_site_cash(p_site integer) RETURNS numeric LANGUAGE sql AS $$
      SELECT COALESCE((SELECT amount FROM test_financial_cash WHERE site_id=p_site),0)-COALESCE((SELECT sum(amount) FROM imprest_ledger WHERE site_id=p_site),0)
      $$;`);
    await query(walletBalanceGuardsSql);await up(db);await up(db);
    await query("SELECT loyalty_vault_apply_delta('user:1',1,1000.25,'credit','Collected cash',NULL,NULL,NULL,10,1)");
    await projectionUp(db);
    await t.test('request creation accepts nobody, reveals no private wallet balances, and retries safely',async()=>{
      const data=request(),made=await createWalletImprestTransfer({id:3},data,db),row=made.transfer;
      assert.equal(row.status,'pending');assert.equal(row.sender_accepted_at,null);assert.equal(row.recipient_accepted_at,null);
      assert.equal(row.can_accept,false);assert.equal(row.can_cancel,true);assert.equal(Number(await balance(1)),1000.25);assert.equal(Number(await float(2)),0);
      assert.equal((await listWalletImprestTransfers({id:3},{site_id:10,attention_only:true},db)).pagination.totalItems,0,'a third-party requester receives no acceptance action');
      assert.equal((await listWalletImprestTransfers({id:1},{site_id:10,attention_only:true},db)).pagination.totalItems,1);
      assert.equal((await createWalletImprestTransfer({id:3},data,db)).replayed,true);
      await assert.rejects(createWalletImprestTransfer({id:3},{...data,amount:'100.16'},db),errorStatus(409));
      const peers=(await walletImprestParticipants({id:3},{site_id:10},db)).participants;
      assert.equal(peers.find(p=>p.id===1).available_balance,null);assert.equal(peers.find(p=>p.id===4).can_receive,false);assert.ok(!peers.some(p=>p.id===5||p.id===7));
      await assert.rejects(resolve(3,row.id),errorStatus(403));
      await assert.rejects(resolve(4,row.id),errorStatus(404));
      await resolve(1,row.id,'accept',{note:'Source counted and handed over cash'});assert.equal(Number(await balance(1)),1000.25);assert.equal(Number(await float(2)),0);
      assert.equal((await listWalletImprestTransfers({id:1},{site_id:10,attention_only:true},db)).pagination.totalItems,0,'a saved acceptance clears only this participant\'s notification');
      assert.equal((await listWalletImprestTransfers({id:2},{site_id:10,attention_only:true},db)).pagination.totalItems,1);
      assert.equal((await resolve(1,row.id)).replayed,true);
      const accepted=await resolve(2,row.id,'accept',{note:'Recipient received and counted cash'});assert.equal(accepted.transfer.status,'accepted');assert.ok(accepted.transfer.sender_accepted_at);assert.ok(accepted.transfer.recipient_accepted_at);
      assert.equal(accepted.transfer.sender_acceptance_note,'Source counted and handed over cash','first acceptance note survives final acceptance and replay');
      assert.equal(accepted.transfer.recipient_acceptance_note,'Recipient received and counted cash');
      assert.equal(Number(await balance(1)),900.10);assert.equal(Number(await float(2)),100.15);
      assert.equal((await resolve(2,row.id)).replayed,true);assert.equal((await resolve(1,row.id)).replayed,true);
      assert.equal((await query('SELECT count(*)::int AS n FROM imprest_ledger WHERE wallet_imprest_transfer_id=$1',[row.id])).rows[0].n,1);
      const totals=(await query(`WITH ${siteVaultAccountsCte('$1','$2')} SELECT total_received::text,total_handover::text,total_imprest_out::text FROM site_accounts WHERE holder_key='user:1'`,[1,10])).rows[0];
      assert.equal(Number(totals.total_received),1000.25);assert.equal(Number(totals.total_handover),0);assert.equal(Number(totals.total_imprest_out),100.15);
      assert.equal((await query('SELECT wallet_imprest_transfer_id FROM loyalty_vault_entries WHERE kind=$1',['imprest_out'])).rows[0].wallet_imprest_transfer_id,row.id);
      await assert.rejects(resolve(3,row.id,'cancel'),errorStatus(409));
    });
    await t.test('recipient may accept first and both posting sides roll back on failure',async()=>{
      const made=await createWalletImprestTransfer({id:1},request('10.05'),db),id=made.transfer.id;
      await resolve(2,id);assert.equal(Number(await float(2)),100.15);
      await query(`CREATE FUNCTION fail_imprest_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated float storage failure'; END $$;
        CREATE TRIGGER fail_imprest_receipt BEFORE INSERT ON imprest_ledger FOR EACH ROW EXECUTE FUNCTION fail_imprest_receipt();`);
      const outboxBefore=(await query('SELECT count(*)::int AS n FROM wallet_imprest_notification_outbox')).rows[0].n;
      const cacheKey='imprest|rollback-regression-site-10';
      await cacheSet(cacheKey,{available:'900.10'},60);
      const generation=getCacheGeneration();
      await assert.rejects(resolve(1,id),/Simulated float storage failure/);
      assert.equal(Number(await balance(1)),900.10);assert.equal(Number(await float(2)),100.15);
      assert.equal((await query('SELECT sender_accepted_at,status FROM wallet_imprest_transfers WHERE id=$1',[id])).rows[0].sender_accepted_at,null);
      assert.equal((await query('SELECT count(*)::int AS n FROM wallet_imprest_notification_outbox')).rows[0].n,outboxBefore,'rolled-back posting cannot publish an acceptance event');
      assert.equal(getCacheGeneration(),generation,'a rolled-back posting is not published as a successful mutation');
      assert.deepEqual(await cacheGet(cacheKey),{available:'900.10'});
      await query('DROP TRIGGER fail_imprest_receipt ON imprest_ledger');
      await resolve(1,id);assert.equal(Number(await balance(1)),890.05);assert.equal(Number(await float(2)),110.20);
      assert.equal(await cacheGet(cacheKey),null,'successful retry invalidates the previous balance after commit');
    });
    await t.test('pending requests reserve nothing and final acceptance rechecks spendable cash',async()=>{
      const first=await createWalletImprestTransfer({id:3},request('800'),db),second=await createWalletImprestTransfer({id:3},request('800'),db);
      await resolve(1,first.transfer.id);await resolve(2,first.transfer.id);
      await resolve(2,second.transfer.id);
      await assert.rejects(resolve(1,second.transfer.id),errorStatus(409));
      assert.equal(Number(await balance(1)),90.05);assert.equal(Number(await float(2)),910.20);
      assert.equal((await query('SELECT status FROM wallet_imprest_transfers WHERE id=$1',[second.transfer.id])).rows[0].status,'pending');
      await resolve(3,second.transfer.id,'cancel');
    });
    await t.test('participant/site access is revalidated, either side may reject, requester may cancel',async()=>{
      const made=await createWalletImprestTransfer({id:3},request('1'),db);
      await resolve(1,made.transfer.id);
      await query('DELETE FROM user_sites WHERE user_id=2 AND site_id=10');
      await assert.rejects(resolve(2,made.transfer.id),errorStatus(403));
      await query('INSERT INTO user_sites VALUES(2,10)');
      await resolve(2,made.transfer.id,'reject');
      assert.equal((await resolve(2,made.transfer.id,'reject')).replayed,true);
      await assert.rejects(resolve(1,made.transfer.id),errorStatus(409));
      const cancelled=await createWalletImprestTransfer({id:3},request('1'),db);
      await assert.rejects(resolve(1,cancelled.transfer.id,'cancel'),errorStatus(403));
      await resolve(3,cancelled.transfer.id,'cancel');
      await assert.rejects(createWalletImprestTransfer({id:3},request('1',{site_id:11}),db),errorStatus(403));
      await assert.rejects(createWalletImprestTransfer({id:3},request('1',{to_user_id:4}),db),errorStatus(400));
      await assert.rejects(createWalletImprestTransfer({id:3},request('1',{to_user_id:5}),db),errorStatus(403));
      const list=await listWalletImprestTransfers({id:2},{site_id:10},db);assert.ok(list.transfers.every(r=>r.to_user_id===2));
      assert.equal((await listWalletImprestTransfers({id:6},{site_id:10},db)).pagination.totalItems,list.pagination.totalItems);
      assert.equal((await listWalletImprestTransfers({id:7},{site_id:10},db).catch(e=>e)).statusCode,403);
      await query("INSERT INTO user_permissions VALUES(3,'wallet',false,false)");
      await assert.rejects(listWalletImprestTransfers({id:3},{site_id:10},db),errorStatus(403));
      await query("INSERT INTO user_permissions VALUES(3,'imprest',true,false)");
      assert.equal((await listWalletImprestTransfers({id:3},{site_id:10},db)).site_id,10,'personal Imprest read alone can open its own transfer flow');
      assert.equal((await walletImprestParticipants({id:3},{site_id:10},db)).participants.find(p=>p.id===1).available_balance,null,'Imprest access grants no other wallet balance');
      const underfunded=await createWalletImprestTransfer({id:1},request('1'),db);
      await resolve(2,underfunded.transfer.id);
      await query('UPDATE test_financial_cash SET amount=910.20 WHERE site_id=10');
      await assert.rejects(resolve(1,underfunded.transfer.id),errorStatus(409));
      assert.equal(Number(await balance(1)),90.05,'insufficient real site cash cannot consume a stale wallet balance');
      await query('UPDATE test_financial_cash SET amount=1000.25 WHERE site_id=10');
      await resolve(1,underfunded.transfer.id,'reject');
    });
    await t.test('statement and lock timeouts after the wallet debit roll back ledger, projection, acceptance and outbox',async()=>{
      for(const code of ['57014','55P03']) {
        const made=await createWalletImprestTransfer({id:1},request('1.01'),db),id=made.transfer.id;
        await resolve(2,id);
        const before={cash:await balance(1),float:await float(2),projection:(await query("SELECT balance::text,total_imprest_out::text,entry_count::text FROM loyalty_vault_site_accounts WHERE organization_id=1 AND site_id=10 AND holder_key='user:1'")).rows[0]};
        const outbox=(await query('SELECT count(*)::int AS n FROM wallet_imprest_notification_outbox WHERE transfer_id=$1',[id])).rows[0].n;
        await query(`CREATE OR REPLACE FUNCTION fail_imprest_timeout() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Simulated database timeout after wallet debit' USING ERRCODE='${code}'; END $$;
          CREATE TRIGGER fail_imprest_timeout BEFORE INSERT ON imprest_ledger FOR EACH ROW EXECUTE FUNCTION fail_imprest_timeout();`);
        let failure;
        try {await resolve(1,id);}catch(error){failure=error;}finally{await query('DROP TRIGGER fail_imprest_timeout ON imprest_ledger');}
        assert.equal(failure?.code,code);
        assert.equal(await balance(1),before.cash);assert.equal(await float(2),before.float);
        assert.deepEqual((await query("SELECT balance::text,total_imprest_out::text,entry_count::text FROM loyalty_vault_site_accounts WHERE organization_id=1 AND site_id=10 AND holder_key='user:1'")).rows[0],before.projection);
        const pending=(await query('SELECT status,sender_accepted_at,recipient_accepted_at FROM wallet_imprest_transfers WHERE id=$1',[id])).rows[0];
        assert.equal(pending.status,'pending');assert.equal(pending.sender_accepted_at,null);assert.ok(pending.recipient_accepted_at);
        assert.equal((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries WHERE wallet_imprest_transfer_id=$1',[id])).rows[0].n,0);
        assert.equal((await query('SELECT count(*)::int AS n FROM wallet_imprest_notification_outbox WHERE transfer_id=$1',[id])).rows[0].n,outbox);
        await resolve(1,id,'reject');
      }
    });
    await t.test('concurrent retry bursts post one immutable pair and competing final acceptances cannot double spend',async()=>{
      const data=request('0.01');
      const requests=await Promise.all(Array.from({length:32},()=>createWalletImprestTransfer({id:1},data,db)));
      assert.equal(new Set(requests.map(result=>result.transfer.id)).size,1);
      assert.equal(requests.filter(result=>!result.replayed).length,1);
      const id=requests[0].transfer.id;
      const burst=await Promise.allSettled(Array.from({length:64},(_,index)=>resolve(index%2?1:2,id)));
      const retryable=burst.filter(result=>result.status==='rejected');
      assert.ok(retryable.every(result=>result.reason.statusCode===503&&result.reason.code==='WALLET_WRITE_BUSY'));
      const decisions=burst.filter(result=>result.status==='fulfilled').map(result=>result.value);
      assert.ok(decisions.every(result=>['pending','accepted'].includes(result.transfer.status)));
      assert.equal(decisions.filter(result=>!result.replayed).length,2,'one acceptance per participant is saved');
      const retries=await Promise.all(retryable.map((_,index)=>resolve(index%2?1:2,id)));
      assert.ok(retries.every(result=>result.replayed&&result.transfer.status==='accepted'),'overload retries recover the posted result without confirming another movement');
      assert.equal((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries WHERE wallet_imprest_transfer_id=$1',[id])).rows[0].n,1);
      assert.equal((await query('SELECT count(*)::int AS n FROM imprest_ledger WHERE wallet_imprest_transfer_id=$1',[id])).rows[0].n,1);
      assert.equal((await query('SELECT count(*)::int AS n FROM wallet_imprest_notification_outbox WHERE transfer_id=$1',[id])).rows[0].n,3,'request, first confirmation and final acceptance are each recorded once');
      assert.equal(await balance(1),'90.04');assert.equal(await float(2),'910.21');
      const competing=await Promise.all(Array.from({length:3},()=>createWalletImprestTransfer({id:1},request('50'),db)));
      await Promise.all(competing.map(result=>resolve(1,result.transfer.id)));
      const finals=await Promise.allSettled(competing.map(result=>resolve(2,result.transfer.id)));
      assert.equal(finals.filter(result=>result.status==='fulfilled').length,1);
      assert.ok(finals.filter(result=>result.status==='rejected').every(result=>result.reason.statusCode===409));
      assert.equal(await balance(1),'40.04');assert.equal(await float(2),'960.21');
      assert.equal((await query(`SELECT count(*)::int AS n FROM wallet_imprest_transfers WHERE id=ANY($1::uuid[]) AND status='accepted'`,[competing.map(result=>result.transfer.id)])).rows[0].n,1);
      assert.equal((await query(`SELECT sum(amount)::text AS n FROM (SELECT amount FROM loyalty_vault_entries WHERE holder_id=1 AND site_id=10
        UNION ALL SELECT amount FROM imprest_ledger WHERE user_id=2 AND site_id=10) movements`)).rows[0].n,'1000.25','wallet cash plus recipient float remains exact to the paisa');
    });
  } finally {await pg.close();}
});
