import assert from 'node:assert/strict';
import test from 'node:test';
import pool from '../src/config/db.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { dayBookModel } from '../src/models/DayBook.model.js';
import { imprestLedgerModel, imprestExpenseRequestModel } from '../src/models/Imprest.model.js';
import { createExpenseFromImprest, createExpenseRequest, approveExpenseRequest } from '../src/controllers/imprest.controller.js';

function invoke(handler, body, user = { id: 12, role: 'sub_admin' }) {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(value) { status = value; return this; },
      json(data) { resolve({ status, data }); return this; },
    };
    handler({ body, user, params: { id: '7' }, imprestSiteId: 5 }, res, reject);
  });
}

function connection(t) {
  const queries = [];
  const db = {
    async query(sql) {
      queries.push(sql);
      return { rows: sql.includes('FROM users u') ? [{ id: 12, role: 'sub_admin' }] : [] };
    },
    release() {},
  };
  t.mock.method(pool, 'connect', async () => db);
  // Any unmocked pool query would reach the real database; fail instead.
  t.mock.method(pool, 'query', async () => { throw new Error('Unexpected database access'); });
  return { db, queries };
}

test('bank and electronic imprest expenses are rejected before storage or database work', async (t) => {
  t.mock.method(pool, 'connect', async () => { throw new Error('Must reject before connecting'); });
  t.mock.method(pool, 'query', async () => { throw new Error('Must reject before querying'); });
  for (const payment_mode of ['BANK', 'UPI', 'NEFT', 'CHEQUE', ' bank ']) {
    for (const handler of [createExpenseFromImprest, createExpenseRequest]) {
      const result = await invoke(handler, { site_id: 5, debit: 100, amount: 100, payment_mode, request_type: 'EXPENSE' });
      assert.equal(result.status, 400);
      assert.equal(result.data.code, 'IMPREST_CASH_ONLY');
    }
  }
});

test('cash expenses default missing modes to CASH and never store bank details', async (t) => {
  const { db, queries } = connection(t);
  t.mock.method(imprestLedgerModel, 'getBalance', async () => 5000);
  const saved = [];
  t.mock.method(expenseModel, 'create', async (data, client) => {
    assert.equal(client, db);
    saved.push(data);
    return { id: 1, ...data };
  });
  for (const payment_mode of [undefined, '', '  ', 'cash', ' CASH ']) {
    const result = await invoke(createExpenseFromImprest, {
      site_id: 5, debit: 100, payment_mode, account_no: 'ignored', branch: 'ignored',
    });
    assert.equal(result.status, 201);
    assert.equal(saved.at(-1).payment_mode, 'CASH');
    assert.equal(saved.at(-1).account_no, null);
    assert.equal(saved.at(-1).branch, null);
  }
  assert.equal(queries.filter((sql) => sql === 'COMMIT').length, 5);
});

test('new imprest expense requests store cash mode even when omitted', async (t) => {
  connection(t);
  let saved;
  t.mock.method(imprestExpenseRequestModel, 'create', async (data) => { saved = data; return { id: 7, ...data }; });
  const result = await invoke(createExpenseRequest, { site_id: 5, debit: 100, request_type: 'EXPENSE' });
  assert.equal(result.status, 201);
  assert.equal(JSON.parse(saved.expense_data).payment_mode, 'CASH');
});

test('approval rolls back legacy bank expenses instead of posting them as imprest', async (t) => {
  const { queries } = connection(t);
  const request = {
    id: 7, sub_admin_id: 12, site_id: 5, amount: 100, status: 'PENDING', request_type: 'EXPENSE',
    expense_data: { payment_mode: 'BANK', debit: 100 },
  };
  t.mock.method(imprestExpenseRequestModel, 'findByIdForUpdate', async () => request);
  t.mock.method(imprestExpenseRequestModel, 'approveRequest', async () => request);
  t.mock.method(expenseModel, 'create', async () => { throw new Error('Bank expense must not be posted'); });
  const result = await invoke(approveExpenseRequest, {}, { id: 1, role: 'admin' });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'IMPREST_CASH_ONLY');
  assert.equal(queries.at(-1), 'ROLLBACK');
  assert.equal(queries.includes('COMMIT'), false);
});

test('approval posts legacy expenses with missing mode as cash in the request site', async (t) => {
  const { queries } = connection(t);
  const request = {
    id: 7, sub_admin_id: 12, site_id: 5, amount: 100, status: 'PENDING', request_type: 'EXPENSE',
    expense_data: { site_id: 999, debit: 100, account_no: 'ignored' },
  };
  t.mock.method(imprestExpenseRequestModel, 'findByIdForUpdate', async () => request);
  t.mock.method(imprestExpenseRequestModel, 'approveRequest', async () => request);
  const saved = [];
  t.mock.method(expenseModel, 'create', async (data) => { saved.push(data); return { id: 1, ...data }; });
  t.mock.method(dayBookModel, 'create', async (data) => { saved.push(data); return { id: 2, ...data }; });
  t.mock.method(imprestLedgerModel, 'getBalance', async () => 4900);
  const result = await invoke(approveExpenseRequest, {}, { id: 1, role: 'admin' });
  assert.equal(result.status, 200);
  assert.equal(saved.length, 2);
  for (const row of saved) {
    assert.equal(row.site_id, 5);
    assert.equal(row.payment_mode, 'CASH');
    assert.equal(row.account_no, null);
  }
  assert.equal(queries.at(-1), 'COMMIT');
});
