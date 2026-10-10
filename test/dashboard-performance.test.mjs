import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { graphql } from 'graphql';
import { schema } from '../src/graphql/schema.js';
import pool from '../src/config/db.js';
import { plotRegistryModel } from '../src/models/PlotRegistry.model.js';
import { clearCacheByPrefixes } from '../src/config/cache.js';
import { readDashboardCache } from '../src/graphql/services/dashboardCache.js';

const contextValue = { user: { id: 1, role: 'admin' } };
const variableValues = {
  siteId: '5', range: { start: '2000-01-01', end: '2026-10-11' },
  excludeOldPlots: false, includeImprestDistribution: false,
};
const frontendQueries = await readFile(new URL('../../rgaccount/src/graphql/queries.js', import.meta.url), 'utf8');
const querySource = name => frontendQueries.match(new RegExp(`export const ${name} = gql\x60([\\s\\S]*?)\x60;`))[1];
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(sql) {
  if (sql.includes('source_key AS source_type')) return [{ source_type: 'expenses', total_debit: 300, txn_count: 2 }];
  if (sql.includes('AS final_sale_value')) return [{ final_sale_value: 1000, sale_value: 1000,
    received: 600, matched_received: 600, remaining: 400, plot_count: 1 }];
  if (sql.includes('FROM sold_deals')) return [{ sale_value: 100, purchase_cost: 50, book_profit: 50,
    received: 70, paid_to_farmers: 30, purchase_cost_already_expensed: 20, deal_count: 1 }];
  if (sql.includes('AS balance_before_imprest')) return [{ cash_balance: 200, bank_balance: 400,
    balance_before_imprest: 600, imprest_held: 50, distributable_balance: 150, site_balance: 550 }];
  if (sql.includes('AS given')) return [{ given: 100, returned: 20 }];
  if (sql.includes('FROM activity')) return [{ total: 250, cash_total: 100, bank_total: 150,
    new_total: 250, new_cash: 100, new_bank: 150, new_count: 2, txn_count: 2 }];
  return [{ total: 300 }];
}

test('the actual dashboard query runs seven KPI groups and preserves the financial formulas', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  const originalQuery = pool.query;
  const originalRegistries = plotRegistryModel.findBySiteId;
  const reads = [];
  pool.query = async (sql, params) => { reads.push({ sql, params }); return { rows: fixture(sql) }; };
  plotRegistryModel.findBySiteId = async () => [];
  try {
    const execute = () => graphql({ schema, source: querySource('GET_KPI_CARDS'), contextValue, variableValues });
    const result = await execute();
    assert.equal(result.errors, undefined);
    assert.equal(reads.length, 7, 'unused KPI groups and duplicated TDS/partner summaries do not run');
    assert.ok(reads.every(read => read.params[0] === 5));
    const kpi = result.data.kpiCards;
    assert.equal(kpi.expectedProfit, 770);
    assert.equal(kpi.currentProfit, 370);
    assert.equal(kpi.totalExpense, 300);
    assert.equal(kpi.siteBalance, 550);
    assert.equal(kpi.outstanding, 80);
    assert.equal(kpi.registryPaymentDetail.total, 250);
    assert.equal(kpi.breakdown, undefined, 'expense details are loaded only when opened');
    assert.equal(kpi.imprestDistribution, undefined);
    assert.deepEqual(await execute(), result);
    assert.equal(reads.length, 7, 'a repeat load is served without more SQL');

    await clearCacheByPrefixes(['dashboard:']);
    await execute();
    assert.equal(reads.length, 14, 'a successful mutation invalidates the report');
  } finally {
    pool.query = originalQuery;
    plotRegistryModel.findBySiteId = originalRegistries;
  }
});

test('expense details retain the existing API contract and load independently of headline cards', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  const original = pool.query;
  let reads = 0;
  pool.query = async sql => { reads += 1; return { rows: fixture(sql) }; };
  try {
    const result = await graphql({ schema, source: querySource('GET_KPI_EXPENSE_BREAKDOWN'), contextValue, variableValues });
    assert.equal(result.errors, undefined);
    assert.equal(reads, 4);
    const expenses = result.data.kpiCards.breakdown.find(row => row.module === 'expenses');
    assert.deepEqual(JSON.parse(JSON.stringify(expenses)), { module: 'expenses', debit: 300, credit: 0, count: 2 });
  } finally { pool.query = original; }
});

test('aliases, fragments and optional fields select only required queries with separate cache entries', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  const original = pool.query;
  let reads = 0;
  pool.query = async sql => { reads += 1; return { rows: fixture(sql) }; };
  const source = `query($includeCash: Boolean!) {
    kpiCards(siteId: 5, range: {start: "2000-01-01", end: "2026-10-11"}) {
      ...Profit
      ... @include(if: $includeCash) { cashflow }
      ...Unused @skip(if: true)
    }
  }
  fragment Profit on KpiCards { profit: currentProfit }
  fragment Unused on KpiCards { imprestGiven }`;
  try {
    const result = await graphql({ schema, source, contextValue, variableValues: { includeCash: false } });
    assert.equal(result.errors, undefined);
    assert.equal(result.data.kpiCards.profit, 370);
    assert.equal(reads, 3);
    const withCash = await graphql({ schema, source, contextValue, variableValues: { includeCash: true } });
    assert.equal(withCash.errors, undefined);
    assert.equal(reads, 7, 'the second selection executes its four required groups');
  } finally { pool.query = original; }
});

test('both dashboard charts share one SQL aggregation and check access even on a cache hit', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  const original = pool.query;
  let reads = 0;
  pool.query = async () => { reads += 1; await tick(); return { rows: [
    { date: '2026-01-01', label: '2026', revenue: 100, expense: 40 },
  ] }; };
  const source = querySource('GET_DASHBOARD_TRENDS');
  try {
    const result = await graphql({ schema, source, contextValue, variableValues });
    assert.equal(result.errors, undefined);
    assert.equal(reads, 1);
    assert.equal(result.data.revenueVsExpense[0].revenue, 100);
    assert.equal(result.data.profitTrend[0].value, 60);
    const forbidden = await graphql({ schema, source, variableValues,
      contextValue: { user: { role: 'sub_admin' }, permissions: new Map(), siteIds: new Set([5]) } });
    assert.equal(forbidden.errors[0].extensions.code, 'FORBIDDEN');
    assert.equal(reads, 1);
    const otherSite = await graphql({ schema, source, contextValue, variableValues: { ...variableValues, siteId: '6' } });
    assert.equal(otherSite.errors, undefined);
    assert.equal(reads, 2, 'sites never share cached figures');
  } finally { pool.query = original; }
});

test('simultaneous cold reads share work and failures can be retried', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  let reads = 0;
  const load = async () => { reads += 1; await tick(); return { value: 12 }; };
  const results = await Promise.all(Array.from({ length: 12 }, () => readDashboardCache('dashboard:test:shared', load)));
  assert.equal(reads, 1);
  assert.ok(results.every(result => result.value === 12));
  const failure = new Error('report failed');
  await assert.rejects(readDashboardCache('dashboard:test:retry', () => { throw failure; }), error => error === failure);
  assert.deepEqual(await readDashboardCache('dashboard:test:retry', load), { value: 12 });
  assert.equal(reads, 2);
});

test('invalidation during a report prevents joining or caching that stale report', async () => {
  await clearCacheByPrefixes(['dashboard:']);
  let finishOld;
  const old = readDashboardCache('dashboard:test:race', () => new Promise(resolve => { finishOld = resolve; }));
  await tick();
  await clearCacheByPrefixes(['dashboard:']);
  const fresh = await readDashboardCache('dashboard:test:race', async () => ({ value: 20 }));
  finishOld({ value: 10 });
  assert.deepEqual(await old, { value: 10 });
  assert.deepEqual(fresh, { value: 20 });
  assert.deepEqual(await readDashboardCache('dashboard:test:race', () => { throw new Error('must be cached'); }), { value: 20 });
});
