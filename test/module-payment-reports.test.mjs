import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pool from '../src/config/db.js';
import { MODULE_REPORTS, loadModuleReport } from '../src/services/modulePaymentReports.service.js';
import { moduleReportAccess, readModuleReport } from '../src/routes/modulePaymentReports.routes.js';
import requireSiteAccess from '../src/middlewares/plotSiteAccess.middleware.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { plotRegistryModel } from '../src/models/PlotRegistry.model.js';
import { cashFlowMonthModel } from '../src/models/CashFlow.model.js';

const invoke = (handler, req) => new Promise((resolve, reject) => {
  const res = { code: 200, status(code) { this.code = code; return this; }, json(body) { resolve({ status: this.code, body }); } };
  handler(req, res, err => err ? reject(err) : resolve({ status: 200, next: true }));
});
const user = (module, all = false) => ({ id: 7, role: 'sub_admin', permissionsByModule: new Map([[module, { can_read: true, can_view_all: all }]]) });
test('each report requires its own module read permission; unknown reports and invalid sites fail closed', async () => {
  for (const [key, module] of Object.entries(MODULE_REPORTS)) {
    const req = { user: user(module), params: { report: key }, query: { site_id: '1' } };
    assert.equal((await invoke(moduleReportAccess, req)).next, true, key);
    req.user.permissionsByModule.set(module, { can_read: false });
    assert.equal((await invoke(moduleReportAccess, req)).status, 403, key);
  }
  const req = { user: { role: 'admin' }, params: { report: 'expenses' }, query: {} };
  for (const site_id of [undefined, '0', '0x10', '1e2', '1.5', '-1', '2147483648', ['1'], '1junk']) {
    req.query.site_id = site_id; assert.equal((await invoke(moduleReportAccess, req)).status, 400);
  }
  req.params.report = '__proto__'; assert.equal((await invoke(moduleReportAccess, req)).status, 404);
});
test('report routes enforce site assignment before reads', async t => {
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  const req = { user: user('expenses'), query: { site_id: '2' } };
  assert.equal((await invoke(requireSiteAccess({ entity: 'site', source: 'query', key: 'site_id' }), req)).status, 403);
  const code = readFileSync(new URL('../src/routes/modulePaymentReports.routes.js', import.meta.url), 'utf8');
  assert.match(code, /router\.use\(auth, requireRole\('admin', 'sub_admin'\)\)/);
  assert.match(code, /router\.get\('\/:report', moduleReportAccess, requireSiteAccess\([\s\S]*readModuleReport\)/);
});
test('self-only users cannot override creators; multi-user scope and invalid filters are handled server-side', async t => {
  const calls = [];
  t.mock.method(pool, 'query', async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 1, amount: 10 }] }; });
  const request = (who, created_by) => ({ user: who, params: { report: 'vendor_payments' }, query: { site_id: '1', created_by } });
  const own = await invoke(readModuleReport, request(user('vendors'), '8,9'));
  assert.deepEqual(calls[0].params, [1, 7]); assert.equal(own.body.receipt_scope, 'creator');
  await invoke(readModuleReport, request(user('vendors', true), '8,9,8'));
  assert.deepEqual(calls[1].params, [1, '8,9']);
  const all = await invoke(readModuleReport, request(user('vendors', true)));
  assert.deepEqual(calls[2].params, [1, null]); assert.equal(all.body.receipt_scope, 'all');
  assert.equal((await invoke(readModuleReport, request(user('vendors', true), '8,bad'))).status, 400);
  assert.equal(calls.length, 3);
});
test('full expense report reuses the unified projection without page limits and preserves split farmer legs', async t => {
  const rows = Array.from({ length: 65 }, (_, i) => ({ id: `fp_${i}`, original_id: i, source: 'farmer_payment', payment_mode: 'SPLIT' }));
  t.mock.method(expenseModel, 'findPaginatedUnified', async (...args) => { assert.deepEqual(args.slice(0, 4), [1, { created_by: '7,8' }, 1, 0]); return { items: rows }; });
  const db = { query: async (sql, params) => { assert.deepEqual(params, [1, '7,8', rows.map(r => r.original_id)]); return { rows: rows.map(r => ({ id: r.original_id, cash_amount: 30, bank_amount: 70 })) }; } };
  const result = await loadModuleReport('expenses', 1, '7,8', db);
  assert.equal(result.length, 65); assert.equal(result[0].id, 'fp_0'); assert.equal(result[0].cash_amount, 30); assert.equal(result[0].bank_amount, 70);
});
test('registry and personal ledgers use native scoped projections, with personal ledger types only', async t => {
  const db = {};
  t.mock.method(plotRegistryModel, 'findBySiteId', async (...args) => { assert.deepEqual(args, [1, db, '7,8']); return [{ id: 1 }]; });
  t.mock.method(cashFlowMonthModel, 'findBySiteId', async (...args) => { assert.deepEqual(args, [1, db, '7,8', true]); return [{ id: 2 }]; });
  assert.equal((await loadModuleReport('registry', 1, '7,8', db))[0].id, 1);
  assert.equal((await loadModuleReport('personal_ledgers', 1, '7,8', db))[0].id, 2);
});
test('transaction reports bind creator/site scope and daybook uses the canonical posted ledger view', async () => {
  for (const key of ['commission_payments', 'land_commission', 'land_payments', 'vendor_payments', 'misc_income', 'daybook']) {
    await loadModuleReport(key, 1, '7,8', { query: async (sql, params) => {
      assert.deepEqual(params, [1, '7,8'], key); assert.match(sql, /created_by = ANY\(string_to_array\(\$2::text/);
      assert.match(sql, /site_id = \$1/); assert.doesNotMatch(sql, /LIMIT\s+\$\d/);
      if (key === 'daybook') { assert.match(sql, /FROM ledger_entries/); assert.match(sql, /split_part\(l.id, ':'/); }
      return { rows: [] };
    } });
  }
  await assert.rejects(() => loadModuleReport('unknown', 1, null), /Unknown/);
});

test('native SQL preserves scoped TDS, split payouts and commission obligations, and executes land, vendor and income reports', async t => {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite(); t.after(() => db.close());
  const source = readFileSync(new URL('../src/migrations/171_cheque_clearance_before_approval.js', import.meta.url), 'utf8');
  await db.exec(source.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);
  await db.exec(`
    CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE SQL AS $$ SELECT CASE WHEN upper(COALESCE($1,'CASH'))='CASH' THEN 'cash' ELSE 'bank' END $$;
    CREATE TABLE users(id int PRIMARY KEY, name text);
    CREATE TABLE members(id int PRIMARY KEY, full_name text, phone text, team text);
    CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_no text, plot_size numeric, plot_rate numeric, buyer_name text,
      commission_rate numeric, plot_tag text, status text, plot_commission numeric, booking_date date, created_at timestamptz);
    CREATE TABLE farmers(id int PRIMARY KEY, site_id int, name text, phone text, total_amount numeric, land_size_bigha numeric,
      land_size_gaz numeric, land_size_mtr numeric, land_rate numeric, status text, created_at timestamptz);
    CREATE TABLE farmer_payments(id int PRIMARY KEY, farmer_id int, amount numeric, tds_amount numeric, date date,
      payment_mode text, cash_amount numeric, bank_amount numeric, status text, cheque_status text, created_by int);
    CREATE TABLE plot_commissions_v2(id int PRIMARY KEY, site_id int, plot_id int, farmer_id int, land_deal_id int, agent_id int,
      total_commission numeric, remarks text, status text, created_at timestamptz);
    CREATE TABLE plot_commission_payments(id int PRIMARY KEY, plot_commission_id int, amount numeric, tds_amount numeric,
      date date, payment_mode text, status text, cheque_status text, created_by int);
    CREATE TABLE land_deals(id int PRIMARY KEY, site_id int, farmer_id int, buyer_name text, buyer_phone text, sale_amount numeric,
      purchase_cost numeric, other_cost numeric, area_bigha numeric, deal_date date, status text, created_by int);
    CREATE TABLE land_deal_payments(id int PRIMARY KEY, land_deal_id int, amount numeric, date date, payment_mode text, status text,
      cheque_status text, created_by int);
    CREATE TABLE vendor_commitments(id int PRIMARY KEY, site_id int, vendor_name text, work_title text, head_name text, contract_amount numeric);
    CREATE TABLE vendor_payments(id int PRIMARY KEY, site_id int, commitment_id int, amount numeric, payment_date date, created_by int);
    CREATE TABLE misc_income_categories(id int PRIMARY KEY, name text);
    CREATE TABLE misc_income_entries(id int PRIMARY KEY, site_id int, category_id int, created_by int, assigned_admin_id int, date date);
    CREATE TABLE bank_accounts(id int PRIMARY KEY, site_id int, name text);
    CREATE TABLE cash_flow_entries(id int PRIMARY KEY, site_id int, source_module text, source_id int, bank_account_id int);
    INSERT INTO users VALUES(7,'Own user'),(8,'Other user');
    INSERT INTO members VALUES(1,'Agent','999','Team');
    INSERT INTO plots VALUES(1,1,'A1',100,1000,'Buyer',10,'NEW','BOOKED',1000,'2026-10-01','2026-10-01'),
      (2,2,'B1',100,1000,'Foreign buyer',10,'NEW','BOOKED',1000,'2026-10-01','2026-10-01');
    INSERT INTO farmers VALUES(1,1,'Land','999',1000,10,NULL,NULL,100,'active','2026-10-01'),
      (2,2,'Foreign land','999',1000,10,NULL,NULL,100,'active','2026-10-01');
    INSERT INTO farmer_payments VALUES
      (1,1,100,10,'2026-10-01','SPLIT',30,70,'approved',NULL,7),
      (2,1,200,20,'2026-10-01','BANK',0,0,'approved',NULL,8),
      (3,1,300,0,'2026-10-01','CHEQUE',0,0,'approved','PENDING',7),
      (4,1,-20,0,'2026-10-01','CASH',0,0,'pending',NULL,7),
      (5,1,900,0,'2200-10-01','CASH',0,0,'approved',NULL,7),
      (6,2,1000,0,'2026-10-01','CASH',0,0,'approved',NULL,7);
    INSERT INTO plot_commissions_v2 VALUES
      (1,1,1,NULL,NULL,1,600,'','pending','2026-10-01'),(2,1,1,NULL,NULL,1,400,'','pending','2026-10-02'),
      (3,1,NULL,1,NULL,1,100,'','pending','2026-10-02');
    INSERT INTO plot_commission_payments VALUES
      (1,1,100,10,'2026-10-01','BANK','approved',NULL,7),
      (2,2,200,20,'2026-10-01','CASH','approved',NULL,8),
      (3,1,-20,0,'2026-10-01','CASH','pending',NULL,7),
      (4,1,300,0,'2026-10-01','CHEQUE','approved','PENDING',7),
      (5,3,20,2,'2026-10-01','BANK','approved',NULL,7);
    INSERT INTO land_deals VALUES(1,1,1,'Buyer','999',500,300,10,5,'2026-10-02','open',7),
      (2,1,1,'Cancelled','999',900,500,10,5,'2026-10-02','cancelled',7);
    INSERT INTO land_deal_payments VALUES(1,1,100,'2026-10-02','BANK','pending',NULL,7),
      (2,1,200,'2026-10-02','CASH','approved',NULL,8), (3,1,900,'2026-10-02','CHEQUE','approved','PENDING',7);
    INSERT INTO vendor_commitments VALUES(1,1,'Vendor','Work','Head',1000);
    INSERT INTO vendor_payments VALUES(1,1,1,100,'2026-10-02',7),(2,1,1,200,'2026-10-02',8);
    INSERT INTO misc_income_categories VALUES(1,'Interest');
    INSERT INTO misc_income_entries VALUES(1,1,1,7,8,'2026-10-02'),(2,2,1,7,8,'2026-10-02');
    INSERT INTO bank_accounts VALUES(1,1,'Project bank');
    INSERT INTO cash_flow_entries VALUES(1,1,'vendor_payments',1,1),(2,1,'farmer_payments',1,1);
  `);
  const [ownFarmer] = await loadModuleReport('land_purchase', 1, 7, db);
  assert.equal(Number(ownFarmer.total_paid), 90); assert.equal(Number(ownFarmer.cash_paid), 10); assert.equal(Number(ownFarmer.bank_paid), 70);
  assert.equal(Number((await loadModuleReport('land_purchase', 1, '7,8', db))[0].total_paid), 310);
  const [commission] = await loadModuleReport('commission', 1, 7, db);
  assert.equal(Number(commission.total_commission), 1000); assert.equal(Number(commission.total_paid), 90); assert.equal(Number(commission.balance), 910);
  assert.equal(Number((await loadModuleReport('commission', 1, null, db))[0].total_paid), 310);
  assert.equal((await loadModuleReport('commission_payments', 1, 7, db)).length, 3);
  const [landCommission] = await loadModuleReport('land_commission', 1, 7, db);
  assert.equal(Number(landCommission.total_paid), 22); assert.equal(Number(landCommission.balance), 78);
  const sales = await loadModuleReport('land_sale', 1, 7, db);
  assert.equal(sales.find(s => s.id === 1).received, 100); assert.equal(sales.find(s => s.id === 1).profit, 190);
  const [profit] = await loadModuleReport('land_profit', 1, 7, db);
  assert.equal(profit.sale_value, 500); assert.equal(profit.profit, 190); assert.equal(profit.paid_to_farmer, 90);
  const [vendor] = await loadModuleReport('vendor_payments', 1, 7, db);
  assert.equal(vendor.vendor_name, 'Vendor'); assert.equal(vendor.bank_account_name, 'Project bank');
  assert.equal((await loadModuleReport('vendor_payments', 1, null, db)).length, 2);
  assert.equal((await loadModuleReport('misc_income', 1, 7, db)).length, 1);
  assert.equal((await loadModuleReport('land_payments', 1, 7, db))[0].farmer_name, 'Land');
});
