import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { getExpenseBreakdown, getRunningExpense } from '../src/graphql/services/kpi.service.js';
import { getRevenueVsExpense, getExpenseByCategory } from '../src/graphql/services/charts.service.js';
import { getProfitSummary, getProfitMonthly } from '../src/controllers/daybook.controller.js';
import balanceSheet from '../src/models/BalanceSheet.model.js';
import { attachDayBookTds, attachDayBookTdsSettlements } from '../src/services/daybookTds.service.js';

// These queries run against an isolated PostgreSQL engine, never the configured
// application database. The fixture intentionally contains split owners,
// rejected/pending withholding, person custody and an already-booked challan.
test('TDS reports preserve gross cost and actual cash across settlement methods', { skip: !process.env.PGLITE_MODULE }, async t => {
  const { PGlite } = await import(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  const originalQuery = pool.query;
  pool.query = (sql, args = []) => args.length ? pg.query(sql, args) : pg.exec(sql).then(results => results.at(-1));
  try {
    await pg.exec(`
      CREATE FUNCTION financial_transaction_posts(direction text, status text, mode text, cheque text)
        RETURNS boolean LANGUAGE SQL AS $$ SELECT LOWER(COALESCE(status,'approved'))='approved'
          AND (UPPER(COALESCE(mode,''))<>'CHEQUE' OR cheque='CLEARED') $$;
      CREATE TABLE ledger_entries(id text, site_id int, entry_date date, debit numeric, credit numeric,
        source_key text, source_id int, ledger_type text, bucket text, plot_tag text);
      CREATE TABLE cash_flow_entries(id int PRIMARY KEY, source_module text, source_id int);
      CREATE TABLE tds_settlements(id int PRIMARY KEY, kind text, amount numeric, existing_entry_id int,
        challan_no text, ca_name text, transaction_id text);
      CREATE TABLE tds_accounting_deductions(id int PRIMARY KEY, site_id int, deduction_date date,
        source_table text, source_id int, commission_payment_id int, tds_amount numeric,
        gross_amount numeric, accounting_state text);
      CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_tag text);
      CREATE TABLE plot_payments(id int PRIMARY KEY, site_id int, plot_id int, date date);
      CREATE TABLE plot_installment_payments(id int PRIMARY KEY, site_id int, plot_id int, payment_date date);
      CREATE TABLE land_deals(id int PRIMARY KEY, site_id int, status text);
      CREATE TABLE land_deal_payments(id int PRIMARY KEY, land_deal_id int, date date);
      CREATE TABLE farmers(id int PRIMARY KEY, site_id int);
      CREATE TABLE farmer_payments(id int PRIMARY KEY, farmer_id int, date date);
      CREATE TABLE plot_commissions_v2(id int PRIMARY KEY, plot_id int, farmer_id int);
      CREATE TABLE plot_commission_payments(id int PRIMARY KEY, site_id int, date date, plot_commission_id int,
        amount numeric, tds_amount numeric, tds_rate numeric, tds_mode text, tds_section text,
        payment_mode text, status text, cheque_status text);
      CREATE TABLE vendor_payments(id int PRIMARY KEY, site_id int, payment_date date);
      CREATE TABLE vendor_inventory_payments(id int PRIMARY KEY, site_id int, payment_date date, source_vendor_payment_id int);
      CREATE TABLE expenses(id int PRIMARY KEY, site_id int, date date, debit numeric, credit numeric,
        category text, tds_amount numeric, payment_mode text, status text, cheque_status text);
      INSERT INTO plot_commissions_v2 VALUES(1,1,NULL);
      INSERT INTO plot_commission_payments VALUES(1,1,'2026-10-01',1,98000,2000,2,'percentage','194H','BANK','approved',NULL);
      INSERT INTO expenses VALUES(10,1,'2026-10-03',2000,0,'Old TDS challan',0,'BANK','approved',NULL),
        (11,1,'2026-09-10',49000,0,'Contractor',1000,'BANK','approved',NULL);
      INSERT INTO cash_flow_entries VALUES(90,'expenses',10);
      INSERT INTO tds_settlements VALUES(2,'government_direct',2000,90,'OLD-CHALLAN',NULL,NULL);
      INSERT INTO ledger_entries VALUES
        ('1:cash',1,'2026-10-01',48000,0,'plot_commission_payments',1,'site','cash',NULL),
        ('1:bank',1,'2026-10-01',50000,0,'plot_commission_payments',1,'site','bank',NULL),
        ('2',1,'2026-10-01',0,200000,'plot_payments',2,'site','bank',NULL),
        ('90',1,'2026-10-03',2000,0,'expenses',10,'site','bank',NULL),
        ('4',1,'2026-09-10',49000,0,'expenses',11,'site','bank',NULL),
        ('5',1,'2026-10-01',49000,0,'expenses',12,'person','cash',NULL),
        ('6',2,'2026-10-01',98000,0,'plot_commission_payments',20,'site','bank',NULL);
      INSERT INTO tds_accounting_deductions VALUES
        (1,1,'2026-10-01',NULL,NULL,1,2000,100000,'active'),
        (2,1,'2026-10-02',NULL,NULL,2,1000,50000,'pending'),
        (3,1,'2026-10-02',NULL,NULL,3,1000,50000,'reversed'),
        (4,1,'2026-09-10','expenses',11,NULL,1000,50000,'active'),
        (5,1,'2026-10-01','expenses',12,NULL,1000,50000,'active'),
        (6,1,'2026-10-01',NULL,NULL,NULL,500,25000,'active'),
        (7,2,'2026-10-01','plot_commission_payments',20,NULL,2000,100000,'active');
    `);
    await t.test('split commission adds one withholding; inactive, manual and custody rows stay out of costs', async () => {
      const report = await getExpenseBreakdown(1, '2026-10-01', '2026-11-01');
      assert.equal(report.total, 100000);
      assert.deepEqual(report.breakdown.plot_commission_payments, { debit: 100000, count: 2 });
      assert.equal(report.breakdown.expenses, undefined);
      assert.equal(await getRunningExpense(1, '2026-11-01'), 150000);
      assert.equal((await getExpenseBreakdown(2, '2026-10-01', '2026-11-01')).total, 100000);
    });
    await t.test('direct deposits and CA funding reduce cash, leave gross cost and profit unchanged', async () => {
      await pg.exec(`
        INSERT INTO tds_settlements VALUES(3,'government_direct',2000,NULL,'NEW-CHALLAN',NULL,NULL),
          (4,'ca_transfer',2000,NULL,NULL,'CA One','CA-REF'),(5,'government_via_ca',2000,NULL,'CA-CHALLAN','CA One',NULL);
        INSERT INTO ledger_entries VALUES
          ('7',1,'2026-10-04',2000,0,'tds_settlements',3,'site','bank',NULL),
          ('8',1,'2026-10-05',2000,0,'tds_settlements',4,'site','bank',NULL);
      `);
      assert.equal((await getExpenseBreakdown(1, '2026-10-01', '2026-11-01')).total, 100000);
      const trend = await getRevenueVsExpense(1, '2026-10-01', '2026-11-01');
      assert.equal(trend.reduce((sum, row) => sum + row.expense, 0), 100000);
      assert.equal(trend.reduce((sum, row) => sum + row.revenue - row.expense, 0), 100000);
      const cash = (await pg.query("SELECT SUM(credit-debit) AS amount FROM ledger_entries WHERE site_id=1 AND ledger_type='site'")).rows[0];
      assert.equal(Number(cash.amount), 47000);
      assert.deepEqual(await getExpenseByCategory(1, '2026-09-01', '2026-11-01'), [{ category: 'Contractor', amount: 50000 }]);
    });
    await t.test('source payout metadata shows gross/net/TDS; all settlement rows are immutable', async () => {
      const payout = [{ id: 'pcp_1', source_key: 'plot_commission_payments', source_id: 1, debit: 98000 }];
      await attachDayBookTds(payout, pool);
      assert.equal(payout[0].gross_amount, 100000); assert.equal(payout[0].net_amount, 98000);
      assert.equal(Number(payout[0].tds_amount), 2000);
      const split = [
        { id: '1:cash', entry_date: '2026-10-01', source_key: 'plot_commission_payments', source_id: 1, debit: 48000 },
        { id: '1:bank', entry_date: '2026-10-01', source_key: 'plot_commission_payments', source_id: 1, debit: 50000 },
      ];
      await attachDayBookTds(split, pool);
      assert.deepEqual(split.map(row => row.debit), [48000, 50000], 'Cash/bank leg amounts remain actual movements');
      for (const row of split) {
        assert.equal(row.net_amount, 98000, 'TDS metadata uses the complete source payout');
        assert.equal(row.gross_amount, 100000);
        assert.equal(row.tds_metadata_scope, 'source_payment');
      }

      await pg.exec(`ALTER TABLE farmer_payments ADD COLUMN amount numeric, ADD COLUMN tds_amount numeric;
        INSERT INTO farmer_payments(id,farmer_id,date,amount,tds_amount) VALUES(2,2,'2026-10-01',98000,2000)`);
      const farmerSplit = [
        { id: 100, farmer_payment_id: 2, debit: 48000, payment_mode: 'CASH' },
        { id: 101, farmer_payment_id: 2, debit: 50000, payment_mode: 'BANK' },
      ];
      await attachDayBookTds(farmerSplit, pool);
      for (const row of farmerSplit) {
        assert.equal(row.net_amount, 98000);
        assert.equal(row.gross_amount, 100000);
        assert.equal(Number(row.tds_amount), 2000);
      }
      const rows = [{ id: 'expense_10', expense_id: 10, debit: 2000 },
        { id: 'tds_3', source_key: 'tds_settlements', source_id: 3, debit: 2000 },
        { id: 'tds_4', source_key: 'tds_settlements', source_id: 4, debit: 2000 }];
      await attachDayBookTdsSettlements(rows, pool);
      for (const row of rows) { assert.equal(row.source_key, 'tds_settlements'); assert.equal(row.read_only, true); }
      assert.equal(rows[0].challan_no, 'OLD-CHALLAN');
      assert.equal(rows[1].challan_no, 'NEW-CHALLAN');
      assert.equal(rows[2].ca_name, 'CA One');
      assert.equal(rows[2].tds_settlement_kind, 'ca_transfer');
    });
    await t.test('Balance Sheet filters and totals include native and historical settlements exactly once', async () => {
      await pg.exec(`
        ALTER TABLE ledger_entries ADD COLUMN particular text, ADD COLUMN remarks text, ADD COLUMN raw_mode text,
          ADD COLUMN status text, ADD COLUMN cheque_status text, ADD COLUMN cheque_no text, ADD COLUMN voucher_url text,
          ADD COLUMN entity_name text, ADD COLUMN linked_detail text, ADD COLUMN created_by_name text,
          ADD COLUMN created_at timestamptz DEFAULT now(), ADD COLUMN assigned_admin_id int,
          ADD COLUMN bank_account_id int, ADD COLUMN bank_account_name text;
        ALTER TABLE cash_flow_entries ADD COLUMN site_id int DEFAULT 1, ADD COLUMN transaction_time time, ADD COLUMN created_by int, ADD COLUMN debit numeric,
          ADD COLUMN credit numeric, ADD COLUMN status text, ADD COLUMN cash_type text, ADD COLUMN cheque_status text;
        ALTER TABLE plots ADD COLUMN plot_no text, ADD COLUMN block text;
        ALTER TABLE tds_settlements ADD COLUMN date date;
        ALTER TABLE tds_accounting_deductions ADD COLUMN ca_transfer_id int, ADD COLUMN settlement_id int, ADD COLUMN deposit_date date;
        CREATE TABLE users(id int PRIMARY KEY, name text, role text);
        CREATE TABLE daybook_entry_order(site_id int, entry_date date, entry_key text, position int);
        CREATE TABLE daybook_global_order(site_id int, entry_key text, position int);
        CREATE TABLE imprest_ledger(user_id int, site_id int, amount numeric, created_at timestamptz);
        CREATE TABLE ledger_quarantine(site_id int, debit numeric, credit numeric);
        UPDATE ledger_entries SET raw_mode = bucket, status='approved';
        UPDATE tds_settlements SET date='2026-10-04';
      `);
      const report = await balanceSheet.getReport({ siteId: 1, source: 'tds_settlements', dateTo: '2026-10-10' });
      assert.equal(Number(report.summary.total_debit), 6000);
      assert.equal(report.transactions.length, 3);
      assert.equal(report.by_source.length, 1);
      assert.equal(report.by_source[0].source_key, 'tds_settlements');
      assert.ok(report.transactions.every(row => row.read_only && row.source_key === 'tds_settlements'));
      assert.equal(report.transactions.find(row => row.source_id === 2).native_source_key, 'expenses');
      assert.equal(report.transactions.find(row => row.source_id === 2).challan_no, 'OLD-CHALLAN');
      assert.equal(report.transactions.find(row => row.source_id === 4).tds_settlement_kind, 'ca_transfer');
      assert.equal(report.summary.available_balance, null, 'A filtered statement does not claim spendable site cash');
      const limited = await balanceSheet.getReport({ siteId: 1, source: 'tds_settlements', dateFrom: '2026-10-04', dateTo: '2026-10-04' });
      assert.equal(limited.transactions.length, 1);
      assert.equal(limited.transactions[0].challan_no, 'NEW-CHALLAN');
    });
    await t.test('Day Book profit summary and month totals use gross cost while cash stock uses the ledger', async () => {
      await pg.exec(`
        ALTER TABLE plot_payments ADD COLUMN amount numeric, ADD COLUMN status text, ADD COLUMN payment_type text, ADD COLUMN cheque_status text;
        ALTER TABLE plot_installment_payments ADD COLUMN amount numeric, ADD COLUMN status text, ADD COLUMN payment_mode text, ADD COLUMN cheque_status text;
        ALTER TABLE land_deal_payments ADD COLUMN amount numeric, ADD COLUMN status text, ADD COLUMN payment_mode text, ADD COLUMN cheque_status text;
        ALTER TABLE farmer_payments ADD COLUMN IF NOT EXISTS amount numeric, ADD COLUMN IF NOT EXISTS tds_amount numeric DEFAULT 0,
          ADD COLUMN status text, ADD COLUMN payment_mode text, ADD COLUMN cheque_status text;
        ALTER TABLE vendor_payments ADD COLUMN amount numeric, ADD COLUMN tds_amount numeric DEFAULT 0,
          ADD COLUMN status text, ADD COLUMN payment_mode text, ADD COLUMN cheque_status text;
        ALTER TABLE vendor_inventory_payments ADD COLUMN amount numeric, ADD COLUMN tds_amount numeric DEFAULT 0,
          ADD COLUMN status text, ADD COLUMN payment_mode text, ADD COLUMN cheque_status text;
        ALTER TABLE cash_flow_entries ADD COLUMN date date, ADD COLUMN cash_flow_month_id int,
          ADD COLUMN from_firm_id int, ADD COLUMN to_firm_id int, ADD COLUMN is_firm_transaction boolean;
        CREATE TABLE plot_registry_payments(id int, site_id int, payment_date date, amount numeric, status text,
          payment_mode text, cheque_status text, source_plot_payment_id int);
        CREATE TABLE plot_commissions(id int, site_id int, date date, amount numeric, tds_amount numeric,
          status text, by_note text, cheque_status text);
        CREATE TABLE day_book(id int,site_id int,date date,debit numeric,credit numeric,tds_amount numeric,
          status text,payment_mode text,cheque_status text,entry_type text,farmer_payment_id int,commission_id int,vendor_payment_id int);
        CREATE TABLE cash_flow_months(id int,ledger_type text);
        CREATE TABLE firms(id int,site_id int);
        CREATE TABLE firm_transactions(firm_id int,debit numeric,credit numeric,status text,payment_mode text,cheque_status text);
        INSERT INTO plots(id,site_id) VALUES(2,1);
        INSERT INTO plot_payments(id,site_id,plot_id,date,amount,status,payment_type)
          VALUES(2,1,2,'2026-10-01',200000,'approved','BANK');
      `);
      const invoke = handler => new Promise((resolve, reject) => handler({ query: { site_id: 1 } }, { json: resolve }, reject));
      const report = await invoke(getProfitSummary);
      assert.equal(report.expense, 150000); assert.equal(report.profit, 50000);
      const expectedCash = Number((await pg.query('SELECT SUM(credit-debit) AS amount FROM ledger_entries WHERE site_id=1')).rows[0].amount);
      assert.equal(report.currentBalance, expectedCash);
      const monthly = await invoke(getProfitMonthly);
      assert.equal(Number(monthly.months.find(row => row.m === '2026-09').expense), 50000);
      assert.equal(Number(monthly.months.find(row => row.m === '2026-10').expense), 100000);
    });
  } finally { pool.query = originalQuery; await pg.close(); }
});
