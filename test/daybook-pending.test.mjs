import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { DAYBOOK_LEDGER_SQL, daybookAmountCounts } from '../src/services/daybookPending.service.js';
import { balanceSheetReportSql } from '../src/models/BalanceSheet.model.js';
import { loadDayBookModeBalanceData, loadSiteBalanceAsOf } from '../src/services/daybookRead.service.js';

const owners = ['plot_payments', 'plot_installment_payments', 'farmer_payments', 'expenses', 'plot_commission_payments',
  'vendor_payments', 'vendor_inventory_payments', 'firm_transactions', 'day_book', 'partner_profit_payments',
  'land_deal_payments', 'misc_income_entries', 'tds_settlements', 'pool_money_receipts'];

async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`
    CREATE TABLE cash_flow_entries(id int PRIMARY KEY,site_id int,date date,particular text,remarks text,debit numeric DEFAULT 0,credit numeric DEFAULT 0,
      source_module text,source_id int,status text,cheque_status text,cheque_no text,created_at timestamptz,created_by int,
      cash_flow_month_id int,assigned_admin_id int,bank_account_id int,cash_type text,voucher_url text,to_name text,transaction_time time,cheque_transaction_date date);
    CREATE TABLE cash_flow_months(id int,ledger_name text,ledger_type text);
    CREATE TABLE users(id int,name text,role text);
    CREATE TABLE bank_accounts(id int,name text);
    CREATE TABLE plots(id int,plot_no text,block text);
    CREATE TABLE plot_commissions_v2(id int,plot_id int);
    CREATE TABLE daybook_entry_order(site_id int,entry_date date,entry_key text,position int);
    CREATE TABLE daybook_global_order(site_id int,entry_key text,position int);
    CREATE TABLE imprest_ledger(site_id int,user_id int,amount numeric,created_at timestamptz);
    CREATE TABLE ledger_quarantine(site_id int,debit numeric,credit numeric);
    CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE SQL AS $$SELECT CASE WHEN UPPER(COALESCE($1,'CASH'))='CASH' THEN 'cash' ELSE 'bank' END$$;
    CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$
      SELECT LOWER(COALESCE($2,'approved')) NOT IN ('rejected','cancelled','deleted','void','voided')
        AND (CASE WHEN UPPER($3) IN ('CHEQUE','CHECK') OR NULLIF($4,'') IS NOT NULL
          THEN UPPER(COALESCE($4,''))='CLEARED' AND LOWER(COALESCE($2,''))='approved'
          ELSE $1='credit' OR LOWER(COALESCE($2,'approved'))='approved' END)$$;
    INSERT INTO users VALUES(12,'Creator','admin'),(77,'Recorded Reviewer','admin');
    INSERT INTO cash_flow_months VALUES(1,'Site','site');
  `);
  for (const table of owners) await db.exec(`CREATE TABLE ${table}(id int PRIMARY KEY,created_at timestamptz,status text,cheque_status text,cheque_no text,
    payment_mode text,payment_type text,cash_amount numeric,bank_amount numeric,entry_type text,plot_id int,plot_commission_id int,
    kind text,amount numeric,challan_no text,ca_name text,existing_entry_id int,approved_by int,approved_at timestamptz)`);
  const add = async (id, source, amount, { status='pending', mode='CASH', created='2026-11-15T10:00:00Z', mirror='2026-11-15T15:00:00Z', credit=0, cheque=null, chequeDate=null, site=8, cash=null, bank=null }={}) => {
    await db.query(`INSERT INTO ${source}(id,created_at,status,payment_mode,cheque_status,cash_amount,bank_amount) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,created,status,mode,cheque,cash,bank]);
    await db.query(`INSERT INTO cash_flow_entries(id,site_id,date,particular,debit,credit,source_module,source_id,status,cash_type,created_at,created_by,cash_flow_month_id,transaction_time,cheque_status,cheque_transaction_date)
      VALUES($1,$2,'2026-11-15','Fixture',$3,$4,$5,$1,$6,$7,$8,12,1,'20:00',$9,$10)`,[id,site,amount,credit,source,status,mode,mirror,cheque,chequeDate]);
  };
  return {db,add};
}

test('Daybook counts pending amounts without changing cheque or terminal approval rules', () => {
  for (const status of ['pending','pending_approval','approved',null]) for(const direction of ['credit','debit'])
    assert.equal(daybookAmountCounts({direction,status,paymentMode:'CASH'}),true);
  for (const status of ['rejected','cancelled','deleted','void','voided'])
    assert.equal(daybookAmountCounts({direction:'debit',status,paymentMode:'BANK'}),false);
  for (const status of ['pending','approved'])
    assert.equal(daybookAmountCounts({direction:'debit',status,paymentMode:'CHEQUE',chequeStatus:'PENDING'}),false);
  assert.equal(daybookAmountCounts({direction:'credit',status:'pending',paymentMode:'CHEQUE',chequeStatus:'CLEARED'}),false);
  assert.equal(daybookAmountCounts({direction:'debit',status:'approved',paymentMode:'CHEQUE',chequeStatus:'CLEARED'}),true);
});

test('embedded PostgreSQL: pending receipts and payments appear once, total immediately, keep status and source creation order after reverse approval', async t => {
  const {db,add}=await fixture(t);
  await add(1,'expenses',100,{created:'2026-11-15T09:00:00Z',mirror:'2026-11-15T16:00:00Z'});
  await add(2,'vendor_payments',200,{created:'2026-11-15T10:00:00Z',mirror:'2026-11-15T10:00:00Z'});
  await add(3,'plot_payments',0,{credit:500,created:'2026-11-15T11:00:00Z'});
  await add(4,'day_book',40,{status:'rejected'});
  await add(5,'farmer_payments',300,{mode:'SPLIT',cash:100,bank:200});
  await add(6,'expenses',50,{mode:'CHEQUE',cheque:'PENDING',created:'2026-11-15T12:00:00Z'});
  await add(7,'expenses',70,{site:9});
  const ledger=async()=> (await db.query(`SELECT * FROM (${DAYBOOK_LEDGER_SQL}) le ORDER BY created_at DESC,id DESC`,[8])).rows;
  let rows=await ledger();
  assert.equal(rows.length,6,'split yields two legs; rejected and another site are excluded');
  assert.equal(rows[0].source_id,6,'pending cheque stays visible');
  assert.equal(Number(rows[0].display_debit),50,'uncleared cheque displays its recorded amount');
  assert.equal(Number(rows[0].debit),0,'uncleared cheque does not change balance');
  assert.equal(rows.every(row=>row.status==='pending'),true);
  assert.equal(rows.reduce((sum,row)=>sum+Number(row.debit),0),600,'all pending non-cheque payments count once');
  assert.equal(rows.reduce((sum,row)=>sum+Number(row.credit),0),500);
  assert.equal(rows.findIndex(row=>row.source_id===2)<rows.findIndex(row=>row.source_id===1),true,'source creation beats mirror insertion time');
  const original=rows.map(row=>row.id);
  await db.exec(`UPDATE vendor_payments SET status='approved' WHERE id=2; UPDATE cash_flow_entries SET status='approved' WHERE id=2;
    UPDATE expenses SET status='approved' WHERE id=1; UPDATE cash_flow_entries SET status='approved' WHERE id=1;`);
  rows=await ledger();
  assert.deepEqual(rows.map(row=>row.id),original,'approval never moves a row');
  assert.equal(rows.find(row=>row.source_id===1).status,'approved');
  assert.equal(rows.reduce((sum,row)=>sum+Number(row.debit),0),600,'approval does not add pending money a second time');
});

test('embedded PostgreSQL: daily, period and mode summaries agree, pending cheque is dated visibly but does not post, and manual positions win within a date', async t=>{
  const {db,add}=await fixture(t);
  await add(1,'expenses',100,{created:'2026-11-15T09:00:00Z'});
  await add(2,'vendor_payments',200,{created:'2026-11-15T10:00:00Z'});
  await add(3,'plot_payments',0,{credit:500,created:'2026-11-15T11:00:00Z'});
  await add(4,'expenses',50,{mode:'CHEQUE',cheque:'PENDING',created:'2026-11-15T12:00:00Z'});
  const queries=balanceSheetReportSql(true);
  const params=[8,'2026-11-15','2026-11-15','all','all','all','all','',12000,'day',null,null,true,false];
  const report=async()=>({meta:(await db.query(queries.metadata,params)).rows[0].report,rows:(await db.query(queries.transactions,params)).rows});
  let result=await report();
  assert.deepEqual(result.rows.map(row=>row.source_id),[4,3,2,1]);
  assert.equal(result.rows[0].entry_date,'2026-11-15');
  assert.equal(Number(result.rows[0].debit),50,'pending cheque amount visible in transaction list');
  assert.equal(Number(result.meta.summary.total_debit),300,'pending cheque excluded from money movement');
  assert.equal(Number(result.meta.summary.total_credit),500);
  assert.equal(Number(result.meta.summary.closing_balance),200);
  assert.equal(result.meta.summary.total_entries,4);
  const modes=await loadDayBookModeBalanceData({siteId:8,date:'2026-11-15',includePending:true},db);
  assert.equal(modes.siteCurrent,200);
  assert.equal(modes.rows.filter(row=>row.bucket==='cash').reduce((sum,row)=>sum+Number(row.debit),0),300);
  assert.equal(await loadSiteBalanceAsOf(8,'2026-11-16',db,true),200);
  await db.exec(`INSERT INTO daybook_global_order VALUES(8,'expenses:1',1),(8,'vendor_payments:2',2),(8,'plot_payments:3',3),(8,'expenses:4',4);`);
  result=await report();
  assert.deepEqual(result.rows.map(row=>row.source_id),[1,2,3,4],'deliberate saved positions take priority within date');
  assert.equal(Number(result.meta.summary.closing_balance),200);
});

test('daily response merges pending source rows without duplicates and uses owner creation when a linked copy was made later', async t => {
  const [{default:pool},{listDayBookEntries},{dayBookModel},{expenseModel},{farmerPaymentModel},{plotCommissionModel},{cashFlowEntryModel},{firmTransactionModel},{plotPaymentModel}] = await Promise.all([
    import('../src/config/db.js'),import('../src/controllers/daybook.controller.js'),import('../src/models/DayBook.model.js'),
    import('../src/models/Expense.model.js'),import('../src/models/Farmer.model.js'),import('../src/models/PlotCommission.model.js'),
    import('../src/models/CashFlow.model.js'),import('../src/models/Firm.model.js'),import('../src/models/Plot.model.js'),
  ]);
  const base={site_id:8,date:'2026-11-15',created_by:12,status:'pending',credit:0,payment_mode:'CASH'};
  const nativeExpense={...base,id:1,debit:100,created_at:'2026-11-15T09:00:00Z'};
  const linkedFarmer={...base,id:150,farmer_payment_id:5,debit:50,payment_mode:'CHEQUE',cheque_status:'PENDING',created_at:'2026-11-15T15:00:00Z'};
  const mirrors=[
    {...base,id:11,source_module:'expenses',source_id:1,debit:100,source_created_at:'2026-11-15T09:00:00Z',source_status:'pending'},
    {...base,id:12,source_module:'vendor_payments',source_id:2,debit:200,source_created_at:'2026-11-15T10:00:00Z',source_status:'pending'},
    {...base,id:15,source_module:'farmer_payments',source_id:5,debit:50,cash_type:'CHEQUE',cheque_status:'PENDING',source_created_at:'2026-11-15T08:00:00Z',source_status:'pending',source_cheque_status:'PENDING'},
  ];
  t.mock.method(dayBookModel,'findBySiteAndDate',async()=>[linkedFarmer]);
  t.mock.method(expenseModel,'findBySiteAndDate',async()=>[nativeExpense]);
  for(const model of [farmerPaymentModel,plotCommissionModel,cashFlowEntryModel,firmTransactionModel,plotPaymentModel])
    t.mock.method(model,'findBySiteAndDate',async()=>[]);
  t.mock.method(pool,'query',async sql=> {
    if(sql.includes('SELECT DISTINCT ON (cfe.id)')) return {rows:mirrors};
    if(sql.includes('AS saved_order_rows')) return {rows:[{saved_order_rows:[],entry_times:{},order_revision:0,bank_map_rows:[]}]};
    if(sql.includes('AS ledger_net')) return {rows:[{ledger_net:0,imprest_outstanding:0}]};
    return {rows:[]};
  });
  const read=()=>new Promise((resolve,reject)=>listDayBookEntries({query:{site_id:'8',date:'2026-11-15',include_pending:'true'},user:{id:12,role:'admin'}},{json:resolve,status(code){reject(new Error(`Unexpected status ${code}`));return this;}},reject));
  let result=await read();
  assert.deepEqual(result.entries.map(row=>row.order_key),['vendor_payments:2','expenses:1','farmer_payments:5']);
  assert.equal(result.entries.length,3,'one native expense plus its mirror still shows once');
  assert.equal(result.entries[2].created_at,'2026-11-15T08:00:00Z','source creation overrides the late farmer display copy');
  assert.equal(result.entries.every(row=>row.status==='pending'),true);
  assert.equal(result.summary.total_debit,300,'pending payments count, uncleared cheque remains visible without posting');
  assert.equal(result.balance.closing_balance,-300);
  mirrors[1].source_status='approved';
  mirrors[1].source_approved_by=77;
  mirrors[1].source_approved_by_name='Recorded Reviewer';
  mirrors[1].source_approved_at='2026-11-15T12:00:00Z';
  mirrors[0].source_status='approved';
  nativeExpense.status='approved';
  result=await read();
  assert.deepEqual(result.entries.map(row=>row.order_key),['vendor_payments:2','expenses:1','farmer_payments:5']);
  assert.equal(result.summary.total_debit,300);
  assert.equal(result.entries[0].approved_by_name,'Recorded Reviewer');
});

test('period rows retain the source approval decision, actual reviewer and decision time', async t => {
  const {db,add}=await fixture(t);
  await add(1,'expenses',100,{mode:'BANK'});
  await add(2,'vendor_payments',200,{mode:'BANK',status:'approved'});
  await db.exec(`UPDATE expenses SET status='approved',approved_by=77,approved_at='2026-11-15T12:00:00Z' WHERE id=1;
    UPDATE cash_flow_entries SET status='pending' WHERE id=1;`);
  const query=balanceSheetReportSql(true).transactions;
  const params=[8,null,null,'bank','all','all','all','',12000,'day',null,null,true,true];
  let rows=(await db.query(query,params)).rows;
  const approved=rows.find(row=>row.source_id===1);
  assert.equal(approved.status,'approved','the owner decision wins over a stale pending mirror');
  assert.equal(approved.approved_by,77);
  assert.equal(approved.approved_by_name,'Recorded Reviewer');
  assert.equal(new Date(approved.approved_at).toISOString(),'2026-11-15T12:00:00.000Z');
  assert.equal(rows.find(row=>row.source_id===2).approved_by_name,null,'historical missing reviewers must not be invented');
  await db.exec(`UPDATE expenses SET status='pending',approved_by=NULL,approved_at=NULL WHERE id=1;`);
  rows=(await db.query(query,params)).rows;
  assert.equal(rows.find(row=>row.source_id===1).status,'pending');
  assert.equal(rows.find(row=>row.source_id===1).approved_by_name,null);
});
