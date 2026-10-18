import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestTransaction, installRequestTransactionAdapter, requestTransactionContext } from '../src/services/requestTransactionContext.js';

function connection(name, calls) {
  return { query: async (sql) => {
    calls.push([name, sql]);
    return { rows: /^INSERT/.test(sql) ? [{ id: name === 'first' ? 1 : 2 }] : [] };
  }, release: () => calls.push([name, 'release']) };
}

test('overlapping requests use separate connections and never share writes or commits', async () => {
  const calls = []; let connections = 0;
  const clients = [connection('first', calls), connection('second', calls)];
  const pool = { query: async sql => { calls.push(['ordinary', sql]); return { rows: [] }; },
    connect: async () => clients[connections++] };
  const { originalConnect } = installRequestTransactionAdapter(pool);
  const writes = [[], []];
  const first = createRequestTransaction({ connect: originalConnect, onWrite: write => writes[0].push(write.rows[0].id) });
  const second = createRequestTransaction({ connect: originalConnect, onWrite: write => writes[1].push(write.rows[0].id) });
  let releaseFirst;
  const barrier = new Promise(resolve => { releaseFirst = resolve; });
  const a = requestTransactionContext.run(first, async () => {
    await pool.query('INSERT INTO expenses DEFAULT VALUES RETURNING id');
    await barrier;
    await pool.query('SELECT first_request');
    await first.finish(true);
  });
  const b = requestTransactionContext.run(second, async () => {
    await pool.query('INSERT INTO expenses DEFAULT VALUES RETURNING id');
    await second.finish(false);
    releaseFirst();
  });
  await Promise.all([a, b]);
  await pool.query('SELECT outside_request');
  assert.deepEqual(writes, [[1], [2]]);
  assert.deepEqual(calls.filter(([name]) => name === 'first').map(([, sql]) => sql),
    ['BEGIN', 'INSERT INTO expenses DEFAULT VALUES RETURNING id', 'SELECT first_request', 'COMMIT', 'release']);
  assert.deepEqual(calls.filter(([name]) => name === 'second').map(([, sql]) => sql),
    ['BEGIN', 'INSERT INTO expenses DEFAULT VALUES RETURNING id', 'ROLLBACK', 'release']);
  assert.deepEqual(calls.at(-1), ['ordinary', 'SELECT outside_request']);
});

test('BEGIN failure releases the checkout and never executes the requested write', async () => {
  const calls = [];
  const transaction = createRequestTransaction({ connect: async () => ({
    query: async sql => { calls.push(sql); throw new Error('BEGIN unavailable'); },
    release: () => calls.push('release'),
  }) });
  await assert.rejects(transaction.query('INSERT INTO expenses DEFAULT VALUES'), /BEGIN unavailable/);
  await transaction.finish(false);
  assert.deepEqual(calls, ['BEGIN', 'release']);
});

test('a failed commit attempts rollback and releases once', async () => {
  const calls = [];
  const transaction = createRequestTransaction({ connect: async () => ({
    query: async sql => { calls.push(sql); if (sql === 'COMMIT') throw new Error('Commit failed'); return { rows: [] }; },
    release: () => calls.push('release'),
  }) });
  await transaction.query('SELECT 1');
  await assert.rejects(transaction.finish(true), /Commit failed/);
  await transaction.finish(false);
  assert.deepEqual(calls, ['BEGIN', 'SELECT 1', 'COMMIT', 'ROLLBACK', 'release']);
  await assert.rejects(transaction.query('SELECT late_write'), /ended/);
});
