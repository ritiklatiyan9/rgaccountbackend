import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { instrumentDatabaseClient, requestPerformance } from '../src/utils/requestPerformance.js';

function fixture() {
  const records = [];
  const middleware = requestPerformance({ enabled: () => true, log: entry => records.push(entry), poolStats: () => ({ active: 2, waiting: 0 }) });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, getHeader: () => '123' });
  return { records, middleware, res };
}

test('query diagnostics keep simultaneous HTTP scopes apart without logging financial or auth data', async () => {
  const client = { async query(sql) { await new Promise(resolve => setTimeout(resolve, 2)); return { rows: [{ balance: '99' }] }; } };
  instrumentDatabaseClient(client); instrumentDatabaseClient(client);
  const a = fixture(), b = fixture();
  const run = ({ middleware, res }, count) => new Promise((resolve, reject) => middleware({
    method: 'GET', route: { path: '/:id' }, baseUrl: '/secret-token', query: { secret: 'private' },
  }, res, async () => {
    try { for (let n = 0; n < count; n++) await client.query('SELECT private_balance'); res.emit('finish'); res.emit('close'); resolve(); }
    catch (error) { reject(error); }
  }));
  await Promise.all([run(a, 2), run(b, 1)]);
  assert.equal(a.records.length, 1); assert.equal(b.records.length, 1);
  assert.equal(a.records[0].query_count, 2); assert.equal(b.records[0].query_count, 1);
  assert.ok(a.records[0].query_total_ms > 0); assert.ok(a.records[0].query_slowest_ms > 0);
  assert.equal(a.records[0].payload_bytes, 123);
  assert.doesNotMatch(JSON.stringify(a.records), /private|secret-token|balance|99/);
});

test('callback queries and query errors are counted; disabled diagnostics preserve original calls', async () => {
  const client = { query(_sql, callback) {
    if (_sql === 'throw') throw new Error('fixture failure');
    if (callback) return queueMicrotask(() => callback(null, { rows: [] }));
    return Promise.resolve({ rows: [] });
  } };
  instrumentDatabaseClient(client);
  const { middleware, res, records } = fixture();
  await new Promise((resolve, reject) => middleware({ method: 'POST', route: { path: '/save' } }, res, async () => {
    try {
      await new Promise(done => client.query('BEGIN', () => done()));
      assert.throws(() => client.query('throw'), /fixture failure/);
      res.emit('finish'); resolve();
    } catch (error) { reject(error); }
  }));
  assert.equal(records[0].query_count, 2);
  requestPerformance({ enabled: () => false, log: () => assert.fail() })({}, res, () => {});
  assert.deepEqual(await client.query('plain'), { rows: [] });
});
