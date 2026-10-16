import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureWalletStartup, walletRuntimeFunctions } from '../src/services/walletStartup.service.js';

const runtimeRows = () => walletRuntimeFunctions.map(({ name, body }) => ({ name, body }));

test('an installed wallet starts with reads only and never locks or rebuilds live tables', async () => {
  const calls = [];
  const plan = ['base','consolidation','guard'].map(version => [version, async () => { throw new Error('Installed schema must not be rebuilt'); }]);
  const db = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rows: sql.includes('pg_proc') ? runtimeRows() : plan.map(([version]) => ({ version })) };
  }, connect() { throw new Error('No migration transaction should be opened'); } };
  assert.deepEqual(await ensureWalletStartup(db, plan), { applied: [], current: true, repaired: [] });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => /^SELECT /.test(call.sql)));
  assert.deepEqual(calls[0].params, [['base','consolidation','guard']]);
});

test('a partial upgrade resumes at its gap and restores later guards in order', async () => {
  const installed = new Set(['base','guard']);
  const calls = [];
  const db = { query: async sql => ({ rows: sql.includes('pg_proc') ? runtimeRows() : [...installed].map(version => ({ version })) }) };
  const plan = ['base','consolidation','guard'].map(version => [version, async database => {
    assert.equal(database, db); calls.push(version); installed.add(version);
  }]);
  assert.deepEqual(await ensureWalletStartup(db, plan), { applied: ['consolidation','guard'], current: false, repaired: [] });
  assert.deepEqual(calls, ['consolidation','guard']);
  assert.deepEqual(await ensureWalletStartup(db, plan), { applied: [], current: true, repaired: [] });
  assert.deepEqual(calls, ['consolidation','guard']);
});

test('a prior interrupted boot restores runtime functions without touching financial tables or triggers', async () => {
  const writes = [];
  const db = { query: async sql => ({ rows: sql.includes('pg_proc') ? [] : [{ version: 'installed' }] }),
    connect: async () => ({ query: async sql => { writes.push(sql); }, release() {} }) };
  const result = await ensureWalletStartup(db, [['installed', async () => { throw new Error('No migration replay'); }]]);
  assert.deepEqual(result.repaired, walletRuntimeFunctions.map(fn => fn.name));
  assert.equal(writes[0], 'BEGIN');
  assert.equal(writes.at(-1), 'COMMIT');
  const repair = writes[2];
  assert.ok(repair.startsWith('CREATE OR REPLACE FUNCTION '));
  assert.doesNotMatch(repair, /ALTER TABLE|CREATE TRIGGER|DROP TRIGGER|UPDATE loyalty_vault_accounts SET reserved_balance/);
});

test('a failed schema upgrade stops startup and never reports readiness', async () => {
  const db = { query: async () => ({ rows: [] }) };
  const failure = Object.assign(new Error('deadlock detected'), { code: '40P01' });
  let laterRan = false;
  await assert.rejects(ensureWalletStartup(db, [
    ['base', async () => { throw failure; }],
    ['guard', async () => { laterRan = true; }],
  ]), error => error === failure);
  assert.equal(laterRan, false);
});

test('a database read failure is preserved and cannot be mistaken for a current schema', async () => {
  const failure = new Error('Connection lost');
  await assert.rejects(ensureWalletStartup({ query: async () => { throw failure; } }), error => error === failure);
});
