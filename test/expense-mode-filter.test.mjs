import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModeWhere, MODE_BUCKET_FILTERS } from '../src/models/Expense.model.js';

test('no mode filter adds no clause and consumes no parameter', () => {
  const params = ['site'];
  assert.deepEqual(buildModeWhere(undefined, params, 2), { clause: '', pIdx: 2 });
  assert.deepEqual(params, ['site']);
});

test('a bucket filter defers to the database ledger_bucket() rule', () => {
  const params = [];
  const cash = buildModeWhere('BUCKET:CASH', params, 2);
  assert.match(cash.clause, /ledger_bucket\(u\.payment_mode\) = \$2/);
  assert.equal(cash.pIdx, 3);
  assert.deepEqual(params, ['cash']);

  const bankParams = [];
  const bank = buildModeWhere('BUCKET:BANK', bankParams, 5);
  assert.match(bank.clause, /ledger_bucket\(u\.payment_mode\) = \$5/);
  assert.deepEqual(bankParams, ['bank']);
  // Only these two buckets exist — the Day Book uses the same pair.
  assert.deepEqual(Object.values(MODE_BUCKET_FILTERS).sort(), ['bank', 'cash']);
});

test('UNSPECIFIED stays a literal blank test and an exact mode still binds', () => {
  const blankParams = [];
  const blank = buildModeWhere('UNSPECIFIED', blankParams, 2);
  assert.match(blank.clause, /payment_mode IS NULL OR u\.payment_mode = ''/);
  assert.equal(blank.pIdx, 2, 'a literal clause must not consume a placeholder');
  assert.deepEqual(blankParams, []);

  const exactParams = [];
  const exact = buildModeWhere('RTGS', exactParams, 2);
  assert.match(exact.clause, /u\.payment_mode = \$2/);
  assert.equal(exact.pIdx, 3);
  assert.deepEqual(exactParams, ['RTGS']);
  // A mode is never interpolated into SQL, whatever it contains.
  const injectionParams = [];
  const injection = buildModeWhere("' OR 1=1 --", injectionParams, 2);
  assert.match(injection.clause, /u\.payment_mode = \$2/);
  assert.deepEqual(injectionParams, ["' OR 1=1 --"]);
});
