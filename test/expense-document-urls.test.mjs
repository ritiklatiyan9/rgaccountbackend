import test from 'node:test';
import assert from 'node:assert/strict';
import pool from '../src/config/db.js';
import { expenseModel } from '../src/models/Expense.model.js';
import { createExpense, updateExpense, getExpense } from '../src/controllers/expense.controller.js';
import { getExpensesPageData } from '../src/graphql/services/expenses.service.js';
import {
  durableExpenseDocumentUrl, expenseDocumentColumns, signExpenseDocumentUrl, signExpenseDocuments,
} from '../src/utils/expenseDocumentUrls.js';

Object.assign(process.env, {
  AWS_S3_BUCKET_NAME: 'private-expense-test', AWS_REGION: 'us-east-1',
  AWS_ACCESS_KEY_ID: 'test-key', AWS_SECRET_ACCESS_KEY: 'test-secret',
});
const bill = 'https://private-expense-test.s3.us-east-1.amazonaws.com/vouchers/bill.pdf';
const invoke = (handler, body = {}) => new Promise((resolve, reject) => {
  const res = { status() { return this; }, json: resolve };
  handler({ body, params: { id: '42' }, user: { id: 12, role: 'admin' } }, res, reject);
});

test('private bill links are signed and expired signatures are replaced', async () => {
  const signed = await signExpenseDocumentUrl(`${bill}?X-Amz-Signature=expired#page=1`);
  assert.match(signed, /X-Amz-Signature=/);
  assert.match(signed, /X-Amz-Expires=3600/);
  assert.ok(!signed.includes('expired'));
  assert.equal(durableExpenseDocumentUrl(signed), bill);
});

test('expense fields cannot obtain signed links for KYC, foreign buckets, or lookalike hosts', async () => {
  for (const url of [
    bill.replace('/vouchers/', '/kyc_documents/'),
    bill.replace('private-expense-test', 'foreign-bucket'),
    bill.replace('amazonaws.com', 'amazonaws.com.attacker.test'),
    'https://example.test/photo.jpg?version=2',
  ]) assert.equal(await signExpenseDocumentUrl(url), url);
});

test('saving signed evidence keeps durable lists and their single-file mirrors', () => {
  assert.deepEqual(expenseDocumentColumns('bill_urls', 'bill_url', [` ${bill}?X-Amz-Signature=old `, null, '']), {
    bill_urls: [bill], bill_url: bill,
  });
  assert.deepEqual(expenseDocumentColumns('bill_urls', 'bill_url', []), { bill_urls: [], bill_url: null });
  assert.deepEqual(expenseDocumentColumns('bill_urls', 'bill_url', undefined, bill), { bill_urls: [bill], bill_url: bill });
});

test('response signing preserves upload order, mirrors, nulls and the original record', async () => {
  const expense = { bill_url: bill, bill_urls: [bill, 'https://example.test/b2.pdf'], voucher_urls: [], voucher_url: null };
  const before = structuredClone(expense);
  const calls = [];
  const result = await signExpenseDocuments(expense, async url => { calls.push(url); return `${url}?fresh=1`; });
  assert.equal(result.bill_url, result.bill_urls[0]);
  assert.deepEqual(result.bill_urls, [`${bill}?fresh=1`, 'https://example.test/b2.pdf?fresh=1']);
  assert.deepEqual(result.voucher_urls, []);
  assert.equal(result.voucher_url, null);
  assert.deepEqual(calls, [bill, 'https://example.test/b2.pdf']);
  assert.deepEqual(expense, before);
});

test('expense create and update never persist temporary credentials in document columns', async t => {
  t.mock.method(pool, 'query', async () => { throw new Error('Unexpected database query'); });
  t.mock.method(expenseModel, 'findById', async () => ({ id: 42, created_by: 12, status: 'pending' }));
  const saved = [];
  t.mock.method(expenseModel, 'create', async data => { saved.push(data); return { id: 42, ...data }; });
  t.mock.method(expenseModel, 'update', async (id, data) => { saved.push(data); return { id, ...data }; });
  const signed = await signExpenseDocumentUrl(bill);
  const created = await invoke(createExpense, { site_id: 5, debit: 1, bill_urls: [signed] });
  const updated = await invoke(updateExpense, { bill_urls: [created.expense.bill_url] });
  for (const data of saved) {
    assert.deepEqual(data.bill_urls, [bill]);
    assert.equal(data.bill_url, bill);
  }
  assert.match(updated.expense.bill_url, /X-Amz-Signature=/);
});

test('REST detail and GraphQL list reads sign persisted PDFs without mutating model rows', async t => {
  const record = { id: 42, created_by: 12, bill_url: bill, bill_urls: [bill] };
  t.mock.method(expenseModel, 'findById', async () => record);
  t.mock.method(expenseModel, 'findPaginatedUnified', async () => ({ items: [record], totalItems: 1 }));
  t.mock.method(pool, 'query', async () => ({ rows: [{ name: 'Test site' }] }));
  const detail = await invoke(getExpense);
  const page = await getExpensesPageData(5);
  for (const item of [detail.expense, page.expenses[0]]) {
    assert.match(item.bill_url, /X-Amz-Signature=/);
    assert.equal(item.bill_url, item.bill_urls[0]);
  }
  assert.equal(record.bill_url, bill);
  assert.deepEqual(record.bill_urls, [bill]);
});
