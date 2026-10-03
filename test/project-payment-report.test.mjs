import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pool from '../src/config/db.js';
import { projectPaymentReport } from '../src/controllers/projectPaymentReport.controller.js';
import requirePermission from '../src/middlewares/permission.middleware.js';
import requirePlotSiteAccess from '../src/middlewares/plotSiteAccess.middleware.js';
import { getPlotsWithTotals } from '../src/graphql/services/plotPayments.service.js';

const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
  handler(req, res, err => err ? reject(err) : resolve({ status: 200, next: true }));
});
const user = (canViewAll = false) => ({ id: 7, role: 'sub_admin', permissionsByModule: new Map([['plot_payments', { can_read: true, can_view_all: canViewAll }]]) });

test('report forces self-only receipt scope even when a restricted user requests other creators', async t => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: sql.includes('FROM plots p') ? [{ id: 1, total_received: '10' }] : [] }; });
  const result = await invoke(projectPaymentReport, { user: user(), query: { site_id: '1', created_by: '8,9' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.plots[0].total_received, '10');
  assert.equal(result.body.receipt_scope, 'creator');
  assert.deepEqual(calls.find(call => call.sql.includes('FROM plots p')).params, [1, 7]);
  assert.deepEqual(calls.find(call => call.sql.includes('full_name AS name')).params, [1]);
});

test('permitted multi-creator and all-entry scopes are passed consistently to the shared projection', async t => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => { if (sql.includes('FROM plots p')) calls.push(params); return { rows: [] }; });
  const multi = await invoke(projectPaymentReport, { user: user(true), query: { site_id: '1', created_by: '8,9,8' } });
  const all = await invoke(projectPaymentReport, { user: user(true), query: { site_id: '1' } });
  assert.deepEqual(calls, [[1, '8,9'], [1, null]]);
  assert.equal(multi.body.receipt_scope, 'creator');
  assert.equal(all.body.receipt_scope, 'all');
});

test('invalid site/creator inputs do not reach database queries', async t => {
  t.mock.method(pool, 'query', () => { throw new Error('must not query'); });
  for (const site_id of [undefined, '1foo', '0', '-1', '2.5', '2147483648', '0x10', '1e2', ' 1 ', ['1']]) {
    assert.equal((await invoke(projectPaymentReport, { user: { role: 'admin' }, query: { site_id } })).status, 400);
  }
  assert.equal((await invoke(projectPaymentReport, { user: user(true), query: { site_id: '1', created_by: '8,bad' } })).status, 400);
});

test('report access fails closed without read permission or site assignment', async t => {
  const denied = user(); denied.permissionsByModule.set('plot_payments', { can_read: false });
  assert.equal((await invoke(requirePermission('plot_payments', 'read'), { user: denied })).status, 403);
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  const access = requirePlotSiteAccess({ entity: 'site', source: 'query', key: 'site_id' });
  assert.equal((await invoke(access, { user: user(), query: { site_id: '2' } })).status, 403);
  const routes = readFileSync(new URL('../src/routes/plot.routes.js', import.meta.url), 'utf8');
  assert.match(routes, /router\.get\('\/reports', requireRole\('admin', 'sub_admin'\), requirePermission\('plot_payments', 'read'\), accessByQuerySite, projectPaymentReport\)/);
});

test('real report SQL includes plot and installment receipts, excludes uncleared/rejected cheques, preserves refunds and creator/site boundaries', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  t.after(() => db.close());
  const postingSource = readFileSync(new URL('../src/migrations/171_cheque_clearance_before_approval.js', import.meta.url), 'utf8');
  const posting = postingSource.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0];
  await db.exec(posting);
  await db.exec(`
    CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE SQL AS $$ SELECT CASE WHEN upper(COALESCE($1,'CASH'))='CASH' THEN 'cash' ELSE 'bank' END $$;
    CREATE TABLE plots(id int, site_id int, plot_no text, plot_tag text, buyer_name text, buyer_member_id int, booking_date date);
    CREATE TABLE members(id int, site_id int, full_name text, team text, phone text, email text, address text, city text, aadhar_no text, pan_no text, voter_id text, passport_no text, driving_license_no text, aadhar_front_url text, aadhar_back_url text, pan_card_url text, voter_id_url text, passport_url text, driving_license_url text, cheque_url text, other_kyc_url text);
    CREATE TABLE bookings(id int, plot_id int, site_id int, client_member_id int, status text);
    CREATE TABLE kyc_cases(id int, client_member_id int, site_id int, status text, updated_at timestamptz);
    CREATE TABLE plot_payments(id int, plot_id int, created_by int, amount numeric, status text, payment_type text, cheque_status text, buyer_name text, booked_by text);
    CREATE TABLE plot_installment_payments(id int, plot_id int, created_by int, amount numeric, status text, payment_mode text, cheque_status text);
    CREATE TABLE plot_registries(id int, site_id int, plot_id int, plot_no text);
    CREATE TABLE plot_registry_payments(id int, registry_id int, created_by int, amount numeric, source_plot_payment_id int, payment_mode text, status text, cheque_status text);
    INSERT INTO plots VALUES (1,1,'A1','NEW','Buyer',NULL,'2026-10-01'), (2,2,'A1','NEW','Foreign buyer',NULL,'2026-10-01');
    INSERT INTO plot_payments VALUES
      (1,1,7,100,'pending','CASH',NULL,NULL,NULL),
      (2,1,8,200,'approved','BANK',NULL,NULL,NULL),
      (3,1,7,300,'approved','CHEQUE','PENDING',NULL,NULL),
      (4,1,7,400,'approved','CHEQUE','CLEARED',NULL,NULL),
      (5,1,7,-20,'approved','CASH',NULL,NULL,NULL),
      (6,1,7,600,'rejected','BANK',NULL,NULL,NULL),
      (7,2,7,700,'approved','BANK',NULL,NULL,NULL);
    INSERT INTO plot_installment_payments VALUES
      (1,1,7,50,'pending','CASH',NULL), (2,1,8,60,'approved','UPI',NULL),
      (3,1,7,90,'approved','CHEQUE','BOUNCED');
    INSERT INTO plot_registries VALUES(1,1,1,'A1');
    INSERT INTO plot_registry_payments VALUES
      (1,1,7,400,4,'CHEQUE','approved','CLEARED'), (2,1,8,25,NULL,'BANK','approved',NULL);
  `);
  t.mock.method(pool, 'query', (sql, params) => db.query(sql, params));
  const all = await getPlotsWithTotals(1);
  assert.equal(all.length, 1);
  assert.equal(Number(all[0].total_received), 790);
  assert.equal(Number(all[0].received_bank), 660);
  assert.equal(Number(all[0].received_cash), 130);
  assert.equal(Number(all[0].registry_bank_received), 425);
  assert.equal(all[0].booking_date, '2026-10-01');
  const self = await getPlotsWithTotals(1, 7);
  assert.equal(Number(self[0].total_received), 530);
  assert.equal(Number(self[0].received_cash), 130);
  assert.equal(Number(self[0].registry_bank_received), 400);
  assert.equal(Number((await getPlotsWithTotals(1, '7,8'))[0].total_received), 790);
  assert.equal(Number((await getPlotsWithTotals(1, 9))[0].total_received), 0);
});
