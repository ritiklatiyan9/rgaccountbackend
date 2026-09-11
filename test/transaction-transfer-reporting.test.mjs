import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import pool from '../src/config/db.js';
import { farmerModel, farmerPaymentModel } from '../src/models/Farmer.model.js';
import { getExpenseByCategory, getRevenueVsExpense } from '../src/graphql/services/charts.service.js';
import { verifyFinancialIntegrity } from '../src/graphql/services/consistency.service.js';
import { getProfitMonthly, getProfitSummary, verifyData } from '../src/controllers/daybook.controller.js';
import {
  getExpenseBreakdown,
  getLandProfitByFarmer,
  getLandProfitDetail,
  getLandRevenue,
  getPlotIncoming,
  getRegistryPayments,
  getRevenue,
  getRunningExpense,
  getSiteBalanceDetail,
} from '../src/graphql/services/kpi.service.js';

// Run against an isolated PostgreSQL engine. No customer connection is opened.
test('transfer offsets reconcile module summaries and the dated site balance', {
  skip: !process.env.PGLITE_MODULE,
}, async (t) => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const db = new PGlite();
  const originalQuery = pool.query;
  pool.query = (sql, values) => db.query(sql, values);
  try {
    await db.exec(`
      CREATE TABLE ledger_entries (
        site_id integer, entry_date date, source_key text, source_id integer,
        debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        bucket text DEFAULT 'bank', ledger_type text DEFAULT 'site', plot_tag text DEFAULT ''
      );
      CREATE TABLE users(id integer, role text);
      CREATE TABLE imprest_ledger(user_id integer, site_id integer, amount numeric, created_at timestamptz);
      CREATE TABLE imprest_allocations(site_id integer, amount numeric, status text, from_own_float boolean, created_at timestamptz);
      CREATE TABLE farmers(id integer PRIMARY KEY, site_id integer, name text, created_by integer, created_at timestamptz);
      CREATE TABLE farmer_payments(id integer PRIMARY KEY, farmer_id integer, amount numeric,
        cash_amount numeric DEFAULT 0, bank_amount numeric DEFAULT 0, interest_amount numeric DEFAULT 0,
        status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text, date date);
      CREATE TABLE plots(id integer PRIMARY KEY, site_id integer, sale_price numeric,
        status text DEFAULT 'BOOKED', plot_tag text DEFAULT '', created_at timestamptz);
      CREATE TABLE plot_payments(id integer, plot_id integer, site_id integer, amount numeric,
        date date, status text DEFAULT 'approved', payment_type text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE plot_installment_payments(id integer, plot_id integer, amount numeric,
        payment_date date, status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE land_deals(id integer PRIMARY KEY, farmer_id integer, site_id integer,
        sale_amount numeric, purchase_cost numeric, other_cost numeric, deal_date date, status text);
      CREATE TABLE land_deal_payments(id integer, land_deal_id integer, amount numeric,
        date date, status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE expenses(id integer, site_id integer, date date, debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        category text, status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE plot_commissions(id integer, site_id integer, date date, amount numeric,
        status text DEFAULT 'approved', by_note text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE plot_commission_payments(id integer, site_id integer, date date, amount numeric,
        status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE vendor_payments(id integer, site_id integer, payment_date date, amount numeric,
        status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE vendor_inventory_payments(id integer, site_id integer, payment_date date, amount numeric,
        source_vendor_payment_id integer, status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE plot_registry_payments(id integer, site_id integer, payment_date date, amount numeric,
        source_plot_payment_id integer, status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE day_book(id integer, site_id integer, date date, debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        entry_type text, farmer_payment_id integer, commission_id integer, vendor_payment_id integer,
        status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE cash_flow_months(id integer, ledger_type text);
      CREATE TABLE firms(id integer, site_id integer);
      CREATE TABLE firm_transactions(firm_id integer, debit numeric DEFAULT 0, credit numeric DEFAULT 0,
        status text DEFAULT 'approved', payment_mode text DEFAULT 'BANK', cheque_status text);
      CREATE TABLE cash_flow_entries(site_id integer, date date, source_module text, source_id integer,
        debit numeric DEFAULT 0, credit numeric DEFAULT 0, status text DEFAULT 'approved',
        cash_type text DEFAULT 'bank', cheque_status text, cash_flow_month_id integer,
        from_firm_id integer, to_firm_id integer, is_firm_transaction boolean DEFAULT false);
      CREATE FUNCTION ledger_bucket(text) RETURNS text LANGUAGE SQL AS
        'SELECT CASE WHEN UPPER(COALESCE($1, ''CASH'')) = ''CASH'' THEN ''cash'' ELSE ''bank'' END';
      INSERT INTO farmers VALUES (1,1,'Farmer',1,'2026-01-01');
    `);
    const posting = await readFile(new URL('../src/migrations/118_credit_first_posting.js', import.meta.url), 'utf8');
    await db.exec(posting.match(/CREATE OR REPLACE FUNCTION financial_transaction_posts\([\s\S]*?AS \$\$[\s\S]*?\$\$/)[0]);

    await t.test('21 October receipt stays in history and 30 October debit/credit leave cash unchanged', async () => {
      await db.exec(`
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,credit,ledger_type)
          VALUES (1,'2026-10-21','personal_ledger',1,5000,'person');
      `);
      const before = await getSiteBalanceDetail(1, '2026-10-01', '2026-11-01', db);
      await db.exec(`
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,debit,credit,ledger_type) VALUES
          (1,'2026-10-30','personal_ledger',2,5000,0,'person'),
          (1,'2026-10-30','farmer_payments',1,0,5000,'site');
        INSERT INTO farmer_payments(id,farmer_id,amount,bank_amount,date)
          VALUES (1,1,-5000,-5000,'2026-10-30');
      `);
      const after = await getSiteBalanceDetail(1, '2026-10-30', '2026-11-01', db);
      const historical = await getSiteBalanceDetail(1, '2026-10-01', '2026-10-30', db);
      assert.equal(before.bankBalance, 5000);
      assert.equal(after.bankBalance, before.bankBalance);
      assert.equal(historical.bankBalance, before.bankBalance);
      assert.equal(after.periodMoneyIn, 5000);
      assert.equal(after.periodMoneyOut, 5000);
      assert.equal(after.periodNet, 0);
      assert.equal(await farmerPaymentModel.getTotalPaid(1, db), -5000);
      assert.equal(await getRunningExpense(1, '2026-11-01'), -5000);
    });

    await t.test('plot transfer does not inflate collections, revenue, or registry collections', async () => {
      await db.exec(`TRUNCATE ledger_entries;
        INSERT INTO plots VALUES (1,1,10000,'REGISTRY','','2026-01-01'),(2,1,10000,'REGISTRY','','2026-01-01');
        INSERT INTO plot_payments(id,plot_id) VALUES (1,1),(2,1),(3,2);
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,debit,credit) VALUES
          (1,'2026-10-21','plot_payments',1,0,10000),
          (1,'2026-10-30','plot_payments',2,4000,0),
          (1,'2026-10-30','plot_payments',3,0,4000);
      `);
      assert.equal(await getRevenue(1, '2026-10-01', '2026-11-01'), 10000);
      assert.equal(await getRevenue(1, '2026-10-30', '2026-11-01'), 0);
      const incoming = await getPlotIncoming(1, '2026-11-01');
      assert.equal(incoming.received, 10000);
      assert.equal(incoming.remaining, 10000);
      assert.equal(incoming.overpaid, 0);
      const { plotRegistryModel } = await import('../src/models/PlotRegistry.model.js');
      const originalFind = plotRegistryModel.findBySiteId;
      plotRegistryModel.findBySiteId = async () => [];
      try {
        const registry = await getRegistryPayments(1, '2026-10-01', '2026-11-01');
        assert.equal(registry.total, 10000);
        assert.equal(registry.bank, 10000);
      } finally { plotRegistryModel.findBySiteId = originalFind; }
    });

    await t.test('farmer, vendor, expense, and project commission credits all reduce operating cost', async () => {
      await db.exec(`TRUNCATE ledger_entries;
        INSERT INTO ledger_entries(site_id,entry_date,source_key,debit,credit) VALUES
          (1,'2026-10-21','farmer_payments',1000,0),
          (1,'2026-10-22','farmer_payments',-100,0),
          (1,'2026-10-30','farmer_payments',0,200),
          (1,'2026-10-21','vendor_payments',700,0),
          (1,'2026-10-30','vendor_payments',0,300),
          (1,'2026-10-21','plot_commission_payments',800,0),
          (1,'2026-10-30','plot_commission_payments',0,400),
          (1,'2026-10-21','expenses',500,0),
          (1,'2026-10-30','expenses',0,200);
      `);
      const expense = await getExpenseBreakdown(1, '2026-10-01', '2026-11-01');
      assert.equal(expense.total, 1800);
      assert.equal(expense.breakdown.farmer_payments.debit, 700);
      assert.equal(expense.breakdown.vendor_payments.debit, 400);
      assert.equal(expense.breakdown.plot_commission_payments.debit, 400);
      assert.equal(expense.breakdown.expenses.debit, 300);
      assert.equal(await getRunningExpense(1, '2026-11-01'), 1800);
    });

    await t.test('land revenue and profit use net buyer receipts and net farmer payments', async () => {
      await db.exec(`TRUNCATE ledger_entries, farmer_payments;
        INSERT INTO farmer_payments(id,farmer_id,amount,date) VALUES (1,1,3000,'2026-10-21'),(2,1,-1000,'2026-10-30');
        INSERT INTO land_deals VALUES (1,1,1,20000,10000,0,'2026-01-01','open');
        INSERT INTO land_deal_payments(id,land_deal_id) VALUES (1,1),(2,1);
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,debit,credit) VALUES
          (1,'2026-10-21','land_deal_payments',1,0,10000),
          (1,'2026-10-30','land_deal_payments',2,4000,0),
          (1,'2026-10-21','farmer_payments',1,3000,0),
          (1,'2026-10-30','farmer_payments',2,0,1000);
      `);
      assert.equal((await getLandRevenue(1, '2026-10-01', '2026-11-01')).credit, 6000);
      const land = await getLandProfitDetail(1, '2026-11-01');
      assert.equal(land.received, 6000);
      assert.equal(land.bankReceived, 6000);
      assert.equal(land.purchaseCostAlreadyExpensed, 2000);
      const [farmer] = await getLandProfitByFarmer(1, '2026-11-01');
      assert.equal(farmer.paid, 2000);
      assert.equal(farmer.received, 6000);
      assert.equal(farmer.currentProfit, 4000);
      assert.equal(await getRunningExpense(1, '2026-11-01'), 2000);
    });

    await t.test('farmer summaries apply credit posting rules to negative recoveries', async () => {
      await db.exec(`TRUNCATE farmer_payments;
        INSERT INTO farmer_payments(id,farmer_id,amount,bank_amount,status,payment_mode,cheque_status,date) VALUES
          (1,1,1000,1000,'approved','BANK',NULL,'2026-10-21'),
          (2,1,-250,-250,'pending','BANK',NULL,'2026-10-30'),
          (3,1,500,500,'pending','BANK',NULL,'2026-10-30'),
          (4,1,-100,-100,'pending','CHEQUE','PENDING','2026-10-30');
      `);
      assert.equal(await farmerPaymentModel.getTotalPaid(1, db), 750);
      const [farmer] = await farmerModel.findBySiteId(1, db);
      assert.equal(Number(farmer.total_paid), 750);
      assert.equal(Number(farmer.bank_paid), 750);
      assert.equal(Number((await farmerModel.findByIdWithSummary(1, db)).total_paid), 750);
    });

    await t.test('dashboard charts and dual-run verification agree with positive transfer credits and debits', async () => {
      await db.exec(`TRUNCATE ledger_entries, farmer_payments, plot_payments, land_deal_payments, cash_flow_entries;
        INSERT INTO plot_payments(id,plot_id,site_id,amount,date) VALUES
          (1,1,1,10000,'2026-10-21'),(2,1,1,-4000,'2026-10-30'),(3,2,1,4000,'2026-10-30');
        INSERT INTO farmer_payments(id,farmer_id,amount,status,date) VALUES
          (1,1,1000,'approved','2026-10-21'),(2,1,-250,'pending','2026-10-30');
        INSERT INTO expenses(id,site_id,date,debit,credit,category) VALUES
          (1,1,'2026-10-21',500,0,'TOOLS'),(2,1,'2026-10-30',0,100,'TOOLS');
        INSERT INTO vendor_inventory_payments(id,site_id,payment_date,amount,source_vendor_payment_id) VALUES
          (1,1,'2026-10-21',400,NULL),(2,1,'2026-10-30',-100,NULL),
          (3,1,'2026-10-21',700,99);
        INSERT INTO cash_flow_entries(site_id,date,source_module,source_id,debit,credit,status) VALUES
          (1,'2026-10-21','plot_payments',1,0,10000,'approved'),
          (1,'2026-10-30','plot_payments',2,4000,0,'approved'),
          (1,'2026-10-30','plot_payments',3,0,4000,'approved'),
          (1,'2026-10-21','farmer_payments',1,1000,0,'approved'),
          (1,'2026-10-30','farmer_payments',2,0,250,'pending'),
          (1,'2026-10-21','vendor_inventory_payments',1,400,0,'approved'),
          (1,'2026-10-30','vendor_inventory_payments',2,0,100,'approved'),
          (1,'2026-10-21','expenses',1,500,0,'approved'),
          (1,'2026-10-30','expenses',2,0,100,'approved');
        INSERT INTO ledger_entries(site_id,entry_date,source_key,source_id,debit,credit)
          SELECT site_id,date,source_module,source_id,debit,credit FROM cash_flow_entries;
      `);
      const check = await verifyFinancialIntegrity(1, '2026-10-01', '2026-11-01');
      assert.equal(check.passed, true, JSON.stringify(check.discrepancies));
      assert.equal(check.runA.totalRevenue, 10000);
      assert.equal(check.runA.totalExpense, 1450);
      const [chart] = await getRevenueVsExpense(1, '2026-10-01', '2026-11-01');
      assert.equal(chart.revenue, 10000);
      assert.equal(chart.expense, 1450);
      assert.deepEqual(await getExpenseByCategory(1, '2026-10-01', '2026-11-01'), [{ category: 'TOOLS', amount: 400 }]);
    });

    await t.test('legacy Daybook reports reconcile the same signed transfer postings and purchasing costs', async () => {
      const invoke = (handler) => new Promise((resolve, reject) => handler(
        { query: { site_id: '1' } }, { json: resolve }, reject,
      ));
      const verification = await invoke(verifyData);
      assert.ok(verification.modules.every((row) => row.match), JSON.stringify(verification.modules));
      assert.equal(verification.modules.find((row) => row.module === 'Purchasing Payments').sourceTotal, 300);
      assert.equal(verification.modules.find((row) => row.module === 'Farmer Payments').sourceTotal, 750);
      const summary = await invoke(getProfitSummary);
      assert.equal(summary.earn, 10000);
      assert.equal(summary.expense, 1450);
      assert.equal(summary.profit, 8550);
      assert.equal(summary.breakdown.expenses.debit, 400);
      assert.equal(summary.breakdown.vendor_inventory_payments.debit, 300);
      // The legacy monthly endpoint ends at today, so use a completed month.
      await db.exec(`
        UPDATE plot_payments SET date='2026-01-15';
        UPDATE farmer_payments SET date='2026-01-15';
        UPDATE expenses SET date='2026-01-15';
        UPDATE vendor_inventory_payments SET payment_date='2026-01-15';
      `);
      const monthly = await invoke(getProfitMonthly);
      const january = monthly.months.find((row) => row.m === '2026-01');
      assert.equal(Number(january.earning), 10000);
      assert.equal(Number(january.expense), 1450);
    });

    await t.test('startup posting repairs preserve immutable transfer projections after restart', async () => {
      for (const table of ['plot_payments', 'farmer_payments', 'expenses', 'plot_commission_payments', 'vendor_payments', 'day_book']) {
        await db.exec(`ALTER TABLE ${table} ADD COLUMN entry_transfer_id UUID, ADD COLUMN cheque_no TEXT`);
      }
      await db.exec(`
        ALTER TABLE cash_flow_entries ADD COLUMN cheque_no TEXT, ADD COLUMN updated_at timestamptz;
        CREATE FUNCTION cashflow_mode_bucket(text) RETURNS text LANGUAGE SQL AS
          'SELECT CASE WHEN UPPER(COALESCE($1, ''CASH'')) = ''CASH'' THEN ''cash'' ELSE ''bank'' END';
        UPDATE plot_payments SET entry_transfer_id='11111111-1111-4111-8111-111111111111' WHERE id IN (2,3);
        UPDATE farmer_payments SET entry_transfer_id='11111111-1111-4111-8111-111111111111' WHERE id=2;
        CREATE FUNCTION reject_projection_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          RAISE EXCEPTION 'Immutable transfer projection cannot change';
        END $$;
        CREATE TRIGGER immutable_projection BEFORE UPDATE ON cash_flow_entries
          FOR EACH ROW EXECUTE FUNCTION reject_projection_rewrite();
      `);
      const before = (await db.query('SELECT * FROM cash_flow_entries ORDER BY source_module,source_id')).rows;
      const repairs = [...posting.matchAll(/await client\.query\(`([\s\S]*?)`\);/g)]
        .map((match) => match[1])
        .filter((sql) => sql.includes('UPDATE cash_flow_entries cfe') && sql.includes('entry_transfer_id'));
      assert.equal(repairs.length, 6);
      for (const sql of repairs) await db.exec(sql);
      assert.deepEqual((await db.query('SELECT * FROM cash_flow_entries ORDER BY source_module,source_id')).rows, before);
    });
  } finally {
    pool.query = originalQuery;
    await db.close();
  }
});
