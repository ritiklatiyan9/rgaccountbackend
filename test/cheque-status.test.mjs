import assert from 'node:assert/strict';
import test from 'node:test';
import { updateChequeStatusRecord } from '../src/services/chequeStatus.service.js';

function fakeDb(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return handler(String(sql), params, calls.length);
    },
  };
}

test('shared cheque command blocks cross-site confirmation before source mutation', async () => {
  const db = fakeDb(() => ({ rows: [{ id: 10, site_id: 8, debit: '100.00', credit: '0.00', cheque_status: 'PENDING' }] }));
  await assert.rejects(
    () => updateChequeStatusRecord(db, { source: 'expense', entryId: 3, status: 'CLEARED', expectedSiteId: 6, expectedAmount: '100.00', requirePending: true }),
    (error) => error.code === 'SITE_SCOPE_MISMATCH'
  );
  assert.equal(db.calls.length, 1);
});

test('shared cheque command blocks a locked accounting period', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM cash_flow_entries')) return { rows: [{ id: 10, site_id: 6, debit: '100.00', credit: '0.00', cheque_status: 'PENDING', cash_flow_month_id: 22 }] };
    if (sql.includes('FROM cash_flow_months')) return { rows: [{ is_locked: true }] };
    return { rows: [] };
  });
  await assert.rejects(
    () => updateChequeStatusRecord(db, { source: 'expense', entryId: 3, status: 'BOUNCED', expectedSiteId: 6, expectedAmount: '100.00', requirePending: true }),
    (error) => error.code === 'ACCOUNTING_PERIOD_LOCKED'
  );
  assert.equal(db.calls.length, 2);
});

test('shared cheque command rejects stale source status under row lock', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM cash_flow_entries')) return { rows: [{ id: 10, site_id: 6, debit: '100.00', credit: '0.00', cheque_status: 'PENDING', cash_flow_month_id: null }] };
    if (sql.includes('SELECT * FROM expenses')) return { rows: [{ id: 3, cheque_status: 'CLEARED' }] };
    return { rows: [] };
  });
  await assert.rejects(
    () => updateChequeStatusRecord(db, { source: 'expense', entryId: 3, status: 'BOUNCED', expectedSiteId: 6, expectedAmount: '100.00', requirePending: true }),
    (error) => error.code === 'STALE_STATUS'
  );
});

test('shared cheque command updates the source and mirror while preserving amount fields', async () => {
  const db = fakeDb((sql) => {
    if (sql.includes('FROM cash_flow_entries')) return { rows: [{ id: 10, site_id: 6, debit: '0.00', credit: '250.00', cheque_status: 'PENDING', cash_flow_month_id: null }] };
    if (sql.includes('SELECT * FROM plot_payments')) return { rows: [{ id: 7, amount: '250.00', cheque_status: 'PENDING', cheque_no: '000007' }] };
    if (sql.includes('UPDATE plot_payments')) return { rows: [{ id: 7, amount: '250.00', cheque_status: 'CLEARED', cheque_no: '000007' }] };
    return { rows: [] };
  });
  const result = await updateChequeStatusRecord(db, {
    source: 'plot_payment', entryId: 7, status: 'CLEARED', expectedSiteId: 6, expectedAmount: '250.00', requirePending: true,
  });
  assert.equal(result.before.amount, '250.00');
  assert.equal(result.after.cheque_status, 'CLEARED');
  assert.ok(db.calls.some((call) => call.sql.includes('UPDATE cash_flow_entries')));
  assert.ok(db.calls.every((call) => !/SET\s+(?:debit|credit|amount)/i.test(call.sql)));
});
