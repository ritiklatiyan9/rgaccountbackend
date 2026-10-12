import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as detailsUp } from '../src/migrations/186_wallet_receipt_details.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up } from '../src/migrations/203_unified_cash_wallet.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { createWalletTransfer,resolveWalletTransfer } from '../src/services/wallet.service.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { vaultTransactionsCte } from '../src/services/loyaltyVaultTransactions.service.js';
import pool from '../src/config/db.js';
import * as controller from '../src/controllers/loyaltyVault.controller.js';

test('one cash wallet preserves legacy funds and approvals without double-crediting sources', {skip:!process.env.PGLITE_MODULE},async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};};
  const db={query,connect:async()=>({query,release(){}})};
  const balance=async(id)=>(await query("SELECT balance::text,reserved_balance::text FROM loyalty_vault_accounts WHERE holder_key='user:'||$1::text",[id])).rows[0]||{balance:'0.00',reserved_balance:'0.00'};
  const count=async()=>Number((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n);
  let serial=100;
  const entry=async(data={})=>{const values={id:serial++,site_id:10,created_by:1,credit:100,debit:0,cash_type:'CASH',status:'pending',particular:'Cash deposit',...data};const keys=Object.keys(values);await query(`INSERT INTO cash_flow_entries(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(values));return values.id;};
  const request=(amount,recipient_id=2)=>({amount,recipient_id,idempotency_key:randomUUID()});
  try {
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
    await entry({id:1,credit:500,created_at:'2020-01-01'});
    await walletUp(db);await detailsUp(db);await vaultUp(db);
    const legacy=await entry({credit:1000});
    const overlap=await entry({credit:200,loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1});
    const bank=await entry({credit:300,cash_type:'BANK',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1});
    await query("INSERT INTO users VALUES(7,'Retired holder','admin',1,true)");
    const retiredExplicit=await entry({credit:5,loyalty_vault_holder_type:'user',loyalty_vault_holder_id:7,loyalty_vault_assigned_by:1});
    const retiredDefault=await entry({credit:7,created_by:7});
    await query("UPDATE users SET role='viewer',is_active=false WHERE id=7");
    const accepted=await createWalletTransfer({id:1},request('100'),db);await resolveWalletTransfer({id:2},accepted.transfer.id,'accept',{},db);
    const pending=await createWalletTransfer({id:1},request('50'),db);
    await query('UPDATE wallet_transfers SET note=NULL WHERE id=$1',[pending.transfer.id]);
    const rejected=await createWalletTransfer({id:1},request('10'),db);await resolveWalletTransfer({id:2},rejected.transfer.id,'reject',{},db);
    const beforeSource=JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows);
    const beforeLegacy=JSON.stringify((await query('SELECT * FROM wallet_entries ORDER BY id')).rows);
    const beforeSettings=(await query('SELECT tracking_started_at FROM wallet_settings')).rows[0].tracking_started_at;
    await up(db);
    await t.test('consolidation deduplicates overlap, reverses bank custody, imports transfers and reserves once',async()=>{
      assert.deepEqual(await balance(1),{balance:'1100.00',reserved_balance:'50.00'});
      assert.deepEqual(await balance(2),{balance:'100.00',reserved_balance:'0.00'});
      assert.equal((await query('SELECT posted_amount::text FROM loyalty_vault_sources WHERE cash_flow_entry_id=$1',[bank])).rows[0].posted_amount,'0.00');
      assert.equal((await query('SELECT count(*)::int AS n FROM loyalty_vault_transfers')).rows[0].n,3);
      assert.equal((await query('SELECT note FROM loyalty_vault_transfers WHERE id=$1',[pending.transfer.id])).rows[0].note,'');
      await assert.rejects(createWalletTransfer({id:1},request('1'),db),e=>e.constraint==='cash_wallet_legacy_read_only');
      assert.equal(JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows),beforeSource);
      assert.equal(JSON.stringify((await query('SELECT * FROM wallet_entries ORDER BY id')).rows),beforeLegacy);
      assert.deepEqual((await query('SELECT tracking_started_at FROM wallet_settings')).rows[0].tracking_started_at,beforeSettings);
      const start=(await query('SELECT consolidated_at FROM loyalty_vault_settings')).rows[0].consolidated_at,entries=await count();
      await walletUp(db);await vaultUp(db);await up(db);
      assert.equal(await count(),entries);assert.deepEqual(await balance(1),{balance:'1100.00',reserved_balance:'50.00'});
      assert.deepEqual((await query('SELECT consolidated_at FROM loyalty_vault_settings')).rows[0].consolidated_at,start);
      assert.equal((await query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname IN ('wallet_cash_receipt_sync','wallet_firm_link_sync')")).rows[0].n,0);
      assert.equal((await query(`${vaultTransactionsCte} SELECT cash_flow_entry_id FROM assigned_transactions ORDER BY cash_flow_entry_id`)).rows.some(r=>r.cash_flow_entry_id===bank),false);
      assert.equal((await query(`${vaultTransactionsCte} SELECT cash_flow_entry_id FROM assigned_transactions`)).rows.some(r=>r.cash_flow_entry_id===1),false);
    });
    await t.test('already tracked and explicit retired-user cash survives, while invalid new default creators stay excluded',async()=>{
      assert.deepEqual(await balance(7),{balance:'12.00',reserved_balance:'0.00'});
      for(const id of [retiredExplicit,retiredDefault]) {
        const row=(await query(`${vaultTransactionsCte} SELECT holder_id,posted_amount::text FROM assigned_transactions WHERE cash_flow_entry_id=$1`,[id])).rows[0];
        assert.equal(row.holder_id,7);assert.ok(Number(row.posted_amount)>0);
      }
      await query('UPDATE cash_flow_entries SET credit=8 WHERE id=$1',[retiredDefault]);assert.equal((await balance(7)).balance,'13.00');
      const invalid=await entry({credit:100,created_by:6});assert.equal((await balance(6)).balance,'0.00');
      assert.equal((await query(`${vaultTransactionsCte} SELECT cash_flow_entry_id FROM assigned_transactions WHERE cash_flow_entry_id=$1`,[invalid])).rows.length,0);
    });
    await t.test('legacy pending approval survives and the designated recipient decides it once',async()=>{
      await assert.rejects(resolveVaultTransfer({id:1},pending.transfer.id,'accept',{},db),e=>e.statusCode===403);
      await resolveVaultTransfer({id:2},pending.transfer.id,'accept',{},db);
      assert.deepEqual(await balance(1),{balance:'1050.00',reserved_balance:'0.00'});
      assert.deepEqual(await balance(2),{balance:'150.00',reserved_balance:'0.00'});
      const entries=await count();assert.equal((await resolveVaultTransfer({id:2},pending.transfer.id,'accept',{},db)).replayed,true);assert.equal(await count(),entries);
      assert.equal((await query("SELECT sum(amount)::text AS amount FROM loyalty_vault_entries WHERE transfer_id IS NOT NULL")).rows[0].amount,'0.00');
    });
    await t.test('new cash defaults to creator, selected recipient overrides it, and bank instruments never post',async()=>{
      const made=await entry({credit:40}),other=await entry({credit:25,loyalty_vault_holder_type:'user',loyalty_vault_holder_id:2,loyalty_vault_assigned_by:1});
      await entry({credit:100,created_by:2,loyalty_vault_holder_type:null,loyalty_vault_holder_id:null,loyalty_vault_assigned_by:2});
      assert.equal((await balance(1)).balance,'1090.00');assert.equal((await balance(2)).balance,'275.00');
      await query('UPDATE cash_flow_entries SET credit=50 WHERE id=$1',[made]);
      assert.equal((await balance(1)).balance,'1100.00','editing changes original maker cash, never editor cash');
      const before=await balance(1),entries=await count();
      for(const cash_type of ['BANK','UPI','NEFT','CHEQUE']) await entry({credit:500,cash_type,cheque_status:'CLEARED',status:'approved',loyalty_vault_holder_type:'user',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:1});
      assert.deepEqual(await balance(1),before);assert.equal(await count(),entries);
      await query("UPDATE cash_flow_entries SET cash_type='BANK' WHERE id=$1",[made]);assert.equal((await balance(1)).balance,'1050.00');
      await query('UPDATE cash_flow_entries SET loyalty_vault_holder_type=NULL,loyalty_vault_holder_id=NULL WHERE id=$1',[other]);assert.equal((await balance(1)).balance,'1075.00');assert.equal((await balance(2)).balance,'250.00');
    });
    await t.test('approval policy and native cash defaults reconcile atomic adjustments, split cash only and no mirrors',async()=>{
      const debit=await entry({credit:0,debit:20}),before=await balance(1);
      assert.equal((await query(`${vaultTransactionsCte} SELECT status FROM assigned_transactions WHERE cash_flow_entry_id=$1`,[debit])).rows[0].status,'pending_approval');
      await query("UPDATE cash_flow_entries SET status='approved' WHERE id=$1",[debit]);assert.equal(Number((await balance(1)).balance),Number(before.balance)-20);
      await query("UPDATE cash_flow_entries SET status='rejected' WHERE id=$1",[debit]);assert.deepEqual(await balance(1),before);
      await query("INSERT INTO expenses(id,site_id,created_by,status,payment_mode) VALUES(10,10,1,'approved','CASH')");
      await entry({source_module:'expenses',source_id:10,credit:0,debit:30,status:'approved'});assert.equal(Number((await balance(1)).balance),Number(before.balance)-30);
      await query("UPDATE expenses SET status='rejected' WHERE id=10");assert.deepEqual(await balance(1),before,'source updates without explicit assignments still reconcile');
      await query("INSERT INTO farmer_payments(id,site_id,created_by,status,payment_mode,cash_amount) VALUES(10,10,1,'approved','SPLIT',-12)");
      const split=await entry({source_module:'farmer_payments',source_id:10,credit:50,status:'approved',cash_type:'SPLIT'});assert.equal(Number((await balance(1)).balance),Number(before.balance)+12);
      await query("UPDATE farmer_payments SET payment_mode=' split ' WHERE id=10");
      const row=(await query(`${vaultTransactionsCte} SELECT credit::text,debit::text FROM assigned_transactions WHERE cash_flow_entry_id=$1`,[split])).rows[0];assert.equal(row.credit,'12');assert.equal(row.debit,'0');
      const entries=await count();await entry({credit:100,is_imprest_internal:true});await entry({credit:100,entry_transfer_id:randomUUID()});await entry({source_module:'plot_payments_person',source_id:10});assert.equal(await count(),entries);
      const old=(await query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n;await entry({credit:2});assert.equal((await query('SELECT count(*)::int AS n FROM wallet_entries')).rows[0].n,old);
    });
    await t.test('new transfer reservation, cancel/reject, insufficient acceptance and immutable history remain enforced',async()=>{
      const sent=await createVaultTransfer({id:1},request('10'),db);
      assert.equal((await balance(1)).reserved_balance,'10.00');await assert.rejects(resolveVaultTransfer({id:3},sent.transfer.id,'accept',{},db),e=>e.statusCode===404);
      await resolveVaultTransfer({id:1},sent.transfer.id,'cancel',{},db);assert.equal((await balance(1)).reserved_balance,'0.00');
      const reject=await createVaultTransfer({id:1},request('10'),db);await resolveVaultTransfer({id:2},reject.transfer.id,'reject',{},db);assert.equal((await balance(1)).reserved_balance,'0.00');
      const endangered=await createVaultTransfer({id:1},request('100'),db);
      await query('UPDATE cash_flow_entries SET credit=0 WHERE id=$1',[legacy]);await assert.rejects(resolveVaultTransfer({id:2},endangered.transfer.id,'accept',{},db),e=>e.statusCode===409);await resolveVaultTransfer({id:1},endangered.transfer.id,'cancel',{},db);
      await assert.rejects(query("UPDATE loyalty_vault_entries SET amount=1 WHERE id=1"),/immutable/);
    });
    await t.test('current cash list excludes bank while immutable audit preserves corrections and maker identity',async()=>{
      const originalQuery=pool.query,originalConnect=pool.connect;pool.query=query;pool.connect=db.connect;
      const invoke=(handler,extra={})=>new Promise((resolve,reject)=>handler({user:{id:1},query:{},body:{},params:{},...extra},{set(){return this;},json:resolve},reject));
      try {
        const history=await invoke(controller.history);assert.ok(history.entries.some(e=>e.details.payment_mode==='BANK'&&e.kind==='reversal'));
        assert.ok(history.entries.some(e=>e.details.payment_mode==='BANK'&&e.kind==='credit'));
        const transactions=await invoke(controller.assignedTransactions);assert.ok(transactions.transactions.every(e=>e.payment_mode==='CASH'));
        const assignment=await invoke(controller.assignment,{user:{id:2},query:{source_table:'cash_flow_entries',source_id:legacy}});
        assert.equal(assignment.assignment.created_by,1);assert.equal(assignment.assignment.loyalty_vault_holder_id,1);assert.equal(assignment.assignment.created_by_name,'Accountant');
      } finally {pool.query=originalQuery;pool.connect=originalConnect;}
    });
  } finally {await pg.close();}
});
