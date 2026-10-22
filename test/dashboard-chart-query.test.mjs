import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import pool from '../src/config/db.js';
import { getRevenueVsExpense } from '../src/graphql/services/charts.service.js';
import { dashboardChartBaselineSql } from './support/dashboard-chart-baseline.mjs';
import { createDashboardChartFixture } from './support/dashboard-chart-fixture.mjs';

test('shared chart bounds preserve every source, date boundary, OLD filter and posted financial total', async t => {
  const db = new PGlite();
  const original = pool.query;
  let executed;
  pool.query = async (sql, params) => { executed = { sql, params }; return db.query(sql, params); };
  try {
    await createDashboardChartFixture(db);
    await db.exec(`
      INSERT INTO plots VALUES (1,1,'OLD'),(2,1,NULL),(3,2,'');
      INSERT INTO farmers VALUES (1,1);
      INSERT INTO land_deals VALUES (1,1,'open'),(2,1,'cancelled');
      INSERT INTO plot_payments VALUES (1,1,1,'2026-01-01'),(2,1,2,'2026-01-03'),
        (3,1,2,'2025-12-31'),(4,1,2,'2027-01-01'),(5,2,3,'2026-12-30'),(6,1,2,NULL);
      INSERT INTO plot_installment_payments VALUES (1,2,'2026-01-04');
      INSERT INTO land_deal_payments VALUES (1,1,'2026-01-05'),(2,2,'2026-12-31');
      INSERT INTO farmer_payments VALUES (1,1,'2026-01-06');
      INSERT INTO expenses VALUES (3,1,'2026-01-07');
      INSERT INTO plot_commission_payments VALUES (1,1,'2026-01-08');
      INSERT INTO vendor_payments VALUES (1,1,'2026-01-09');
      INSERT INTO vendor_inventory_payments VALUES (1,1,'2026-01-10',NULL),(2,1,'2026-01-20',123);
      INSERT INTO ledger_entries VALUES
        (1,1,'2026-01-01','plot_payments',1,0,100,'OLD','site'),
        (2,1,'2026-01-03','plot_payments',2,25,200,'','site'),
        (3,1,'2026-01-07','expenses',3,50,10,'','site'),
        (4,1,'2026-01-07','expenses',4,999,0,'','person'),
        (5,1,'2026-01-07','expenses',5,900,0,'','site'),
        (6,1,'2026-01-05','land_deal_payments',1,0,60,'','site'),
        (7,1,'2026-01-05','land_deal_payments',2,0,999,'','site'),
        (8,2,'2026-01-03','plot_payments',5,0,999,'','site'),
        (9,1,'2027-01-01','expenses',9,999,0,'','site');
      INSERT INTO tds_settlements VALUES (5);
      INSERT INTO tds_accounting_deductions VALUES
        (1,1,'2026-01-07','expenses',3,NULL,7,47,'active'),
        (2,1,'2026-01-07','expenses',3,NULL,99,139,'inactive'),
        (3,1,'2026-01-03','plot_payments',2,NULL,99,299,'active');
    `);
    for (const excludeOldPlots of [false, true]) {
      for (const resolution of ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR']) {
        await t.test(`${resolution}, exclude OLD = ${excludeOldPlots}`, async () => {
          const result = await getRevenueVsExpense(1, '2026-01-01', '2027-01-01', resolution, excludeOldPlots);
          const { sql, params } = executed;
          if (resolution === 'QUARTER') {
            // PostgreSQL accepts date_trunc('quarter') but not INTERVAL '1 quarter'.
            await assert.rejects(db.query(dashboardChartBaselineSql(sql, excludeOldPlots), params), { code: '22007' });
            assert.equal(result.length, 1);
            assert.equal(result[0].label, 'Q1 26');
          } else {
            const baseline = await db.query(dashboardChartBaselineSql(sql, excludeOldPlots), params);
            assert.deepEqual(result, baseline.rows.map(row => ({ ...row, revenue: Number(row.revenue), expense: Number(row.expense) })));
          }
          assert.equal(result.reduce((sum, row) => sum + row.revenue, 0), excludeOldPlots ? 235 : 335);
          assert.equal(result.reduce((sum, row) => sum + row.expense, 0), 47);
          if (resolution === 'DAY') {
            assert.equal(result.length, excludeOldPlots ? 8 : 10);
            assert.equal(result[0].date.toISOString().slice(0, 10), excludeOldPlots ? '2026-01-03' : '2026-01-01');
            assert.equal(result.at(-1).date.toISOString().slice(0, 10), '2026-01-10');
          }
        });
      }
    }
    await t.test('empty site and empty range retain fallback series and zero totals', async () => {
      for (const [site, start, end] of [[99,'2026-01-01','2026-02-01'],[1,'2026-02-01','2026-03-01']]) {
        const result = await getRevenueVsExpense(site, start, end, 'DAY');
        const { sql, params } = executed;
        const baseline = await db.query(dashboardChartBaselineSql(sql), params);
        assert.deepEqual(result, baseline.rows.map(row => ({ ...row, revenue: Number(row.revenue), expense: Number(row.expense) })));
        assert.ok(result.every(row => row.revenue === 0 && row.expense === 0));
      }
    });
    await t.test('quarterly series advances by three months across the full requested year', async () => {
      const result = await getRevenueVsExpense(99, '2026-01-01', '2027-01-01', 'QUARTER');
      assert.deepEqual(result.map(row => row.label), ['Q1 26', 'Q2 26', 'Q3 26', 'Q4 26']);
      assert.ok(result.every(row => row.revenue === 0 && row.expense === 0));
    });
    await t.test('bounds plans scan each joined installment source once instead of twice', async () => {
      await getRevenueVsExpense(1, '2026-01-01', '2027-01-01', 'YEAR');
      const { sql, params } = executed;
      const scans = async query => {
        const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, params);
        let count = 0;
        const walk = node => {
          if (node['Relation Name'] === 'plot_installment_payments' && node['Actual Loops'] > 0) count++;
          (node.Plans || []).forEach(walk);
        };
        walk(rows[0]['QUERY PLAN'][0].Plan);
        return count;
      };
      assert.equal(await scans(dashboardChartBaselineSql(sql)), 2);
      assert.equal(await scans(sql), 1);
    });
  } finally {
    pool.query = original;
    await db.close();
  }
});
