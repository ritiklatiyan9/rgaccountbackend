import {up as projectionUp} from '../src/migrations/234_wallet_site_projection.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {adminWalletCashStates,adminWalletCashStatesForSites,adminWalletCashRowsSql} from '../src/services/adminWalletCash.service.js';
import {walletMinor,walletDecimal,sumWalletMoney} from '../src/services/walletMoney.service.js';

test('exact wallet arithmetic preserves paise beyond Number precision and rejects sub-paise data',()=>{
 assert.equal(sumWalletMoney(['90071992547409.93','-90071992547409.92']),'0.01');
 assert.equal(walletDecimal(walletMinor('-0.01000')),'-0.01');
 assert.equal(walletDecimal(walletMinor('123.0000')),'123.00');
 for(const value of ['NaN','Infinity','1e3','1.001','',null])assert.throws(()=>walletMinor(value));
});

test('batched Admin cash reads preserve site custody, exact money, supplied writer snapshots and fresh retries',async()=>{
 const pg=new PGlite();let count=0,fail=false,financialReads=0;
 const query=async(sql,args)=>{
  count++;if(sql===adminWalletCashRowsSql)financialReads++;
  if(fail){fail=false;throw Error('Interrupted snapshot');}
  const result=args?.length?await pg.query(sql,args):(await pg.exec(sql)).at(-1);return {...result,rows:result?.rows||[]};
 };
 const db={query,release(){}};
 try {
  await query(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(1,1),(2,1),(3,2);
   CREATE TABLE users(id int PRIMARY KEY,organization_id int,role text);INSERT INTO users VALUES(1,1,'admin'),(2,1,'sub_admin'),(3,2,'admin');
   CREATE TABLE loyalty_vault_entries(id SERIAL PRIMARY KEY,organization_id int,site_id int,holder_key text,holder_type text,holder_id int,amount numeric,kind text,source_table text,created_at timestamptz DEFAULT now());
   CREATE TABLE ledger_entries(site_id int,entry_date date,bucket text,credit numeric,debit numeric);
   CREATE TABLE imprest_ledger(site_id int,user_id int,amount numeric,created_at timestamptz);
   CREATE TABLE imprest_allocations(site_id int,amount numeric,status text,from_own_float boolean,created_at timestamptz);
   CREATE TABLE imprest_site_debit_reservations(site_id int,amount numeric);
   INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,amount,kind,source_table) VALUES
    (1,1,'user:1','user',1,1000.01,'adjustment','manual_wallet_site_cash_alignment'),
    (1,1,'user:1','user',1,-100.01,'transfer_out',NULL),
    (1,1,'user:2','user',2,100.01,'transfer_in',NULL),
    (1,1,'member:2','member',2,20.02,'credit',NULL),
    (1,2,'user:1','user',1,90071992547409.93,'adjustment','manual_wallet_site_cash_alignment'),
    (1,2,'user:2','user',2,0.01,'credit',NULL),
    (2,3,'user:3','user',3,999999,'adjustment','manual_wallet_site_cash_alignment');
   INSERT INTO ledger_entries VALUES(1,'2000-01-01','cash',1000.01,0),(1,'2000-01-01','bank',999999,0),(1,'2999-01-01','cash',999999,0),(2,'2000-01-01','cash',90071992547409.93,0);
   INSERT INTO imprest_ledger VALUES(1,2,100.03,'2000-01-01'),(1,1,999999,'2000-01-01'),(2,2,-50.01,'2000-01-01');
   INSERT INTO imprest_allocations VALUES(1,50.04,'PENDING_RECEIPT',false,'2000-01-01'),(1,99999,'PENDING_RECEIPT',true,'2000-01-01'),(1,99999,'RECEIVED',false,'2000-01-01'),(1,99999,'PENDING_RECEIPT',false,'2999-01-01');
   INSERT INTO imprest_site_debit_reservations VALUES(1,10.05);`);
  await projectionUp({query,connect:async()=>db});
  count=0;financialReads=0;
  const states=await adminWalletCashStatesForSites(1,[2,1,1,3],db);
  assert.equal(count,1,'every requested site is grouped in one database statement');
  assert.equal(states.get(3).size,0,'a caller organization cannot read another organization site');
  const first=states.get(1).get('user:1');
  assert.equal(first.balance,'719.86');assert.equal(first.recorded_balance,'900.00');assert.equal(first.cash_in_hand_adjustment,'-180.14');
  assert.equal(first.site_cash_balance,'1000.01');assert.equal(first.imprest_held,'100.03');assert.equal(first.pending_imprest_reservations,'60.09');
  assert.equal(first.wallet_cash_held_elsewhere,'120.03');assert.equal(first.wallet_transfer_net,'-100.01');
  assert.equal(states.get(2).get('user:1').balance,'90071992547409.92');
  assert.equal(states.get(2).get('user:1').cash_in_hand_adjustment,'-0.01','minor-unit drift never becomes a false zero');
  const single=await adminWalletCashStates(1,1,db);assert.deepEqual(single,states.get(1));
  count=0;
  const [one,two]=await Promise.all([adminWalletCashStatesForSites(1,[1,2],db),adminWalletCashStatesForSites(1,[2,1],db)]);
  assert.equal(count,1,'only matching in-flight organization and site scopes are coalesced');assert.equal(one,two);
  await query("UPDATE ledger_entries SET credit=1001.01 WHERE site_id=1 AND bucket='cash' AND entry_date='2000-01-01'");
  assert.equal((await adminWalletCashStates(1,1,db)).get('user:1').balance,'720.86','settled reads are never retained as a stale financial cache');
  const detail={cashBalance:1000,imprestHeld:100,pendingImprestReservations:60,distributableBalance:840};
  Object.defineProperty(detail,'exact',{value:{cashBalance:'1000.01',imprestHeld:'100.03',pendingImprestReservations:'60.09',distributableBalance:'839.89'}});
  financialReads=0;
  const supplied=await adminWalletCashStates(1,1,db,detail);
  assert.equal(supplied.get('user:1').balance,'719.86');assert.equal(financialReads,0,'writers reuse their already locked exact financial snapshot');
  fail=true;await assert.rejects(adminWalletCashStates(1,1,db),/Interrupted snapshot/);
  assert.equal((await adminWalletCashStates(1,1,db)).get('user:1').balance,'720.86','a failed read never poisons subsequent requests');
 }finally{await pg.close();}
});
