import assert from 'node:assert/strict';
import test from 'node:test';
import { chequeStatusForPaymentEdit, attachChequeDates, chequeDateOnly, chequeMetadataFromOwner, currentChequeBusinessDate, validateChequeTransactionDate } from '../src/services/chequeDates.service.js';

test('clearance dates reject impossible calendar dates, timestamps and absent values', () => {
  assert.equal(validateChequeTransactionDate('2028-02-29'), '2028-02-29');
  for (const value of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2026-08-20T00:00:00Z', '', null, undefined]) {
    assert.throws(() => validateChequeTransactionDate(value), (error) => error.code === 'INVALID_CHEQUE_TRANSACTION_DATE' && error.statusCode === 400);
  }
});

test('legacy manual clearance defaults to the current Indian business date', () => {
  assert.equal(currentChequeBusinessDate(new Date('2026-10-15T20:00:00Z')), '2026-10-16');
  assert.equal(chequeDateOnly(new Date(2026, 7, 20)), '2026-08-20');
});

test('one site-scoped batch enriches module and direct cheques without changing accounting dates', async () => {
  const rows = [
    { id: 1, site_id: 8, date: '2026-08-10', payment_type: 'CHEQUE', cheque_status: 'CLEARED' },
    { id: 2, site_id: 8, date: '2026-08-12', payment_mode: 'CHEQUE', cheque_status: 'PENDING', cheque_transaction_date: '2026-08-19' },
    { id: 3, site_id: 9, entry_date: '2026-08-13', payment_mode: 'CHEQUE', cheque_status: 'CLEARED' },
    { id: 4, site_id: 8, date: '2026-08-14', payment_mode: 'BANK' },
    { id: 5, site_id: 8, date: '2026-08-15', payment_mode: 'CHEQUE', cheque_status: 'BOUNCED', cheque_transaction_date: '2026-08-19' },
  ];
  const calls = [];
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    const requested = JSON.parse(params[0]);
    assert.equal(requested.length, 2);
    assert.equal(requested[0].source_module, 'plot_payments');
    assert.equal(requested[1].ledger_id, 3);
    return { rows: requested.map((item) => ({ lookup_key: item.lookup_key, cheque_transaction_date: item.site_id === 8 ? '2026-08-21' : null })) };
  } };
  await attachChequeDates(rows, db, (row) => ({ sourceModule: row.id === 3 ? 'cash_flow_entry' : 'plot_payments', sourceId: row.id, siteId: row.site_id }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /cfe\.site_id = requested\.site_id/);
  assert.equal(rows[0].date, '2026-08-10');
  assert.equal(rows[0].cheque_apply_date, '2026-08-10');
  assert.equal(rows[0].cheque_transaction_date, '2026-08-21');
  assert.equal(rows[1].cheque_transaction_date, null);
  assert.equal(rows[2].cheque_apply_date, '2026-08-13');
  assert.equal(rows[2].cheque_transaction_date, null, 'historical unknown clearance remains unknown');
  assert.equal(Object.hasOwn(rows[3], 'cheque_apply_date'), false);
  assert.equal(rows[4].cheque_transaction_date, null);
});

test('pending-only cheque reads do not add a metadata query', async () => {
  const rows = [{ date: '2026-08-20', cheque_status: 'PENDING' }];
  await attachChequeDates(rows, { query() { throw new Error('Unexpected query'); } }, () => null);
  assert.equal(rows[0].cheque_apply_date, '2026-08-20');
  assert.equal(rows[0].cheque_transaction_date, null);
});

test('linked daily rows take cheque metadata from the owner and match ledger range dates', async () => {
  const owner = { id: 7, date: '2026-08-10', cheque_status: 'CLEARED', cheque_no: '007', amount: 250, status: 'approved' };
  const daily = {
    id: 12, date: '2026-08-11', debit: 0, credit: 250, status: 'pending', approved_by: null,
    payment_mode: 'CHEQUE', cheque_status: 'PENDING', cheque_no: 'stale', ...chequeMetadataFromOwner(owner),
  };
  const range = { id: '70:bank', entry_date: '2026-08-10', payment_mode: 'CHEQUE', cheque_status: 'CLEARED' };
  await attachChequeDates([daily, range], { async query(_sql, params) {
    return { rows: JSON.parse(params[0]).map((lookup) => ({ lookup_key: lookup.lookup_key, cheque_transaction_date: '2026-08-22' })) };
  } }, (row) => row === daily ? { sourceModule: 'plot_payments', sourceId: owner.id, siteId: 8 } : { ledgerId: 70, siteId: 8 });
  assert.equal(daily.cheque_status, 'CLEARED');
  assert.equal(daily.cheque_no, '007');
  assert.equal(daily.cheque_apply_date, range.cheque_apply_date);
  assert.equal(daily.cheque_transaction_date, range.cheque_transaction_date);
  assert.equal(daily.date, '2026-08-11', 'projection accounting date is retained');
  assert.equal(daily.status, 'pending', 'projection approval is retained');
  assert.equal(daily.credit, 250);
  const reopened = { ...daily, ...chequeMetadataFromOwner({ ...owner, cheque_status: 'PENDING', cheque_transaction_date: '2026-08-22' }) };
  await attachChequeDates([reopened], { query() { throw new Error('No read for a pending cheque'); } }, () => null);
  assert.equal(reopened.cheque_transaction_date, null, 'a preloaded old date cannot override reopened owner status');
});


test('ordinary edit resubmissions preserve lifecycle while material payment changes require re-verification', () => {
  for (const status of ['PENDING','CLEARED','BOUNCED','RETURNED']) {
    const original = { payment_mode:'cheque',date:new Date(2026,9,1),amount:'100.00',bank_name:'PNB',cheque_no:'001',cheque_status:status };
    assert.equal(chequeStatusForPaymentEdit(original,{payment_mode:'CHEQUE',date:'2026-10-01',amount:100,remarks:'Changed note',cheque_status:'CLEARED'}),status);
    for (const changed of [{amount:200},{date:'2026-10-02'},{cheque_no:'002'},{bank_name:'SBI'}]) assert.equal(chequeStatusForPaymentEdit(original,changed),'PENDING');
    assert.equal(chequeStatusForPaymentEdit(original,{payment_mode:'BANK'}),null);
  }
  assert.equal(chequeStatusForPaymentEdit({cash_type:'bank'},{cash_type:'cheque'},'cash_type'),'PENDING');
  assert.equal(chequeStatusForPaymentEdit({by_note:'CHEQUE',cheque_status:'CLEARED'},{remarks:'No financial change'},'by_note'),'CLEARED');
});
