// Deterministic resource-control benchmark. No credentials, network, SQL data,
// migrations or API server are used. It runs the real installed pg-pool with a
// simulated 5ms database client; this measures admission, not production SQL.
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { BoundedPool, databasePoolStats } from '../src/config/boundedPool.js';
import { createBoundedWork } from '../src/utils/boundedWork.js';

class TimedClient extends EventEmitter {
  _queryable = true;
  connect(callback) { process.nextTick(callback); }
  query(sql, values, callback) {
    if (typeof values === 'function') callback = values;
    setTimeout(() => callback(null, { rows: [{ result: 1 }] }), 5);
  }
  end(callback) { process.nextTick(() => { this.emit('end'); callback?.(); }); }
  ref() {}
  unref() {}
}

// Original financialReportDb.js admission algorithm before the audit.
const unboundedFinancialQueue = task => {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (active < 2 && pending.length) {
      const item = pending.shift(); active += 1;
      Promise.resolve().then(() => task()).then(item.resolve, item.reject)
        .finally(() => { active -= 1; drain(); });
    }
  };
  const run = () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); drain(); });
  run.getStats = () => ({ active, pending: pending.length, concurrency: 2 });
  return run;
};

const quantile = (values, pct) => Math.round(values[Math.max(0, Math.ceil(values.length * pct) - 1)] * 100) / 100;
const latencies = values => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return { p50: quantile(values, .5), p95: quantile(values, .95), p99: quantile(values, .99) };
};

async function measure(name, count, run, stats, close = async () => {}) {
  const start = performance.now();
  const promises = Array.from({ length: count }, () => {
    const created = performance.now();
    return run().then(() => ({ ok: true, ms: performance.now() - created }),
      error => ({ ok: false, ms: performance.now() - created, code: error.code }));
  });
  const peak = stats();
  const results = await Promise.all(promises);
  const durationMs = performance.now() - start;
  const successes = results.filter(row => row.ok), failures = results.filter(row => !row.ok);
  const final = stats();
  await close();
  return { name, requests: count, completed: successes.length, rejected: failures.length,
    errorRate: failures.length / count, durationMs: Math.round(durationMs * 100) / 100,
    successfulThroughputPerSecond: Math.round(successes.length * 1000 / durationMs),
    successfulLatencyMs: latencies(successes.map(row => row.ms)),
    rejectedLatencyMs: latencies(failures.map(row => row.ms)), peak, final };
}

const output = { measuredAt: new Date().toISOString(), node: process.version,
  scope: 'Real pg-pool lifecycle with simulated 5ms query cost; no production performance claims', scenarios: [] };
for (const count of [20, 100]) {
  for (const optimized of [false, true]) {
    let active = 0, maxActive = 0, started = 0;
    const task = async () => {
      active += 1; maxActive = Math.max(maxActive, active); started += 1;
      await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
    };
    const run = optimized ? createBoundedWork(task) : unboundedFinancialQueue(task);
    output.scenarios.push(await measure(`financial-${count}-${optimized ? 'optimized' : 'baseline'}`, count, run,
      () => ({ ...run.getStats(), databaseActive: active, maxDatabaseActive: maxActive })));
  }
}
for (const count of [20, 200]) {
  for (const optimized of [false, true]) {
    const Pool = optimized ? BoundedPool : pg.Pool;
    const pool = new Pool({ Client: TimedClient, max: 10, maxWaiting: 64, connectionTimeoutMillis: 1000 });
    output.scenarios.push(await measure(`pool-${count}-${optimized ? 'optimized' : 'baseline'}`, count,
      () => pool.query('SELECT simulated_probe'), () => databasePoolStats(pool), () => pool.end()));
  }
}
console.log(JSON.stringify(output, null, 2));
