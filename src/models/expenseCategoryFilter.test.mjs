import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCategoryWhere } from './Expense.model.js';

test('multiple categories are OR-combined so all of them render', () => {
  const params = ['site'];
  const { clause, pIdx } = buildCategoryWhere(['FUEL', 'LABOUR', 'RENT'], undefined, params, 2);
  assert.equal(clause, ` AND (u.category ILIKE $2 OR u.category ILIKE $3 OR u.category ILIKE $4)`);
  assert.deepEqual(params, ['site', '%FUEL%', '%LABOUR%', '%RENT%']);
  assert.equal(pIdx, 5);
});

test('UNCATEGORIZED joins the OR set without consuming a placeholder', () => {
  const params = [];
  const { clause, pIdx } = buildCategoryWhere(['UNCATEGORIZED', 'FUEL'], undefined, params, 2);
  assert.equal(clause, ` AND ((u.category IS NULL OR u.category = '') OR u.category ILIKE $2)`);
  assert.deepEqual(params, ['%FUEL%']);
  assert.equal(pIdx, 3);
});

test('falls back to the legacy single category, and to no clause at all', () => {
  const params = [];
  assert.deepEqual(
    buildCategoryWhere([], 'FUEL', params, 2),
    { clause: ' AND u.category = $2', pIdx: 3 },
  );
  assert.deepEqual(params, ['FUEL']);
  assert.deepEqual(buildCategoryWhere(undefined, undefined, [], 2), { clause: '', pIdx: 2 });
});
