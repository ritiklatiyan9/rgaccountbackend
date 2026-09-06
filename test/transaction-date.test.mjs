import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { currentTransactionDate, enforceTransactionDate, transactionDateTarget, transactionDateEditable, protectProposedTransactionDate } from '../src/services/transactionDate.service.js';

const now = new Date('2026-09-06T19:00:00Z');
const fakeDb = (editable = false, existingDate = '2024-02-29') => {
  const calls = [];
  return { calls, query: async (sql, params) => {
    calls.push({ sql, params });
    assert.match(sql, /^SELECT /, 'the date policy never modifies stored records');
    return { rows: sql.includes('application_settings') ? editable === undefined ? [] : [{ setting_value: editable }] : [{ site_id: 8, existing_date: existingDate }] };
  } };
};
const request = (path, body = {}, method = 'POST') => ({ originalUrl: path, body, method, user: { id: 1 } });

test('server today uses IST and absent settings preserve editable behavior', async () => {
  assert.equal(currentTransactionDate(now), '2026-09-07');
  assert.equal(currentTransactionDate(new Date('2026-09-06T18:29:59Z')), '2026-09-06');
  assert.equal(await transactionDateEditable(8, { query: async () => ({ rows: [] }) }), true);
  assert.equal(await transactionDateEditable(8, fakeDb(true)), true);
  assert.equal(await transactionDateEditable(8, fakeDb('FALSE')), false);
  assert.equal(await transactionDateEditable(8, fakeDb({ enabled: false })), false);
});
test('all money creation routes replace submitted dates only when disabled', async () => {
  const paths = ['/daybook', '/expenses', '/commissions', '/misc-income', '/cashflow/entries', '/firms/transactions', '/plots/payments', '/registries/payments', '/plot-commission/payment', '/farmers/2/payments', '/land-deals/2/payments', '/vendors/commitments/2/payments', '/vendors/inventory/2/payments', '/plots/2/installment-payment', '/firms/transactions/firm-to-firm', '/imprest/allocations', '/imprest/expense', '/imprest/expense-requests', '/imprest/adjust'];
  for (const path of paths) {
    const target = transactionDateTarget(path);
    assert.ok(target, path);
    const date = target.date || 'date';
    const body = { site_id: 8, [date]: '2030-12-31', amount: 125, notes: 'Preserve me', due_date: '2027-01-01', cheque_date: '2028-02-02' };
    const locked = request(path, { ...body });
    await enforceTransactionDate(locked, fakeDb(false), now);
    assert.deepEqual(locked.body, { ...body, [date]: '2026-09-07' }, path);
    const editable = request(path, { ...body });
    await enforceTransactionDate(editable, fakeDb(true), now);
    assert.deepEqual(editable.body, body, path);
  }
});
test('editing preserves the original date across native and Day Book routes', async () => {
  const paths = ['/expenses/1', '/farmers/2/payments/1', '/plots/payments/1', '/registries/payments/1', '/firms/transactions/1', '/plot-commission/payment/1', '/vendors/inventory/inv-payments/1', '/daybook/expense/1', '/daybook/farmer-payment/1', '/daybook/commission/1', '/daybook/cashflow-entry/1', '/daybook/firm-transaction/1', '/daybook/plot-payment/1', '/daybook/module-entry/plot_installment_payments/1', '/daybook/module-entry/vendor_payments/1', '/daybook/module-entry/plot_commission_payments/1', '/daybook/module-entry/plot_registry_payments/1'];
  for (const path of paths) {
    const target = transactionDateTarget(path);
    assert.ok(target, path);
    const key = target.bodyDate || target.date || 'date';
    const req = request(path, { site_id: 99, [key]: '2030-01-01', amount: 200 }, 'PUT');
    const db = fakeDb(false);
    await enforceTransactionDate(req, db, now);
    assert.equal(req.body[key], '2024-02-29', path);
    assert.equal(req.body.amount, 200);
    assert.equal(db.calls.at(-1).params[0], 8, 'record site wins over a supplied site');
  }
});
test('parent ownership determines creation policy rather than a supplied site', async () => {
  const db = fakeDb(false);
  const req = request('/plots/payments', { site_id: 99, plot_id: 4, date: '2020-01-01' });
  await enforceTransactionDate(req, db, now);
  assert.match(db.calls[0].sql, /FROM plots/);
  assert.equal(db.calls.at(-1).params[0], 8);
  assert.equal(req.body.date, '2026-09-07');
});
test('imports, approvals, schedules, document dates and linked historical payments are untouched', async () => {
  for (const [path, method, body] of [
    ['/firms/transactions/bulk', 'POST', { transactions: [{ date: '2020-01-01' }] }],
    ['/expenses/1/approve', 'PUT', { date: '2020-01-01' }],
    ['/plots/1/installments', 'POST', { installments: [{ due_date: '2030-01-01' }] }],
    ['/registries/1/noc', 'PUT', { noc_date: '2020-01-01' }],
    ['/registries/payments', 'POST', { source_plot_payment_id: 3, payment_date: '2020-01-01' }],
    ['/expenses/1', 'PUT', { remarks: 'Metadata-only edit' }],
  ]) {
    const req = request(path, structuredClone(body), method); const db = fakeDb();
    await enforceTransactionDate(req, db, now);
    assert.deepEqual(req.body, body); assert.equal(db.calls.length, 0, path);
  }
});
test('approval requests cannot change saved dates after the setting is disabled', async () => {
  const proposed = { date: '2030-01-01', amount: 500 };
  await protectProposedTransactionDate('plot_payment', proposed, 8, fakeDb(false));
  assert.deepEqual(proposed, { amount: 500 });
  const enabled = { date: '2030-01-01' };
  await protectProposedTransactionDate('plot_payment', enabled, 8, fakeDb(true));
  assert.equal(enabled.date, '2030-01-01');
});
test('every transaction route installs date checks after access checks and body parsing', async () => {
  const expected = { expense: ['createExpense', 'updateExpense'], farmer: ['createPayment', 'updatePayment'], plot: ['createPayment', 'updatePayment', 'recordInstallmentPayment'], registry: ['createRegistryPayment', 'updateRegistryPayment'], vendor: ['addVendorPayment', 'updateVendorPayment', 'addInventoryPayment', 'updateInventoryPayment'], firm: ['createTransaction', 'createFirmToFirmTransfer', 'updateTransaction'], imprest: ['createAllocation', 'createExpenseFromImprest'], daybook: ['createDayBookEntry', 'updateModuleEntryFromDayBook'], commission: ['createCommission'], plotCommissionV2: ['createPlotCommissionPayment'], miscIncome: ['createEntry'], landDeal: ['createPayment'], cashflow: ['createEntry'] };
  for (const [file, handlers] of Object.entries(expected)) {
    const source = await readFile(new URL(`../src/routes/${file}.routes.js`, import.meta.url), 'utf8');
    for (const handler of handlers) assert.match(source, new RegExp(`transactionDateMiddleware, ${handler}\\)`));
  }
});

test('commission payment ownership uses the payment site, not the request-only master_id name', async () => {
  const db = fakeDb(false);
  await enforceTransactionDate(request('/plot-commission/payment/3', { date: '2030-01-01' }, 'PUT'), db, now);
  assert.match(db.calls[0].sql, /t.site_id/);
  assert.doesNotMatch(db.calls[0].sql, /t.master_id/);
});
