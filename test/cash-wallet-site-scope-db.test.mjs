import { walletHistoryParentsSql } from './helpers/walletHistoryParents.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up } from '../src/migrations/208_cash_wallet_site_scope.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { siteVaultAccountsCte } from '../src/services/loyaltyVaultSite.service.js';
import { pendingVaultTotals } from '../src/services/loyaltyVaultTransactions.service.js';
import * as controller from '../src/controllers/loyaltyVault.controller.js';
import pool from '../src/config/db.js';

test('Cash Wallet separates real/test site custody and rejects cross-site spending and detail access', {skip:!process.env.PGLITE_MODULE},async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};};
  // PGlite has one connection. Serialize the production read limiter while
  // still starting both promises together to exercise its site cache keys.
  const db={query,options:{max:3},connect:async()=>({query,release(){}})};
  const originalQuery=pool.query,originalConnect=pool.connect;pool.query=query;pool.connect=db.connect;
  let serial=100;
  const entry=async(data={})=>{const values={id:serial++,site_id:10,created_by:1,credit:100,debit:0,cash_type:'CASH',status:'approved',particular:'Cash receipt',...data};const keys=Object.keys(values);await query(`INSERT INTO cash_flow_entries(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(values));return values.id;};
  const invoke=(handler,{site=10,user=2,params={},extraQuery={}}={})=>new Promise((resolve,reject)=>handler({user:{id:user},query:{...(site==null?{}:{site_id:site}),...extraQuery},body:{},params},{set(){return this;},json:resolve},reject));
  const status=code=>error=>error.statusCode===code;
  const balance=async(site,key='user:1')=>(await query(`WITH ${siteVaultAccountsCte('$1','$2')} SELECT balance::text,reserved_balance::text FROM site_accounts WHERE holder_key=$3`,[1,site,key])).rows[0]||{balance:'0',reserved_balance:'0'};
  const transfer=(amount,site_id=10,to_holder_id=2)=>({site_id,amount,to_holder_id,idempotency_key:randomUUID()});
  const unallocatedTransfer=randomUUID();
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Sachin','sub_admin',1,true),(2,'Administrator','admin',1,true),(3,'Live site staff','sub_admin',1,true),(4,'Outside admin','admin',2,true),(5,'Test site staff','sub_admin',1,true);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);INSERT INTO sites VALUES(10,'Live project',1),(11,'Test site',1),(20,'Outside',2);
      CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(1,10),(1,11),(3,10),(5,11);
      CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_view_all boolean);INSERT INTO user_permissions VALUES(1,'cashflow',true,true),(3,'cashflow',true,false);
      CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text);INSERT INTO members VALUES(1,10,'Live client','9999999999'),(2,11,'Test client','8888888888');
      CREATE TABLE cash_flow_entries(id integer PRIMARY KEY,site_id integer,created_by integer,credit numeric DEFAULT 0,debit numeric DEFAULT 0,
        cash_type text,status text,cheque_status text,particular text,source_module text,source_id integer,date date DEFAULT CURRENT_DATE,
        created_at timestamptz DEFAULT now(),entry_transfer_id uuid,is_imprest_internal boolean,is_firm_transaction boolean,to_firm_id integer);
      CREATE TABLE cash_flow_months(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE farmers(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,buyer_name text,block text);CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer);
      CREATE TABLE firms(id integer PRIMARY KEY,site_id integer);${postingPolicySql}`);
    for(const table of [...LOYALTY_VAULT_SOURCE_TABLES].filter(table=>table!=='cash_flow_entries'))await query(`CREATE TABLE ${table}(id integer PRIMARY KEY,site_id integer,created_by integer,status text DEFAULT 'pending',payment_mode text DEFAULT 'BANK',payment_type text,cheque_status text,
      entry_type text,created_at timestamptz DEFAULT now(),farmer_id integer,firm_id integer,plot_id integer,installment_id integer,cash_amount numeric,
      cash_flow_entry_id integer,expense_id integer,farmer_payment_id integer,commission_id integer,firm_transaction_id integer,plot_payment_id integer,vendor_payment_id integer,imprest_allocation_id integer,
      entry_transfer_id uuid,money_transfer_id uuid,is_firm_to_firm_transfer boolean,transfer_group_id uuid,is_financial_projection boolean,source_vendor_payment_id integer,is_imprest_internal boolean)`);
    await query(walletHistoryParentsSql);
    await walletUp(db);await vaultUp(db);await unifiedUp(db);await up(db);
    const testReceipt=await entry({site_id:11,credit:1504000});
    const liveReceipt=await entry({site_id:10,credit:30000});
    // Legacy handovers have no proven project. They remain immutable and
    // visible in separate metadata, never credited to every selected site.
    await query(`INSERT INTO loyalty_vault_transfers(id,organization_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,amount,status,idempotency_key)
      VALUES($1,1,'user',2,1,2,1,77,'accepted',$2)`,[unallocatedTransfer,randomUUID()]);
    await query("SELECT loyalty_vault_apply_delta('user:1',1,77,'transfer_in','Unallocated legacy handover',NULL,NULL,NULL,NULL,1,$1)",[unallocatedTransfer]);
    await query("SELECT loyalty_vault_apply_delta('user:2',1,-77,'transfer_out','Unallocated legacy handover',NULL,NULL,NULL,NULL,1,$1)",[unallocatedTransfer]);

    await t.test('site summary, holder chooser and user details exclude test and unallocated money',async()=>{
      const live=await invoke(controller.summary,{user:1}),sandbox=await invoke(controller.summary,{site:11,user:1});
      assert.equal(Number(live.vault.balance),30000);assert.equal(Number(sandbox.vault.balance),1504000);
      assert.equal(live.vault.site_cash_incoming,null,'staff cannot see the full site cash receipts');
      assert.equal(live.vault.site_id,10);assert.equal(live.unallocated.entry_count,1);assert.equal(Number(live.unallocated.balance),77);
      const admin=await invoke(controller.summary);assert.equal(Number(admin.vault.total_balance),30000);assert.equal(admin.vault.entry_count,1);
      assert.equal(Number(admin.vault.site_cash_incoming),30000);
      assert.equal(Number((await invoke(controller.summary,{site:11})).vault.site_cash_incoming),1504000);
      const holders=await invoke(controller.holders);const sachin=holders.holders.find(h=>h.holder_id===1&&h.holder_type==='user');
      assert.equal(Number(sachin.available_balance),30000);assert.ok(!holders.holders.some(h=>h.holder_type==='member'&&h.holder_id===2));
      assert.ok(!holders.holders.some(h=>h.holder_type==='user'&&h.holder_id===5));
      const user=await invoke(controller.userDetail,{params:{id:1}});assert.equal(Number(user.user.balance),30000);assert.equal(user.user.site_id,10);assert.equal(Number(user.unallocated.balance),77);
      await assert.rejects(invoke(controller.summary,{site:11,user:3}),status(403));
      await assert.rejects(invoke(controller.summary,{site:20}),status(403));
      await assert.rejects(invoke(controller.summary,{site:null}),status(400));
      await assert.rejects(invoke(controller.userDetail,{site:null,params:{id:1}}),status(400));
    });

    await t.test('all read endpoints require a selected accessible site and return scope metadata',async()=>{
      const requests=[
        [controller.summary,{}],[controller.holders,{}],[controller.userDetail,{params:{id:1}}],
        [controller.assignedTransactions,{}],[controller.history,{}],[controller.historyDetail,{params:{id:2}}],
        [controller.transfers,{}],[controller.assignment,{extraQuery:{source_table:'cash_flow_entries',source_id:liveReceipt}}],
      ];
      for(const [handler,options] of requests) {
        assert.equal((await invoke(handler,options)).site_id,10);
        await assert.rejects(invoke(handler,{...options,site:null}),status(400));
        await assert.rejects(invoke(handler,{...options,site:20}),status(403));
      }
    });

    await t.test('transactions, history, running balances, source lookup and detail are selected-site scoped',async()=>{
      const transactions=await invoke(controller.assignedTransactions,{user:1});assert.deepEqual(transactions.transactions.map(e=>e.id),[liveReceipt]);
      const exact=await invoke(controller.assignedTransactions,{user:1,extraQuery:{source_table:'cash_flow_entries',source_id:liveReceipt}});
      assert.deepEqual(exact.transactions.map(e=>e.id),[liveReceipt]);
      assert.equal((await invoke(controller.assignedTransactions,{user:1,extraQuery:{source_table:'cash_flow_entries',source_id:testReceipt}})).total,0);
      await assert.rejects(invoke(controller.assignedTransactions,{extraQuery:{source_table:'users',source_id:1}}),status(400));
      const history=await invoke(controller.history,{user:1});assert.equal(history.total,1);assert.equal(history.entries[0].site_id,10);
      assert.equal(Number(history.entries[0].balance_after),30000,'global snapshot contains test money, public snapshot must not');
      const detail=await invoke(controller.historyDetail,{user:1,params:{id:history.entries[0].id}});assert.equal(Number(detail.entry.balance_after),30000);
      await assert.rejects(invoke(controller.historyDetail,{site:11,user:1,params:{id:history.entries[0].id}}),status(404));
      const assignment=await invoke(controller.assignment,{extraQuery:{source_table:'cash_flow_entries',source_id:liveReceipt}});assert.equal(assignment.assignment.site_id,10);
      await assert.rejects(invoke(controller.assignment,{site:11,extraQuery:{source_table:'cash_flow_entries',source_id:liveReceipt}}),status(404));
      await assert.rejects(invoke(controller.assignment,{site:null,extraQuery:{source_table:'cash_flow_entries',source_id:liveReceipt}}),status(400));
      const filtered=await invoke(controller.history,{extraQuery:{q:'Cash receipt',holder_type:'user',holder_id:1,from:'2000-01-01'}});assert.equal(filtered.total,1);
      assert.equal(filtered.entries[0].cash_flow_entry_id,liveReceipt);
    });

    await t.test('pending read deduplication includes site and returns independent site totals',async()=>{
      // Pre-consolidation pending mode is covered separately from today's
      // credit-first CASH mode, which has no awaiting approval cash credits.
      const cutoff=(await query('SELECT consolidated_at FROM loyalty_vault_settings')).rows[0].consolidated_at;
      const made=[];
      try {
        await query('UPDATE loyalty_vault_settings SET consolidated_at=NULL');
        made.push(await entry({credit:13,cash_type:'CHEQUE',cheque_status:'PENDING',status:'pending',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1}));
        made.push(await entry({site_id:11,credit:29,cash_type:'CHEQUE',cheque_status:'PENDING',status:'pending',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1}));
        const actor={id:1,organization_id:1,role:'sub_admin'};
        const [live,sandbox]=await Promise.all([pendingVaultTotals(actor,db,null,10),pendingVaultTotals(actor,db,null,11)]);
        assert.equal(Number(live[0].pending_credit),13);assert.equal(Number(sandbox[0].pending_credit),29);
      } finally {await query('DELETE FROM cash_flow_entries WHERE id=ANY($1::int[])',[made]);await query('UPDATE loyalty_vault_settings SET consolidated_at=$1',[cutoff]);}
    });

    await t.test('unreserved requests and acceptance cannot spend another site balance',async()=>{
      await assert.rejects(createVaultTransfer({id:1},transfer('30000.01'),db),status(409));
      await assert.rejects(createVaultTransfer({id:1},{...transfer('1'),site_id:null},db),status(400));
      await assert.rejects(createVaultTransfer({id:3},transfer('1',11),db),status(403));
      await assert.rejects(createVaultTransfer({id:1},transfer('1',10,5),db),status(403));
      const liveRequest=transfer('10000'),live=await createVaultTransfer({id:1},liveRequest,db);
      const sandbox=await createVaultTransfer({id:1},transfer('100000',11),db);
      assert.equal(Number((await balance(10)).reserved_balance),0);assert.equal(Number((await balance(11)).reserved_balance),0);
      assert.equal((await createVaultTransfer({id:1},liveRequest,db)).replayed,true);
      await assert.rejects(createVaultTransfer({id:1},{...liveRequest,site_id:11},db),status(409));
      const unreserved=await createVaultTransfer({id:1},transfer('20000.01'),db);
      const incoming=await invoke(controller.transfers,{extraQuery:{direction:'incoming',status:'pending'}});
      assert.deepEqual(new Set(incoming.transfers.map(e=>e.id)),new Set([live.transfer.id,unreserved.transfer.id]));
      const summary=await invoke(controller.summary,{user:1});assert.equal(summary.pending_outgoing,2);assert.equal(Number(summary.vault.reserved_balance),0);assert.equal(Number(summary.vault.available_balance),30000);
      await assert.rejects(resolveVaultTransfer({id:2},live.transfer.id,'accept',{site_id:11},db),status(404));
      await assert.rejects(resolveVaultTransfer({id:2},live.transfer.id,'accept',{},db),status(400));
      await resolveVaultTransfer({id:2},live.transfer.id,'accept',{site_id:10},db);
      assert.equal(Number((await balance(10)).balance),20000);assert.equal(Number((await balance(10,'user:2')).balance),10000);
      assert.equal(Number((await balance(11)).balance),1504000);assert.equal(Number((await balance(11)).reserved_balance),0);
      await assert.rejects(resolveVaultTransfer({id:2},unreserved.transfer.id,'accept',{site_id:10},db),status(409));
      await resolveVaultTransfer({id:1},unreserved.transfer.id,'cancel',{site_id:10},db);
      assert.equal((await resolveVaultTransfer({id:2},live.transfer.id,'accept',{site_id:10},db)).replayed,true);
      const posted=(await query('SELECT site_id,sum(amount)::text AS amount,count(*)::int AS n FROM loyalty_vault_entries WHERE transfer_id=$1 GROUP BY site_id',[live.transfer.id])).rows;
      assert.deepEqual(posted,[{site_id:10,amount:'0.00',n:2}]);
      await resolveVaultTransfer({id:1},sandbox.transfer.id,'cancel',{site_id:11},db);assert.equal(Number((await balance(11)).reserved_balance),0);
      const rejected=await createVaultTransfer({id:1},transfer('10'),db);await resolveVaultTransfer({id:2},rejected.transfer.id,'reject',{site_id:10},db);
      assert.equal(Number((await balance(10)).reserved_balance),0);
      // An old unallocated outgoing handover must not be spent a second time
      // just because the source site of that debit is still unknown.
      await assert.rejects(createVaultTransfer({id:2},transfer('9950',10,1),db),status(409));
    });

    await t.test('an admin-requested handover is visible to its wallet owner without granting decision rights',async()=>{
      const made=await createVaultTransfer({id:2},{...transfer('1'),from_holder_type:'user',from_holder_id:1},db);
      const outgoing=await invoke(controller.transfers,{user:1,extraQuery:{direction:'outgoing',status:'pending'}});
      const row=outgoing.transfers.find(item=>item.id===made.transfer.id);
      assert.ok(row,'wallet owner receives the outgoing notification even when an admin requested it');
      assert.equal(row.can_accept,false);assert.equal(row.can_cancel,false);
      assert.ok((await invoke(controller.summary,{user:1})).pending_outgoing>0);
      assert.ok(!(await invoke(controller.transfers,{user:3})).transfers.some(item=>item.id===made.transfer.id));
      await assert.rejects(resolveVaultTransfer({id:1},made.transfer.id,'accept',{site_id:10},db),status(404));
      await resolveVaultTransfer({id:2},made.transfer.id,'cancel',{site_id:10},db);
    });

    await t.test('legacy null-site transfer rows cannot appear or be accepted in an arbitrary site',async()=>{
      const id=randomUUID();await query(`INSERT INTO loyalty_vault_transfers(id,organization_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,amount,idempotency_key)
        VALUES($1,1,'user',1,2,1,2,1,$2)`,[id,randomUUID()]);
      const list=await invoke(controller.transfers);assert.ok(!list.transfers.some(t=>t.id===id));
      await assert.rejects(resolveVaultTransfer({id:2},id,'accept',{site_id:10},db),status(404));
      assert.equal((await query('SELECT status FROM loyalty_vault_transfers WHERE id=$1',[id])).rows[0].status,'pending');
      await query('DELETE FROM loyalty_vault_transfers WHERE id=$1',[id]);
    });

    await t.test('site changes append reversals and credits while repeat migration changes no money/history',async()=>{
      const moved=await entry({credit:50,created_by:2});
      const before=(await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows;
      await query('UPDATE cash_flow_entries SET site_id=11 WHERE id=$1',[moved]);
      const after=(await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows;
      assert.deepEqual(after.slice(0,before.length),before);assert.equal(after.length,before.length+2);
      assert.deepEqual(after.slice(-2).map(e=>[e.site_id,e.kind,Number(e.amount)]),[[10,'reversal',-50],[11,'credit',50]]);
      assert.equal(Number((await balance(10,'user:2')).balance),10000);assert.equal(Number((await balance(11,'user:2')).balance),50);
      const native=9000;
      await query("INSERT INTO plot_payments(id,site_id,created_by,status,payment_mode) VALUES($1,10,2,'approved','CASH')",[native]);
      const mirror=await entry({site_id:null,source_module:'plot_payments',source_id:native,created_by:2,credit:12});
      const nativeBefore=Number((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n);
      await query('UPDATE plot_payments SET site_id=11 WHERE id=$1',[native]);
      await query('UPDATE plot_payments SET site_id=10 WHERE id=$1',[native]);
      await query('SELECT reconcile_loyalty_vault_entry($1)',[mirror]);await query('SELECT reconcile_loyalty_vault_entry($1)',[mirror]);
      assert.equal(Number((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n),nativeBefore+4);
      assert.equal(Number((await balance(10,'user:2')).balance),10012);assert.equal(Number((await balance(11,'user:2')).balance),50);
      const finalHistory=(await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows;
      const sources=JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows);
      const accounts=JSON.stringify((await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows);
      await up(db);await up(db);
      assert.equal(JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows),sources);
      assert.equal(JSON.stringify((await query('SELECT * FROM loyalty_vault_accounts ORDER BY holder_key')).rows),accounts);
      assert.deepEqual((await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows,finalHistory);
      assert.equal((await query("SELECT count(*)::int AS n FROM app_schema_migrations WHERE version='208_cash_wallet_site_scope'")).rows[0].n,1);
      await assert.rejects(query('UPDATE loyalty_vault_entries SET amount=1 WHERE id=$1',[after[0].id]),/immutable/);
      await assert.rejects(entry({loyalty_vault_holder_type:'user',loyalty_vault_holder_id:5,loyalty_vault_assigned_by:2}),e=>e.constraint==='cash_wallet_holder_site');
      assert.ok(testReceipt!==liveReceipt);
    });

    await t.test('proven legacy site attribution preserves money/history and clears only net-zero unallocated warnings',async()=>{
      const global=async()=>(await query('SELECT holder_key,balance::text,reserved_balance::text FROM loyalty_vault_accounts ORDER BY holder_key')).rows;
      const before=await global(),originals=(await query('SELECT * FROM loyalty_vault_entries WHERE transfer_id=$1 ORDER BY id',[unallocatedTransfer])).rows;
      const siteBefore=await balance(11),key=randomUUID();
      assert.equal((await invoke(controller.summary)).unallocated.entry_count,2,'opposite holders must not cancel each other in metadata');
      await query('BEGIN');
      try {
        for(const original of originals) {
          const details={original_transfer_id:unallocatedTransfer,site_repair_key:key,original_entry_ids:originals.map(e=>e.id)};
          await query("SELECT loyalty_vault_apply_delta($1,1,-$2::numeric,'adjustment','Remove unallocated attribution',NULL,NULL,NULL,NULL,2,NULL,$3)",[original.holder_key,original.amount,details]);
          await query("SELECT loyalty_vault_apply_delta($1,1,$2::numeric,'adjustment','Assign proven test site',NULL,NULL,NULL,11,2,NULL,$3)",[original.holder_key,original.amount,details]);
        }
        await query('UPDATE loyalty_vault_transfers SET site_id=11 WHERE id=$1',[unallocatedTransfer]);
        await query('COMMIT');
      } catch(error) {await query('ROLLBACK');throw error;}
      assert.deepEqual(await global(),before);
      assert.deepEqual((await query('SELECT * FROM loyalty_vault_entries WHERE transfer_id=$1 ORDER BY id',[unallocatedTransfer])).rows,originals);
      assert.equal(Number((await balance(11)).balance),Number(siteBefore.balance)+77);
      assert.equal((await query("SELECT count(*)::int AS n FROM loyalty_vault_entries WHERE details->>'site_repair_key'=$1",[key])).rows[0].n,4);
      assert.equal((await query("SELECT sum(amount)::text AS amount FROM loyalty_vault_entries WHERE details->>'site_repair_key'=$1",[key])).rows[0].amount,'0.00');
      const summary=await invoke(controller.summary),profile=await invoke(controller.userDetail,{params:{id:1}});
      assert.equal(summary.unallocated.entry_count,0);assert.equal(Number(summary.unallocated.balance),0);
      assert.equal(profile.unallocated.entry_count,0);assert.equal(Number(profile.unallocated.balance),0);
      assert.ok((await invoke(controller.transfers,{site:11})).transfers.some(t=>t.id===unallocatedTransfer));
      assert.ok(!(await invoke(controller.transfers)).transfers.some(t=>t.id===unallocatedTransfer));
    });
    await t.test('staff see only their own wallet while admin and super admin can inspect all site wallets',async()=>{
      await query("INSERT INTO users VALUES(6,'Super administrator','super_admin',1,true)");
      const privateReceipt=await entry({created_by:3,credit:640});
      const privateMovement=(await query('SELECT id FROM loyalty_vault_entries WHERE cash_flow_entry_id=$1 ORDER BY id DESC LIMIT 1',[privateReceipt])).rows[0].id;
      for(const user of [1,3]) {
        const own=await invoke(controller.holders,{user});
        assert.deepEqual(own.holders.map(h=>`${h.holder_type}:${h.holder_id}`),[`user:${user}`]);
        const summary=await invoke(controller.summary,{user});
        assert.equal(Number(summary.vault.total_balance),Number(summary.vault.balance));
        assert.equal(summary.vault.site_cash_incoming,null);
        assert.ok((await invoke(controller.history,{user})).entries.every(e=>e.holder_key===`user:${user}`));
        assert.ok((await invoke(controller.assignedTransactions,{user})).transactions.every(e=>e.holder_type==='user'&&e.holder_id===user));
      }
      const directory=await invoke(controller.holders,{user:1,extraQuery:{purpose:'selection'}});
      assert.ok(directory.holders.some(h=>h.holder_id===3&&h.holder_type==='user'),'other recipients remain selectable');
      for(const other of directory.holders.filter(h=>h.holder_type!=='user'||h.holder_id!==1)) {
        for(const field of ['balance','total_in','total_handover','available_balance','reserved_balance','pending_credit','pending_debit','pending_count','updated_at']) {
          assert.equal(other[field],null,`recipient directory must hide ${field}`);
        }
        assert.equal(other.can_transfer_from,false);
      }
      await assert.rejects(invoke(controller.userDetail,{user:1,params:{id:3}}),status(403));
      await assert.rejects(invoke(controller.historyDetail,{user:1,params:{id:privateMovement}}),status(404));
      assert.equal((await invoke(controller.history,{user:1,extraQuery:{holder_type:'user',holder_id:3}})).total,0);
      assert.equal((await invoke(controller.assignedTransactions,{user:1,extraQuery:{holder_type:'user',holder_id:3}})).total,0);
      await assert.rejects(invoke(controller.holders,{user:1,extraQuery:{purpose:'all'}}),status(400));
      for(const user of [2,6]) {
        const all=await invoke(controller.holders,{user});
        assert.ok(all.holders.some(h=>h.holder_type==='user'&&h.holder_id===1));
        assert.equal(Number(all.holders.find(h=>h.holder_type==='user'&&h.holder_id===3).balance),640);
        assert.equal(Number((await invoke(controller.userDetail,{user,params:{id:3}})).user.balance),640);
        assert.equal((await invoke(controller.historyDetail,{user,params:{id:privateMovement}})).entry.holder_id,3);
        await assert.rejects(invoke(controller.summary,{user,site:20}),status(403));
      }
    });
    await t.test('cashbook reconciles the notebook example, accepted handovers and receipt corrections across every page',async()=>{
      const siteIncomingBefore=Number((await invoke(controller.summary)).vault.site_cash_incoming);
      await query("INSERT INTO users VALUES(7,'Cashbook collector','sub_admin',1,true); INSERT INTO user_sites VALUES(7,10)");
      const collect=credit=>entry({created_by:7,credit});
      const handover=async amount=>{
        const request=await createVaultTransfer({id:7},transfer(String(amount)),db);
        await resolveVaultTransfer({id:2},request.transfer.id,'accept',{site_id:10},db);
      };
      await collect(500000);await collect(200000);await collect(100000);
      await handover(500000);
      await collect(200000);await collect(400000);
      await handover(900000);
      const profile=()=>invoke(controller.userDetail,{params:{id:7}});
      let cashbook=(await profile()).user;
      assert.equal(Number(cashbook.total_in),1400000);
      assert.equal(Number(cashbook.total_handover),1400000);
      assert.equal(Number(cashbook.balance),0);
      assert.equal(Number((await invoke(controller.summary)).vault.site_cash_incoming),siteIncomingBefore+1400000,'site receipts count each collection once across all holders');
      const directory=(await invoke(controller.holders)).holders.find(h=>h.holder_type==='user'&&h.holder_id===7);
      for(const key of ['total_in','total_handover','balance'])assert.equal(directory[key],cashbook[key]);
      const own=(await invoke(controller.holders,{user:7})).holders;
      assert.equal(own.length,1);assert.equal(Number(own[0].total_handover),1400000);
      const expected=[500000,700000,800000,300000,500000,900000,0];
      for(let page=1;page<=7;page++){
        const ledger=await invoke(controller.history,{user:7,extraQuery:{order:'asc',limit:1,page}});
        assert.equal(ledger.order,'asc');assert.equal(ledger.total,7);
        assert.equal(Number(ledger.entries[0].balance_after),expected[page-1]);
        assert.equal(Number(ledger.totals.credit),1400000,'credit total includes every matching page');
        assert.equal(Number(ledger.totals.debit),1400000);
        assert.equal(Number(ledger.totals.net),0);
      }
      const corrected=await collect(20.25);
      await query('UPDATE cash_flow_entries SET credit=10.25 WHERE id=$1',[corrected]);
      const pending=await createVaultTransfer({id:7},transfer('10'),db);
      cashbook=(await profile()).user;
      assert.equal(Number(cashbook.total_in),1400010.25,'receipt corrections reduce net receipts');
      assert.equal(Number(cashbook.total_handover),1400000,'pending requests never count as handovers');
      assert.equal(Number(cashbook.balance),10.25);
      await resolveVaultTransfer({id:7},pending.transfer.id,'cancel',{site_id:10},db);
      assert.deepEqual((await profile()).user,cashbook);
      const received=await createVaultTransfer({id:2},{...transfer('5.25'),to_holder_id:7},db);
      await resolveVaultTransfer({id:7},received.transfer.id,'accept',{site_id:10},db);
      cashbook=(await profile()).user;
      assert.equal(Number(cashbook.total_in),1400015.50,'incoming accepted handovers count in receipts');
      assert.equal(Number(cashbook.total_handover),1400000);
      assert.equal(Number(cashbook.balance),15.50);
      assert.equal(Number((await invoke(controller.summary)).vault.site_cash_incoming),siteIncomingBefore+1400010.25,'incoming handovers never inflate the site receipts and corrections are netted');
      const siteSummary=(await invoke(controller.summary)).vault;
      assert.equal(siteSummary.total_balance,siteSummary.site_cash_incoming,'existing site balance aggregate remains a valid compatibility fallback under receipt-only and paired-handover rules');
      const rejected=await entry({created_by:7,credit:100,status:'rejected',date:'2026-10-15'});
      const transactionScope={holder_type:'user',holder_id:7,limit:1};
      const allTransactions=await invoke(controller.assignedTransactions,{user:7,extraQuery:transactionScope});
      assert.equal(allTransactions.transactions.length,1);
      assert.equal(Number(allTransactions.totals.credit),1400110.25,'recorded credits include the rejected source original, across all pages');
      assert.equal(Number(allTransactions.totals.debit),0);
      assert.equal(Number(allTransactions.totals.posted_amount),1400010.25,'posted cash excludes rejected receipts and wallet handovers');
      const rejectedOnly=await invoke(controller.assignedTransactions,{user:7,extraQuery:{...transactionScope,status:'rejected',from:'2026-10-15',to:'2026-10-15',q:String(rejected)}});
      assert.deepEqual(Object.values(rejectedOnly.totals).map(Number),[100,0,0]);
      const beyond=await invoke(controller.assignedTransactions,{user:7,extraQuery:{...transactionScope,page:999}});
      assert.equal(beyond.transactions.length,0);assert.deepEqual(beyond.totals,allTransactions.totals,'an out-of-range page preserves filtered totals');
    });
    await t.test('user filters apply incoming and outgoing directions to the selected wallet and preserve action permissions',async()=>{
      const scope={holder_type:'user',holder_id:7};
      const all=await invoke(controller.transfers,{extraQuery:scope});
      assert.ok(all.transfers.length>0);
      assert.ok(all.transfers.every(row=>(row.from_holder_type==='user'&&row.from_holder_id===7)||row.to_holder_id===7));
      const outgoing=await invoke(controller.transfers,{extraQuery:{...scope,direction:'outgoing'}});
      assert.ok(outgoing.transfers.length>0);
      assert.ok(outgoing.transfers.every(row=>row.from_holder_type==='user'&&row.from_holder_id===7));
      const incoming=await invoke(controller.transfers,{extraQuery:{...scope,direction:'incoming'}});
      assert.ok(incoming.transfers.length>0);
      assert.ok(incoming.transfers.every(row=>row.to_holder_id===7));
      const request=await createVaultTransfer({id:7},transfer('1'),db);
      const selected=await invoke(controller.transfers,{extraQuery:{...scope,direction:'outgoing',status:'pending'}});
      const row=selected.transfers.find(item=>item.id===request.transfer.id);
      assert.ok(row);
      assert.equal(row.can_cancel,false,'viewing another user does not impersonate the sender');
      assert.equal(row.can_accept,true,'acceptance rights still belong to the signed-in recipient');
      await assert.rejects(invoke(controller.transfers,{user:1,extraQuery:scope}),status(403));
      await assert.rejects(invoke(controller.transfers,{extraQuery:{holder_id:4}}),status(403));
      await assert.rejects(invoke(controller.transfers,{site:11,extraQuery:scope}),status(403));
      await resolveVaultTransfer({id:7},request.transfer.id,'cancel',{site_id:10},db);
    });
  } finally {pool.query=originalQuery;pool.connect=originalConnect;await pg.close();}
});
