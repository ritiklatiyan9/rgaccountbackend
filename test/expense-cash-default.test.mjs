import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { createExpense, updateExpense } from '../src/controllers/expense.controller.js';

const invoke = (handler, body) => new Promise((resolve, reject) => {
  const res = { status() { return this; }, json: resolve };
  handler({ body, params: { id: '24365' }, user: { id: 12, role: 'admin' } }, res, reject);
});

test('expense creation defaults blank modes to cash and preserves the authenticated creator', async t => {
  t.mock.method(pool, 'query', async () => { throw new Error('Unexpected database query'); });
  t.mock.method(expenseModel, 'create', async data => data);
  for (const payment_mode of [undefined, null, '', '  ', 'cash', ' CASH ']) {
    const { expense } = await invoke(createExpense, { site_id: 5, debit: 710, payment_mode, created_by: 7 });
    assert.equal(expense.payment_mode, 'CASH');
    assert.equal(expense.created_by, 12);
    assert.equal(expense.status, 'pending');
  }
  for (const mode of ['BANK', 'UPI', 'NEFT', 'CHEQUE', 'ADJUST']) {
    const { expense } = await invoke(createExpense, { site_id: 5, debit: 710, payment_mode: mode.toLowerCase() });
    assert.equal(expense.payment_mode, mode);
  }
});

test('expense edits cannot clear a cash mode and attachment edits preserve the instrument', async t => {
  t.mock.method(pool, 'query', async () => { throw new Error('Unexpected database query'); });
  t.mock.method(expenseModel, 'findById', async () => ({ id: 24365, status: 'pending', created_by: 12 }));
  const saved = [];
  t.mock.method(expenseModel, 'update', async (id, data) => { saved.push(data); return { id, ...data }; });
  for (const payment_mode of [null, '', '  ', 'CASH']) {
    await invoke(updateExpense, { payment_mode });
    assert.equal(saved.at(-1).payment_mode, 'CASH');
  }
  await invoke(updateExpense, { payment_mode: ' upi ' });
  assert.equal(saved.at(-1).payment_mode, 'UPI');
  await invoke(updateExpense, { bill_url: 'test-bill.pdf' });
  assert.equal(Object.hasOwn(saved.at(-1), 'payment_mode'), false);
});
