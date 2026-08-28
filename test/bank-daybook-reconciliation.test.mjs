import assert from 'node:assert/strict';
import test from 'node:test';
import {
  candidateSnapshotHash,
  canonicalMatchedKeys,
  exactStatementCandidatePair,
  reconcileBankDaybookRows,
} from '../src/services/bankDaybookReconciliation.service.js';

const statementRow = ({ row = 2, date = '2026-08-20', debit = null, credit = '100.00', narration = 'TEST', serial = '1' } = {}) => ({
  rowNumber: row,
  raw: {},
  errors: [],
  normalized: {
    source_serial: serial,
    transaction_date: date,
    value_date: date,
    narration,
    transaction_reference: '',
    cheque_reference: '',
    debit,
    credit,
    balance: null,
    debit_minor: debit == null ? null : String(Math.round(Number(debit) * 100)),
    credit_minor: credit == null ? null : String(Math.round(Number(credit) * 100)),
  },
});

const candidate = ({
  key = 'plot_payments:1', date = '2026-08-20', direction = 'CREDIT', amount = '100.00',
  particular = 'TEST', remarks = '', entity = 'TEST CUSTOMER', inPeriod = true,
} = {}) => ({
  entry_key: key,
  ledger_id: key.split(':')[1],
  source_key: key.split(':')[0],
  source_id: Number(key.split(':')[1]),
  date,
  direction,
  amount,
  amount_minor: String(Math.round(Number(amount) * 100)),
  particular,
  remarks,
  cheque_no: '',
  entity_name: entity,
  linked_detail: '',
  bank_account_id: null,
  bank_account_name: '',
  local_position: null,
  global_position: null,
  in_statement_period: inPeriod,
});

test('automatically matches a single exact date, direction, and paise amount', () => {
  const row = statementRow();
  const erp = candidate();
  const result = reconcileBankDaybookRows([row], [erp]);
  assert.equal(result.summary.matched, 1);
  assert.equal(result.rows[0].state, 'MATCHED');
  assert.equal(result.rows[0].candidate.entry_key, erp.entry_key);
  assert.equal(result.rows[0].candidate.exact_data, true);
  assert.equal(exactStatementCandidatePair(row, erp), true);
});

test('keeps duplicate exact accounting rows in review when narration cannot distinguish them', () => {
  const rows = [
    statementRow({ row: 2, serial: '1', narration: 'BANK TRANSFER' }),
    statementRow({ row: 3, serial: '2', narration: 'BANK TRANSFER' }),
  ];
  const candidates = [
    candidate({ key: 'personal_ledger:10', particular: 'BANK', entity: 'PARTY' }),
    candidate({ key: 'personal_ledger:11', particular: 'BANK', entity: 'PARTY' }),
  ];
  const result = reconcileBankDaybookRows(rows, candidates);
  assert.equal(result.summary.matched, 0);
  assert.equal(result.summary.review, 2);
  assert.deepEqual(result.rows.map((row) => row.alternatives.length), [2, 2]);
});

test('uses a shared bank reference to resolve exact duplicate amounts one-to-one', () => {
  const rows = [
    statementRow({ row: 2, serial: '1', narration: 'UPI/ABC12345/RAMESH' }),
    statementRow({ row: 3, serial: '2', narration: 'UPI/XYZ67890/SURESH' }),
  ];
  const candidates = [
    candidate({ key: 'plot_payments:10', remarks: 'RECEIPT ABC12345', entity: 'RAMESH' }),
    candidate({ key: 'plot_payments:11', remarks: 'RECEIPT XYZ67890', entity: 'SURESH' }),
  ];
  const result = reconcileBankDaybookRows(rows, candidates);
  assert.equal(result.summary.matched, 2);
  assert.equal(result.rows[0].candidate.entry_key, 'plot_payments:10');
  assert.equal(result.rows[1].candidate.entry_key, 'plot_payments:11');
  assert.equal(new Set(result.rows.map((row) => row.candidate.entry_key)).size, 2);
});

test('never makes a different ERP date orderable even when amount and direction match', () => {
  const row = statementRow({ date: '2026-08-20' });
  const erp = candidate({ date: '2026-08-22' });
  const result = reconcileBankDaybookRows([row], [erp]);
  assert.equal(result.rows[0].state, 'DATA_MISMATCH');
  assert.equal(result.rows[0].candidate.exact_data, false);
  assert.equal(exactStatementCandidatePair(row, erp), false);
});

test('normalizes an oldest-first statement to canonical newest-first stored order', () => {
  const canonical = canonicalMatchedKeys([
    { row_number: 2, date: '2026-08-20', entry_key: 'plot_payments:1' },
    { row_number: 3, date: '2026-08-20', entry_key: 'plot_payments:2' },
    { row_number: 4, date: '2026-08-21', entry_key: 'plot_payments:3' },
  ], 'ASC');
  assert.deepEqual(canonical.map((item) => item.entry_key), [
    'plot_payments:3',
    'plot_payments:2',
    'plot_payments:1',
  ]);
});

test('candidate snapshots change when accounting data or saved order changes', () => {
  const base = candidate();
  const first = candidateSnapshotHash([base]);
  assert.notEqual(candidateSnapshotHash([{ ...base, amount_minor: '10001' }]), first);
  assert.notEqual(candidateSnapshotHash([{ ...base, global_position: 2 }]), first);
});

