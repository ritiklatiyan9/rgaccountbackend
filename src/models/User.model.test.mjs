import test from 'node:test';
import assert from 'node:assert/strict';
import userModel from './User.model.js';

const queryPool = (expectedParam, row) => ({
  async query(query, params) {
    assert.match(query, /lower\(btrim\(email\)\) = \$1/);
    assert.deepEqual(params, [expectedParam]);
    return { rows: row ? [row] : [] };
  },
});

test('findByEmail ignores surrounding whitespace and email case', async () => {
  const expected = { id: 8, email: 'user@example.com' };
  const actual = await userModel.findByEmail(
    '  User@Example.COM  ',
    queryPool('user@example.com', expected)
  );

  assert.equal(actual, expected);
});

test('findByLoginIdentifier accepts a numeric user ID', async () => {
  const expected = { id: 8 };
  const pool = {
    async query(query, params) {
      assert.match(query, /WHERE id = \$1/);
      assert.deepEqual(params, [8]);
      return { rows: [expected] };
    },
  };

  assert.equal(await userModel.findByLoginIdentifier(' 8 ', pool), expected);
});

test('findByLoginIdentifier accepts the displayed #ID format', async () => {
  const expected = { id: 8 };
  const pool = {
    async query(query, params) {
      assert.match(query, /WHERE id = \$1/);
      assert.deepEqual(params, [8]);
      return { rows: [expected] };
    },
  };

  assert.equal(await userModel.findByLoginIdentifier('#008', pool), expected);
});

test('findByLoginIdentifier falls back to normalized email lookup', async () => {
  const expected = { id: 8, email: 'user@example.com' };
  const actual = await userModel.findByLoginIdentifier(
    ' User@Example.COM ',
    queryPool('user@example.com', expected)
  );

  assert.equal(actual, expected);
});

test('findByLoginIdentifier rejects empty and invalid numeric identifiers without querying', async () => {
  const pool = { query: () => assert.fail('database should not be queried') };

  assert.equal(await userModel.findByLoginIdentifier('   ', pool), undefined);
  assert.equal(await userModel.findByLoginIdentifier('#0', pool), undefined);
  assert.equal(await userModel.findByLoginIdentifier('999999999999999999999999', pool), undefined);
});
