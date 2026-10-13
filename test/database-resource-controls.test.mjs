import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import { BoundedPool, databasePoolStats, boundedInteger } from '../src/config/boundedPool.js';
import { createBoundedWork, mapWithConcurrency } from '../src/utils/boundedWork.js';
import { isDatabaseUnavailable } from '../src/utils/databaseError.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { resolve, reject, promise };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

// Exercise the real installed pg-pool lifecycle without any database/network.
class FakeClient extends EventEmitter {
  _queryable = true;
  connect(callback) { process.nextTick(callback); }
  query(sql, values, callback) {
    if (typeof values === 'function') callback = values;
    if (callback) process.nextTick(callback, null, { rows: [sql] });
    else return Promise.resolve({ rows: [sql] });
  }
  end(callback) { process.nextTick(() => { this.emit('end'); callback?.(); }); }
  ref() {}
  unref() {}
}

test('pool caps new checkouts, preserves existing transaction clients, and recovers', async t => {
  const pool = new BoundedPool({ Client: FakeClient, max: 2, maxWaiting: 2, connectionTimeoutMillis: 100 });
  t.after(() => pool.end());
  const first = await pool.connect(), second = await pool.connect();
  const queuedFirst = pool.connect(), queuedSecond = pool.connect();
  const burst = await Promise.allSettled(Array.from({ length: 100 }, () => pool.connect()));
  assert.ok(burst.every(result => result.status === 'rejected' && result.reason.code === 'DATABASE_POOL_BUSY'));
  assert.deepEqual(databasePoolStats(pool), { max: 2, total: 2, idle: 0, active: 2, waiting: 2,
    maxWaiting: 2, rejectedCheckouts: 100 });
  // Admission only concerns obtaining a NEW client, including pool.query.
  assert.deepEqual((await first.query('COMMIT')).rows, ['COMMIT']);
  const callbackError = await new Promise(resolve => pool.connect(resolve));
  assert.equal(callbackError.code, 'DATABASE_POOL_BUSY');
  await assert.rejects(pool.query('SELECT 1'), { code: 'DATABASE_POOL_BUSY' });
  first.release(); second.release();
  (await queuedFirst).release(); (await queuedSecond).release();
  assert.deepEqual((await pool.query('SELECT recovered')).rows, ['SELECT recovered']);
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.totalCount, 2);
});

test('native checkout timeout removes pending work and leaves pool reusable', async t => {
  const pool = new BoundedPool({ Client: FakeClient, max: 1, maxWaiting: 1, connectionTimeoutMillis: 5 });
  t.after(() => pool.end());
  const client = await pool.connect();
  // pg unrefs its acquisition timer; keep this synthetic test alive briefly.
  const keepAlive = setTimeout(() => {}, 50);
  try { await assert.rejects(pool.connect(), /timeout exceeded when trying to connect/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(pool.waitingCount, 0);
  client.release();
  const recovered = await pool.connect(); recovered.release();
});

test('queued driver callbacks restore the requesting context for pool query instrumentation', async t => {
  const context = new AsyncLocalStorage();
  const pool = new BoundedPool({ Client: FakeClient, max: 1, maxWaiting: 2, connectionTimeoutMillis: 100 });
  t.after(() => pool.end());
  const first = await context.run('first-request', () => pool.connect());
  const queued = context.run('second-request', () => new Promise((resolve, reject) => {
    pool.connect((error, client) => {
      if (error) return reject(error);
      const value = context.getStore(); client.release(); resolve(value);
    });
  }));
  context.run('first-request', () => first.release());
  assert.equal(await queued, 'second-request');
});

test('bounded read queue fails fast on overload, retains FIFO and never executes expired work', async () => {
  const active = deferred();
  const started = [];
  const run = createBoundedWork(value => { started.push(value); return value === 1 ? active.promise : value; },
    { concurrency: 1, maxPending: 2, queueTimeoutMs: 15 });
  const first = run(1), second = run(2), third = run(3);
  const queued = Promise.allSettled([second, third]);
  await assert.rejects(run(4), { code: 'DATABASE_READ_BUSY', statusCode: 503 });
  assert.equal(run.getStats().pending, 2);
  assert.ok((await queued).every(result => result.status === 'rejected' && result.reason.code === 'DATABASE_READ_BUSY'));
  active.resolve('complete');
  assert.equal(await first, 'complete');
  assert.equal(await run(5), 5);
  assert.deepEqual(started, [1, 5]);
  assert.deepEqual(run.getStats(), { active: 0, pending: 0, concurrency: 1, maxPending: 2,
    queueTimeoutMs: 15, rejected: 3, completed: 2, peakActive: 1, peakPending: 2 });
});

test('queue preserves original failure values and releases its slot before resolving', async () => {
  const error = Object.assign(new Error('query cancelled'), { code: '57014' });
  const run = createBoundedWork(value => { if (value === 1) throw error; if (value === 2) return Promise.reject(null); return value; });
  const results = await Promise.allSettled([run(1), run(2), run(3)]);
  assert.equal(results[0].reason, error); assert.equal(results[1].reason, null);
  assert.equal(results[2].value, 3); assert.equal(run.getStats().active, 0);
});

test('queued queries retain their caller context when another request releases a slot', async () => {
  const context = new AsyncLocalStorage(), gate = deferred();
  const run = createBoundedWork(async value => {
    if (value === 1) await gate.promise;
    return context.getStore();
  }, { concurrency: 1 });
  const first = context.run('first-user', () => run(1));
  const second = context.run('second-user', () => run(2));
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), ['first-user', 'second-user']);
});

test('bounded mapping preserves order and waits for started work on failure', async () => {
  const first = deferred(), second = deferred();
  const starts = [];
  let settled = false;
  const mapped = mapWithConcurrency([1, 2, 3, 4], 2, value => {
    starts.push(value); return value === 1 ? first.promise : second.promise;
  });
  const result = mapped.catch(error => { settled = true; return error; });
  const error = new Error('failed'); first.reject(error);
  await tick(); assert.equal(settled, false);
  second.resolve('done'); assert.equal(await result, error);
  assert.deepEqual(starts, [1, 2], 'do not launch additional queries after failure');
  assert.deepEqual(await mapWithConcurrency([3, 2, 1], 2, async value => value * 2), [6, 4, 2]);
});

test('resource configuration rejects malformed limits and preserves configured caps', () => {
  assert.equal(boundedInteger('2junk', 10, 20), 10);
  assert.equal(boundedInteger('2.5', 10, 20), 10);
  assert.equal(boundedInteger('-1', 10, 20), 10);
  assert.equal(boundedInteger('200', 10, 20), 20);
  assert.equal(boundedInteger('3', 10, 20), 3);
  assert.throws(() => createBoundedWork(() => {}, { concurrency: 0 }), RangeError);
  assert.throws(() => new BoundedPool({ maxWaiting: 0 }), RangeError);
  for (const code of ['DATABASE_POOL_BUSY', 'DATABASE_READ_BUSY']) assert.ok(isDatabaseUnavailable({ code }));
});
