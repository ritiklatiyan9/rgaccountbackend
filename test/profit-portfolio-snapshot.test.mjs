import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheGet, cacheSet, clearCacheByPrefixes, getCacheGeneration } from '../src/config/cache.js';
import { getProfitPortfolioSnapshot, profitSnapshotKey } from '../src/services/profitPortfolioSnapshot.service.js';

process.env.NODE_ENV = 'test';
process.env.PROFIT_PORTFOLIO_QUEUE_ENABLED = 'false';
const params = id => ({ userId: id, siteIds: [2, 1], end: '2026-10-31', excludeOldPlots: false });
const report = (amount = 10) => ({ data: [{ siteId: 1, amount }], failures: [], completed: 2, total: 2 });

test('cache scope is canonical and separates identities, cutoff and old-plot setting', () => {
  assert.equal(profitSnapshotKey(params(1)), profitSnapshotKey({ ...params(1), siteIds: [1, 2, 2] }));
  for (const changed of [{ userId: 2 }, { end: '2026-11-01' }, { excludeOldPlots: true }, { siteIds: [1] }]) {
    assert.notEqual(profitSnapshotKey(params(1)), profitSnapshotKey({ ...params(1), ...changed }));
  }
});

test('concurrent cold reads share SQL and subsequent navigation uses fresh cache', async () => {
  let calls = 0;
  const build = async () => { calls++; await new Promise(resolve => setImmediate(resolve)); return report(); };
  const [first, second] = await Promise.all([getProfitPortfolioSnapshot(params(10), build), getProfitPortfolioSnapshot(params(10), build)]);
  assert.equal(calls, 1);
  assert.deepEqual(first.value, second.value);
  const third = await getProfitPortfolioSnapshot(params(10), build);
  assert.equal(third.cacheStatus, 'fresh');
  assert.equal(calls, 1);
});

test('explicit refresh waits for a new report rather than returning cached totals', async () => {
  await getProfitPortfolioSnapshot(params(11), async () => report(10));
  const result = await getProfitPortfolioSnapshot({ ...params(11), refresh: true }, async () => report(20));
  assert.equal(result.cacheStatus, 'rebuilt');
  assert.equal(result.value.data[0].amount, 20);
});

test('stale data returns immediately while one background refresh runs without Redis', async () => {
  const key = `site-profit|portfolio:${profitSnapshotKey(params(12))}`;
  await cacheSet(key, { value: report(10), generatedAt: new Date(Date.now() - 60_000).toISOString(), generation: getCacheGeneration(), revision: 'local' }, 300);
  let complete;
  const build = () => new Promise(resolve => { complete = () => resolve(report(30)); });
  const result = await getProfitPortfolioSnapshot(params(12), build);
  assert.equal(result.refreshing, true);
  assert.equal(result.value.data[0].amount, 10);
  complete();
  await new Promise(resolve => setImmediate(resolve));
  const refreshed = await getProfitPortfolioSnapshot(params(12), build);
  assert.equal(refreshed.refreshing, false);
  assert.equal(refreshed.value.data[0].amount, 30);
});

test('a mutation during a read prevents that old read from refilling the cache', async () => {
  let complete;
  const reading = getProfitPortfolioSnapshot(params(13), () => new Promise(resolve => { complete = () => resolve(report(10)); }));
  while (!complete) await new Promise(resolve => setImmediate(resolve));
  await clearCacheByPrefixes(['site-profit|']);
  complete();
  await reading;
  assert.equal(await cacheGet(`site-profit|portfolio:${profitSnapshotKey(params(13))}`), null);
  const result = await getProfitPortfolioSnapshot(params(13), async () => report(50));
  assert.equal(result.value.data[0].amount, 50);
});

test('partial reports never become a cached complete portfolio', async () => {
  let calls = 0;
  const build = async () => { calls++; return { ...report(), failures: [{ id: 2, name: 'Missing' }] }; };
  await getProfitPortfolioSnapshot(params(14), build);
  await getProfitPortfolioSnapshot(params(14), build);
  assert.equal(calls, 2);
});

test('local snapshot count stays bounded across many users and scopes', async () => {
  for (let user = 100; user < 140; user++) await getProfitPortfolioSnapshot(params(user), async () => report(user));
  assert.equal(await cacheGet(`site-profit|portfolio:${profitSnapshotKey(params(100))}`), null);
  assert.ok(await cacheGet(`site-profit|portfolio:${profitSnapshotKey(params(139))}`));
});
