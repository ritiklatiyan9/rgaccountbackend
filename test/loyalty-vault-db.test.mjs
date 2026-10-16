import { walletHistoryParentsSql } from './helpers/walletHistoryParents.mjs';
import { applyApprovedEditRequest } from '../src/controllers/editRequest.controller.js';
import pool from '../src/config/db.js';
import * as controller from '../src/controllers/loyaltyVault.controller.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up } from '../src/migrations/199_loyalty_vault.js';
import { up as cashWalletUp } from '../src/migrations/185_cash_wallets.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';

test('Loyalty Vault attributes existing finances and transfers custody exactly once', { skip:!process.env.PGLITE_MODULE }, async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{
    const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
    return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};
  };
  const db={query,connect:async()=>({query,release(){}})};
  const amount=async(key)=>(await query('SELECT balance::text,reserved_balance::text FROM loyalty_vault_accounts WHERE holder_key=$1',[key])).rows[0]||{balance:'0.00',reserved_balance:'0.00'};
  const entries=async()=>Number((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n);
  const errorStatus=status=>error=>error.statusCode===status;
  const actor={id:1},admin={id:2};let serial=100;
  const entry=async(data={})=>{
    const values={id:serial++,site_id:10,created_by:1,credit:100,debit:0,cash_type:'BANK',status:'pending',particular:'Client deposit',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1,...data};
    const keys=Object.keys(values);await query(`INSERT INTO cash_flow_entries(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(values));return values.id;
  };
  const req=(amount='10',from={type:'user',id:1},to=2)=>({from_holder_type:from.type,from_holder_id:from.id,to_holder_type:'user',to_holder_id:to,amount,note:'Handed over',site_id:10,idempotency_key:randomUUID()});
  try{
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Accountant','sub_admin',1,true),(2,'Administrator','admin',1,true),(3,'Owner','super_admin',1,true),(4,'Outside admin','admin',2,true),(5,'Inactive','admin',1,false),(6,'Viewer','viewer',1,true);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);INSERT INTO sites VALUES(10,'A',1),(11,'B',1),(20,'Outside',2);
      CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(1,10);
      CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_view_all boolean);INSERT INTO user_permissions VALUES(1,'cashflow',true,false);
      CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text);INSERT INTO members VALUES(1,10,'Known account','9999999999'),(2,11,'Other site known','8888888888'),(3,20,'Outside known','7777777777');
      CREATE TABLE cash_flow_entries(id integer PRIMARY KEY,site_id integer,created_by integer,credit numeric DEFAULT 0,debit numeric DEFAULT 0,
        cash_type text,status text,cheque_status text,particular text,source_module text,source_id integer,date date DEFAULT CURRENT_DATE,
        created_at timestamptz DEFAULT now(),entry_transfer_id uuid,is_imprest_internal boolean,is_firm_transaction boolean,to_firm_id integer);
      CREATE TABLE cash_flow_months(id integer PRIMARY KEY,site_id integer);
      CREATE TABLE farmers(id integer PRIMARY KEY,site_id integer);INSERT INTO farmers VALUES(1,10);
      CREATE TABLE plots(id integer PRIMARY KEY,site_id integer,plot_no text,buyer_name text,block text);CREATE TABLE plot_installments(id integer PRIMARY KEY,plot_id integer);
      CREATE TABLE firms(id integer PRIMARY KEY,site_id integer);INSERT INTO firms VALUES(1,10);
      ${postingPolicySql}`);
    for(const table of [...LOYALTY_VAULT_SOURCE_TABLES].filter(table=>table!=='cash_flow_entries'))await query(`CREATE TABLE ${table}(id integer PRIMARY KEY,site_id integer,created_by integer,status text DEFAULT 'pending',payment_mode text DEFAULT 'BANK',payment_type text,cheque_status text,
      entry_type text,created_at timestamptz DEFAULT now(),farmer_id integer,firm_id integer,plot_id integer,installment_id integer,cash_amount numeric,
      cash_flow_entry_id integer,expense_id integer,farmer_payment_id integer,commission_id integer,firm_transaction_id integer,plot_payment_id integer,vendor_payment_id integer,imprest_allocation_id integer,
      entry_transfer_id uuid,money_transfer_id uuid,is_firm_to_firm_transfer boolean,transfer_group_id uuid,is_financial_projection boolean,source_vendor_payment_id integer,is_imprest_internal boolean)`);
    await query("INSERT INTO cash_flow_entries(id,site_id,created_by,credit,cash_type,status,created_at) VALUES(1,10,1,500,'CASH','approved','2020-01-01')");
    await query(walletHistoryParentsSql);
    await cashWalletUp(db);await up(db);await up(db);
    await t.test('migration is idempotent and historical unassigned finances are unchanged',async()=>{
      assert.equal((await query('SELECT credit::text FROM cash_flow_entries WHERE id=1')).rows[0].credit,'500');
      assert.equal(await entries(),0);assert.equal((await amount('user:1')).balance,'0.00');
      await query('UPDATE cash_flow_entries SET credit=600 WHERE id=1');assert.equal(await entries(),0);
    });
    let credit;
    await t.test('credit-first, approved debits and all payment modes follow existing posting policy',async()=>{
      credit=await entry({credit:'1000.25'});assert.equal((await amount('user:1')).balance,'1000.25');
      await query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1",[credit]);assert.equal(await entries(),1);
      const debit=await entry({credit:0,debit:120});assert.equal((await amount('user:1')).balance,'1000.25');
      await query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1",[debit]);assert.equal((await amount('user:1')).balance,'880.25');
      await query("UPDATE cash_flow_entries SET status='rejected' WHERE id=$1",[debit]);assert.equal((await amount('user:1')).balance,'1000.25');
      for(const cash_type of ['CASH','UPI','NEFT'])await entry({cash_type,credit:10});
      const cheque=await entry({cash_type:'CHEQUE',credit:25,cheque_status:'PENDING'});assert.equal((await amount('user:1')).balance,'1030.25');
      await query("UPDATE cash_flow_entries SET cheque_status='CLEARED',status='approved' WHERE id=$1",[cheque]);assert.equal((await amount('user:1')).balance,'1055.25');
      assert.equal((await query('SELECT sum(balance)::text AS n FROM wallet_accounts')).rows[0].n,'10.00','Cash wallet independently collects only physical cash');
    });
    await t.test('holder edits, clearing, deletion and refunds append exact compensating history',async()=>{
      await query('UPDATE cash_flow_entries SET credit=1100.25 WHERE id=$1',[credit]);assert.equal((await amount('user:1')).balance,'1155.25');
      await query("UPDATE cash_flow_entries SET loyalty_vault_holder_type='member',loyalty_vault_holder_id=1,loyalty_vault_assigned_by=2 WHERE id=$1",[credit]);
      assert.equal((await amount('user:1')).balance,'55.00');assert.equal((await amount('member:1')).balance,'1100.25');
      await query('UPDATE cash_flow_entries SET loyalty_vault_holder_type=NULL,loyalty_vault_holder_id=NULL WHERE id=$1',[credit]);assert.equal((await amount('member:1')).balance,'0.00');
      await query("UPDATE cash_flow_entries SET loyalty_vault_holder_type='user',loyalty_vault_holder_id=1 WHERE id=$1",[credit]);
      const refund=await entry({credit:0,debit:-10});assert.equal((await amount('user:1')).balance,'1165.25');
      await query('DELETE FROM cash_flow_entries WHERE id=$1',[refund]);assert.equal((await amount('user:1')).balance,'1155.25');
      await assert.rejects(query("UPDATE loyalty_vault_entries SET description='changed' WHERE id=1"),/immutable/);
    });
    await t.test('real native sources reconcile once; paired, projected and firm copies never mint custody',async()=>{
      await query("INSERT INTO expenses(id,site_id,created_by,status,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by) VALUES(1,10,1,'approved','user',1,1)");
      await entry({source_module:'expenses',source_id:1,credit:0,debit:30,loyalty_vault_holder_type:null,loyalty_vault_holder_id:null,loyalty_vault_assigned_by:null});
      assert.equal((await amount('user:1')).balance,'1125.25');
      await query("UPDATE expenses SET loyalty_vault_holder_id=2,loyalty_vault_assigned_by=2 WHERE id=1");assert.equal((await amount('user:1')).balance,'1155.25');assert.equal((await amount('user:2')).balance,'-30.00');
      await query('BEGIN');const direct=await entry({credit:50});
      await query("INSERT INTO firm_transactions(id,site_id,created_by,cash_flow_entry_id,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by) VALUES(1,10,1,$1,'user',1,1)",[direct]);
      await entry({source_module:'firm_transactions',source_id:1,credit:50});await query('COMMIT');assert.equal((await amount('user:1')).balance,'1205.25');
      const before=await entries();await entry({credit:100,is_imprest_internal:true});await entry({credit:100,entry_transfer_id:randomUUID()});
      await entry({source_module:'plot_payments_person',source_id:1});
      await entry({source_module:'plot_registry_payments',source_id:1,debit:100,credit:0,status:'approved'});
      await entry({source_module:'plot_commissions',source_id:1,debit:100,credit:0,status:'approved'});
      await query("INSERT INTO day_book(id,site_id,created_by,expense_id,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by) VALUES(1,10,1,1,'user',1,1)");
      await entry({source_module:'day_book',source_id:1});assert.equal(await entries(),before);
    });
    await t.test('cross-organization, inactive holder, site edits and forged roles fail closed',async()=>{
      for(const data of [{loyalty_vault_holder_id:4},{loyalty_vault_holder_id:5},{loyalty_vault_holder_id:6},{loyalty_vault_holder_type:'member',loyalty_vault_holder_id:2},{site_id:20},{loyalty_vault_assigned_by:6}])await assert.rejects(entry(data),/active|accessible|known client/);
      await assert.rejects(query('UPDATE cash_flow_entries SET site_id=20 WHERE id=$1',[credit]),/accessible/);
      await assert.rejects(createVaultTransfer({id:6,role:'admin'},req(),db),errorStatus(403));
      await assert.rejects(createVaultTransfer(actor,req('10',{type:'member',id:1}),db),errorStatus(403));
      await assert.rejects(createVaultTransfer(actor,req('10',{type:'user',id:1},4),db),errorStatus(403));
    });
    await t.test('unreserved pending transfer, recipient-only acceptance and idempotent balanced posting',async()=>{
      const data=req('400.10'),first=await createVaultTransfer(actor,data,db),before=await entries();
      assert.equal((await amount('user:1')).reserved_balance,'0.00');assert.equal((await amount('user:2')).balance,'-30.00');
      assert.equal((await createVaultTransfer(actor,data,db)).transfer.id,first.transfer.id);
      await assert.rejects(createVaultTransfer(actor,{...data,amount:'400.11'},db),errorStatus(409));
      await assert.rejects(resolveVaultTransfer(actor,first.transfer.id,'accept',{site_id:10},db),errorStatus(403));
      await assert.rejects(resolveVaultTransfer({id:3},first.transfer.id,'accept',{site_id:10},db),errorStatus(404));
      const financialBefore=JSON.stringify((await query('SELECT id,credit::text,debit::text FROM cash_flow_entries ORDER BY id')).rows);
      const cashBefore=JSON.stringify((await query('SELECT * FROM wallet_accounts ORDER BY user_id')).rows);
      await resolveVaultTransfer(admin,first.transfer.id,'accept',{site_id:10},db);
      assert.equal((await amount('user:1')).balance,'805.15');assert.equal((await amount('user:2')).balance,'370.10');assert.equal(await entries(),before+2);
      assert.equal((await resolveVaultTransfer(admin,first.transfer.id,'accept',{site_id:10},db)).replayed,true);assert.equal(await entries(),before+2);
      assert.equal(JSON.stringify((await query('SELECT id,credit::text,debit::text FROM cash_flow_entries ORDER BY id')).rows),financialBefore);
      assert.equal(JSON.stringify((await query('SELECT * FROM wallet_accounts ORDER BY user_id')).rows),cashBefore);
      assert.equal((await query("SELECT sum(amount)::text AS n FROM loyalty_vault_entries WHERE kind IN ('transfer_in','transfer_out')")).rows[0].n,'0.00');
    });
    await t.test('known clients can hand over funds through admin, and cancellation/rejection leave balances intact',async()=>{
      await entry({credit:200,loyalty_vault_holder_type:'member',loyalty_vault_holder_id:1});
      await assert.rejects(query('DELETE FROM members WHERE id=1'),error=>error.constraint==='loyalty_vault_holder_funds');
      const incoming=await createVaultTransfer(admin,req('100',{type:'member',id:1},3),db);
      await resolveVaultTransfer({id:3},incoming.transfer.id,'accept',{site_id:10},db);assert.equal((await amount('member:1')).balance,'100.00');assert.equal((await amount('user:3')).balance,'100.00');
      const rejectable=await createVaultTransfer(actor,req('10'),db),cancellable=await createVaultTransfer(actor,req('15'),db),before=await entries();
      await resolveVaultTransfer(admin,rejectable.transfer.id,'reject',{site_id:10},db);await resolveVaultTransfer(actor,cancellable.transfer.id,'cancel',{site_id:10},db);
      assert.equal((await amount('user:1')).reserved_balance,'0.00');assert.equal(await entries(),before);
    });
    await t.test('receipt corrections after transfer preserve deficit, reject unfunded acceptance, and roll back failures',async()=>{
      const pending=await createVaultTransfer(actor,req('50'),db);
      await query('UPDATE cash_flow_entries SET credit=1 WHERE id=$1',[credit]);assert.equal((await amount('user:1')).balance,'-294.10');
      await assert.rejects(resolveVaultTransfer(admin,pending.transfer.id,'accept',{site_id:10},db),errorStatus(409));
      await assert.rejects(createVaultTransfer(actor,req('0.01'),db),errorStatus(409));
      await resolveVaultTransfer(actor,pending.transfer.id,'cancel',{site_id:10},db);
      const broken=await createVaultTransfer(admin,req('10',{type:'user',id:2},3),db),before=await amount('user:2'),count=await entries();
      await query("CREATE FUNCTION fail_vault_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='transfer_in' THEN RAISE EXCEPTION 'Storage failed'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_vault_test BEFORE INSERT ON loyalty_vault_entries FOR EACH ROW EXECUTE FUNCTION fail_vault_test()");
      await assert.rejects(resolveVaultTransfer({id:3},broken.transfer.id,'accept',{site_id:10},db),/Storage failed/);assert.deepEqual(await amount('user:2'),before);assert.equal(await entries(),count);
      assert.equal((await query('SELECT status FROM loyalty_vault_transfers WHERE id=$1',[broken.transfer.id])).rows[0].status,'pending');
      await query('DROP TRIGGER fail_vault_test ON loyalty_vault_entries');await resolveVaultTransfer(admin,broken.transfer.id,'cancel',{site_id:10},db);
    });
    await t.test('zero balance deleted-client history retains its recorded holder name',async()=>{
      await query("INSERT INTO members VALUES(4,10,'Bound zero holder','6666666666')");
      const bound=await entry({credit:0,debit:0,loyalty_vault_holder_type:'member',loyalty_vault_holder_id:4});
      await assert.rejects(query('DELETE FROM members WHERE id=4'),error=>error.constraint==='loyalty_vault_holder_funds');
      await query('UPDATE cash_flow_entries SET loyalty_vault_holder_type=NULL,loyalty_vault_holder_id=NULL,loyalty_vault_assigned_by=2 WHERE id=$1',[bound]);
      await query("INSERT INTO day_book(id,site_id,created_by,expense_id,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by) VALUES(77,10,1,1,'member',4,2)");
      await query('DELETE FROM members WHERE id=4');
      await query("SELECT loyalty_vault_apply_delta('member:2',1,5,'credit','Recorded handover')");
      await query("SELECT loyalty_vault_apply_delta('member:2',1,-5,'transfer_out','Returned money')");
      await query('DELETE FROM members WHERE id=2');
      assert.equal((await query("SELECT details->>'holder_name' AS name FROM loyalty_vault_entries WHERE holder_key='member:2' ORDER BY id DESC LIMIT 1")).rows[0].name,'Other site known');
    });
    await t.test('finite amount safeguards prevent poisoned accounts and rollback uncommitted capture',async()=>{
      for(const value of ['NaN','Infinity','-Infinity'])await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:1',1,$1::numeric,'credit','Invalid')",[value]),/finite/);
      await assert.rejects(query("UPDATE loyalty_vault_accounts SET balance='NaN' WHERE holder_key='user:1'"),/check constraint/);
      const before=await amount('user:1'),count=await entries();await query('BEGIN');await entry({credit:50});await query('ROLLBACK');assert.deepEqual(await amount('user:1'),before);assert.equal(await entries(),count);
    });
    await t.test('API endpoints enforce scope, history filters, snapshot detail, and paginated notifications',async()=>{
      const originalQuery=pool.query,originalConnect=pool.connect;pool.query=query;pool.connect=db.connect;
      const invoke=(handler,extra={})=>new Promise((resolve,reject)=>{
        const request={user:actor,body:{},params:{},...extra,query:{site_id:10,...extra.query}};
        const response={set(){return this;},status(code){this.code=code;return this;},json(body){resolve({body,code:this.code||200});}};
        handler(request,response,reject);
      });
      try {
        const summary=(await invoke(controller.summary)).body;assert.equal(summary.vault.balance,'-294.10');assert.equal(summary.pending_incoming,0);
        const own=(await invoke(controller.holders,{query:{site_id:'10'}})).body.holders;
        assert.deepEqual(own.map(h=>`${h.holder_type}:${h.holder_id}`),['user:1']);
        const recipients=(await invoke(controller.holders,{query:{site_id:'10',purpose:'selection'}})).body.holders;
        assert.ok(recipients.some(h=>h.holder_type==='member'&&h.holder_id===1));assert.ok(!recipients.some(h=>h.holder_type==='member'&&h.holder_id===2));
        assert.ok(!recipients.some(h=>h.holder_type==='user'&&[4,5,6].includes(h.holder_id)));
        assert.equal(recipients.find(h=>h.holder_type==='member').balance,null);
        await assert.rejects(invoke(controller.holders,{query:{site_id:'20'}}),errorStatus(403));
        const all=(await invoke(controller.history,{user:admin,query:{limit:'1'}})).body;assert.equal(all.entries.length,1);assert.ok(all.total>1);
        const detail=(await invoke(controller.historyDetail,{user:admin,params:{id:all.entries[0].id}})).body.entry;assert.equal(detail.id,all.entries[0].id);assert.ok(detail.source_details);
        const known=(await invoke(controller.history,{user:admin,query:{holder_type:'member',holder_id:1}})).body;assert.ok(known.entries.every(e=>e.holder_key==='member:1'));
        const privateHistory=(await invoke(controller.history,{query:{holder_type:'user',holder_id:2}})).body;assert.equal(privateHistory.total,0);
        await query("UPDATE users SET is_active=false WHERE id=3");
        const retired=(await invoke(controller.holders,{user:admin})).body.holders.find(h=>h.holder_type==='user'&&h.holder_id===3);assert.equal(retired.can_receive_transfer,false);assert.equal(retired.can_transfer_from,true);
        const recover=await createVaultTransfer(admin,req('1',{type:'user',id:3},2),db);await resolveVaultTransfer(admin,recover.transfer.id,'accept',{site_id:10},db);
        await query("UPDATE users SET is_active=true WHERE id=3");
        const restricted=(await invoke(controller.history)).body;assert.ok(restricted.entries.every(e=>e.holder_key==='user:1'));
        const search=(await invoke(controller.history,{query:{q:'Client deposit'}})).body;assert.ok(search.total>0);
        const absent=(await invoke(controller.assignment,{query:{source_table:'cash_flow_entries',source_id:1}})).body.assignment;assert.equal(absent.loyalty_vault_holder_type,'user');assert.equal(absent.loyalty_vault_holder_id,1);
        await assert.rejects(invoke(controller.assignment,{query:{source_table:'users',source_id:1}}),errorStatus(400));
        const listing=(await invoke(controller.transfers,{user:admin})).body;assert.ok(listing.total>0);
        const pending=await createVaultTransfer(admin,req('5',{type:'user',id:2},3),db);
        const notices=(await invoke(controller.transfers,{user:{id:3},query:{direction:'incoming',status:'pending',limit:'1'}})).body;
        assert.equal(notices.total,1);assert.equal(notices.transfers[0].id,pending.transfer.id);assert.equal(notices.transfers[0].can_accept,true);
        await resolveVaultTransfer({id:3},pending.transfer.id,'reject',{site_id:10},db);
        await query("INSERT INTO loyalty_vault_entries(organization_id,holder_key,holder_type,holder_id,amount,balance_after,kind,site_id,created_at) VALUES(1,'user:1','user',1,1,0,'adjustment',10,'2026-09-30T18:29:59Z'),(1,'user:1','user',1,1,0,'adjustment',10,'2026-09-30T18:30:00Z'),(1,'user:1','user',1,1,0,'adjustment',10,'2026-10-01T18:29:59Z'),(1,'user:1','user',1,1,0,'adjustment',10,'2026-10-01T18:30:00Z')");
        const filtered=(await invoke(controller.history,{query:{type:'adjustment',from:'2026-10-01',to:'2026-10-01',limit:'1',page:'2'}})).body;assert.equal(filtered.total,2);assert.equal(new Date(filtered.entries[0].created_at).toISOString(),'2026-09-30T18:30:00.000Z');
        await assert.rejects(invoke(controller.history,{query:{from:'2026-10-02',to:'2026-10-01'}}),errorStatus(400));
        await query('BEGIN');
        try {
          const ids=listing.transfers.slice(0,4).map(row=>row.id);assert.equal(ids.length,4);
          await query("UPDATE loyalty_vault_transfers SET created_at='2040-01-01T00:00:00Z'");
          const timestamps=['2040-04-30T18:29:59Z','2040-04-30T18:30:00Z','2040-05-01T18:29:59Z','2040-05-01T18:30:00Z'];
          for(let i=0;i<ids.length;i++)await query('UPDATE loyalty_vault_transfers SET created_at=$2 WHERE id=$1',[ids[i],timestamps[i]]);
          const transfers=(await invoke(controller.transfers,{user:admin,query:{from:'2040-05-01',to:'2040-05-01',limit:'1',page:'2'}})).body;
          assert.equal(transfers.total,2);assert.equal(transfers.transfers.length,1);assert.equal(transfers.transfers[0].id,ids[1]);
          assert.equal((await invoke(controller.transfers,{user:admin,query:{from:'2040-05-01'}})).body.total,3);
          const outside=(await invoke(controller.transfers,{user:admin,query:{from:'2040-05-01',to:'2040-05-01',page:'99'}})).body;
          assert.equal(outside.total,2);assert.equal(outside.transfers.length,0);
          await assert.rejects(invoke(controller.transfers,{user:admin,query:{from:'2040-05-02',to:'2040-05-01'}}),errorStatus(400));
          await assert.rejects(invoke(controller.transfers,{user:admin,query:{to:'2040-02-30'}}),errorStatus(400));
        } finally {await query('ROLLBACK');}
      } finally {pool.query=originalQuery;pool.connect=originalConnect;}
    });
    await t.test('an approved edit preserves historical custody and never stamps the reviewer as collector',async()=>{
      await query("INSERT INTO plot_payments(id,site_id,created_by,status) VALUES(99,10,1,'approved')");
      const cashId=await entry({source_module:'plot_payments',source_id:99,credit:7});
      const before=await amount('user:2');
      await query('BEGIN');
      await applyApprovedEditRequest({module:'plot_payment',record_id:99},{},admin,db);
      await query('COMMIT');
      const source=(await query('SELECT loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by FROM plot_payments WHERE id=99')).rows[0];
      assert.deepEqual(source,{loyalty_vault_holder_type:null,loyalty_vault_holder_id:null,loyalty_vault_assigned_by:null});
      assert.equal(Number((await amount('user:2')).balance),Number(before.balance));
      assert.equal((await query('SELECT credit::text,debit::text FROM cash_flow_entries WHERE id=$1',[cashId])).rows[0].credit,'7');
    });
    await t.test('pending original payments are visible without funding custody, then clear exactly once',async()=>{
      const originalQuery=pool.query,originalConnect=pool.connect;pool.query=query;pool.connect=db.connect;
      const invoke=(handler,extra={})=>new Promise((resolve,reject)=>handler({user:admin,params:{},...extra,query:{site_id:10,...extra.query}},
        {set(){return this;},json(body){resolve(body);}},reject));
      try {
        await query("INSERT INTO users VALUES(7,'Pending cheque holder','admin',1,true)");
        await query("INSERT INTO plots VALUES(3,10,'A3','ALICE BUYER','A'),(4,10,'A3','OTHER BUYER','A')");
        await query("INSERT INTO plot_payments(id,plot_id,site_id,created_by,payment_mode,cheque_status,loyalty_vault_holder_type,loyalty_vault_holder_id,loyalty_vault_assigned_by) VALUES(5001,3,10,2,'CHEQUE','PENDING','user',7,2)");
        const cashId=await entry({source_module:'plot_payments',source_id:5001,date:'2024-02-29',credit:150000,cash_type:'CHEQUE',cheque_status:'PENDING',loyalty_vault_holder_type:null,loyalty_vault_holder_id:null});
        const scope={holder_type:'user',holder_id:'7'};
        const profile=await invoke(controller.userDetail,{params:{id:'7'}});
        assert.equal(profile.user.pending_credit,'150000');assert.equal(profile.user.balance,'0');assert.equal(profile.user.available_balance,'0');
        const listed=(await invoke(controller.holders)).holders.find(row=>row.holder_id===7&&row.holder_type==='user');
        assert.equal(listed.pending_count,1);assert.equal(listed.pending_credit,'150000');assert.equal(listed.available_balance,'0');
        const before=await entries(),pending=await invoke(controller.assignedTransactions,{query:{...scope,status:'pending',limit:'1'}});
        assert.equal(pending.total,1);assert.equal(pending.transactions[0].source_id,5001);assert.equal(pending.transactions[0].status,'pending_clearance');
        assert.equal(pending.transactions[0].posted_amount,'0');assert.equal(pending.transactions[0].pending_credit,'150000');
        assert.equal(pending.transactions[0].plot_no,'A3');assert.equal(pending.transactions[0].buyer_name,'ALICE BUYER');assert.equal(pending.transactions[0].source_details.plot_id,3);
        assert.equal(pending.transactions[0].created_by_name,'Administrator');assert.equal(await entries(),before);
        const beyond=await invoke(controller.assignedTransactions,{query:{...scope,page:'99'}});assert.equal(beyond.total,1);assert.equal(beyond.transactions.length,0);
        for(const dates of [{from:'2024-02-29',to:'2024-02-29'},{from:'2024-02-01',to:'2024-02-29'},{from:'2024-01-01',to:'2024-12-31'},{to:'2024-02-29'},{from:'2024-02-29'}]){
          const dated=await invoke(controller.assignedTransactions,{query:{...scope,...dates,status:'pending',q:'ALICE BUYER',site_id:'10'}});
          assert.equal(dated.total,1);assert.equal(dated.transactions[0].source_id,5001);
        }
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,from:'2024-03-01'}})).total,0);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,to:'2024-02-28'}})).total,0);
        const datedBeyond=await invoke(controller.assignedTransactions,{query:{...scope,from:'2024-02-29',to:'2024-02-29',page:'99'}});
        assert.equal(datedBeyond.total,1);assert.equal(datedBeyond.transactions.length,0);
        await assert.rejects(invoke(controller.assignedTransactions,{query:{...scope,from:'2024-03-01',to:'2024-02-29'}}),errorStatus(400));
        await assert.rejects(invoke(controller.assignedTransactions,{query:{...scope,from:'2023-02-29'}}),errorStatus(400));
        await assert.rejects(createVaultTransfer(admin,req('1',{type:'user',id:7},2),db),/cash balance/);
        await assert.rejects(invoke(controller.userDetail,{user:actor,params:{id:'7'}}),errorStatus(403));
        assert.equal((await invoke(controller.assignedTransactions,{user:actor,query:scope})).total,0);
        await assert.rejects(invoke(controller.userDetail,{params:{id:'4'}}),errorStatus(404));
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,q:'Client deposit'}})).total,1);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,q:'ALICE BUYER'}})).total,1);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,q:'A3'}})).total,1);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,q:'OTHER BUYER'}})).total,0);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,q:'%'}})).total,0);
        await query("UPDATE plot_payments SET cheque_status='CLEARED',status='approved' WHERE id=5001");
        await query("UPDATE cash_flow_entries SET cheque_status='CLEARED',status='approved' WHERE id=$1",[cashId]);
        assert.equal((await amount('user:7')).balance,'150000.00');assert.equal(await entries(),before+1);
        const movement=(await invoke(controller.history,{query:scope})).entries[0];
        assert.equal(movement.plot_no,'A3');assert.equal(movement.buyer_name,'ALICE BUYER');assert.equal(movement.source_details.plot_id,3);
        const movementDetail=(await invoke(controller.historyDetail,{params:{id:movement.id}})).entry;assert.equal(movementDetail.plot_no,'A3');
        const cleared=await invoke(controller.userDetail,{params:{id:'7'}});assert.equal(Number(cleared.user.pending_credit),0);assert.equal(cleared.user.pending_count,0);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,status:'posted'}})).total,1);
        await query("UPDATE plot_payments SET cheque_status='CLEARED' WHERE id=5001");assert.equal(await entries(),before+1);
        const debit=await entry({credit:0,debit:20,loyalty_vault_holder_id:7});
        const approval=await invoke(controller.assignedTransactions,{query:{...scope,status:'pending_approval'}});assert.equal(approval.total,1);assert.equal(approval.transactions[0].pending_debit,'20');
        await query("UPDATE cash_flow_entries SET status='rejected' WHERE id=$1",[debit]);
        assert.equal((await invoke(controller.userDetail,{params:{id:'7'}})).user.pending_count,0);
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,status:'rejected'}})).total,1);
        await query("UPDATE plot_payments SET cheque_status='BOUNCED' WHERE id=5001");
        assert.equal((await invoke(controller.assignedTransactions,{query:{...scope,status:'bounced'}})).total,1);
        assert.equal((await amount('user:7')).balance,'0.00');
      } finally {pool.query=originalQuery;pool.connect=originalConnect;}
    });
  }finally{await pg.close();}
});
