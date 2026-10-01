import { up as nativeWorkflow } from '../src/migrations/184_payment_module_tds.js';
import { TDS_SOURCES } from '../src/services/paymentTds.service.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { up as register } from '../src/migrations/179_tds_register.js';
import { up as workflow } from '../src/migrations/183_commission_tds_workflow.js';
import { createPlotCommissionPayment, updatePlotCommissionPayment } from '../src/controllers/plotCommissionV2.controller.js';
import { listDeductions, recordDeposit, updateDeduction, deleteDeduction } from '../src/controllers/tds.controller.js';

const invoke = (handler, body = {}, extra = {}) => new Promise((resolve, reject) => handler({ body, user: { id: 1, role: 'admin' }, query: {}, params: {}, ...extra }, { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code || 200, body }); } }, reject));
test('commission TDS database lifecycle', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const query = async (sql, args) => args?.length ? pg.query(sql, args) : (await pg.exec(sql)).at(-1);
  pool.query = query; pool.connect = async () => ({ query, release() {} });
  try {
    await pg.exec(`
      CREATE TABLE sites(id int PRIMARY KEY); INSERT INTO sites VALUES(1),(2);
      CREATE TABLE users(id int PRIMARY KEY,name text); INSERT INTO users VALUES(1,'Admin'),(2,'Sub admin');
      CREATE TABLE user_sites(user_id int,site_id int); INSERT INTO user_sites VALUES(2,1);
      CREATE TABLE members(id int PRIMARY KEY,site_id int,full_name text,pan_no text,aadhar_no text);
      INSERT INTO members VALUES(1,1,'Agent','ABCDE1234F','123456789012');
      CREATE TABLE plots(id int PRIMARY KEY,plot_no text); INSERT INTO plots VALUES(1,'A1');
      CREATE TABLE application_settings(site_id int,setting_key text,setting_value jsonb);
      INSERT INTO application_settings VALUES(1,'tds_workflow','{"plot_commission":{"enabled":true,"rate":2,"section":"194H"},"land_purchase_commission":{"enabled":false,"rate":2,"section":"194H"},"land_sale_commission":{"enabled":true,"rate":2,"section":"194H"}}');
      CREATE TABLE plot_commissions_v2(id int PRIMARY KEY,site_id int,plot_id int,farmer_id int,land_deal_id int,agent_id int,total_commission numeric,status text,updated_at timestamptz);
      INSERT INTO plot_commissions_v2 VALUES(1,1,1,NULL,NULL,1,100000,'Pending',now()),(2,1,NULL,1,NULL,1,100000,'Pending',now()),(3,1,NULL,NULL,1,1,100000,'Pending',now()),(4,2,1,NULL,NULL,1,100000,'Pending',now());
      CREATE TABLE plot_commission_payments(id serial PRIMARY KEY,site_id int,plot_commission_id int REFERENCES plot_commissions_v2(id) ON DELETE CASCADE,date date,amount numeric,balance_after_payment numeric,payment_mode text,bank_name text,transaction_id text,remarks text,status text,voucher_number text,voucher_url text,assigned_admin_id int,created_by int,approved_by int,approved_at timestamptz,cheque_no text,cheque_status text,transaction_time time,updated_at timestamptz);
      CREATE TABLE imprest_ledger(id int,user_id int,site_id int,source_module text,reference_id int,type text);
      CREATE FUNCTION financial_transaction_posts(text,text,text,text) RETURNS boolean LANGUAGE SQL AS $$ SELECT lower(COALESCE($2,'approved'))='approved' AND (upper(COALESCE($3,''))<>'CHEQUE' OR $4='CLEARED') $$;
      CREATE TABLE cash_movements(source_id int PRIMARY KEY,amount numeric);
      CREATE FUNCTION test_cash_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO cash_movements VALUES(NEW.id,NEW.amount) ON CONFLICT(source_id) DO UPDATE SET amount=EXCLUDED.amount; RETURN NEW; END $$;
      CREATE TRIGGER test_mirror AFTER INSERT OR UPDATE ON plot_commission_payments FOR EACH ROW EXECUTE FUNCTION test_cash_mirror();
    `);
    for (const table of new Set(Object.values(TDS_SOURCES).map(source => source.table))) await pg.exec(`CREATE TABLE ${table}(id serial PRIMARY KEY,site_id int,amount numeric,debit numeric)`);
    await register(pool); await workflow(pool); await workflow(pool); await nativeWorkflow(pool);
    let payment;
    const list = async (user) => (await invoke(listDeductions, {}, { query: { site_id: 1, financial_year: 2026 }, ...(user ? { user } : {}) })).body.deductions;
    await t.test('create atomically stores net cash and one pending linked deduction', async () => {
      const result = await invoke(createPlotCommissionPayment, { master_id: 1, date: '2026-10-01', amount: 100000, payment_mode: 'BANK', tds_applicable: true });
      assert.equal(result.code, 201); payment = result.body.payment;
      assert.equal(Number(payment.amount), 98000); assert.equal(Number(payment.tds_amount), 2000);
      assert.equal(Number((await query('SELECT amount FROM cash_movements WHERE source_id=$1', [payment.id])).rows[0].amount), 98000);
      const rows = await list(); assert.equal(rows.length, 1); assert.equal(rows[0].payment_state, 'pending');
      assert.equal(Number(rows[0].gross_amount), 100000); assert.equal(rows[0].pan, 'ABCDE1234F');
      await assert.rejects(invoke(recordDeposit, { site_id: 1, ids: [rows[0].id], deposit_date: '2026-10-02', challan_no: 'TEST' }), /pending/);
      assert.equal((await query('SELECT status FROM plot_commissions_v2 WHERE id=1')).rows[0].status, 'Pending');
    });
    await t.test('pending gross reserves commission and prevents overpayment', async () => {
      const result = await invoke(createPlotCommissionPayment, { master_id: 1, date: '2026-10-01', amount: 1 });
      assert.equal(result.code, 400); assert.equal(result.body.code, 'COMMISSION_EXCEEDED');
      await assert.rejects(query("INSERT INTO plot_commission_payments(site_id,plot_commission_id,date,amount,status) VALUES(1,1,'2026-10-01',1,'pending')"), /exceeds/);
    });
    await t.test('edit recomputes percentage and updates the same deduction', async () => {
      await invoke(updatePlotCommissionPayment, { amount: 50000, tds_applicable: true, tds_rate: 2 }, { params: { id: payment.id } });
      const rows = await list(); assert.equal(rows.length, 1); assert.equal(Number(rows[0].tds_amount), 1000); assert.equal(Number(rows[0].net_amount), 49000);
      await query("UPDATE plot_commission_payments SET status='approved' WHERE id=$1", [payment.id]);
      assert.equal((await list())[0].payment_state, 'active');
      assert.equal((await query('SELECT status FROM plot_commissions_v2 WHERE id=1')).rows[0].status, 'Partial');
      await assert.rejects(query('UPDATE plot_commission_payments SET amount=48000 WHERE id=$1', [payment.id]), /commission module/);
    });
    await t.test('cheques and rejection preserve history but remove active withholding', async () => {
      await query("UPDATE plot_commission_payments SET payment_mode='CHEQUE',cheque_status='PENDING' WHERE id=$1", [payment.id]);
      assert.equal((await list())[0].payment_state, 'pending');
      await query("UPDATE plot_commission_payments SET cheque_status='BOUNCED' WHERE id=$1", [payment.id]);
      assert.equal((await list())[0].payment_state, 'reversed');
      await query("UPDATE plot_commission_payments SET cheque_status='CLEARED' WHERE id=$1", [payment.id]);
      assert.equal((await list())[0].payment_state, 'active');
      await query("UPDATE plot_commission_payments SET status='rejected' WHERE id=$1", [payment.id]);
      assert.equal((await list())[0].payment_state, 'reversed');
      await query("UPDATE plot_commission_payments SET status='approved',payment_mode='BANK',cheque_status=NULL WHERE id=$1", [payment.id]);
    });
    await t.test('source register entries cannot be edited or deleted independently', async () => {
      const row = (await list())[0];
      await assert.rejects(invoke(updateDeduction, {}, { params: { id: row.id } }), /source/);
      await assert.rejects(invoke(deleteDeduction, {}, { params: { id: row.id } }), /source/);
    });
    await t.test('deposit is atomic and deposited source edits/deletes are blocked', async () => {
      const row = (await list())[0];
      await assert.rejects(invoke(recordDeposit, { site_id: 1, ids: [row.id, 999], deposit_date: '2026-10-02', challan_no: 'TEST' }), /Nothing saved/);
      assert.equal((await list())[0].deposit_date, null);
      await invoke(recordDeposit, { site_id: 1, ids: [row.id], deposit_date: '2026-10-02', challan_no: 'TEST-CHALLAN' });
      assert.equal((await list())[0].challan_no, 'TEST-CHALLAN');
      await assert.rejects(invoke(recordDeposit, { site_id: 1, ids: [row.id], deposit_date: '2026-10-03', challan_no: 'DUPLICATE' }), /already deposited/);
      await assert.rejects(query('DELETE FROM plot_commission_payments WHERE id=$1', [payment.id]), /deposited/);
      await assert.rejects(query('DELETE FROM plot_commissions_v2 WHERE id=1'), /deposited/);
      await assert.rejects(query("UPDATE plot_commission_payments SET status='rejected' WHERE id=$1", [payment.id]), /deposited/);
      await assert.rejects(invoke(updatePlotCommissionPayment, { amount: 40000, tds_applicable: true }, { params: { id: payment.id } }), /deposited/);
    });
    await t.test('module settings, manual deductions, disabling and removing TDS', async () => {
      await assert.rejects(invoke(createPlotCommissionPayment, { master_id: 2, amount: 100000, date: '2026-10-01', tds_applicable: true }), /Enable/);
      const { body } = await invoke(createPlotCommissionPayment, { master_id: 3, amount: 100000, date: '2026-10-01', tds_applicable: true, tds_mode: 'manual', tds_amount: 3000 });
      const id = body.payment.id; assert.equal(Number(body.payment.amount), 97000);
      await query("UPDATE application_settings SET setting_value=jsonb_set(setting_value,'{land_sale_commission,enabled}','false')");
      await invoke(updatePlotCommissionPayment, { remarks: 'Preserve TDS snapshot' }, { params: { id } });
      assert.equal((await list()).find(row => row.commission_payment_id === id).tds_amount, '3000.00');
      await invoke(updatePlotCommissionPayment, { amount: 100000, tds_applicable: false }, { params: { id } });
      assert.equal((await list()).some(row => row.commission_payment_id === id), false);
      await query('DELETE FROM plot_commission_payments WHERE id=$1', [id]);
    });
    await t.test('site access is enforced for reads and new payments', async () => {
      await assert.rejects(invoke(listDeductions, {}, { user: { id: 2, role: 'sub_admin' }, query: { site_id: 2, financial_year: 2026 } }), /Access denied/);
      await assert.rejects(invoke(createPlotCommissionPayment, { master_id: 4, amount: 1000, date: '2026-10-01' }, { user: { id: 2, role: 'sub_admin' } }), /Access denied/);
    });
  } finally { await pg.close(); }
});
