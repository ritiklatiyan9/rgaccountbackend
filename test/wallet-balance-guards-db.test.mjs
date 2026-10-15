import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up as siteUp } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up } from '../src/migrations/210_wallet_balance_guards.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { createVaultTransfer,resolveVaultTransfer } from '../src/services/loyaltyVault.service.js';
import { siteVaultAccountsCte } from '../src/services/loyaltyVaultSite.service.js';

test('Cash Wallet requests never reserve cash and every debit must remain funded', {skip:!process.env.PGLITE_MODULE},async t=>{
  const {PGlite}=await import(process.env.PGLITE_MODULE),pg=new PGlite();
  const query=async(sql,args)=>{
    const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);
    return {...result,rows:result?.rows||[],rowCount:result?.affectedRows??result?.rows?.length??0};
  };
  // PGlite owns one connection: queue whole transactions so concurrent API
  // promises do not accidentally share a transaction in the test adapter.
  let connection=Promise.resolve();
  const db={query,connect:async()=>{
    const previous=connection;let release;
    connection=new Promise(resolve=>{release=resolve;});await previous;
    return {query,release};
  }};
  let serial=100;
  const entry=async(data={})=>{
    const values={id:serial++,site_id:10,created_by:1,credit:100000,debit:0,cash_type:'CASH',status:'approved',particular:'Cash receipt',...data};
    const keys=Object.keys(values);
    await query(`INSERT INTO cash_flow_entries(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(values));
    return values.id;
  };
  const balance=async(key='user:1')=>(await query('SELECT balance::text,reserved_balance::text FROM loyalty_vault_accounts WHERE holder_key=$1',[key])).rows[0];
  const count=async()=>Number((await query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n);
  const request=(amount,to_holder_id=2,extra={})=>({amount:String(amount),to_holder_id,site_id:10,idempotency_key:randomUUID(),...extra});
  const status=code=>error=>error.statusCode===code;
  const noFunds=error=>error.constraint==='loyalty_vault_holder_funds'&&/restore funds/.test(error.message);
  try {
    await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
      CREATE TABLE users(id integer PRIMARY KEY,name text,role text,organization_id integer,is_active boolean DEFAULT true);
      INSERT INTO users VALUES(1,'Ravi','sub_admin',1,true),(2,'Kuldeep','admin',1,true),(3,'Manoj','super_admin',1,true),
        (4,'Other organization','admin',2,true),(7,'Historical deficit','sub_admin',1,true);
      CREATE TABLE sites(id integer PRIMARY KEY,name text,organization_id integer);INSERT INTO sites VALUES(10,'Main site',1),(11,'Other site',1),(20,'Outside',2);
      CREATE TABLE user_sites(user_id integer,site_id integer);INSERT INTO user_sites VALUES(1,10),(1,11),(7,10);
      CREATE TABLE user_permissions(user_id integer,module text,can_read boolean,can_view_all boolean);INSERT INTO user_permissions VALUES(1,'cashflow',true,false),(7,'cashflow',true,false);
      CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,phone text);INSERT INTO members VALUES(1,10,'Known client','9999999999');
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
    await walletUp(db);await vaultUp(db);await unifiedUp(db);await siteUp(db);
    const original=await entry();await entry({created_by:2});await entry({loyalty_vault_holder_type:'member',loyalty_vault_holder_id:1,loyalty_vault_assigned_by:2});
    await query("SELECT loyalty_vault_apply_delta('user:7',1,-50,'adjustment','Historical deficit',NULL,NULL,NULL,10)");
    await query("SELECT loyalty_vault_apply_delta('user:3',1,100,'credit','Historical site receipt',NULL,NULL,NULL,10)");
    await query("SELECT loyalty_vault_apply_delta('user:3',1,-90,'adjustment','Historical unallocated debit')");
    const legacy=request(25);
    await query(`INSERT INTO loyalty_vault_transfers(id,organization_id,site_id,from_holder_type,from_holder_id,to_holder_id,sender_id,recipient_id,amount,idempotency_key)
      VALUES($1,1,10,'user',1,2,1,2,25,$2)`,[randomUUID(),legacy.idempotency_key]);
    await query("UPDATE loyalty_vault_accounts SET reserved_balance=25 WHERE holder_key='user:1'");

    await t.test('migration clears obsolete holds without rewriting money, approvals or history',async()=>{
      const sources=JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows);
      const movements=JSON.stringify((await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows);
      const transfers=JSON.stringify((await query('SELECT * FROM loyalty_vault_transfers ORDER BY id')).rows);
      await up(db);await up(db);
      assert.equal(JSON.stringify((await query('SELECT * FROM cash_flow_entries ORDER BY id')).rows),sources);
      assert.equal(JSON.stringify((await query('SELECT * FROM loyalty_vault_entries ORDER BY id')).rows),movements);
      assert.equal(JSON.stringify((await query('SELECT * FROM loyalty_vault_transfers ORDER BY id')).rows),transfers);
      assert.deepEqual(await balance(),{balance:'100000.00',reserved_balance:'0.00'});
      assert.equal((await balance('user:7')).balance,'-50.00');
    });

    await t.test('staff, administrators and client handovers cannot request more than the balance',async()=>{
      await assert.rejects(createVaultTransfer({id:1},request(200000),db),status(409));
      await assert.rejects(createVaultTransfer({id:2},request(150000,1),db),status(409));
      await assert.rejects(createVaultTransfer({id:3},request(150000,2,{from_holder_type:'member',from_holder_id:1}),db),status(409));
      await assert.rejects(createVaultTransfer({id:3},request(11),db),status(409),'site money cannot hide a global deficit');
      await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:3',1,-11,'adjustment','Exceeds global cash',NULL,NULL,NULL,10)"),noFunds);
      const before=await count(),exact=await createVaultTransfer({id:1},request(100000),db);
      assert.deepEqual(await balance(),{balance:'100000.00',reserved_balance:'0.00'});assert.equal(await count(),before);
      await resolveVaultTransfer({id:1},exact.transfer.id,'cancel',{site_id:10},db);
      await entry({site_id:11,credit:200000});
      await assert.rejects(createVaultTransfer({id:1},request('100000.01'),db),status(409));
      await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:1',1,-100000.01,'adjustment','Exceeds selected site cash',NULL,NULL,NULL,10)"),noFunds);
    });

    await t.test('multiple unreserved requests are rechecked on acceptance and only funded cash moves',async()=>{
      const first=await createVaultTransfer({id:1},request(80000),db);
      const second=await createVaultTransfer({id:1},request(80000,3),db);
      const site=(await query(`WITH ${siteVaultAccountsCte('$1','$2')} SELECT balance::text,reserved_balance::text FROM site_accounts WHERE holder_key='user:1'`,[1,10])).rows[0];
      assert.equal(Number(site.balance),100000);assert.equal(Number(site.reserved_balance),0);
      const before=await count();
      const decisions=await Promise.allSettled([
        resolveVaultTransfer({id:2},first.transfer.id,'accept',{site_id:10},db),
        resolveVaultTransfer({id:3},second.transfer.id,'accept',{site_id:10},db),
      ]);
      assert.equal(decisions.filter(result=>result.status==='fulfilled').length,1);
      assert.equal(decisions.find(result=>result.status==='rejected').reason.statusCode,409);
      assert.equal((await balance()).balance,'220000.00','the other site remains unspent');
      assert.equal(await count(),before+2);
      assert.equal((await resolveVaultTransfer({id:2},first.transfer.id,'accept',{site_id:10},db)).replayed,true);
      await resolveVaultTransfer({id:1},second.transfer.id,'cancel',{site_id:10},db);
    });

    await t.test('concurrent retry keys and decisions move cash once and reject changed payloads',async()=>{
      const data=request(10000),results=await Promise.all([
        createVaultTransfer({id:1},data,db),createVaultTransfer({id:1},data,db),
      ]);
      assert.equal(results[0].transfer.id,results[1].transfer.id);assert.equal(results[1].replayed,true);
      await assert.rejects(createVaultTransfer({id:1},{...data,note:'Changed'},db),status(409));
      const before=await count();
      const decisions=await Promise.all([
        resolveVaultTransfer({id:2},results[0].transfer.id,'accept',{site_id:10},db),
        resolveVaultTransfer({id:2},results[0].transfer.id,'accept',{site_id:10},db),
      ]);
      assert.equal(decisions[1].replayed,true);assert.equal(await count(),before+2);
      assert.equal((await balance()).balance,'210000.00');
    });

    await t.test('unfunded receipt edits, removal and reassignment roll back their source and ledger together',async()=>{
      const before=await count(),snapshot=await balance();
      await assert.rejects(query('UPDATE cash_flow_entries SET credit=5000 WHERE id=$1',[original]),noFunds);
      await assert.rejects(query('DELETE FROM cash_flow_entries WHERE id=$1',[original]),noFunds);
      await assert.rejects(query('UPDATE cash_flow_entries SET loyalty_vault_holder_type=\'user\',loyalty_vault_holder_id=2,loyalty_vault_assigned_by=2 WHERE id=$1',[original]),noFunds);
      assert.equal((await query('SELECT credit::text FROM cash_flow_entries WHERE id=$1',[original])).rows[0].credit,'100000');
      assert.deepEqual(await balance(),snapshot);assert.equal(await count(),before);
      const returned=await createVaultTransfer({id:2},request(90000,1),db);
      await resolveVaultTransfer({id:1},returned.transfer.id,'accept',{site_id:10},db);
      await query('UPDATE cash_flow_entries SET credit=5000 WHERE id=$1',[original]);
      assert.equal((await balance()).balance,'205000.00');
    });

    await t.test('direct ledger debits use the same guards and historical deficits can recover',async()=>{
      await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:1',1,-5001,'adjustment','Unfunded correction',NULL,NULL,NULL,10)"),noFunds);
      await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:7',1,-1,'adjustment','Deepen old deficit',NULL,NULL,NULL,10)"),noFunds);
      await query("SELECT loyalty_vault_apply_delta('user:7',1,20,'credit','Recovery',NULL,NULL,NULL,10)");
      assert.equal((await balance('user:7')).balance,'-30.00');
      await query("SELECT loyalty_vault_apply_delta('user:7',1,30,'credit','Recovery complete',NULL,NULL,NULL,10)");
      assert.equal((await balance('user:7')).balance,'0.00');
      for(const value of ['NaN','Infinity','-Infinity'])await assert.rejects(query("SELECT loyalty_vault_apply_delta('user:1',1,$1::numeric,'credit','Invalid',NULL,NULL,NULL,10)",[value]),/finite/);
    });
    await t.test('rejecting a receipt after its full handover cannot create a negative collector balance',async()=>{
      await query("INSERT INTO users VALUES(8,'Receipt rejection regression','sub_admin',1,true); INSERT INTO user_sites VALUES(8,10)");
      const receipt=await entry({created_by:8,credit:100000});
      const handed=await createVaultTransfer({id:8},request(100000),db);
      await resolveVaultTransfer({id:2},handed.transfer.id,'accept',{site_id:10},db);
      assert.equal((await balance('user:8')).balance,'0.00');
      const before=await count(),recipientBefore=await balance('user:2');
      await assert.rejects(query("UPDATE cash_flow_entries SET status='rejected' WHERE id=$1",[receipt]),noFunds);
      assert.equal((await balance('user:8')).balance,'0.00');
      assert.deepEqual(await balance('user:2'),recipientBefore);
      assert.equal(await count(),before);
      assert.equal((await query('SELECT status FROM cash_flow_entries WHERE id=$1',[receipt])).rows[0].status,'approved');
      assert.equal((await query('SELECT posted_amount::text FROM loyalty_vault_sources WHERE cash_flow_entry_id=$1',[receipt])).rows[0].posted_amount,'100000.00');
    });
  } finally {await pg.close();}
});
