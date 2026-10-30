import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import pool from '../src/config/db.js';
import { cacheGet, cacheSet, getCacheGeneration, clearCacheByPrefixes } from '../src/config/cache.js';
import { getProfitPortfolioSnapshot, profitSnapshotKey, getProfitPortfolioQueueStatus, closeProfitPortfolioQueue } from '../src/services/profitPortfolioSnapshot.service.js';

// This test owns its Redis child process and never connects to a project Redis
// or database. It skips cleanly on systems without the optional Redis binary.
test('BullMQ consumes stale refresh jobs; reconnect fences snapshots invalidated offline', { timeout: 15_000 }, async t => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  try { await once(listener, 'listening'); } catch (error) {
    if (error.code === 'EPERM') { t.skip('loopback listeners are restricted'); return; }
    throw error;
  }
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.env.REDIS_SERVER_BIN || 'redis-server', ['--bind', '127.0.0.1', '--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const started = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 3000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.stdout.on('data', chunk => { if (chunk.toString().includes('Ready to accept connections')) { clearTimeout(timer); resolve(true); } });
    child.once('exit', () => { clearTimeout(timer); resolve(false); });
  });
  if (!started) { child.kill(); t.skip('redis-server is unavailable'); return; }
  const oldQuery = pool.query;
  const oldUrl = process.env.PROFIT_PORTFOLIO_REDIS_URL;
  process.env.NODE_ENV = 'test';
  process.env.PROFIT_PORTFOLIO_REDIS_URL = `redis://127.0.0.1:${port}`;
  process.env.PROFIT_PORTFOLIO_QUEUE_ENABLED = 'true';
  let financialReads = 0;
  pool.query = async sql => {
    if (sql.includes('WITH requested AS MATERIALIZED')) { financialReads++; return { rows: [{ site_id: 1, running_expense: 99 }] }; }
    return { rows: [] };
  };
  const params = { userId: 77, siteIds: [1], end: '2026-10-31', excludeOldPlots: false };
  const report = () => ({ data: [{ siteId: 1, profit: { runningExpense: 10 } }], failures: [], total: 1, completed: 1 });
  let client;
  try {
    await getProfitPortfolioSnapshot(params, async () => report());
    const until = Date.now() + 4000;
    while (!getProfitPortfolioQueueStatus().ready && Date.now() < until) await delay(20);
    assert.equal(getProfitPortfolioQueueStatus().ready, true, 'optional queue starts successfully');
    const { default: Redis } = await import('ioredis');
    client = new Redis(process.env.PROFIT_PORTFOLIO_REDIS_URL);
    // The ready request flushes startup/offline mutation fences before cache use.
    await getProfitPortfolioSnapshot(params, async () => report());
    const revision = String(await client.get('profit-portfolio:revision') || '0');
    const key = `site-profit|portfolio:${profitSnapshotKey(params)}`;
    await cacheSet(key, { value: report(), generatedAt: new Date(Date.now() - 60_000).toISOString(), generation: getCacheGeneration(), revision }, 300);
    const stale = await getProfitPortfolioSnapshot(params, async () => { throw new Error('must use the Bull worker'); });
    assert.equal(stale.refreshing, true);
    const completeBy = Date.now() + 4000;
    while (!financialReads && Date.now() < completeBy) await delay(20);
    while ((await cacheGet(key))?.value.data[0]?.profit.runningExpense !== 99 && Date.now() < completeBy) await delay(20);
    assert.equal(financialReads, 1, 'worker computes exactly one batched financial report');
    assert.equal((await cacheGet(key)).value.data[0].profit.runningExpense, 99);
    const before = Number(await client.get('profit-portfolio:revision'));
    child.kill('SIGSTOP');
    await clearCacheByPrefixes(['site-profit|']);
    child.kill('SIGCONT');
    await getProfitPortfolioSnapshot(params, async () => report());
    assert.ok(Number(await client.get('profit-portfolio:revision')) > before, 'offline mutations fence shared snapshots before re-use');
  } finally {
    pool.query = oldQuery;
    if (oldUrl === undefined) delete process.env.PROFIT_PORTFOLIO_REDIS_URL;
    else process.env.PROFIT_PORTFOLIO_REDIS_URL = oldUrl;
    await closeProfitPortfolioQueue();
    client?.disconnect();
    child.kill('SIGCONT');
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});
