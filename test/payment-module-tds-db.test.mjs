import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import MasterModel from '../src/models/MasterModel.js';
import { up as register } from '../src/migrations/179_tds_register.js';
import { up as migrate } from '../src/migrations/184_payment_module_tds.js';
import { defaultTdsWorkflow } from '../src/services/tdsWorkflow.service.js';
import { TDS_SOURCES, paymentTdsMiddleware } from '../src/services/paymentTds.service.js';
import { createExpense } from '../src/controllers/expense.controller.js';
import { createPayment as createFarmerPayment } from '../src/controllers/farmer.controller.js';
import { listDeductions, recordDeposit, updateDeduction, deleteDeduction } from '../src/controllers/tds.controller.js';

const invoke = (handler, body = {}, extra = {}, useTds = false) => new Promise((resolve, reject) => {
  const req = { body, user: { id: 1, role: 'admin' }, query: {}, params: {}, ...extra };
  const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code || 200, body }); } };
  if (useTds) paymentTdsMiddleware(req, res, error => error ? reject(error) : handler(req, res, reject));
  else handler(req, res, reject);
});

test('native payment modules withhold atomically and share the TDS register', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  try {
    await pg.exec(`
      CREATE TABLE sites(id int PRIMARY KEY,name text); INSERT INTO sites VALUES(1,'Mount Valley'),(2,'Other site');
      CREATE TABLE users(id int PRIMARY KEY,name text); INSERT INTO users VALUES(1,'Admin');
      CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,pan_no text,aadhar_no text); INSERT INTO members VALUES(1,1,'Payee','ABCDE1234F','123456789012');
      CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
      CREATE TABLE farmers(id int PRIMARY KEY,site_id int,name text,member_id int,total_amount numeric,cash_amount numeric,bank_amount numeric); INSERT INTO farmers VALUES(1,1,'Farmer',1,100000,0,100000),(2,2,'Other farmer',NULL,100000,0,100000);
      CREATE TABLE cash_flow_months(id int PRIMARY KEY,site_id int,ledger_name text,linked_member_id int); INSERT INTO cash_flow_months VALUES(1,1,'Personal',1);
      CREATE TABLE firms(id int PRIMARY KEY,site_id int,name text); INSERT INTO firms VALUES(1,1,'Firm');
      CREATE TABLE vendor_commitments(id int PRIMARY KEY,site_id int,vendor_member_id int,vendor_name text,work_title text); INSERT INTO vendor_commitments VALUES(1,1,1,'Vendor','Construction');
      CREATE TABLE vendor_inventory_orders(id int PRIMARY KEY,site_id int,vendor_member_id int,vendor_name text); INSERT INTO vendor_inventory_orders VALUES(1,1,1,'Vendor');
      CREATE TABLE plots(id int PRIMARY KEY,plot_no text);
      CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,plot_id int,farmer_id int,land_deal_id int);
      CREATE TABLE plot_commission_payments(id int PRIMARY KEY,plot_commission_id int,payment_mode text,transaction_id text,cheque_no text,cheque_status text,status text,amount numeric);
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT lower(COALESCE($2,'approved'))='approved' AND (upper(COALESCE($3,''))<>'CHEQUE' OR $4='CLEARED') $$;
    `);
    const modules = defaultTdsWorkflow(); Object.values(modules).forEach(value => { value.enabled = true; });
    await pg.query("INSERT INTO application_settings VALUES(1,'tds_workflow',$1)", [JSON.stringify(modules)]);
    for (const table of new Set(Object.values(TDS_SOURCES).map(source => source.table))) await pg.exec(`CREATE TABLE ${table}(
      id serial PRIMARY KEY,site_id int,date date,payment_date date,amount numeric,debit numeric DEFAULT 0,credit numeric DEFAULT 0,
      status text DEFAULT 'pending',payment_mode text,cheque_status text,cheque_no text,created_by int,assigned_admin_id int,assigned_user_id int,
      farmer_id int,cash_flow_month_id int,firm_id int,commitment_id int,order_id int,member_id int,
      particular text,entry_type text,from_entity text,to_entity text,party_name text,name text,direction text,cash_type text,
      cash_amount numeric,bank_amount numeric,bank_name text,bank_account_no text,bank_reference text,bank_ifsc text,
      account_no text,branch text,category text,sub_category text,remark text,remarks text,note text,by_note text,
      voucher_url text,voucher_urls text[],bill_url text,bill_urls text[],transaction_time time,farmer_payment_id int,
      updated_at timestamptz DEFAULT now(), approved_by int, approved_at timestamptz,interest_amount numeric DEFAULT 0)`);
    await register(pool);
    await pg.exec('ALTER TABLE tds_deductions ADD COLUMN commission_payment_id int, ADD COLUMN source_module text, ADD COLUMN calculation_mode text');
    await migrate(pool); await migrate(pool);
    const base = { site_id: 1, date: '2026-10-01', payment_date: '2026-10-01', amount: 100000, payment_mode: 'BANK', tds_applicable: true, tds_mode: 'percentage', tds_rate: 2, tds_section: 'OTHER' };
    let expense, farmer;
    await t.test('expense create stores 98K net and 2K held with one linked pending register row', async () => {
      const result = await invoke(createExpense, { ...base, debit: 100000, credit: 0, to_entity: 'Supplier', tds_pan: 'ABCDE1234F' }, { originalUrl: '/expenses', method: 'POST' }, true);
      expense = result.body.expense; assert.equal(result.code, 201);
      assert.equal(Number(expense.debit), 98000); assert.equal(Number(expense.tds_amount), 2000);
      const deduction = (await pg.query("SELECT * FROM tds_deductions WHERE source_table='expenses' AND source_id=$1", [expense.id])).rows[0];
      assert.equal(Number(deduction.gross_amount), 100000); assert.equal(deduction.payment_state, 'pending'); assert.equal(deduction.deductee_name, 'SUPPLIER');
    });
    await t.test('farmer create keeps native payment, cash/bank legs and register aligned', async () => {
      const result = await invoke(createFarmerPayment, { ...base, particular: 'BANK', cash_amount: 0, bank_amount: 100000 }, { originalUrl: '/farmers/1/payments', method: 'POST', params: { farmerId: '1' } }, true);
      farmer = result.body.payment; assert.equal(result.code, 201);
      assert.equal(Number(farmer.amount), 98000); assert.equal(Number(farmer.bank_amount), 98000); assert.equal(Number(farmer.tds_amount), 2000);
      assert.equal(Number(result.body.daybook_entries[0].debit), 98000);
      const deduction = (await pg.query("SELECT * FROM tds_deductions WHERE source_table='farmer_payments' AND source_id=$1", [farmer.id])).rows[0];
      assert.equal(deduction.member_id, 1); assert.equal(deduction.deductee_name, 'Farmer'); assert.equal(deduction.pan, 'ABCDE1234F');
    });
    await t.test('every remaining outgoing source uses the same manual withholding contract', async () => {
      const entries = [
        ['daybook','/daybook',{}], ['cashflow','/cashflow/entries',{cash_flow_month_id:1}], ['firm_transaction','/firms/transactions',{firm_id:1}],
        ['vendor_payment','/vendors/commitments/1/payments',{commitment_id:1}], ['vendor_inventory_payment','/vendors/inventory/1/payments',{order_id:1}],
        ['misc_income','/misc-income',{direction:'debit',party_name:'Refund payee'}], ['partner_profit_payment','/sites/1/profit-payments',{member_id:1}],
        ['imprest_expense','/imprest/expense',{to_entity:'Imprest supplier'}],
      ];
      for (const [module, path, details] of entries) {
        const source = TDS_SOURCES[module]; const body = { ...base, ...details, debit:100000,credit:0,tds_mode:'manual',tds_amount:2500 };
        const handler = (req, res, next) => new MasterModel(source.table).create({ site_id:1, date:base.date, payment_date:base.date, status:'pending', created_by:1, payment_mode:'BANK', [source.amount || 'amount']: req.body[source.amount || 'amount'], ...details }, pool).then(row => res.json(row), next);
        const result = await invoke(handler, body, { originalUrl:path, method:'POST' }, true);
        assert.equal(Number(result.body[source.amount || 'amount']),97500,module);
        const deduction = (await pg.query('SELECT * FROM tds_deductions WHERE source_table=$1 AND source_id=$2',[source.table,result.body.id])).rows[0];
        assert.equal(deduction.source_module,module); assert.equal(Number(deduction.tds_amount),2500); assert.equal(Number(deduction.tds_rate),2.5);
      }
    });
    await t.test('register retains source identity and protects linked entries from manual edits', async () => {
      const list = await invoke(listDeductions, {}, { query: { site_id:1,financial_year:2026 } });
      assert.equal(list.body.deductions.length,10);
      assert.ok(list.body.deductions.every(row => row.source_id && row.payment_state==='pending'));
      const deduction = list.body.deductions.find(row => row.source_table==='expenses' && row.source_id===expense.id);
      await assert.rejects(invoke(updateDeduction, {}, { params: { id:deduction.id } }), /source payment/);
      await assert.rejects(invoke(deleteDeduction, {}, { params: { id:deduction.id } }), /source payment/);
      await assert.rejects(invoke(recordDeposit,{site_id:1,ids:[deduction.id],deposit_date:'2026-10-02',challan_no:'C1'}), /pending/);
      await pg.query("UPDATE expenses SET status='approved' WHERE id=$1",[expense.id]);
      await invoke(recordDeposit,{site_id:1,ids:[deduction.id],deposit_date:'2026-10-02',challan_no:'C1'});
      await assert.rejects(pg.query('UPDATE expenses SET debit=90000 WHERE id=$1',[expense.id]), /deposited/);
      await assert.rejects(pg.query("UPDATE expenses SET status='rejected' WHERE id=$1",[expense.id]), /deposited/);
      await assert.rejects(pg.query('DELETE FROM expenses WHERE id=$1',[expense.id]), /deposited/);
    });
    await t.test('deposited taxpayer snapshots survive later member and source-note changes', async () => {
      const deduction = (await pg.query("SELECT * FROM tds_deductions WHERE source_module='vendor_payment'")).rows[0];
      await pg.query("UPDATE vendor_payments SET status='approved' WHERE id=$1",[deduction.source_id]);
      await invoke(recordDeposit,{site_id:1,ids:[deduction.id],deposit_date:'2026-10-02',challan_no:'C2'});
      await pg.query("UPDATE members SET pan_no='FGHIJ1234K',full_name='New member name' WHERE id=1");
      await pg.query("UPDATE vendor_commitments SET vendor_name='New vendor name' WHERE id=1");
      await pg.query("UPDATE vendor_payments SET note='Receipt attached later' WHERE id=$1",[deduction.source_id]);
      const stored = (await pg.query('SELECT * FROM tds_deductions WHERE id=$1',[deduction.id])).rows[0];
      assert.equal(stored.pan,deduction.pan); assert.equal(stored.deductee_name,deduction.deductee_name);
      assert.equal(stored.challan_no,'C2');
    });
    await t.test('disabled sites, credits and edits without a TDS snapshot cannot change held money', async () => {
      await assert.rejects(invoke(createFarmerPayment,{...base,particular:'BANK'}, { originalUrl:'/farmers/2/payments',method:'POST',params:{farmerId:'2'} },true), /Enable/);
      await assert.rejects(invoke(createExpense,{...base,debit:0,credit:100000}, {originalUrl:'/expenses',method:'POST'},true), /outgoing/);
      await assert.rejects(pg.query('UPDATE farmer_payments SET amount=90000 WHERE id=$1',[farmer.id]), /source module/);
      const linked = (await pg.query("SELECT id FROM tds_deductions WHERE source_table='farmer_payments' AND source_id=$1",[farmer.id])).rows[0];
      await pg.query("UPDATE farmer_payments SET status='rejected' WHERE id=$1",[farmer.id]);
      assert.equal((await pg.query('SELECT payment_state FROM tds_deductions WHERE id=$1',[linked.id])).rows[0].payment_state,'reversed');
      await pg.query('DELETE FROM farmer_payments WHERE id=$1',[farmer.id]);
      assert.equal((await pg.query('SELECT id FROM tds_deductions WHERE id=$1',[linked.id])).rows.length,0);
    });
  } finally { await pg.close(); }
});
