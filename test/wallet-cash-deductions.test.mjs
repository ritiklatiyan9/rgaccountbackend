import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { addWalletCashDeductions, walletCashDeductions } from '../src/services/walletCashDeductions.service.js';
const opening={version:1,organization_id:1,site_id:2,holder_type:'user',holder_id:7,started_at:'2026-10-25T11:12:42.570Z',operation_key:'test-opening-2026',opening_cash:'4945079.26',received_at_start:'0',handovers_at_start:'0',adjustments_at_start:'0',recorded_balance_at_start:'4945079.26'};
const spending={commission:'20000',expenses:'0',other_cash_payments:'0'};
test('the reported ₹20,000 gap is exactly commission, with decimal balances preserved',()=>{
 const result=walletCashDeductions({opening,totals:{total_received:'20000',total_handover:'0'},state:{balance:'4945079.26'},spending,imprest:'0',siteId:2,holderId:7});
 assert.equal(result.received,'4965079.26');assert.equal(result.total,'20000.00');assert.equal(result.commission,'20000.00');assert.equal(result.other_adjustments,'0.00');
});
test('staff spending and released imprest offset instead of being deducted twice',()=>{
 const result=walletCashDeductions({opening:{...opening,opening_cash:'1000'},totals:{total_received:'0',total_handover:'0'},state:{balance:'1000'},spending:{commission:'0',expenses:'300',other_cash_payments:'0'},imprest:'-300',siteId:2,holderId:7});
 assert.equal(result.expenses,'300.00');assert.equal(result.imprest,'-300.00');assert.equal(result.total,'0.00');assert.equal(result.other_adjustments,'0.00');
});
test('custody differences remain explicit and never get relabelled as expenses',()=>{
 const result=walletCashDeductions({opening:{...opening,opening_cash:'1000.01'},totals:{total_received:'0.20',total_handover:'0.10'},state:{balance:'700.01'},spending:{commission:'0',expenses:'0',other_cash_payments:'100'},imprest:'200',siteId:2,holderId:7});
 assert.equal(result.total,'300.10');assert.equal(result.other_adjustments,'0.10');
});
test('batched SQL classifies only posted cash in this organisation, site and opening period',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(2,1),(5,1),(20,2);
  CREATE TABLE users(id int PRIMARY KEY,role text);INSERT INTO users VALUES(7,'admin'),(8,'sub_admin'),(9,'admin');
  CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
  CREATE TABLE ledger_entries(site_id int,bucket text,entry_date date,created_at timestamptz,source_key text,debit numeric,credit numeric);
  INSERT INTO ledger_entries VALUES
   (2,'cash','2026-10-26','2026-10-26T10:00:00Z','plot_commission_payments',20000,0),
   (2,'cash','2026-10-24','2026-10-24T10:00:00Z','expenses',99999,0),
   (2,'bank','2026-10-26','2026-10-26T10:00:00Z','expenses',8888,0),
   (2,'cash','2026-11-01','2026-10-26T10:00:00Z','expenses',7000,0),
   (5,'cash','2026-10-26','2026-10-26T10:00:00Z','expenses',6000,0),
   (20,'cash','2026-10-26','2026-10-26T10:00:00Z','expenses',5000,0),
   (2,'cash','2026-10-26','2026-10-26T10:00:00Z','expenses',0,0);
  CREATE TABLE imprest_ledger(site_id int,user_id int,created_at timestamptz,amount numeric,type text);
  INSERT INTO imprest_ledger VALUES(2,8,'2026-10-24T10:00:00Z',100,'ALLOCATION'),(20,8,'2026-10-26T10:00:00Z',99999,'ALLOCATION'),(2,9,'2026-10-26T10:00:00Z',99999,'ALLOCATION');
  CREATE TABLE imprest_allocations(site_id int,admin_id int,amount numeric,status text,from_own_float boolean,created_at timestamptz,confirmed_at timestamptz);
  INSERT INTO imprest_allocations VALUES
   (2,7,100,'RECEIVED',false,'2026-10-24T09:00:00Z','2026-10-24T10:00:00Z'),
   (2,9,5.20,'RECEIVED',false,'2026-10-24T09:00:00Z',NULL),
   (2,7,10.05,'RECEIVED',false,'2026-10-24T09:00:00Z','2026-10-25T11:12:42.570Z'),
   (2,7,8888,'RECEIVED',false,'2026-10-24T09:00:00Z','2026-10-25T11:12:42.569Z'),
   (2,9,5.20,'RECEIVED',false,'2026-10-27T10:00:00Z',NULL),
   (2,9,7777,'RECEIVED',false,'2026-10-27T09:59:59.999Z',NULL),
   (2,7,1000,'PENDING_RECEIPT',false,'2026-10-26T10:00:00Z',NULL),
   (2,7,2000,'CANCELLED',false,'2026-10-26T10:00:00Z',NULL),
   (2,7,3000,'DECLINED',false,'2026-10-26T10:00:00Z',NULL),
   (2,7,4000,'RECEIVED',true,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z'),
   (5,7,5000,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z'),
   (20,7,6000,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z'),
   (2,7,7000,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-31T00:00:00Z');`);
 await db.query('INSERT INTO application_settings VALUES(2,$1,$2)', ['wallet_reporting_opening:user:7',JSON.stringify(opening)]);
 const later={...opening,holder_id:9,started_at:'2026-10-27T10:00:00Z',opening_cash:'10'};
 await db.query('INSERT INTO application_settings VALUES(2,$1,$2)', ['wallet_reporting_opening:user:9',JSON.stringify(later)]);
 const states=new Map([['user:7',{balance:'4945079.26'}],['user:9',{balance:'10'}]]);
 const totals=new Map([['user:7',{total_received:'20000',total_handover:'0'}],['user:9',{total_received:'0',total_handover:'0'}]]);
 let queries=0;const database={query:(...args)=>{queries++;return db.query(...args);}};
 await addWalletCashDeductions(database,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 assert.equal(queries,3,'one opening query and two aggregate queries for every wallet');
 const first=states.get('user:7').cash_deductions;
 assert.equal(first.imprest_given,'10.05','the opening timestamp is inclusive and older confirmed allocations are excluded');assert.equal(first.commission,'20000.00');assert.equal(first.expenses,'0.00');assert.equal(first.imprest,'0.00');assert.equal(first.other_adjustments,'0.00');
 assert.equal(states.get('user:9').cash_deductions.commission,'0.00','a later opening excludes earlier payments');
 assert.equal(states.get('user:9').cash_deductions.imprest_given,'5.20','each giver uses their own opening; legacy rows fall back to creation time');
 await db.exec(`INSERT INTO ledger_entries VALUES(2,'cash','2026-10-27','2026-10-27T10:00:00Z','expenses',25.10,0),(2,'cash','2026-10-27','2026-10-27T10:00:00Z','plot_payments',0,-10.25);
   INSERT INTO imprest_ledger VALUES(2,8,'2026-10-27T10:00:00Z',30.15,'ALLOCATION');
   INSERT INTO imprest_allocations VALUES(2,7,30.15,'RECEIVED',false,'2026-10-27T09:00:00Z','2026-10-27T10:00:00Z');`);
 states.get('user:7').balance='4945013.76';
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 const changed=states.get('user:7').cash_deductions;
 assert.equal(changed.imprest_given,'40.20');assert.equal(changed.expenses,'25.10');assert.equal(changed.imprest,'30.15');assert.equal(changed.other_cash_payments,'10.25');assert.equal(changed.other_adjustments,'0.00');
 assert.deepEqual(changed.modules,[{source:'expenses',amount:'25.10'},{source:'plot_commission_payments',amount:'20000'},{source:'plot_payments',amount:'10.25'}]);
 assert.deepEqual(states.get('user:9').cash_deductions.modules,[{source:'expenses',amount:'25.10'},{source:'plot_payments',amount:'10.25'}]);
 await db.exec(`INSERT INTO imprest_ledger VALUES (2,8,'2026-10-28T10:00:00Z',-50,'EXPENSE'),(2,8,'2026-10-28T11:00:00Z',50,'TRANSFER_IN'),(2,8,'2026-10-28T12:00:00Z',-10,'RETURN');`);
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 assert.equal(states.get('user:7').cash_deductions.imprest_given,'40.20','expenses, returns and staff transfers do not change the total given');
 assert.equal(states.get('user:9').cash_deductions.imprest_given,'5.20','another giver is unaffected by these allocations');
 await db.exec(`INSERT INTO imprest_allocations VALUES
  (2,7,0.10,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-30T18:29:59Z'),
  (2,7,9999,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-30T18:30:00Z');`);
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 assert.equal(states.get('user:7').cash_deductions.imprest_given,'40.30','confirmation cutoff uses midnight India time and preserves exact paise');
 const missing=new Map([['user:10',{balance:'50'}]]);
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states:missing,totals:new Map(),endDate:'2026-10-31'});
 assert.equal(missing.get('user:10').cash_deductions,undefined,'no opening never invents zero deductions');
 }finally{await db.close();}
});
