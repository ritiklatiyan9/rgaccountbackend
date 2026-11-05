import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getSiteBalanceDetail, getExpenseBreakdown, getRunningExpense, getPersonalLedgerCredit, getSiteCashflow } from '../src/graphql/services/kpi.service.js';
import { getRevenueVsExpense } from '../src/graphql/services/charts.service.js';
import { getFinanceForecast } from '../src/graphql/services/forecast.service.js';
import { getSiteDirectorOverview } from '../src/services/siteDirector.service.js';
import { buildReport } from '../src/controllers/report.controller.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';

// Entirely isolated PostgreSQL fixtures. The actual reporting SQL runs against
// one canonical view, as it does in the application; no customer DB is opened.
test('internal transfers conserve balances without increasing external cashflow, income, cost or forecast demand', async t => {
  const db = new PGlite();
  const original = pool.query;
  pool.query = (...args) => db.query(...args);
  try {
    await db.exec(`
      CREATE TABLE sites(id int PRIMARY KEY,name text,code text,city text,state text,status text);
      CREATE TABLE users(id int PRIMARY KEY,name text,role text);
      CREATE TABLE cash_flow_months(id int PRIMARY KEY,site_id int,ledger_type text);
      CREATE TABLE cash_flow_entries(id serial PRIMARY KEY,site_id int,cash_flow_month_id int,
        date date DEFAULT CURRENT_DATE,source_module text,source_id int,debit numeric DEFAULT 0,credit numeric DEFAULT 0,
        cash_type text DEFAULT 'cash',status text DEFAULT 'approved',cheque_status text,
        bank_account_id int,particular text,remarks text,cheque_no text,cheque_transaction_date date);
      CREATE TABLE bank_accounts(id int,site_id int,name text);
      CREATE VIEW ledger_entries AS SELECT c.id,c.site_id,c.date AS entry_date,
        COALESCE(c.source_module,'personal_ledger') AS source_key,c.source_id,c.credit,c.debit,
        c.cash_type AS bucket,m.ledger_type,''::text AS plot_tag FROM cash_flow_entries c JOIN cash_flow_months m ON m.id=c.cash_flow_month_id;
      CREATE TABLE imprest_ledger(site_id int,user_id int,amount numeric,created_at timestamptz);
      CREATE TABLE imprest_allocations(site_id int,amount numeric,status text,from_own_float boolean,created_at timestamptz);
      CREATE TABLE imprest_site_debit_reservations(site_id int,amount numeric);
      CREATE TABLE tds_settlements(id int,existing_entry_id int);
      CREATE TABLE tds_accounting_deductions(id int,site_id int,deduction_date date,source_table text,
        source_id int,commission_payment_id int,tds_amount numeric,gross_amount numeric,accounting_state text);
      CREATE TABLE plots(id int,site_id int,plot_tag text);
      CREATE TABLE plot_payments(id int,site_id int,plot_id int,date date);
      CREATE TABLE plot_installment_payments(id int,plot_id int,payment_date date);
      CREATE TABLE land_deals(id int,site_id int,status text);
      CREATE TABLE land_deal_payments(id int,land_deal_id int,date date);
      CREATE TABLE farmers(id int,site_id int);
      CREATE TABLE farmer_payments(id int,farmer_id int,date date);
      CREATE TABLE expenses(id int,site_id int,date date);
      CREATE TABLE plot_commission_payments(id int,site_id int,date date);
      CREATE TABLE vendor_payments(id int,site_id int,payment_date date);
      CREATE TABLE vendor_inventory_payments(id int,site_id int,payment_date date,source_vendor_payment_id int);
      INSERT INTO sites(id,name) VALUES (1,'Source'),(2,'Destination');
      INSERT INTO cash_flow_months VALUES (1,1,'site'),(2,1,'person'),(3,2,'site');
      INSERT INTO cash_flow_entries(site_id,cash_flow_month_id,source_module,debit,credit) VALUES
        (1,1,'plot_payments',0,1000),(1,1,'expenses',100,0),(1,2,NULL,0,20),
        (2,3,'plot_payments',0,500),(2,3,'expenses',50,0);
    `);
    await db.exec(postingPolicySql);
    const today = (await db.query('SELECT CURRENT_DATE::text AS day')).rows[0].day;
    const tomorrow = (await db.query("SELECT (CURRENT_DATE+1)::text AS day")).rows[0].day;
    const cashflowReport = async site => {
      const report = await buildReport('cashflow', site, today, today);
      // Compare every money-bearing output produced by the real report engine,
      // including its detail query; generation timestamps are intentionally omitted.
      return { kpis: report.kpis, trend: report.trend, breakdown: report.breakdown,
        rows: report.rows.sort((a, b) => a.id - b.id) };
    };
    const external = async site => ({
      expense: await getExpenseBreakdown(site, '1900-01-01', tomorrow),
      running: await getRunningExpense(site, tomorrow),
      personalIncome: await getPersonalLedgerCredit(site, '1900-01-01', tomorrow),
      cashflow: await getSiteCashflow(site, '1900-01-01', tomorrow),
      chart: await getRevenueVsExpense(site, today, tomorrow),
      report: await cashflowReport(site),
    });
    const balances = () => Promise.all([1, 2].map(site => getSiteBalanceDetail(site, '1900-01-01', tomorrow, db)));
    const baselineExternal = await Promise.all([1, 2].map(external));
    assert.equal(baselineExternal[0].report.kpis.find(row => row.key === 'total').value, 1020);
    assert.equal(baselineExternal[1].report.kpis.find(row => row.key === 'total').value, 500);
    assert.ok(baselineExternal[0].report.rows.some(row => row.source_module === null),
      'the transfer exclusion must retain manual receipts with a NULL source');
    const baseline = await balances();
    const baselineDirector = await getSiteDirectorOverview();
    const forecast = async () => {
      // Optional payables modules are outside this fixture. Their SQL returns
      // empty commitments; all four real ledger forecast queries execute.
      pool.query = (sql, params) => /FROM ledger_entries/.test(sql) ? db.query(sql, params) : Promise.resolve({ rows: [] });
      try { return await getFinanceForecast(1, { horizonMonths: 3, lookbackMonths: 3 }); }
      finally { pool.query = (...args) => db.query(...args); }
    };
    const baselineForecast = await forecast();
    await t.test('same-site legs remain visible but leave all site and external totals unchanged', async () => {
      await db.exec(`INSERT INTO cash_flow_entries(site_id,cash_flow_month_id,source_module,debit,credit) VALUES
        (1,1,'cashflow_transfers',100,0),(1,2,'cashflow_transfers',0,100)`);
      assert.deepEqual(await balances(), baseline);
      assert.deepEqual(await Promise.all([1, 2].map(external)), baselineExternal);
      assert.equal((await db.query("SELECT count(*) FROM ledger_entries WHERE source_key='cashflow_transfers'")).rows[0].count, 2);
    });
    await t.test('cross-site legs move cash equally and oppositely, with no extra receipts or expenses', async () => {
      await db.exec(`INSERT INTO cash_flow_entries(site_id,cash_flow_month_id,source_module,debit,credit) VALUES
        (1,1,'cashflow_transfers',200,0),(2,3,'cashflow_transfers',0,200)`);
      const after = await balances();
      assert.equal(after[0].siteBalance, baseline[0].siteBalance - 200);
      assert.equal(after[1].siteBalance, baseline[1].siteBalance + 200);
      assert.equal(after.reduce((n, row) => n + row.siteBalance, 0), baseline.reduce((n, row) => n + row.siteBalance, 0));
      for (const i of [0, 1]) for (const key of ['totalMoneyIn', 'totalMoneyOut', 'periodMoneyIn', 'periodMoneyOut']) {
        assert.equal(after[i][key], baseline[i][key], key);
      }
      assert.deepEqual(await Promise.all([1, 2].map(external)), baselineExternal);
      const director = await getSiteDirectorOverview();
      for (const key of ['totalBalance', 'totalInflow', 'totalOutflow', 'cashIn', 'cashOut', 'bankIn', 'bankOut', 'monthInflow', 'monthOutflow']) {
        assert.equal(director.totals[key], baselineDirector.totals[key], `Director ${key}`);
      }
      for (const site of director.sites) {
        const before = baselineDirector.sites.find(row => row.id === site.id);
        assert.equal(site.totalBalance, before.totalBalance + (site.id === 1 ? -200 : 200));
      }
      const nextForecast = await forecast();
      assert.equal(nextForecast.currentBalance, baselineForecast.currentBalance - 200);
      for (const key of ['historical', 'runRate', 'totals', 'sourcePattern', 'weekdayPattern']) {
        assert.deepEqual(nextForecast[key], baselineForecast[key], `Forecast ${key}`);
      }
    });
  } finally { pool.query = original; await db.close(); }
});
