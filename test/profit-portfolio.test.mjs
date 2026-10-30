import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getProfitKpis } from '../src/graphql/services/kpi.service.js';
import { partnerPaidByMember } from '../src/services/partnerPayments.service.js';
import { buildProfitPortfolio, profitPortfolioQueries } from '../src/services/profitPortfolio.service.js';
import { graphql } from 'graphql';
import { schema as graphqlSchema } from '../src/graphql/schema.js';
import { postingPolicySql } from '../src/migrations/171_cheque_clearance_before_approval.js';

const schema = `
  CREATE TABLE sites(id int PRIMARY KEY, name text, include_in_overall boolean);
  CREATE TABLE plots(id int PRIMARY KEY, site_id int, plot_tag text, status text, sale_price numeric, created_at timestamp);
  CREATE TABLE plot_payments(id int PRIMARY KEY, plot_id int);
  CREATE TABLE plot_installment_payments(id int PRIMARY KEY, plot_id int);
  CREATE TABLE farmers(id int PRIMARY KEY, site_id int, name text);
  CREATE TABLE farmer_payments(id int PRIMARY KEY, farmer_id int);
  CREATE TABLE land_deals(id int PRIMARY KEY, site_id int, farmer_id int, sale_amount numeric, purchase_cost numeric, other_cost numeric, deal_date date, status text);
  CREATE TABLE land_deal_payments(id int PRIMARY KEY, land_deal_id int);
  CREATE TABLE ledger_entries(id int PRIMARY KEY, site_id int, source_key text, source_id int, entry_date date,
    credit numeric DEFAULT 0, debit numeric DEFAULT 0, bucket text DEFAULT 'cash', ledger_type text DEFAULT 'site');
  CREATE TABLE tds_accounting_deductions(id int, site_id int, deduction_date date, source_table text, source_id int,
    commission_payment_id int, tds_amount numeric, gross_amount numeric, accounting_state text);
  CREATE TABLE tds_settlements(id int, existing_entry_id int);
  CREATE TABLE users(id int PRIMARY KEY, role text, name text);
  CREATE TABLE imprest_ledger(site_id int, user_id int, amount numeric, created_at timestamp);
  CREATE TABLE imprest_allocations(site_id int, amount numeric, status text, from_own_float boolean, created_at timestamp);
  CREATE TABLE imprest_site_debit_reservations(site_id int, amount numeric);
  CREATE TABLE members(id int PRIMARY KEY, full_name text, member_type text, phone text, photo text);
  CREATE TABLE site_partner_shares(id int, site_id int, member_id int, share_pct numeric, notes text);
  CREATE TABLE land_partner_shares(id int, farmer_id int, member_id int, share_pct numeric, notes text);
  CREATE TABLE partner_profit_payments(id int PRIMARY KEY, site_id int, member_id int, date date, transaction_time text,
    amount numeric, payment_mode text, bank_account_id int, created_by int, tds_amount numeric, status text, entry_transfer_id int);
  CREATE TABLE bank_accounts(id int, name text);
  CREATE TABLE cash_flow_months(id int PRIMARY KEY, site_id int, ledger_type text, ledger_name text, linked_member_id int,
    opening_balance numeric, month int, year int);
  CREATE TABLE cash_flow_entries(id int, cash_flow_month_id int, source_module text, debit numeric, credit numeric,
    status text, cash_type text, cheque_status text);
`;
const fixture = `
  INSERT INTO sites VALUES (1,'First site',true),(2,'Second site',true),(3,'Empty site',true),(4,'Hidden site',false);
  INSERT INTO plots VALUES (1,1,'NEW','BOOKED',1000,'2026-01-01'),(2,1,'OLD','RESALE',2000,'2026-01-01'),
    (3,1,NULL,'COMPANY',3000,'2026-01-01'),(4,2,'NEW','BOOKED',500,'2026-01-01'),(5,1,'NEW','BOOKED',600,'2026-11-01'),
    (6,4,'NEW','BOOKED',99999,'2026-01-01');
  INSERT INTO plot_payments VALUES (1,1),(2,1),(3,2),(4,4),(5,5),(6,6);
  INSERT INTO plot_installment_payments VALUES (1,1);
  INSERT INTO farmers VALUES (1,1,'Sold land'),(2,1,'Unsold land'),(3,2,'Other site');
  INSERT INTO farmer_payments VALUES (1,1),(2,2),(3,3);
  INSERT INTO land_deals VALUES (1,1,1,1000,300,10,'2026-02-01','open'),(2,1,1,100,100,5,'2026-03-01','completed'),
    (3,1,NULL,100,40,5,'2026-02-01','open'),(4,1,1,99999,100,0,'2026-02-01','cancelled'),(5,2,3,600,100,5,'2026-02-01','open');
  INSERT INTO land_deal_payments VALUES (1,1),(2,2),(3,3),(4,4),(5,5);
  INSERT INTO ledger_entries(id,site_id,source_key,source_id,entry_date,credit,debit,bucket,ledger_type) VALUES
    (1,1,'plot_payments',1,'2026-02-01',600,0,'cash','site'),(2,1,'plot_payments',2,'2026-02-02',0,50,'bank','site'),
    (3,1,'plot_payments',3,'2026-02-01',700,0,'bank','site'),(4,2,'plot_payments',4,'2026-02-01',250,0,'cash','site'),
    (5,1,'plot_payments',5,'2026-11-01',900,0,'cash','site'),(6,4,'plot_payments',6,'2026-02-01',99999,0,'cash','site'),
    (7,1,'plot_installment_payments',1,'2026-02-02',100,0,'cash','site'),
    (10,1,'farmer_payments',1,'2026-02-01',0,400,'cash','site'),(11,1,'farmer_payments',1,'2026-02-02',50,0,'cash','site'),
    (12,1,'farmer_payments',2,'2026-02-01',0,100,'bank','site'),(13,2,'farmer_payments',3,'2026-02-01',0,50,'cash','site'),
    (20,1,'land_deal_payments',1,'2026-02-02',200,0,'cash','site'),(21,1,'land_deal_payments',2,'2026-02-02',80,0,'bank','site'),
    (22,1,'land_deal_payments',3,'2026-02-02',20,0,'cash','site'),(23,1,'land_deal_payments',4,'2026-02-02',30,0,'cash','site'),
    (24,2,'land_deal_payments',5,'2026-02-02',300,0,'cash','site'),
    (30,1,'expenses',30,'2026-02-01',0,100,'cash','site'),(31,1,'expenses',30,'2026-02-02',20,0,'cash','site'),
    (32,1,'day_book',32,'2026-02-01',0,1234,'cash','site'),(33,1,'misc_income_entries',33,'2026-02-01',10,0,'cash','site'),
    (34,1,'personal_ledger',34,'2026-02-01',0,200,'cash','person'),
    (41,1,'expenses',41,'2026-02-01',0,200,'cash','site'),(42,1,'expenses',42,'2026-11-01',0,50,'cash','site'),
    (50,1,'partner_profit_payments',1,'2026-02-01',0,50,'cash','site'),(51,1,'partner_profit_payments',2,'2026-02-01',0,20,'bank','site'),
    (52,1,'partner_profit_payments',4,'2026-11-01',0,25,'cash','site');
  INSERT INTO tds_settlements VALUES (1,41);
  INSERT INTO tds_accounting_deductions VALUES (1,1,'2026-02-01','farmer_payments',1,NULL,10,410,'active'),
    (2,1,'2026-02-01','expenses',30,NULL,20,120,'active'),(3,1,'2026-02-01','expenses',42,NULL,5,55,'active');
  INSERT INTO users VALUES (1,'admin','Admin'),(2,'sub_admin','Staff'),(3,'sub_admin','Negative staff');
  INSERT INTO imprest_ledger VALUES (1,1,50,'2026-02-01'),(1,2,30,'2026-02-01'),(1,3,-10,'2026-02-01');
  INSERT INTO imprest_allocations VALUES (1,70,'PENDING_RECEIPT',false,'2026-02-01'),(1,999,'PENDING_RECEIPT',true,'2026-02-01');
  INSERT INTO imprest_site_debit_reservations VALUES (1,20);
  INSERT INTO members VALUES (7,'Partner A','PARTNER','9999999999',NULL),(8,'Partner B','PARTNER','8888888888',NULL),(9,'Land partner','PARTNER','7777777777',NULL);
  INSERT INTO site_partner_shares VALUES (1,1,7,75,NULL),(2,1,8,25,NULL);
  INSERT INTO land_partner_shares VALUES (1,1,9,100,NULL);
  INSERT INTO partner_profit_payments VALUES (1,1,7,'2026-02-01','12:00',50,'CASH',NULL,1,5,'approved',NULL),
    (2,1,7,'2026-02-01','12:01',20,'BANK',NULL,1,0,'approved',10),(3,1,8,'2026-02-01','12:00',100,'CASH',NULL,1,0,'void',NULL),
    (4,1,7,'2026-11-01','12:00',25,'CASH',NULL,1,0,'approved',NULL);
  INSERT INTO cash_flow_months VALUES (1,1,'person','Partner A',7,100,1,2026),(2,1,'person','Unlinked',NULL,0,1,2026),(3,2,'person','Other',8,0,1,2026);
  INSERT INTO cash_flow_entries VALUES (1,1,NULL,200,0,'approved','cash',NULL),(2,1,NULL,0,30,'pending','cash',NULL),
    (3,1,NULL,99,0,'pending','cash',NULL),(4,1,NULL,0,20,'approved','CHEQUE','CLEARED'),
    (5,1,NULL,0,40,'approved','CHEQUE','PENDING'),(6,1,NULL,-5,0,'approved','cash',NULL),
    (7,1,'expenses_person',500,0,'approved','cash',NULL),(8,2,NULL,1,0,'approved','cash',NULL);
`;

test('batched portfolio preserves every existing profit book, shares, payments and posting policy with four reads', async t => {
  const db = new PGlite();
  const originalQuery = pool.query;
  pool.query = (...args) => db.query(...args);
  try {
    await db.exec(schema);
    await db.exec(postingPolicySql);
    await db.exec(fixture);
    for (const excludeOldPlots of [false, true]) await t.test(`full parity, excludeOldPlots=${excludeOldPlots}`, async () => {
      let calls = 0;
      const measured = { query: (...args) => { calls++; return db.query(...args); } };
      const result = await buildProfitPortfolio([1,2,3], '2026-10-31', excludeOldPlots, { db: measured, financialDb: measured });
      assert.equal(calls, 4, 'query count must not grow with the number of sites or personal ledgers');
      assert.deepEqual(result.failures, []);
      assert.deepEqual(result.data.map(site => site.siteId), [1,2,3]);
      assert.equal(result.completed, 3);
      for (const site of result.data) {
        const baseline = await getProfitKpis(site.siteId, '2026-10-31', excludeOldPlots);
        const { lands, ...expectedProfit } = baseline;
        assert.deepEqual(site.profit, expectedProfit, `profit calculations drifted for site ${site.siteId}`);
        assert.deepEqual(site.lands.map(({ shares, ...land }) => land), lands);
        const paid = await partnerPaidByMember(site.siteId, '2026-10-31', db);
        const normalize = rows => rows.map(row => ({ ...row, paid: Number(row.paid) })).sort((a,b) => a.member_id-b.member_id);
        assert.deepEqual(normalize(site.payments), normalize(paid));
      }
      const first = result.data[0];
      assert.deepEqual(first.shares.map(s => Number(s.member_id)), [7,8]);
      assert.equal(first.lands.find(land => land.farmer_id === 1).shares[0].member_id, 9);
      assert.equal(first.personalLedgers.length, 2, 'unlinked ledger candidates remain available');
      const account = first.personalLedgers.find(ledger => ledger.id === 1);
      assert.equal(Number(account.total_debit), 195);
      assert.equal(Number(account.total_credit), 50);
      assert.equal(Number(account.profit_given_debit), 195);
      assert.equal(Number(account.profit_return_credit), 50);
      assert.ok(!Object.hasOwn(account, 'profitEntries'), 'statement rows are lazy, not fetched for every overall site');
      assert.equal(first.profitPayments.length, 4, 'history retains voids and future entries like the existing endpoint');
      assert.equal(result.data[2].profit.expectedProfit, 0, 'a genuine empty site remains visible');
    });
    await t.test('the combined financial plan expands the source ledger once for all sites', async () => {
      const { rows } = await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${profitPortfolioQueries.financial}`, [[1,2,3], '2026-10-31', false]);
      const nodes = [];
      const walk = node => { nodes.push(node); (node.Plans || []).forEach(walk); };
      walk(rows[0]['QUERY PLAN'][0].Plan);
      const scans = nodes.filter(node => node['Relation Name'] === 'ledger_entries');
      assert.equal(scans.length, 1);
      assert.equal(scans[0]['Actual Loops'], 1);
    });
    await t.test('single site still uses four reads', async () => {
      let calls = 0;
      const measured = { query: (...args) => { calls++; return db.query(...args); } };
      await buildProfitPortfolio([1], '2026-10-31', false, { db: measured, financialDb: measured });
      assert.equal(calls, 4);
    });
    await t.test('no requested sites does not query the database', async () => {
      const unexpected = { query: () => { throw new Error('unexpected query'); } };
      assert.deepEqual(await buildProfitPortfolio([], '2026-10-31', false, { db: unexpected, financialDb: unexpected }),
        { data: [], failures: [], completed: 0, total: 0 });
    });
  } finally { pool.query = originalQuery; await db.close(); }
});

test('financial failures never become fabricated zero-profit sites; account failures remain explicit', async () => {
  const data = { query: async sql => ({ rows: sql === profitPortfolioQueries.financial ? [{ site_id: 1 }] : [] }) };
  const failing = { query: async () => { throw new Error('database temporarily unavailable'); } };
  const failed = await buildProfitPortfolio([1,2], '2026-10-31', false, { db: data, financialDb: failing });
  assert.deepEqual(failed.data, []);
  assert.deepEqual(failed.failures.map(site => site.id), [1,2]);
  assert.equal(failed.completed, 2);
  const partial = await buildProfitPortfolio([1], '2026-10-31', false, { financialDb: data, db: {
    query: async sql => { if (sql === profitPortfolioQueries.ledgers) throw new Error('ledger timeout'); return { rows: [] }; },
  } });
  assert.equal(partial.data[0].personalLedgersUnavailable, true);
  assert.equal(partial.failures[0].id, 1);
});


const portfolioQuery = `query Portfolio($siteIds:[ID!]!, $overall:Boolean) { profitPortfolio(siteIds:$siteIds, overall:$overall) {
  generatedAt refreshing cacheStatus completed total failures { id name message scopeChanged }
  data { siteId siteName personalLedgersUnavailable profitPaymentsUnavailable
    profit { expectedProfit currentProfit runningExpense siteBalance plot {expectedProfit currentProfit}
      siteBalanceDetail {siteBalance cashBalance bankBalance imprestHeld}
      plotIncoming {finalSaleValue received} landProfitDetail {bookProfit purchaseCostAlreadyExpensed received} }
    shares {id member_id share_pct notes full_name member_type phone photo}
    lands {farmer_id name paid expectedProfit currentProfit shares {member_id share_pct}}
    payments {member_id paid payment_count} personalLedgers {id site_id linked_member_id total_debit total_credit profit_given_debit profit_return_credit}
    profitPayments {id site_id member_id date amount posted_amount tds_amount status entry_transfer_id payment_mode bank_name bank_reference remarks bank_account_id}
  }
} }`;

test('typed GraphQL portfolio validates access and scope before cache and refreshes live site names', async () => {
  const db = new PGlite();
  const originalQuery = pool.query;
  pool.query = (...args) => db.query(...args);
  process.env.PROFIT_PORTFOLIO_QUEUE_ENABLED = 'false';
  try {
    await db.exec(schema); await db.exec(postingPolicySql); await db.exec(fixture);
    const execute = (ids, user, overall = true) => graphql({schema: graphqlSchema, source: portfolioQuery, variableValues: {siteIds: ids.map(String), overall}, contextValue: {user} });
    for (const user of [null, {id:820, role:'sub_admin'}]) {
      const result = await execute([1], user);
      assert.equal(result.errors.length, 1);
      assert.ok(['UNAUTHENTICATED','FORBIDDEN'].includes(result.errors[0].extensions.code));
    }
    const user = {id:821,role:'admin'};
    const first = await execute([1,2,3,4,999],user);
    assert.equal(first.errors, undefined);
    const report = first.data.profitPortfolio;
    assert.deepEqual(report.data.map(site => site.siteId), ['1','2','3']);
    assert.deepEqual(report.failures.map(site => site.id), ['4','999']);
    assert.ok(report.failures.every(site => site.scopeChanged === true), 'hidden and deleted sites invalidate retained snapshots');
    assert.equal(report.completed,5); assert.equal(report.total,5);
    assert.equal(report.data[2].profit.expectedProfit,0);
    assert.equal(report.data[0].siteName,'First site');
    assert.equal(report.data[0].personalLedgers[0].profit_given_debit,195);
    await db.exec("UPDATE sites SET name='Renamed site' WHERE id=1");
    let reads = 0;
    pool.query = (...args) => { reads++; return db.query(...args); };
    const cached = await execute([1,2,3,4,999],user);
    assert.equal(cached.errors,undefined);
    assert.equal(cached.data.profitPortfolio.data[0].siteName,'Renamed site');
    assert.equal(reads,1,'cached reads still validate authoritative site scope, without rebuilding books');
    const hiddenOverall = await execute([4], {id:822,role:'admin'});
    assert.deepEqual(hiddenOverall.data.profitPortfolio.data, []);
    assert.equal(hiddenOverall.data.profitPortfolio.failures[0].id, '4', 'a one-site overall report also enforces the overall switch');
    assert.equal(hiddenOverall.data.profitPortfolio.failures[0].scopeChanged, true);
    const individual = await execute([4],{id:823,role:'super_admin'},false);
    assert.equal(individual.errors,undefined);
    assert.equal(individual.data.profitPortfolio.data[0].siteName,'Hidden site','an explicit site report remains accessible');
    const invalid = await graphql({schema:graphqlSchema,source:portfolioQuery,variableValues:{siteIds:['1oops']},contextValue:{user}});
    assert.equal(invalid.errors[0].extensions.code,'BAD_USER_INPUT');
  } finally {pool.query = originalQuery; await db.close();}
});
