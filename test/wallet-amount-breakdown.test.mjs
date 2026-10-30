import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { getWalletAmountBreakdown, walletAmountSummary, readWalletDeductionEntries } from '../src/services/walletAmountBreakdown.service.js';
import { walletCashDeductions } from '../src/services/walletCashDeductions.service.js';
import { LOYALTY_VAULT_SOURCE_TABLES } from '../src/services/loyaltyVaultContext.service.js';
import { walletHistoryParentsSql } from './helpers/walletHistoryParents.mjs';

const started = '2026-10-25T10:00:00.000Z';
const opening = { version:1, organization_id:1, site_id:2, holder_type:'user', holder_id:7,
  opening_cash:'5000.00', received_at_start:'10000.00', handovers_at_start:'1000.00',
  adjustments_at_start:'-2000.00', recorded_balance_at_start:'7000.00', started_at:started, operation_key:'test-opening-amounts' };
const admin = { id:7, role:'admin', organization_id:1, is_active:true };
const sub = { id:8, role:'sub_admin', organization_id:1, is_active:true };
const deductions = walletCashDeductions({ opening, totals:{ total_received:'11400.15', total_handover:'1200.00' },
  state:{balance:'5000.00'}, spending:{commission:'200.15',expenses:'100.00',other_cash_payments:'0.00'}, imprest:'250.00',siteId:2,holderId:7 });

test('opening, handovers and net corrections preserve every paise', () => {
  assert.deepEqual(walletAmountSummary({total_received:'11400.15',total_handover:'1200.00',balance:'5000.00',cash_deductions:deductions},opening),
    {received:'6400.15',handed_over:'200.00',current_cash:'5000.00',deductions:'1200.15',categories:deductions});
  assert.equal(walletAmountSummary({total_received:'-12.15',total_handover:'0',balance:'-12.15'},null).received,'-12.15');
});

test('amount pages reconcile all entries, paginate and enforce current wallet/site visibility', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE TABLE sites(id int PRIMARY KEY,name text,organization_id int);
      INSERT INTO sites VALUES(2,'Selected site',1),(3,'Other site',1),(20,'Other org',2);
      CREATE TABLE users(id int PRIMARY KEY,name text,role text,organization_id int,is_active boolean);
      INSERT INTO users VALUES(7,'Admin','admin',1,true),(8,'Staff','sub_admin',1,true),(9,'Other staff','sub_admin',1,true),(77,'Outsider','admin',2,true);
      CREATE TABLE user_sites(user_id int,site_id int); INSERT INTO user_sites VALUES(8,2),(9,3);
      CREATE TABLE members(id int PRIMARY KEY,full_name text,site_id int);
      CREATE TABLE loyalty_vault_transfers(id uuid PRIMARY KEY,from_holder_type text,from_holder_id int,to_holder_id int,
        status text,note text,created_at timestamptz,resolved_at timestamptz,resolved_by int,resolution_note text);
      INSERT INTO loyalty_vault_transfers VALUES('00000000-0000-0000-0000-000000000001','user',7,8,'accepted','Office cash',
        '2026-10-26T10:00:00Z','2026-10-26T11:00:00Z',8,'Received in full');
      INSERT INTO loyalty_vault_transfers VALUES('00000000-0000-0000-0000-000000000002','user',7,8,'pending','Not accepted',
        '2026-10-26T12:00:00Z',null,null,null);
      CREATE TABLE loyalty_vault_entries(id serial PRIMARY KEY,organization_id int,site_id int,holder_key text,holder_type text,
        holder_id int,actor_id int,amount numeric,balance_after numeric,kind text,description text,source_table text,
        source_id int,cash_flow_entry_id int,transfer_id uuid,details jsonb DEFAULT '{}',created_at timestamptz);
      INSERT INTO loyalty_vault_entries(organization_id,site_id,holder_key,holder_type,holder_id,actor_id,amount,balance_after,kind,description,created_at) VALUES
        (1,2,'user:7','user',7,7,10000,99999999,'credit','Old receipt','2026-10-24T10:00:00Z'),
        (1,2,'user:7','user',7,7,-1000,99999999,'transfer_out','Old handover','2026-10-24T11:00:00Z'),
        (1,2,'user:7','user',7,7,-2000,99999999,'adjustment','Old adjustment','2026-10-24T12:00:00Z'),
        (1,2,'user:7','user',7,7,1000.25,99999999,'credit','New collection','2026-10-26T10:00:00Z'),
        (1,2,'user:7','user',7,7,-100.10,99999999,'reversal','Corrected receipt','2026-10-26T11:00:00Z'),
        (1,2,'user:7','user',7,7,500,99999999,'transfer_in','Cash received','2026-10-26T12:00:00Z'),
        (1,2,'user:7','user',7,7,-200,99999999,'transfer_out','Cash handed over','2026-10-26T13:00:00Z'),
        (1,2,'user:7','user',7,7,-50,99999999,'adjustment','Cash correction','2026-10-26T14:00:00Z'),
        (1,3,'user:7','user',7,7,999999,99999999,'credit','Other site private','2026-10-26T10:00:00Z'),
        (2,20,'user:77','user',77,77,999999,99999999,'credit','Other org private','2026-10-26T10:00:00Z'),
        (1,2,'user:8','user',8,8,30,99999999,'credit','Staff receipt','2026-10-26T10:00:00Z');
      UPDATE loyalty_vault_entries SET transfer_id='00000000-0000-0000-0000-000000000001' WHERE kind='transfer_out' AND amount=-200;
      CREATE TABLE plots(id int PRIMARY KEY,site_id int,plot_no text,buyer_name text,block text);
      CREATE TABLE plot_installments(id int PRIMARY KEY,plot_id int);
      CREATE FUNCTION loyalty_vault_source_site(source_table text,source jsonb) RETURNS int LANGUAGE sql STABLE AS $$ SELECT NULLIF(source->>'site_id','')::int $$;
      CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
      CREATE TABLE ledger_entries(id int,site_id int,bucket text,entry_date date,created_at timestamptz,source_key text,source_id int,debit numeric,credit numeric,particular text,remarks text,entity_name text,created_by_name text);
      INSERT INTO ledger_entries VALUES
        (1,2,'cash','2026-10-26','2026-10-26T10:00:00Z','plot_commission_payments',1,200.15,0,'Commission instalment','Payment note','Agent A','Admin'),
        (2,2,'cash','2026-10-26','2026-10-26T11:00:00Z','expenses',2,100,0,'Office supplies','Receipt attached','Office','Admin'),
        (3,3,'cash','2026-10-26','2026-10-26T10:00:00Z','expenses',3,99000,0,'OTHER SITE PRIVATE',null,null,null),
        (4,20,'cash','2026-10-26','2026-10-26T10:00:00Z','expenses',4,99000,0,'OTHER ORG PRIVATE',null,null,null),
        (5,2,'bank','2026-10-26','2026-10-26T10:00:00Z','expenses',5,99000,0,'BANK NOT CASH',null,null,null),
        (6,2,'cash','2026-10-24','2026-10-24T10:00:00Z','expenses',6,99000,0,'BEFORE OPENING',null,null,null),
        (7,2,'cash','2099-10-26','2026-10-26T10:00:00Z','expenses',7,99000,0,'FUTURE PAYMENT',null,null,null);
      CREATE TABLE imprest_ledger(id serial PRIMARY KEY,site_id int,user_id int,created_at timestamptz,amount numeric,description text,source_module text,reference_id int,created_by int);
      INSERT INTO imprest_ledger(site_id,user_id,created_at,amount,description,source_module,created_by) VALUES
        (2,8,'2026-10-24T10:00:00Z',100,'Earlier imprest','manual',7),
        (2,8,'2026-10-26T10:00:00Z',400,'Cash advanced','manual',7),
        (2,8,'2026-10-26T11:00:00Z',-150,'Staff expense','expense',8),
        (3,8,'2026-10-26T10:00:00Z',99000,'OTHER SITE IMPREST','manual',7),
        (2,7,'2026-10-26T10:00:00Z',99000,'Admin is excluded','manual',7);`);
    for (const table of LOYALTY_VAULT_SOURCE_TABLES) await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,
      description text,particular text,narration text,remark text,remarks text,note text,reference_no text,
      plot_id int,installment_id int,date date,payment_date date,site_id int DEFAULT 2,status text,approved_at timestamptz,approved_by int,created_by int)`);
    await db.exec(walletHistoryParentsSql);
    await db.query('INSERT INTO application_settings VALUES(2,$1,$2)', ['wallet_reporting_opening:user:7', JSON.stringify(opening)]);
    const options = { cashStateReader:async()=>new Map([['user:7',{balance:'5000.00',cash_deductions:deductions}]]) };
    const read = (section, query = {}, actor = admin) => getWalletAmountBreakdown(db, {actor,siteId:2,userId:7,section,...query}, options);
    const receipts = await read('received',{limit:2});
    assert.equal(receipts.summary.received,'6400.15'); assert.equal(receipts.entries_total,'1400.15');
    assert.equal(receipts.total,3); assert.equal(receipts.entries.length,2); assert.equal(receipts.reconciliation_difference,'0.00');
    assert.ok(receipts.entries.every(row=>row.site_id===2&&!Object.hasOwn(row,'balance_after')));
    assert.equal((await read('received',{limit:2,page:2})).entries.length,1);
    const handed = await read('handed-over');
    assert.equal(handed.total,1); assert.equal(handed.entries_total,'200.00'); assert.equal(handed.summary.handed_over,'200.00');
    assert.equal(handed.entries[0].to_holder_name,'Staff'); assert.equal(handed.entries[0].transfer_status,'accepted');
    assert.equal(handed.entries[0].transfer_note,'Office cash');
    const deduction = await read('deductions');
    assert.equal(deduction.entries_total,'1200.15'); assert.equal(deduction.summary.deductions,'1200.15');
    assert.equal(deduction.reconciliation_difference,'0.00'); assert.equal(deduction.total,6);
    assert.equal(deduction.entries.find(row=>row.entry_type==='reconciliation').amount,'600.00');
    assert.equal(deduction.entries.find(row=>row.entry_type==='adjustment').amount,'50');
    assert.equal(deduction.entries.find(row=>row.category==='commission').description,'Commission instalment');
    assert.ok(!JSON.stringify(deduction).match(/PRIVATE|BEFORE OPENING|FUTURE PAYMENT|BANK NOT CASH|Admin is excluded/));
    const allPaged = await read('deductions',{limit:2,page:3});
    assert.equal(allPaged.entries_total,'1200.15'); assert.equal(allPaged.entries.length,2);
    await assert.rejects(read('received',{},sub), error=>error.statusCode===403);
    await assert.rejects(read('received',{siteId:20}), error=>error.statusCode===403);
    await assert.rejects(read('received',{userId:77}), error=>error.statusCode===403);
    await assert.rejects(read('received',{}, {...sub,wallet_can_read:false}), error=>error.statusCode===403);
    assert.equal((await read('received',{}, {...sub,wallet_view_all:true})).summary.received,'6400.15');
    const ordinary=await getWalletAmountBreakdown(db,{actor:sub,siteId:2,userId:8,section:'deductions'},options);
    assert.equal(ordinary.deductions_available,false); assert.equal(ordinary.summary.deductions,null); assert.deepEqual(ordinary.entries,[]);
    for (const query of [{section:'unknown'},{page:0},{limit:101},{siteId:0},{userId:'7;DROP TABLE users'}]) await assert.rejects(read('received',query), error=>error.statusCode===400);
    // A negative staff balance is not money held. Only the portion crossing
    // back above zero contributes, matching the canonical deduction aggregate.
    await db.exec(`INSERT INTO imprest_ledger(site_id,user_id,created_at,amount,description) VALUES
      (2,9,'2026-10-24T10:00:00Z',-200,'Before'),(2,9,'2026-10-26T10:00:00Z',50,'Still below zero'),
      (2,9,'2026-10-26T11:00:00Z',200,'Now holding 50');`);
    const floor = await readWalletDeductionEntries(db,{organizationId:1,siteId:2,userId:7,opening,deductions,
      endDate:'2026-10-31',page:1,limit:25,offset:0});
    const crossings = floor.entries.filter(row=>row.person_name==='Other staff');
    assert.equal(crossings.length,1); assert.equal(crossings[0].amount,'50'); assert.equal(crossings[0].original_amount,'200');
  } finally { await db.close(); }
});
