import { up as walletUp } from '../src/migrations/185_cash_wallets.js';
import { up as vaultUp } from '../src/migrations/199_loyalty_vault.js';
import { up as unifiedUp } from '../src/migrations/203_unified_cash_wallet.js';
import { up as siteUp } from '../src/migrations/208_cash_wallet_site_scope.js';
import { up as collectorUp } from '../src/migrations/211_locked_cash_collector.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';
import { migrationSql as plotReviewSettingSql } from '../src/migrations/177_plot_status_approval_setting.js';
import { plotSnapshotFunctionSql } from '../src/migrations/172_approval_change_snapshots.js';
import { resolveEntryVisibility } from '../src/services/entryVisibility.service.js';
import { migrationSql as plotReviewSql } from '../src/migrations/158_plot_status_approval.js';
import { migrationSql as directPlotBookingSql } from '../src/migrations/258_direct_plot_status.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { poolMoneySql,up as migratePoolMoney } from '../src/migrations/238_pool_money.js';
import { listPoolMoney,poolDetail,mutatePoolMoney,poolEligibility,validatePoolIdentity,assertPoolSiteAccess,allocatePoolReceipt,returnPoolReceipt,poolReturnReceiptSql } from '../src/services/poolMoney.service.js';
import { poolEnrollmentPlan, enrollExistingPoolReceipts } from '../src/services/poolMoneyEnrollment.service.js';
import accountsDatabase from '../src/config/db.js';
import { deletePayment } from '../src/controllers/plot.controller.js';
import { deleteEntry } from '../src/controllers/cashflow.controller.js';
import { deleteCashFlowEntryFromDayBook } from '../src/controllers/daybook.controller.js';
import { forgetRelationProbes } from '../src/utils/schemaProbe.js';
import { createPoolMoneyRouter } from '../src/routes/poolMoney.routes.js';
const admin={id:1,role:'admin',name:'ADMIN',organization_id:1}, identity={kind:'draw',id:1,siteId:1};
function callController(handler, id) {
 return new Promise((resolve, reject) => {
   let status = 200;
   const res = { status(code) { status = code; return this; }, json(body) { resolve({ status, body }); } };
   handler({ params: { id: String(id) }, user: admin }, res, reject);
 });
}
async function fixture(t,{source='draw',mode='CASH',date='2020-01-01',cancelled=false,ready=true,projectId=1}={}) {
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`
 CREATE TABLE sites(id integer PRIMARY KEY,organization_id integer);
 CREATE TABLE users(id integer PRIMARY KEY,name text,role text,is_active boolean,organization_id integer);
 CREATE TABLE user_sites(user_id integer,site_id integer);
 CREATE TABLE members(id integer PRIMARY KEY,site_id integer,full_name text,status text,phone text);
 CREATE TABLE bank_accounts(id integer PRIMARY KEY,site_id integer);
 CREATE TABLE plots(id serial PRIMARY KEY,site_id integer,plot_no text,block text,unit_type text DEFAULT 'shop',plot_size numeric,sale_price numeric,
 status text,buyer_name text,buyer_member_id integer,booking_by text,booking_date date,approval_status text DEFAULT 'approved',assigned_admin_id integer,approval_requested_by integer,updated_at timestamptz);
 CREATE TABLE bookings(id serial PRIMARY KEY,site_id integer,plot_id integer,client_member_id integer,booking_no text,booking_date date DEFAULT CURRENT_DATE,
 token_amount numeric DEFAULT 0,token_payment_id integer,token_payment_from text,token_payment_date date,token_bank_name text,token_branch text,token_bank_details text,
 token_cheque_no text,token_received_by text,token_narration text,sale_price numeric,payment_plan text,status text,kyc_status text,buyer_name text,booked_by text,
 created_by integer,created_at timestamptz DEFAULT now(),updated_at timestamptz,agent_user_id integer,team_id integer);
 CREATE TABLE draw_registrations(id serial PRIMARY KEY,site_id integer,client_member_id integer,registration_no text,scheme_name text,required_amount numeric,
 status text,slip_no text,is_winner boolean DEFAULT false,allotted_plot_id integer,booking_id integer,kyc_case_id integer,workflow_version integer DEFAULT 1,
 draw_opening_date date,winner_marked_at timestamptz,winner_marked_by integer,allotted_at timestamptz,allotted_by integer,created_at timestamptz DEFAULT now(),updated_at timestamptz);
 CREATE TABLE draw_payments(id serial PRIMARY KEY,draw_registration_id integer,receipt_no text,payment_date date,amount numeric,payment_from text,bank_name text,
 branch text,bank_details text,bank_account_id integer,cheque_no text,received_by text,narration text,plot_payment_id integer,created_by integer,created_at timestamptz DEFAULT now());
 CREATE TABLE draw_events(id serial PRIMARY KEY,draw_registration_id integer,event_type text,detail jsonb,actor_user_id integer);
 CREATE TABLE kyc_cases(id serial PRIMARY KEY,booking_id integer,client_member_id integer,site_id integer,status text);
 CREATE TABLE plot_payments(id serial PRIMARY KEY,plot_id integer,site_id integer,date date,amount numeric,payment_from text,payment_type text,
 bank_name text,branch text,bank_details text,cheque_no text,cheque_status text,received_by text,narration text,buyer_name text,booked_by text,status text,
 created_by integer,created_at timestamptz DEFAULT now(),approved_by integer,approved_at timestamptz);
 CREATE TABLE plot_installments(id serial PRIMARY KEY,plot_id integer);
 CREATE TABLE cash_flow_months(id integer PRIMARY KEY,site_id integer,month integer,year integer,is_locked boolean DEFAULT false);
 INSERT INTO cash_flow_months(id,site_id,month,year) VALUES(1,${projectId},1,2020);
 CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,cash_flow_month_id integer,site_id integer,date date,particular text,debit numeric,credit numeric,
 cash_type text,remarks text,status text,source_module text,source_id integer,created_by integer,created_at timestamptz,updated_at timestamptz,
 cheque_no text,cheque_status text,bank_account_id integer,approved_by integer,approved_at timestamptz,assigned_admin_id integer,UNIQUE(source_module,source_id));
 CREATE FUNCTION ensure_site_cashflow_month(integer,date,integer) RETURNS integer LANGUAGE sql AS 'SELECT 1';
 CREATE FUNCTION test_plot_mirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO cash_flow_entries(site_id,date,particular,debit,credit,cash_type,status,source_module,source_id,created_by,created_at,cheque_status)
 VALUES(NEW.site_id,NEW.date,'Plot payment',0,NEW.amount,lower(NEW.payment_type),NEW.status,'plot_payments',NEW.id,NEW.created_by,NEW.created_at,NEW.cheque_status);
 RETURN NEW; END $$;
 CREATE TRIGGER test_pp AFTER INSERT ON plot_payments FOR EACH ROW EXECUTE FUNCTION test_plot_mirror();
 INSERT INTO sites VALUES(${projectId},1),(2,1);
 INSERT INTO users VALUES(1,'ADMIN','admin',true,1),(2,'COLLECTOR','sub_admin',true,1);
 INSERT INTO members VALUES(1,${projectId},'BUYER','ACTIVE','9999999999');
 INSERT INTO plots(site_id,plot_no,sale_price,status,assigned_admin_id) VALUES(${projectId},'S-01',1000000,'COMPANY',1),(2,'OTHER',1000000,'COMPANY',1);
 INSERT INTO kyc_cases(booking_id,client_member_id,site_id,status) VALUES(NULL,1,${projectId},'VERIFIED');
 `);
 const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
 if(ready) {await db.exec(poolMoneySql);await db.exec('CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source(); CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source()');}
 if(source==='draw') {
  await db.query("INSERT INTO draw_registrations(site_id,client_member_id,registration_no,required_amount,status,kyc_case_id,draw_opening_date) VALUES($1,1,'DR-01',100000,$2,1,$3)",[projectId,'SLIP_ISSUED',date]);
  await db.query("INSERT INTO draw_payments(draw_registration_id,receipt_no,payment_date,amount,payment_from,created_by,bank_details,cheque_no) VALUES(1,'DP-01','2020-01-01',100000,$1,2,'REFERENCE','CH01')",[mode]);
  if(cancelled) await db.exec("UPDATE draw_registrations SET status='CANCELLED' WHERE id=1");
 } else await db.exec(`INSERT INTO bookings(site_id,client_member_id,booking_no,booking_date,token_amount,token_payment_from,status,kyc_status,created_by) VALUES(${projectId},1,'BK-0001','2020-01-01',100000,'CASH','KYC_DONE','VERIFIED',2); UPDATE kyc_cases SET booking_id=1;`);
 return {db,pool};
}
test('validates IDs and recognises allotted records',()=>{
 for(const args of [['draw','1xx',1],['other',1,1],['booking',1,'x']]) assert.throws(()=>validatePoolIdentity(...args),{statusCode:400});
 assert.equal(poolEligibility({status:'ALLOTTED'}),'Already allotted');
});
test('new draw receipts post exactly once before allotment with original collector',async t=>{
 const {db,pool}=await fixture(t);const before=await listPoolMoney(pool,1);
 assert.equal(before.automatic_enrollment,true);
 assert.equal(before.summary.pool_balance,100000);assert.equal(before.summary.unposted_amount,0);assert.match(before.rows[0].reason,/draw result/);
 await db.exec("UPDATE draw_payments SET receipt_no='DP-NEW' WHERE id=1");
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,1);
 assert.equal((await db.query('SELECT created_by FROM cash_flow_entries')).rows[0].created_by,2);
});
test('automatic enrollment catches up historic cash, bank and cheques once without changing source receipts',async t=>{
 const {db,pool}=await fixture(t,{ready:false,cancelled:true});
 await db.exec(`INSERT INTO bank_accounts VALUES(10,1);
 INSERT INTO draw_payments(draw_registration_id,receipt_no,payment_date,amount,payment_from,bank_account_id,created_by)
 VALUES(1,'DP-BANK','2020-01-02',50000,'UPI',10,2),(1,'DP-CHEQUE','2020-01-03',25000,'CHEQUE',10,2);`);
 const original=(await db.query('SELECT to_jsonb(d) AS receipt FROM draw_payments d ORDER BY id')).rows;
 await db.exec(poolMoneySql);
 await db.exec(`CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();
 CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();`);
 const plan=await poolEnrollmentPlan(pool,admin,1);
 assert.equal(plan.amount,175000);assert.equal(plan.receipt_count,3);
 const result=await enrollExistingPoolReceipts(pool,admin,1,{expectedAmount:plan.amount,expectedCount:plan.receipt_count});
 assert.equal(result.enrolled_count,3);assert.equal(result.summary.unposted_amount,0);
 assert.equal(result.summary.pool_balance,150000);assert.equal(result.summary.pending_cheque_amount,25000);
 assert.deepEqual((await db.query('SELECT to_jsonb(d) AS receipt FROM draw_payments d ORDER BY id')).rows,original);
 const entries=(await db.query('SELECT credit,cash_type,created_by,status,cheque_status FROM cash_flow_entries ORDER BY id')).rows;
 assert.deepEqual(entries.map(row=>Number(row.credit)),[100000,50000,25000]);
 assert.ok(entries.every(row=>row.created_by===2 && row.status==='pending'));
 assert.equal(entries[2].cheque_status,'PENDING');
 const retry=await enrollExistingPoolReceipts(pool,admin,1,{expectedAmount:0,expectedCount:0});
 assert.equal(retry.enrolled_count,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,3);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_events')).rows[0].n,1);
});
test('new bank and cheque receipts enter Accounts automatically and remain duplicate safe',async t=>{
 for(const mode of ['BANK','CHEQUE']) {
  const {db,pool}=await fixture(t,{mode});
  const first=(await listPoolMoney(pool,1)).rows[0];
  assert.equal(first.unposted_amount,0);assert.equal(first.payments[0].recorded,true);
  assert.equal(first.pending_cheque_amount,mode==='CHEQUE'?100000:0);
  assert.equal(first.pool_balance,mode==='CHEQUE'?0:100000);
  await db.exec('UPDATE draw_payments SET id=id WHERE id=1');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,1);
 }
});
test('enrollment rejects a stale plan, disabled capture, foreign projects and locked periods atomically',async t=>{
 const {db,pool}=await fixture(t,{ready:false});await db.exec(poolMoneySql);
 await assert.rejects(poolEnrollmentPlan(pool,admin,1),{statusCode:503});
 await db.exec(`CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON bookings FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();
 CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();`);
 await db.exec('ALTER TABLE draw_payments DISABLE TRIGGER pool_capture');
 assert.equal((await listPoolMoney(pool,1)).automatic_enrollment,false);
 await assert.rejects(poolEnrollmentPlan(pool,admin,1),{statusCode:503});
 await db.exec('ALTER TABLE draw_payments ENABLE TRIGGER pool_capture');
 await assert.rejects(enrollExistingPoolReceipts(pool,admin,1,{expectedAmount:1,expectedCount:1}),{statusCode:409});
 await assert.rejects(enrollExistingPoolReceipts(pool,{...admin,organization_id:2},1,{expectedAmount:100000,expectedCount:1}),{statusCode:403});
 await assert.rejects(enrollExistingPoolReceipts(pool,{...admin,role:'sub_admin'},1,{expectedAmount:100000,expectedCount:1}),{statusCode:403});
 await db.exec('UPDATE cash_flow_months SET is_locked=true');
 await assert.rejects(enrollExistingPoolReceipts(pool,admin,1,{expectedAmount:100000,expectedCount:1}),/locked accounting period/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_events')).rows[0].n,0);
});
test('read-only fallback shows receipts without accounting writes',async t=>{
 const {db,pool}=await fixture(t,{ready:false});const list=await listPoolMoney(pool,1);
 assert.equal(list.available,false);assert.equal(list.rows[0].unposted_amount,100000);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,0);
});
test('allotment preserves one cash-flow identity, amount, date and collector; retries cannot duplicate',async t=>{
 const {db,pool}=await fixture(t);const before=(await db.query('SELECT * FROM cash_flow_entries')).rows[0];
 await db.exec(`CREATE TABLE website_booking_requests(id integer,plot_id integer,status text,hold_expires_at timestamptz);
 INSERT INTO website_booking_requests VALUES(1,1,'PAYMENT_REVIEW',now()+interval '15 minutes');`);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Physical draw sheet 1'});
 const result=await mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000});
 assert.equal(result.row.status,'ALLOTTED');assert.equal(result.row.pool_balance,0);assert.equal(result.row.allocated_amount,100000);
 const cash=(await db.query('SELECT * FROM cash_flow_entries')).rows;
 assert.equal(cash.length,1);assert.equal(cash[0].id,before.id);assert.equal(Number(cash[0].credit),100000);assert.equal(cash[0].created_by,2);
 assert.equal(cash[0].source_module,'plot_payments');assert.deepEqual(cash[0].date,before.date);
 const plot=(await db.query('SELECT * FROM plots WHERE id=1')).rows[0];assert.equal(plot.status,'BOOKED');assert.equal(plot.buyer_member_id,1);
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000}),{statusCode:409});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n,1);
 assert.equal((await db.query('SELECT status FROM website_booking_requests WHERE id=1')).rows[0].status,'PAYMENT_REVIEW');
});
test('existing BK is allotted without creating another booking',async t=>{
 const {db,pool}=await fixture(t,{source:'booking'});const input={kind:'booking',id:1,siteId:1};
 await mutatePoolMoney(pool,admin,input,'result',{result:'WINNER',note:'External result'});
 const result=await mutatePoolMoney(pool,admin,input,'allot',{plot_id:1,expected_amount:100000});
 assert.equal(result.row.booking_no,'BK-0001');assert.equal(result.row.plot_id,1);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,1);
});

test('Pool Money lists only the buyer’s assigned shops and applies a whole receipt once', async t => {
 const { db, pool } = await fixture(t);
 const before = await poolDetail(pool, identity);
 assert.deepEqual(before.assigned_shops, []);
 assert.equal(before.row.can_allocate, false);
 assert.equal(before.payments[0].can_select_for_shop, true);
 await db.exec(`INSERT INTO members VALUES (2,1,'BUYER','ACTIVE',NULL),(3,2,'BUYER','ACTIVE',NULL);
   UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1;
   UPDATE plots SET status='BOOKED',buyer_member_id=3 WHERE id=2;
   INSERT INTO plots(site_id,plot_no,status,buyer_member_id,unit_type,approval_status) VALUES
     (1,'S-SECOND','REGISTRY',1,'shop','approved'),(1,'S-OTHER','BOOKED',2,'shop','approved'),
     (1,'P-ONLY','BOOKED',1,'plot','approved'),(1,'S-PENDING','BOOKED',1,'shop','pending');`);
 const detail = await poolDetail(pool, identity);
 assert.deepEqual(detail.assigned_shops.map(shop => shop.id), [1, 3]);
 assert.equal(detail.row.can_allocate, true);
 assert.equal(detail.payments[0].can_allocate, true);
 const input = { receiptId: detail.payments[0].id, siteId: 1, plotId: 3, expectedAmount: 100000 };
 for (const plotId of [2, 4, 5, 6]) {
   await assert.rejects(allocatePoolReceipt(pool, admin, { ...input, plotId }), /currently assigned/);
 }
 await assert.rejects(allocatePoolReceipt(pool, admin, { ...input, expectedAmount: 99999 }), /amount changed/);
 await assert.rejects(allocatePoolReceipt(pool, { ...admin, organization_id: 2 }, input), { statusCode: 403 });
 const original = (await db.query('SELECT id, credit, created_by FROM cash_flow_entries')).rows[0];
 const posted = await allocatePoolReceipt(pool, admin, input);
 assert.equal(posted.plot_id, 3);
 await assert.rejects(allocatePoolReceipt(pool, admin, { ...input, plotId: 1 }), /already been applied/);
 const after = await poolDetail(pool, identity);
 assert.equal(after.payments[0].can_allocate, false);
 assert.equal(after.payments[0].can_select_for_shop, false);
 assert.equal(after.payments[0].can_return, true);
 assert.equal(after.payments[0].allocated_plot_id, 3);
 assert.equal(after.payments[0].allocated_plot_no, 'S-SECOND');
 assert.equal(after.row.pool_balance, 0);
 assert.equal(after.row.allocated_amount, 100000);
 assert.deepEqual((await db.query(`SELECT pp.plot_id,pp.amount,${poolReturnReceiptSql} AS pool_return_receipt_id
   FROM plot_payments pp`)).rows, [{ plot_id: 3, amount: '100000.00', pool_return_receipt_id: input.receiptId }]);
 assert.deepEqual((await db.query('SELECT id, credit, created_by FROM cash_flow_entries')).rows, [original]);
 assert.equal((await db.query('SELECT status FROM draw_registrations WHERE id=1')).rows[0].status, 'SLIP_ISSUED');
});

test('sub-admin receipt allocation requires write permission, project access, and receipt visibility', async t => {
 const { db, pool } = await fixture(t);
 await db.exec(`UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1;
   INSERT INTO draw_payments(draw_registration_id,receipt_no,payment_date,amount,payment_from,created_by)
   VALUES (1,'DP-OTHER','2020-01-01',100000,'CASH',1);`);
 const { payments } = await poolDetail(pool, identity);
 const ownReceiptId = payments.find(payment => payment.created_by === 2).id;
 const otherReceiptId = payments.find(payment => payment.created_by === 1).id;
 const router = createPoolMoneyRouter({ database: pool, authenticate: (_req, _res, next) => next() });
 const apply = (id, canWrite) => new Promise((resolve, reject) => {
   const user = { id: 2, role: 'sub_admin', organization_id: 1,
     permissionsByModule: new Map([['plot_payments', { can_read: true, can_write: canWrite, can_view_all: false }]]) };
   const req = { method: 'POST', url: `/pool-money/receipts/${id}/allocate`, user,
     body: { site_id: 1, plot_id: 1, expected_amount: 100000 } };
   const res = { statusCode: 200, on() {}, status(code) { this.statusCode = code; return this; },
     json(body) { resolve({ status: this.statusCode, body }); } };
   router.handle(req, res, error => error?.statusCode ? resolve({ status: error.statusCode }) : reject(error || new Error('No route matched')));
 });
 assert.equal((await apply(ownReceiptId, true)).status, 403);
 await db.exec('INSERT INTO user_sites VALUES (2,1)');
 assert.equal((await apply(ownReceiptId, false)).status, 403);
 assert.equal((await apply(otherReceiptId, true)).status, 404);
 const applied = await apply(ownReceiptId, true);
 assert.equal(applied.status, 201);
 assert.equal(applied.body.receipt_id, ownReceiptId);
 assert.deepEqual((await db.query('SELECT created_by FROM plot_payments')).rows, [{ created_by: 2 }]);
});

test('deleting a Pool Money shop payment restores the same original receipt and accounting approval', async t => {
 const { db, pool } = await fixture(t, { source: 'booking' });
 await db.exec(`UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1;
   INSERT INTO plots(site_id,plot_no,status,buyer_member_id) VALUES (1,'S-ANOTHER','BOOKED',1);
   CREATE TABLE reverted_projections(source text);
   CREATE FUNCTION capture_projection_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
     IF current_setting('app.recycle_bin_skip',true) IS DISTINCT FROM 'on' THEN
       INSERT INTO reverted_projections VALUES (TG_TABLE_NAME);
     END IF;
     RETURN OLD;
   END $$;
   CREATE TRIGGER test_cfe_archive AFTER DELETE ON cash_flow_entries FOR EACH ROW EXECUTE FUNCTION capture_projection_delete();
   CREATE TRIGGER test_plot_archive AFTER DELETE ON plot_payments FOR EACH ROW EXECUTE FUNCTION capture_projection_delete();
   CREATE TABLE day_book(id integer,plot_payment_id integer);
   CREATE TABLE plot_registry_payments(id integer,source_plot_payment_id integer);`);
 const input = { receiptId: 1, siteId: 1, plotId: 1, expectedAmount: 100000 };
 const originalLedger = (await db.query('SELECT id, credit, date, created_by FROM cash_flow_entries')).rows[0];
 const posted = await allocatePoolReceipt(pool, admin, input);
 const deleteInput = { receiptId: input.receiptId, siteId: input.siteId, plotPaymentId: posted.plot_payment_id };
 await db.query(`UPDATE cash_flow_entries SET status='approved',approved_by=1,approved_at='2020-01-02' WHERE id=$1`, [originalLedger.id]);
 await db.query('INSERT INTO day_book VALUES (10,$1)', [posted.plot_payment_id]);
 await db.query('INSERT INTO plot_registry_payments VALUES (10,$1)', [posted.plot_payment_id]);
 await db.exec('UPDATE cash_flow_months SET is_locked=true');
 await assert.rejects(returnPoolReceipt(pool, admin, deleteInput), /locked or missing accounting period/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM plot_payments')).rows[0].n, 1);
 await db.exec('UPDATE cash_flow_months SET is_locked=false');

 t.mock.method(accountsDatabase, 'query', pool.query);
 t.mock.method(accountsDatabase, 'connect', pool.connect);
 forgetRelationProbes();
 t.after(forgetRelationProbes);
 for (const controller of [deleteEntry, deleteCashFlowEntryFromDayBook]) {
   const response = await callController(controller, originalLedger.id);
   assert.equal(response.status, 409);
   assert.match(response.body.message, /Return this receipt to Pool Money/);
 }
 const { status: deleteStatus, body: restored } = await callController(deletePayment, posted.plot_payment_id);
 assert.equal(deleteStatus, 200);
 assert.equal(restored.pool_restored, true);
 assert.equal(restored.receipt_id, input.receiptId);
 const { status, approved_by: approvedBy, source_module: sourceModule, source_id: sourceId, ...ledger } = (await db.query(
   'SELECT id, credit, date, created_by, status, approved_by, source_module, source_id FROM cash_flow_entries')).rows[0];
 assert.deepEqual(ledger, originalLedger);
 assert.deepEqual([status, approvedBy, sourceModule, sourceId], ['approved', 1, 'pool_money_receipts', input.receiptId]);
 assert.deepEqual((await db.query('SELECT token_payment_id FROM bookings WHERE id=1')).rows, [{ token_payment_id: null }]);
 for (const table of ['plot_payments', 'day_book', 'plot_registry_payments', 'reverted_projections']) {
   assert.equal((await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
 }
 const detail = await poolDetail(pool, { ...identity, kind: 'booking' });
 assert.equal(detail.payments[0].id, input.receiptId);
 assert.equal(detail.payments[0].can_allocate, true);
 assert.equal(detail.payments[0].can_return, false);
 assert.equal(detail.row.pool_balance, 100000);
 assert.deepEqual(detail.events.map(event => event.event_type), ['RECEIPT_RETURNED', 'RECEIPT_ALLOCATED']);
 assert.equal((await db.query('SELECT status FROM plots WHERE id=1')).rows[0].status, 'BOOKED');

 const newPayment = await allocatePoolReceipt(pool, admin, { ...input, plotId: 3 });
 assert.notEqual(newPayment.plot_payment_id, posted.plot_payment_id);
 await assert.rejects(returnPoolReceipt(pool, admin, deleteInput), /no longer applied/);
 assert.equal((await db.query('SELECT plot_payment_id FROM pool_money_receipts WHERE id=1')).rows[0].plot_payment_id, newPayment.plot_payment_id);
 assert.equal((await returnPoolReceipt(pool, admin, { ...deleteInput, plotPaymentId: newPayment.plot_payment_id })).pool_restored, true);
});

test('result, KYC, unit site and stale amount are checked before allocation',async t=>{
 const {db,pool}=await fixture(t);
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000}),/draw result/);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'External result'});
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:999}),/money changed/);
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:2,expected_amount:100000}),/no longer available/);
 await db.exec("UPDATE kyc_cases SET status='OPEN'");
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000}),/KYC/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
});
test('future draws and non-admin users cannot record winners',async t=>{
 const {pool}=await fixture(t,{date:'2099-01-01'});
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Physical result'}),/not opened/);
 await assert.rejects(mutatePoolMoney(pool,{id:2,role:'sub_admin'},identity,'result',{result:'WINNER',note:'Physical result'}),{statusCode:403});
});
test('pending cheque remains visible but cannot fund allotment',async t=>{
 const {pool}=await fixture(t,{mode:'CHEQUE'});const list=await listPoolMoney(pool,1);
 assert.equal(list.rows[0].pending_cheque_amount,100000);assert.equal(list.rows[0].total_received,0);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Physical result'});
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:0}),/cheques/);
});
test('cancelled collections survive; deleting/changing recorded receipts is blocked',async t=>{
 const {db,pool}=await fixture(t,{cancelled:true});assert.equal((await listPoolMoney(pool,1)).rows[0].pool_balance,100000);
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Physical result'}),/cancelled/);
 await assert.rejects(db.exec('DELETE FROM draw_payments WHERE id=1'),/cannot be deleted/);
 await assert.rejects(db.exec('UPDATE draw_payments SET amount=200000 WHERE id=1'),/already been recorded/);
 assert.equal(Number((await db.query('SELECT credit FROM cash_flow_entries')).rows[0].credit),100000);
});

test('draw receipt corrections update pending Accounting records and reconcile collector cash', async t => {
 const {db}=await fixture(t,{ready:false});
 const query=async (sql,args)=>args?.length ? db.query(sql,args) : (await db.exec(sql)).at(-1);
 const pool={query,connect:async()=>({query,release(){}})};
 await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
   CREATE TABLE day_book(id integer PRIMARY KEY,cash_flow_entry_id integer);
   CREATE TABLE firm_transactions(id integer PRIMARY KEY,cash_flow_entry_id integer);
   ${postingPolicySql}`);
 await walletUp(pool);
 await vaultUp(pool);
 await unifiedUp(pool);
 await siteUp(pool);
 await collectorUp(pool);
 await migratePoolMoney(pool);
 await db.exec("UPDATE loyalty_vault_settings SET consolidated_at='2019-01-01'");
 await db.exec("UPDATE draw_registrations SET status='REGISTERED' WHERE id=1");
 await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:100000});
 await db.exec(`INSERT INTO draw_payments(draw_registration_id,receipt_no,payment_date,amount,payment_from,created_by)
   VALUES(1,'DP-02','2020-01-02',20000,'CASH',2)`);
 const balance=async () => Number((await db.query(
   "SELECT balance FROM loyalty_vault_accounts WHERE holder_key='user:2'"
 )).rows[0].balance);
 const remaining=async () => (await db.query(`SELECT
   ARRAY(SELECT id FROM draw_payments ORDER BY id) AS payments,
   ARRAY(SELECT source_id FROM pool_money_receipts ORDER BY id) AS receipts,
   ARRAY(SELECT source_id FROM cash_flow_entries WHERE source_module='pool_money_receipts' ORDER BY id) AS ledger`
 )).rows[0];
 const remove=async (drawId,paymentId) => (await db.query(
   'SELECT delete_draw_payment_with_accounting($1,$2,$3) AS deleted',[drawId,paymentId,admin.id]
 )).rows[0].deleted;
 const edit=async (drawId,paymentId,patch) => (await db.query(
   'SELECT update_draw_payment_with_accounting($1,$2,$3,$4::jsonb) AS updated',[drawId,paymentId,admin.id,JSON.stringify(patch)]
 )).rows[0].updated;
 assert.equal(await balance(),120000);
 assert.equal(await remove(2,1),false);
 assert.equal(await edit(2,1,{amount:90000}),false);
 await assert.rejects(db.exec('DELETE FROM cash_flow_entries WHERE source_id=1'),/pool collection cannot be deleted/);
 await db.exec('UPDATE cash_flow_months SET is_locked=true');
 await assert.rejects(remove(1,1),/locked or missing accounting period/);
 await assert.rejects(edit(1,1,{amount:90000}),/locked or missing accounting period/);
 await db.exec('UPDATE cash_flow_months SET is_locked=false');
 await db.exec("UPDATE pool_money_receipts SET status='approved',approved_by=1,approved_at=now() WHERE id=1");
 await assert.rejects(remove(1,1),/already been processed/);
 await assert.rejects(edit(1,1,{amount:90000}),/already been processed/);
 assert.deepEqual(await remaining(),{payments:[1,2],receipts:[1,2],ledger:[1,2]});
 assert.equal(await balance(),120000);
 await db.exec("UPDATE pool_money_receipts SET status='pending',approved_by=NULL,approved_at=NULL WHERE id=1");
 await db.exec('INSERT INTO day_book VALUES(1,1)');
 await assert.rejects(edit(1,1,{amount:90000}),/backs a posted entry/);
 await db.exec('DELETE FROM day_book WHERE id=1');
 assert.equal(await edit(1,1,{amount:90000,narration:'Corrected amount'}),true);
 assert.deepEqual(await remaining(),{payments:[1,2],receipts:[1,2],ledger:[1,2]});
 const { rows: [corrected] } = await db.query(`SELECT p.receipt_no,p.created_by,p.narration,
   p.amount::int AS payment_amount,r.amount::int AS pool_amount,c.credit::int AS ledger_amount
   FROM draw_payments p JOIN pool_money_receipts r ON r.source_kind='draw' AND r.source_id=p.id
   JOIN cash_flow_entries c ON c.source_module='pool_money_receipts' AND c.source_id=r.id WHERE p.id=1 AND r.id=1 AND c.id=1`);
 assert.deepEqual(corrected,{receipt_no:'DP-01',created_by:2,narration:'Corrected amount',payment_amount:90000,pool_amount:90000,ledger_amount:90000});
 assert.equal(await balance(),110000);
 assert.equal(await remove(1,1),true);
 assert.deepEqual(await remaining(),{payments:[2],receipts:[2],ledger:[2]});
 assert.equal(await balance(),20000);
 assert.equal(await remove(1,1),false);
 const audit=await db.query("SELECT actor_user_id,detail FROM pool_money_events WHERE event_type='RECEIPT_DELETED'");
 assert.equal(audit.rows.length,1);
 assert.equal(audit.rows[0].actor_user_id,admin.id);
 assert.equal(audit.rows[0].detail.reference,'DP-01');
 const edits=await db.query("SELECT actor_user_id,detail FROM pool_money_events WHERE event_type='RECEIPT_UPDATED'");
 assert.equal(edits.rows.length,1);
 assert.equal(edits.rows[0].actor_user_id,admin.id);
 assert.equal(edits.rows[0].detail.amount_before,100000);
 assert.equal(edits.rows[0].detail.amount_after,90000);
});

test('explicit recording imports cancelled historical collections once after stale check',async t=>{
 const {db,pool}=await fixture(t,{ready:false,cancelled:true});
 await db.exec(poolMoneySql);await db.exec('CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source()');
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'record',{expected_amount:999}),/money changed/);
 const recorded=await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:100000});assert.equal(recorded.row.unposted_amount,0);
 await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:0});
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,1);
});

test('historical receipt edits preserve unrecorded status and recorded edits move the bank projection in place',async t=>{
 const {db,pool}=await fixture(t,{ready:false});
 await db.exec(`${poolMoneySql}
   CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();
   CREATE TABLE day_book(id integer PRIMARY KEY,cash_flow_entry_id integer);
   CREATE TABLE firm_transactions(id integer PRIMARY KEY,cash_flow_entry_id integer);
   INSERT INTO bank_accounts VALUES(5,1);`);
 const edit=async patch=>(await db.query('SELECT update_draw_payment_with_accounting(1,1,1,$1::jsonb) AS updated',[JSON.stringify(patch)])).rows[0].updated;
 assert.equal(await edit({amount:105000}),true);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_receipts')).rows[0].n,0);
 await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:105000});
 const { rows:[initial] }=await db.query("SELECT id,source_id FROM cash_flow_entries WHERE source_module='pool_money_receipts'");
 assert.equal(await edit({payment_from:'UPI',bank_details:'test-utr',bank_account_id:5,cheque_no:null}),true);
 const { rows:[corrected] }=await db.query("SELECT id,source_id,cash_type,bank_account_id FROM cash_flow_entries WHERE source_module='pool_money_receipts'");
 assert.deepEqual(corrected,{...initial,cash_type:'bank',bank_account_id:5});
});

test('organization scope applies to admins and sub-admins',async t=>{
 const {db,pool}=await fixture(t);await db.exec('INSERT INTO sites VALUES(3,2)');
 await assert.rejects(assertPoolSiteAccess(pool,admin,3),{statusCode:403});
 await assert.rejects(mutatePoolMoney(pool,{...admin,organization_id:2},identity,'record',{expected_amount:0}),{statusCode:403});
 await assert.rejects(assertPoolSiteAccess(pool,{id:2,role:'sub_admin',organization_id:1},1),{statusCode:403});
 await db.exec('INSERT INTO user_sites VALUES(2,1)');
 await assertPoolSiteAccess(pool,{id:2,role:'sub_admin',organization_id:1},1);
});

test('schema installation is idempotent and never posts historical collections',async t=>{
 const {db}=await fixture(t,{ready:false});
 await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
 CREATE TABLE loyalty_vault_sources(cash_flow_entry_id integer PRIMARY KEY,holder_key text,posted_amount numeric,organization_id integer,source_table text,source_id integer,site_id integer,updated_at timestamptz);`);
 const query=async(sql,args)=>args?.length?db.query(sql,args):(await db.exec(sql)).at(-1);
 const pool={query,connect:async()=>({query,release(){}})};
 const before=(await db.query('SELECT to_jsonb(d) AS row FROM draw_payments d')).rows;
 await migratePoolMoney(pool);await migratePoolMoney(pool);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM pool_money_receipts')).rows[0].n,0);
 assert.deepEqual((await db.query('SELECT to_jsonb(d) AS row FROM draw_payments d')).rows,before);
 const fn=(await db.query("SELECT pg_get_functiondef('reconcile_loyalty_vault_entry(integer)'::regprocedure) AS definition")).rows[0].definition;
 assert.match(fn,/pool_money_receipts/);assert.match(fn,/v_old.site_id IS DISTINCT FROM v_site/);
});

test('source corrections and ledger mirrors cannot change already collected or allotted money',async t=>{
 const {db,pool}=await fixture(t);
 await assert.rejects(db.exec('UPDATE cash_flow_entries SET credit=999 WHERE id=1'),/cannot be edited/);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Official sheet'});
 await mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000});
 await assert.rejects(db.exec('UPDATE plot_payments SET amount=999 WHERE id=1'),/cannot change/);
 await assert.rejects(db.exec('UPDATE draw_payments SET amount=999 WHERE id=1'),/already been recorded/);
 await assert.rejects(db.exec('DELETE FROM plot_payments WHERE id=1'),/cannot be deleted/);
});

test('recording and allotment cannot write into a locked accounting period',async t=>{
 const {db,pool}=await fixture(t);await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Result sheet'});
 await db.exec('UPDATE cash_flow_months SET is_locked=true');
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000}),/locked accounting period/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,1);
});

test('actual deferred Cash Wallet reconciliation keeps collector cash unchanged through allotment',async t=>{
 for(const mode of ['CASH','BANK']) {
  const {db}=await fixture(t,{ready:false,mode});
  const query=async(sql,args)=>{const r=args?.length?await db.query(sql,args):(await db.exec(sql)).at(-1);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};};
  const pool={query,connect:async()=>({query,release(){}})};
  await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);${postingPolicySql}`);
  await walletUp(pool);await vaultUp(pool);await unifiedUp(pool);await siteUp(pool);await collectorUp(pool);
  await migratePoolMoney(pool);
  await db.exec("UPDATE loyalty_vault_settings SET consolidated_at='2019-01-01'");
  await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:100000});
  const balance=async()=>Number((await db.query("SELECT COALESCE(sum(amount),0) AS amount FROM loyalty_vault_entries WHERE holder_key='user:2' AND site_id=1")).rows[0].amount);
  const before=await balance();assert.equal(before,mode==='CASH'?100000:0);
  await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Official result'});
  await mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000});
  assert.equal(await balance(),before);
  assert.equal(Number((await db.query("SELECT COALESCE(sum(amount),0) AS amount FROM loyalty_vault_entries WHERE holder_key='user:1'")).rows[0].amount),0,'allotting admin never acquires collected cash');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,1);
  if(mode==='CASH') assert.equal((await db.query('SELECT count(*)::int AS n FROM loyalty_vault_entries')).rows[0].n,1,'allotment must not create a second wallet receipt or reversal');
 }
});

test('actual deferred Cash Wallet reconciliation preserves the collector posting through allocation and return',async t=>{
 const {db}=await fixture(t,{ready:false});
 const query=async(sql,args)=>{const r=args?.length?await db.query(sql,args):(await db.exec(sql)).at(-1);return {...r,rows:r?.rows||[],rowCount:r?.affectedRows??r?.rows?.length??0};};
 const pool={query,connect:async()=>({query,release(){}})};
 await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);${postingPolicySql}`);
 await walletUp(pool);await vaultUp(pool);await unifiedUp(pool);await siteUp(pool);await collectorUp(pool);
 await migratePoolMoney(pool);
 await db.exec(`UPDATE loyalty_vault_settings SET consolidated_at='2019-01-01';
   UPDATE plots SET status='BOOKED',buyer_member_id=1 WHERE id=1;`);
 const recorded=await mutatePoolMoney(pool,admin,identity,'record',{expected_amount:100000});
 const receiptId=recorded.payments[0].id;
 const readPosting=async()=>(await db.query("SELECT id,holder_key,amount,site_id FROM loyalty_vault_entries")).rows;
 const originalPosting=await readPosting();
 assert.deepEqual(originalPosting.map(({holder_key,amount,site_id})=>[holder_key,Number(amount),site_id]),[['user:2',100000,1]]);
 const originalLedger=(await db.query('SELECT id FROM cash_flow_entries')).rows;
 const {plot_payment_id:plotPaymentId}=await allocatePoolReceipt(pool,admin,{receiptId,siteId:1,plotId:1,expectedAmount:100000});
 assert.deepEqual(await readPosting(),originalPosting);
 assert.deepEqual((await db.query('SELECT id FROM cash_flow_entries')).rows,originalLedger);
 await returnPoolReceipt(pool,admin,{receiptId,siteId:1,plotPaymentId});
 assert.deepEqual(await readPosting(),originalPosting);
 assert.deepEqual((await db.query('SELECT id FROM cash_flow_entries')).rows,originalLedger);
 assert.deepEqual((await db.query('SELECT plot_payment_id FROM draw_payments WHERE id=1')).rows,[{plot_payment_id:null}]);
});

test('native plot approval queue stays intact and reserves the unit while review is pending',async t=>{
 const {db,pool}=await fixture(t);await db.exec('CREATE TABLE app_schema_migrations(version text PRIMARY KEY);ALTER TABLE plots ADD COLUMN created_by integer;');
 await db.exec(plotReviewSql);
 await db.exec(`CREATE TABLE application_settings(site_id integer,setting_key text,setting_value jsonb);${plotReviewSettingSql};${plotSnapshotFunctionSql};
 CREATE TRIGGER trg_approval_change_snapshot BEFORE UPDATE ON plots FOR EACH ROW EXECUTE FUNCTION capture_plot_approval_change();`);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Official result'});
 const result=await mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000});
 assert.equal(result.row.plot_approval_status,'pending');
 const plot=(await db.query('SELECT * FROM plots WHERE id=1')).rows[0];
 assert.equal(plot.approval_original_data.status,'COMPANY');assert.equal(plot.approval_proposed_data.status,'BOOKED');
 assert.equal(plot.approval_requested_by,admin.id);assert.equal(plot.approved_by,null);
 await db.exec("UPDATE plot_status_approvals SET status='rejected' WHERE id=1");
 assert.equal((await db.query('SELECT status FROM plots WHERE id=1')).rows[0].status,'BOOKED','review flag does not release money or reserve the unit for another buyer');
});

test('Pool Money allots an approved Naya Baazar shop without raising another review', async t => {
 const {db,pool}=await fixture(t,{projectId:7});
 await db.exec(`CREATE TABLE app_schema_migrations(version text PRIMARY KEY);
   ALTER TABLE plots ADD COLUMN created_by integer;
   ALTER TABLE draw_registrations ADD COLUMN broker_member_id integer, ADD COLUMN agent_user_id integer;
   ALTER TABLE bookings ADD COLUMN booking_agent_id integer;
   INSERT INTO members VALUES(202,7,'Draw Broker','ACTIVE',NULL);
   UPDATE draw_registrations SET broker_member_id=202,agent_user_id=2 WHERE id=1;
   ${plotReviewSql};${directPlotBookingSql}`);
 const nayaDraw = { ...identity, siteId: 7 };
 await mutatePoolMoney(pool,admin,nayaDraw,'result',{result:'WINNER',note:'Official result'});
 const result=await mutatePoolMoney(pool,admin,nayaDraw,'allot',{plot_id:1,expected_amount:100000});
 assert.equal(result.row.status,'ALLOTTED');
 assert.equal(result.row.plot_approval_status,'approved');
 assert.equal(result.row.allocated_amount,100000);
 assert.deepEqual((await db.query('SELECT booking_by FROM plots WHERE id=1')).rows,[{booking_by:'DRAW BROKER'}]);
 assert.deepEqual((await db.query('SELECT booking_agent_id,booked_by,created_by FROM bookings')).rows,[{booking_agent_id:202,booked_by:'DRAW BROKER',created_by:admin.id}]);
 assert.deepEqual((await db.query('SELECT booked_by FROM plot_payments WHERE plot_id=1')).rows,[{booked_by:'DRAW BROKER'}]);
});

test('a changed result in Booking Software overrides a stale Pool Money winner',async t=>{
 const {db,pool}=await fixture(t);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Physical result'});
 await db.exec("UPDATE draw_registrations SET is_winner=false,status='SLIP_ISSUED' WHERE id=1");
 const list=await listPoolMoney(pool,1);assert.equal(list.rows[0].can_allot,false);assert.equal(list.rows[0].draw_result,'PENDING');
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'allot',{plot_id:1,expected_amount:100000}),/winner status has changed/);
});
test('explicit recording rejects a locked source period without posting money',async t=>{
 const {db,pool}=await fixture(t,{ready:false});await db.exec(poolMoneySql);
 await db.exec('CREATE TRIGGER pool_capture AFTER INSERT OR UPDATE OR DELETE ON draw_payments FOR EACH ROW EXECUTE FUNCTION capture_pool_money_source();UPDATE cash_flow_months SET is_locked=true');
 await assert.rejects(mutatePoolMoney(pool,admin,identity,'record',{expected_amount:100000}),/locked accounting period/);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flow_entries')).rows[0].n,0);
});

test('read-own collections expose only the receipt creator’s money and reject another owner’s detail',async t=>{
 const {db,pool}=await fixture(t);
 await db.exec("INSERT INTO draw_payments(draw_registration_id,receipt_no,payment_date,amount,payment_from,created_by) VALUES(1,'DP-OTHER','2020-01-01',50000,'CASH',1)");
 const user={id:2,role:'sub_admin',organization_id:1,permissionsByModule:new Map([['plot_payments',{can_read:true,can_view_all:false}]])};
 const scope=await resolveEntryVisibility(user,'plot_payments','1');
 assert.equal(scope.creatorId,2,'caller cannot request someone else’s receipts');
 const own=await listPoolMoney(pool,1,scope);assert.equal(own.rows.length,1);assert.equal(own.summary.total_collections,100000);assert.equal(own.rows[0].payment_count,1);
 assert.equal(own.rows[0].payments[0].created_by,2);
 await mutatePoolMoney(pool,admin,identity,'result',{result:'WINNER',note:'Internal result reference'});
 const detail=await poolDetail(pool,identity,scope);assert.equal(detail.payments.length,1);assert.equal(detail.row.result_note,null);assert.deepEqual(detail.events,[]);
 await assert.rejects(poolDetail(pool,identity,{canViewAll:false,creatorId:99}),{statusCode:404});
 const all=await listPoolMoney(pool,1,await resolveEntryVisibility(admin,'plot_payments'));assert.equal(all.summary.total_collections,150000);assert.equal(all.rows[0].payment_count,2);
});
