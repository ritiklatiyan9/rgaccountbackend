import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { createFinancialReadQueue } from '../src/config/financialReportDb.js';
import { getRevenue } from '../src/graphql/services/kpi.service.js';
import { getRevenueVsExpense, getProfitTrend } from '../src/graphql/services/charts.service.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('KPI and chart reads share a two-query limit across simultaneous sites', async () => {
  const original = pool.query;
  const running = [];
  let active = 0;
  let peak = 0;
  pool.query = (sql, params) => {
    const task = deferred();
    active += 1;
    peak = Math.max(peak, active);
    running.push({ task, params });
    return task.promise.finally(() => { active -= 1; });
  };
  try {
    const reads = [
      ...Array.from({ length: 16 }, (_, i) => getRevenue(i + 1, '2000-01-01', '2026-10-07')),
      getRevenueVsExpense(7, '2000-01-01', '2026-10-07', 'YEAR'),
      getProfitTrend(10, '2000-01-01', '2026-10-07', 'YEAR'),
    ];
    await tick();
    assert.equal(running.length, 2, 'only two reports reach PostgreSQL initially');
    let completed = 0;
    while (completed < reads.length) {
      const batch = running.splice(0);
      assert.ok(batch.length > 0);
      for (const { task, params } of batch) {
        task.resolve({ rows: [{ total: params[0], date: '2026-01-01', label: '2026', revenue: 100, expense: 40 }] });
        completed += 1;
      }
      await tick();
    }
    const results = await Promise.all(reads);
    assert.equal(peak, 2, 'chart requests cannot bypass the KPI limit');
    assert.deepEqual(results.slice(0, 16), Array.from({ length: 16 }, (_, i) => i + 1));
    assert.equal(results[16][0].revenue, 100);
    assert.equal(results[17][0].value, 60);
    assert.equal(active, 0);
  } finally {
    pool.query = original;
  }
});

test('failed and synchronously throwing reads release their slot and retain the original error', async () => {
  const databaseError = Object.assign(new Error('out of memory'), { code: '53200' });
  const first = deferred();
  const started = [];
  const query = createFinancialReadQueue((value) => {
    started.push(value);
    if (value === 1) return first.promise;
    if (value === 2) throw databaseError;
    return { rows: [value] };
  }, 1);
  const results = Promise.allSettled([query(1), query(2), query(3)]);
  await tick();
  assert.deepEqual(started, [1]);
  first.reject(databaseError);
  const settled = await results;
  assert.deepEqual(started, [1, 2, 3]);
  assert.equal(settled[0].reason, databaseError);
  assert.equal(settled[1].reason, databaseError);
  assert.deepEqual(settled[2], { status: 'fulfilled', value: { rows: [3] } });
  assert.deepEqual(await query(4), { rows: [4] });
});
