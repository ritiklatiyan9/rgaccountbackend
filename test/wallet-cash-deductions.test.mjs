import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { addWalletCashDeductions, addHolderWalletActivity, walletCashDeductions } from '../src/services/walletCashDeductions.service.js';
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
test('holder totals exclude staff approvals and float spending while gross giving never falls with spending or returns',async()=>{
 const db=new PGlite();try{
 await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,organization_id int);INSERT INTO sites VALUES(2,1),(5,1),(20,2);
  CREATE TABLE users(id int PRIMARY KEY,role text);INSERT INTO users VALUES(7,'admin'),(8,'sub_admin'),(9,'admin'),(10,'sub_admin'),(11,'sub_admin');
  CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
  CREATE TABLE loyalty_vault_entries(organization_id int,site_id int,holder_key text,kind text,amount numeric,created_at timestamptz);
  CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,created_by int,approved_by int,source_module text,source_id int);
  CREATE TABLE ledger_entries(id text,site_id int,bucket text,entry_date date,created_at timestamptz,source_key text,source_id int,debit numeric,credit numeric);
  CREATE TABLE imprest_ledger(site_id int,user_id int,created_at timestamptz,amount numeric,type text,source_module text,reference_id int);
  CREATE TABLE imprest_allocations(site_id int,admin_id int,amount numeric,status text,from_own_float boolean,created_at timestamptz,confirmed_at timestamptz);
  CREATE TABLE imprest_transfers(site_id int,from_user_id int,to_user_id int,amount numeric,created_at timestamptz);`);
 const entries=[
  [1,7,'plot_commission_payments','cash',20000,0],
  [2,8,'expenses','cash',337875,0],
  [3,8,'personal_ledger','cash',15000,0],
  [4,7,'plot_payments','cash',0,-15000],
  [5,7,'expenses','cash',100.25,0],
  [6,7,'farmer_payments','cash',50.05,0],
  [7,9,'expenses','cash',60,0],
  [8,7,'expenses','cash',0,0], // pending canonical outflow posts zero
  [9,7,'expenses','bank',9999,0],
  [10,7,'expenses','cash',9999,0],
  [11,7,'expenses','cash',9999,0],
  [12,7,'expenses','cash',9999,0],
  [13,7,'expenses','cash',9999,0],
  [14,7,'expenses','cash',10,0], // paid out of own historical float
  [15,7,'personal_ledger','cash',7.77,0],
  [16,7,'plot_installment_payments','cash',0,-3.33],
  [17,7,'land_deal_payments','cash',300,0],
  [18,7,'plot_installment_payments','cash',400,0],
  [19,7,'partner_profit_payments','cash',500,0],
 ];
 for(const [id,maker,source,bucket,debit,credit]of entries){
  const site=id===11?5:id===12?20:2,created=id===10?'2026-10-24T10:00:00Z':'2026-10-26T10:00:00Z';
  await db.query('INSERT INTO cash_flow_entries VALUES($1,$2,$3,7,$4,$5)',[id,site,maker,source==='personal_ledger'?null:source,source==='personal_ledger'?null:id+100]);
  await db.query('INSERT INTO ledger_entries VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[id===6?'6:cash':String(id),site,bucket,id===13?'2026-11-01':'2026-10-26',created,source,id+100,debit,credit]);
 }
 await db.exec(`INSERT INTO imprest_ledger VALUES
  (2,7,'2026-10-26T10:00:00Z',-10,'EXPENSE','expense',114),
  (2,7,'2026-10-26T10:00:00Z',-300,'EXPENSE','land_deal_payment',117),
  (2,7,'2026-10-26T10:00:00Z',-400,'EXPENSE','plot_installment_payment',118),
  (2,7,'2026-10-26T10:00:00Z',-500,'EXPENSE','partner_profit_payment',119),
  (2,7,'2026-10-26T10:00:00Z',-999,'EXPENSE','land_deal_payment',116),
  (2,8,'2026-10-24T10:00:00Z',500,'ALLOCATION',NULL,NULL),
  (2,8,'2026-10-26T10:00:00Z',-800,'EXPENSE','expense',102),
  (2,8,'2026-10-26T10:00:00Z',-15000,'EXPENSE','cash_flow_entry',3);
  INSERT INTO imprest_allocations VALUES
   (2,7,999,'RECEIVED',false,'2026-10-24T10:00:00Z','2026-10-24T11:00:00Z'),
   (2,7,100,'RECEIVED',false,'2026-10-24T10:00:00Z','2026-10-26T11:00:00Z'),
   (2,7,999,'PENDING_RECEIPT',false,'2026-10-26T10:00:00Z',NULL),
   (2,7,999,'CANCELLED',false,'2026-10-26T10:00:00Z',NULL),
   (2,7,999,'DECLINED',false,'2026-10-26T10:00:00Z',NULL),
   (5,7,999,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z'),
   (20,7,999,'RECEIVED',false,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z'),
   (2,8,40,'RECEIVED',true,'2026-10-26T10:00:00Z','2026-10-26T11:00:00Z');
  INSERT INTO imprest_transfers VALUES
   (2,7,8,20.01,'2026-10-26T11:30:00Z'),
   (2,7,8,999,'2026-10-24T11:30:00Z'),
   (5,7,8,999,'2026-10-26T11:30:00Z'),
   (20,7,8,999,'2026-10-26T11:30:00Z');
  INSERT INTO loyalty_vault_entries VALUES
   (1,2,'user:7','imprest_out',-20,'2026-10-26T12:00:00Z'),
   (1,2,'user:8','imprest_out',-30,'2026-10-26T12:00:00Z'),
   (1,5,'user:7','imprest_out',-999,'2026-10-26T12:00:00Z'),
   (2,20,'user:7','imprest_out',-999,'2026-10-26T12:00:00Z');`);
 const ownOpening={...opening,opening_cash:'50000.50'};
 await db.query('INSERT INTO application_settings VALUES(2,$1,$2)', ['wallet_reporting_opening:user:7',JSON.stringify(ownOpening)]);
 const states=new Map([['user:7',{balance:'14699.09'}]]),totals=new Map([['user:7',{total_received:'0',total_handover:'0'}]]);
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 const data=states.get('user:7').cash_deductions;
 assert.equal(data.version,2);assert.equal(data.scope,'holder');assert.equal(data.started_at,opening.started_at);
 assert.equal(data.commission,'20000.00');assert.equal(data.expenses,'100.25');assert.equal(data.other_cash_payments,'15061.15');
 assert.equal(data.payment_total,'35161.40');assert.equal(data.imprest_given,'140.01','confirmed allocations, legacy successful transfers and owned bridges each count once');
 assert.ok(!data.modules.some(row=>row.source==='land_deal_payments'||row.source==='partner_profit_payments'),'own float-funded land and partner payments are excluded');
 assert.equal(data.modules.find(row=>row.source==='plot_installment_payments').amount,'3.33','float-funded installment is excluded, while another module sharing its reference ID cannot hide a direct installment payment');
 assert.equal(data.imprest,'-530.00','old site net remains explanatory and does not replace gross giving');
 assert.equal(data.cash_adjustment,'0.00','direct holder payments and gross giving reconcile without charging staff expenses');
 assert.deepEqual(data.modules,[{source:'expenses',amount:'100.25'},{source:'farmer_payments',amount:'50.05'},
  {source:'personal_ledger',amount:'7.77'},{source:'plot_commission_payments',amount:'20000'},{source:'plot_installment_payments',amount:'3.33'},{source:'plot_payments',amount:'15000'}]);
 await db.exec("INSERT INTO imprest_ledger VALUES(2,8,'2026-10-27T10:00:00Z',-100,'EXPENSE','expense',999),(2,8,'2026-10-28T10:00:00Z',-100,'REFUND',NULL,NULL)");
 await addWalletCashDeductions(db,{organizationId:1,siteId:2,states,totals,endDate:'2026-10-31'});
 assert.equal(states.get('user:7').cash_deductions.imprest_given,'140.01','spending and returns never reduce the gross amount given');
 const holders=[{holder_type:'user',holder_id:7,balance:'14699.09',total_received:'0',total_handover:'0',cash_deductions:data},
  {holder_type:'user',holder_id:8,balance:'70.00',total_received:'100.00',total_handover:'0'},
  {holder_type:'user',holder_id:10,balance:'1.25',total_received:'1.25',total_handover:'0'},
  {holder_type:'user',holder_id:11,balance:null,total_received:null,total_handover:null}];
 assert.equal(await addHolderWalletActivity(db,{organizationId:1,siteId:2,holders,endDate:'2026-10-31'}),holders);
 assert.equal(holders[0].cash_deductions,data,'already valid aligned snapshots keep their cash basis');
 assert.equal(holders[1].cash_deductions.started_at,null);assert.equal(holders[1].cash_deductions.payment_total,'0.00','staff spending funded by float is not a second wallet deduction');
 assert.equal(holders[1].cash_deductions.imprest_given,'70.00','staff gross giving includes peer float distributions and its own accepted bridge once');
 assert.equal(holders[1].cash_deductions.cash_adjustment,'40.00','peer float giving is explicit reconciliation outside the cash payments column');
 assert.equal(holders[2].cash_deductions.payment_total,'0.00');assert.equal(holders[2].cash_deductions.cash_adjustment,'0.00');
 assert.equal(holders[3].cash_deductions,undefined,'private balances never gain totals');
 }finally{await db.close();}
});

test('the OM example uses own payments and gross giving with its one rupee reconciliation outside deductions',()=>{
 const result=walletCashDeductions({opening:{...opening,opening_cash:'8996582.00'},totals:{total_received:'0',total_handover:'1584302'},
  state:{balance:'4506621'},spending:{commission:'2239074',expenses:'0',other_cash_payments:'15000'},imprest:'-1000',imprestGiven:'651584',siteId:5,holderId:7});
 assert.equal(result.payment_total,'2254074.00');assert.equal(result.imprest_given,'651584.00');assert.equal(result.cash_adjustment,'-1.00');
 assert.throws(()=>walletCashDeductions({opening,totals:{total_received:'0',total_handover:'0'},state:{balance:'0'},spending,imprestGiven:'-0.01',siteId:2,holderId:7}),/cannot be negative/);
});
