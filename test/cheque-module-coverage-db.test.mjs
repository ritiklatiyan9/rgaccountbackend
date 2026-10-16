import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { PGlite } from '@electric-sql/pglite';
import { attachModuleChequeDates } from '../src/services/chequeDates.service.js';
import { updateChequeStatusRecord } from '../src/services/chequeStatus.service.js';
import { loadReportRows } from '../src/services/reportRead.service.js';

const fixture = async () => {
  const embedded = new PGlite();
  await embedded.exec(`CREATE TABLE cash_flow_entries(id int PRIMARY KEY, site_id int, date date,
    source_module text, source_id int, status text DEFAULT 'approved', cheque_status text, cheque_no text,
    cheque_transaction_date date, debit numeric DEFAULT 100, credit numeric DEFAULT 0,
    cash_flow_month_id int, updated_at timestamptz);
    CREATE TABLE plot_registry_payments(id int PRIMARY KEY, site_id int, source_plot_payment_id int);
    CREATE TABLE vendor_inventory_payments(id int PRIMARY KEY, site_id int, source_vendor_payment_id int);
    CREATE TABLE day_book(id int PRIMARY KEY, site_id int, date date, commission_id int, farmer_payment_id int,
      cash_flow_entry_id int, firm_transaction_id int, plot_payment_id int, vendor_payment_id int,
      cheque_status text, cheque_no text, status text DEFAULT 'approved', debit numeric DEFAULT 100,
      updated_at timestamptz);
    CREATE TABLE plot_commissions(id int PRIMARY KEY, site_id int, date date, amount numeric, by_note text,
      cheque_status text, cheque_no text, status text, updated_at timestamptz);
    CREATE TABLE cash_flow_months(id int PRIMARY KEY, is_locked boolean);
    INSERT INTO cash_flow_months VALUES(1,true);
    INSERT INTO plot_registry_payments VALUES(88,8,1);
    INSERT INTO vendor_inventory_payments VALUES(77,8,6);
    INSERT INTO day_book(id,site_id,date,farmer_payment_id,cheque_status) VALUES(66,8,'2026-10-07',2,'PENDING');
    INSERT INTO day_book(id,site_id,date,commission_id,cheque_status) VALUES(69,8,'2026-10-01',99,'CLEARED');
    INSERT INTO plot_commissions VALUES(99,8,'2026-10-01',100,'CHEQUE','CLEARED','099','approved',now());
    INSERT INTO cash_flow_entries(id,site_id,date,source_module,source_id,cheque_status,cheque_no,cheque_transaction_date) VALUES
      (11,8,'2026-10-01','plot_payments',1,'CLEARED','001','2026-10-10'),
      (12,8,'2026-10-02','farmer_payments',2,'CLEARED','002','2026-10-11'),
      (13,8,'2026-10-03','firm_transactions',3,'CLEARED','003','2026-10-12'),
      (14,8,'2026-10-04','plot_commission_payments',4,'CLEARED','004','2026-10-13'),
      (15,8,'2026-10-05','expenses',5,'CLEARED','005','2026-10-14'),
      (16,8,'2026-10-06','vendor_payments',6,'CLEARED','006','2026-10-15'),
      (17,8,'2026-10-07','vendor_inventory_payments',7,'PENDING','007',NULL),
      (18,8,'2026-10-08','plot_registry_payments',8,'CLEARED','008','2026-10-16'),
      (19,8,'2026-10-09','land_deal_payments',9,'BOUNCED','009',NULL),
      (20,8,'2026-10-10','misc_income_entries',10,'RETURNED','010',NULL),
      (21,8,'2026-10-11','plot_installment_payments',11,'CLEARED','011','2026-10-12'),
      (22,8,'2026-10-12','plot_commissions',12,'CLEARED','012','2026-10-13'),
      (23,8,'2026-10-13','day_book',13,'PENDING','013',NULL),
      (24,8,'2026-10-14',NULL,NULL,'CLEARED','014','2026-10-15'),
      (80,8,'2026-10-07','plot_registry_payments',88,'PENDING','stale','2026-10-09'),
      (81,8,'2026-10-07','vendor_inventory_payments',77,'PENDING','stale','2026-10-09'),
      (82,8,'2026-10-07','day_book',66,'PENDING','stale','2026-10-09'),
      (83,8,'2026-10-01','day_book',69,'CLEARED','099','2026-10-02'),
      (90,9,'2025-01-01','plot_payments',1,'CLEARED','foreign','2025-01-02');`);
  const calls = [];
  const db = { async query(sql, params) { calls.push({ sql, params }); return embedded.query(sql, params); } };
  return { embedded, db, calls };
};

test('all native cheque modules share one site-scoped date batch and preserve native owner identity', async () => {
  const { embedded, db, calls } = await fixture();
  try {
    const rows = (await embedded.query("SELECT *, date::text AS date FROM cash_flow_entries WHERE site_id=8 AND source_module IS NOT NULL AND id<24 ORDER BY id")).rows.map(row => ({
      id: row.source_id, site_id: row.site_id, source: row.source_module, date: row.date,
      payment_mode: 'CHEQUE', cheque_status: row.cheque_status, amount: 100, status: 'approved',
      ...(row.source_module === 'firm_transactions' ? { cash_flow_entry_id: 24 } : {}),
    }));
    await attachModuleChequeDates(rows, db);
    assert.equal(calls.length, 1, 'native rows never issue per-row metadata reads');
    for (const row of rows) {
      assert.equal(row.cheque_source_module, row.source);
      assert.equal(row.cheque_source_id, row.id);
      assert.equal(row.cheque_apply_date, row.date);
      assert.equal(row.amount, 100);
      assert.equal(row.status, 'approved');
    }
    assert.equal(rows[0].cheque_transaction_date, '2026-10-10', 'foreign site source ID cannot override clearing date');
    assert.equal(rows.find(row => row.source === 'firm_transactions').cheque_source_module, 'firm_transactions', 'a linked CFE ID does not steal native Firm ownership');
    assert.equal(rows.find(row => row.source === 'vendor_inventory_payments').cheque_transaction_date, null);
    assert.equal(rows.find(row => row.source === 'misc_income_entries').cheque_transaction_date, null);
  } finally { await embedded.close(); }
});

test('registry, inventory and Day Book allocations read the original cheque status/dates without rewriting their own date or amount', async () => {
  const { embedded, db, calls } = await fixture();
  try {
    const rows = [
      { id: 88, site_id: 8, source: 'plot_registry_payments', source_plot_payment_id: 1 },
      { id: 77, site_id: 8, source: 'vendor_inventory_payments', source_vendor_payment_id: 6 },
      { id: 66, site_id: 8, source: 'day_book', farmer_payment_id: 2 },
    ].map(row => ({ ...row, date: '2026-10-07', amount: 25, status: 'pending', payment_mode: 'CHEQUE', cheque_status: 'PENDING' }));
    await attachModuleChequeDates(rows, db);
    assert.equal(calls.length, 1);
    assert.deepEqual(rows.map(row => [row.cheque_source_module,row.cheque_source_id,row.cheque_status,row.cheque_apply_date,row.cheque_transaction_date]), [
      ['plot_payments',1,'CLEARED','2026-10-01','2026-10-10'],
      ['vendor_payments',6,'CLEARED','2026-10-06','2026-10-15'],
      ['farmer_payments',2,'CLEARED','2026-10-02','2026-10-11'],
    ]);
    for (const row of rows) { assert.equal(row.date, '2026-10-07'); assert.equal(row.amount,25); assert.equal(row.status,'pending'); }
  } finally { await embedded.close(); }
});

test('Personal Ledger and Balance Sheet mirrors resolve native owners including sparse Expense projections', async () => {
  const { embedded, db, calls } = await fixture();
  try {
    const rows = [
      { id: 'pl_16', original_id:16, site_id:8, source:'personal_ledger', date:'2026-10-06', payment_mode:'CHEQUE', cheque_status:'CLEARED' },
      { id:'80:bank', cheque_ledger_id:80, source_module:'plot_registry_payments', cheque_ledger_source_id:88, site_id:8, date:'2026-10-07', payment_mode:'CHEQUE', cheque_status:'PENDING' },
      { id:81, source_module:'vendor_inventory_payments', source_id:77, site_id:8, date:'2026-10-07', cash_type:'cheque', cheque_status:'PENDING' },
    ];
    await attachModuleChequeDates(rows, db, 'cash_flow_entries');
    assert.equal(calls.length,3,'one metadata read, one projection-reference batch and one owner-date batch for any row count');
    assert.deepEqual(rows.map(row=>[row.cheque_source_module,row.cheque_source_id,row.cheque_transaction_date]), [
      ['vendor_payments',6,'2026-10-15'],['plot_payments',1,'2026-10-10'],['vendor_payments',6,'2026-10-15'],
    ]);
    assert.ok(calls.every(call=>/site_id/.test(call.sql)));
  } finally { await embedded.close(); }
});

test('legacy commission fallback uses existing Day Book mirror and status-only updates preserve money/application date', async () => {
  const { embedded, db } = await fixture();
  try {
    const legacy = { id:99, site_id:8, date:'2026-10-01', by_note:'CHEQUE', cheque_status:'CLEARED' };
    await attachModuleChequeDates([legacy],db,'plot_commissions');
    assert.equal(legacy.cheque_transaction_date,'2026-10-02');
    const result = await updateChequeStatusRecord(db,{source:'plot_commission',entryId:99,status:'RETURNED',expectedSiteId:8});
    assert.equal(result.after.cheque_transaction_date,null);
    const owner=(await embedded.query('SELECT *,date::text AS date FROM plot_commissions WHERE id=99')).rows[0];
    const projection=(await embedded.query('SELECT *,date::text AS date FROM day_book WHERE id=69')).rows[0];
    assert.equal(owner.cheque_status,'RETURNED');assert.equal(projection.cheque_status,'RETURNED');
    assert.equal(owner.date,'2026-10-01');assert.equal(Number(owner.amount),100);assert.equal(Number(projection.debit),100);
    assert.equal((await embedded.query('SELECT cheque_transaction_date FROM cash_flow_entries WHERE id=83')).rows[0].cheque_transaction_date,null);
    await assert.rejects(updateChequeStatusRecord(db,{source:'plot_commission',entryId:99,status:'CLEARED',requireTransactionDate:true}), error=>error.code==='CHEQUE_TRANSACTION_DATE_REQUIRED');
  } finally { await embedded.close(); }
});

test('status mutation requires a clearing date on transitions, preserves unchanged CLEARED dates, and enforces site and period guards', async () => {
  const { embedded,db } = await fixture();
  try {
    const result = await updateChequeStatusRecord(db,{source:'cash_flow_entry',entryId:24,status:'CLEARED',chequeNo:'new-number',requireTransactionDate:true});
    assert.equal(result.after.cheque_transaction_date,'2026-10-15');
    await assert.rejects(updateChequeStatusRecord(db,{source:'cash_flow_entry',entryId:24,status:'PENDING',authorizeSite:()=>{throw Object.assign(new Error('Forbidden'),{statusCode:403});}}),error=>error.statusCode===403);
    assert.equal((await embedded.query('SELECT cheque_status FROM cash_flow_entries WHERE id=24')).rows[0].cheque_status,'CLEARED');
    await embedded.query('UPDATE cash_flow_entries SET cash_flow_month_id=1 WHERE id=24');
    await assert.rejects(updateChequeStatusRecord(db,{source:'cash_flow_entry',entryId:24,status:'RETURNED'}),error=>error.code==='ACCOUNTING_PERIOD_LOCKED');
  } finally { await embedded.close(); }
});

test('generic payment report adds editable cheque metadata while preserving its summary, detail columns and native amounts', async () => {
  const { embedded,db,calls } = await fixture();
  try {
    await embedded.exec(`CREATE TABLE expenses(id int PRIMARY KEY,site_id int,date date,payment_mode text,cheque_status text,cheque_no text,debit numeric);
      INSERT INTO expenses VALUES(5,8,'2026-10-05','CHEQUE','CLEARED','005',100),(6,9,'2026-10-05','CHEQUE','CLEARED','foreign',900);`);
    const def={from:'expenses e',siteCol:'e.site_id',dateCol:'e.date',amount:'e.debit',columns:[{key:'date',expr:'e.date'},{key:'debit',expr:'e.debit'}]};
    const report=await loadReportRows(db,{def,dimension:{expr:'e.payment_mode'},bucket:'day',where:'e.site_id=$1 AND e.date >= $2::date AND e.date <= $3::date',params:[8,'2026-10-01','2026-10-16'],rowLimit:10});
    assert.equal(calls.length,2);assert.equal(report.totals.record_count,1);assert.equal(Number(report.totals.total),100);
    assert.equal(report.rows[0].cheque_source_module,'expenses');assert.equal(report.rows[0].cheque_source_id,5);
    assert.equal(report.rows[0].cheque_transaction_date,'2026-10-14');assert.equal(Number(report.rows[0].debit),100);
    assert.equal(def.columns.length,2,'metadata never adds aggregate or displayed report columns');
  } finally { await embedded.close(); }
});


test('member financial-info and combined transaction readers retain the same native cheque metadata in one batch', async () => {
  const { embedded, db, calls } = await fixture();
  try {
    const native = new Map([
      ['expenses',5],['plot_commissions',12],['plot_payments',1],['farmer_payments',2],['firm_transactions',3],['plot_commission_payments',4],
    ]);
    const originals = new Map();
    for (const [module,id] of native) {
      const row=(await embedded.query('SELECT *,date::text AS date FROM cash_flow_entries WHERE site_id=8 AND source_module=$1 AND source_id=$2',[module,id])).rows[0];
      originals.set(module,{...row,id,amount:100,payment_mode:'CHEQUE',payment_type:'CHEQUE',by_note:'CHEQUE'});
    }
    const controllerSource=readFileSync(new URL('../src/controllers/member.controller.js',import.meta.url),'utf8');
    const excerpt=controllerSource.slice(controllerSource.indexOf('export const getMemberTransactions =')).replace(/export const /g,'const ');
    const fakePool={async query(sql,params){
      if (sql.includes('jsonb_to_recordset')) return db.query(sql,params);
      if (/ambiguous_legacy_name/.test(sql)) return {rows:[{ambiguous_legacy_name:false}]};
      for (const [module] of native) if (new RegExp(`FROM ${module} [a-z]+\\b`).test(sql)) {
        assert.match(sql,/cheque_status/,'the native projection includes lifecycle status');
        const {cheque_transaction_date, ...selected} = originals.get(module);
        return {rows:[{...selected,...(/'EXPENSE' as source/.test(sql)?{source:'EXPENSE'}:{})}]};
      }
      if (/FROM day_book d/.test(sql)) return {rows:[{id:66,site_id:8,date:'2026-10-07',farmer_payment_id:2,payment_mode:'CHEQUE',cheque_status:'PENDING',source:'DAYBOOK',debit:100,credit:0}]};
      return db.query(sql,params);
    }};
    const context={pool:fakePool,attachModuleChequeDates,asyncHandler:fn=>fn,
      resolveMemberIdentityId:async()=>7,memberModel:{findById:async()=>({id:7})},
      memberTransactionMatch:()=> 'TRUE', uniqueMemberNameMatch:()=> 'TRUE',LEDGER_PLOT_BUYER_JOIN:'',MEMBER_PLOT_PAYMENT_MATCH:'TRUE'};
    vm.createContext(context);vm.runInContext(`${excerpt}\nthis.handlers={getMemberFinancialInfo,getMemberTransactions};`,context);
    const invoke=async name=>{let body;await context.handlers[name]({params:{id:'7'},query:{site_id:'8'},user:{id:1,role:'admin'}},{json(value){body=value;},status(){return this;}});return body;};
    const info=await invoke('getMemberFinancialInfo');
    assert.equal(calls.length,1,'all six native categories share one date lookup');
    for (const [key,module] of [['expenses','expenses'],['commissions','plot_commissions'],['plot_payments','plot_payments'],['farmer_payments','farmer_payments'],['firm_transactions','firm_transactions'],['commission_payments','plot_commission_payments']]) {
      assert.equal(info[key][0].cheque_source_module,module);
      assert.equal(info[key][0].cheque_transaction_date,originals.get(module).cheque_transaction_date.toISOString().slice(0,10));
    }
    calls.length=0;
    const transactions=await invoke('getMemberTransactions');
    assert.equal(calls.length,1);
    const projected=transactions.transactions.find(row=>row.source==='DAYBOOK');
    assert.equal(projected.cheque_source_module,'farmer_payments');assert.equal(projected.cheque_source_id,2);
    assert.equal(projected.cheque_transaction_date,'2026-10-11');assert.equal(projected.date,'2026-10-07');
  } finally {await embedded.close();}
});
