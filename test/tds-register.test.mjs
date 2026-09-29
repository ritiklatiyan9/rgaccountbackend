import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeduction, tdsDueDate } from '../src/utils/tds.js';

const valid = { deductee_name: ' Ramesh ', pan: 'abcde1234f', aadhaar: '1234 5678 9012', section: '194H',
  deduction_date: '2025-10-15', gross_amount: '10000', tds_rate: '2', tds_amount: '200' };

test('TDS is due on the 7th of next month, March deductions on 30 April', () => {
  assert.equal(tdsDueDate('2025-10-15'), '2025-11-07');
  assert.equal(tdsDueDate('2025-12-31'), '2026-01-07');
  assert.equal(tdsDueDate('2026-03-01'), '2026-04-30');
  assert.equal(tdsDueDate('2026-02-28'), '2026-03-07');
});

test('a deduction is normalised and bad input is rejected', () => {
  const row = parseDeduction(valid);
  assert.equal(row.deductee_name, 'Ramesh');
  assert.equal(row.pan, 'ABCDE1234F');
  assert.equal(row.aadhaar, '123456789012');
  assert.equal(row.gross_amount, 10000);
  assert.equal(parseDeduction({ ...valid, pan: '', aadhaar: '' }).pan, null);
  const rejects = (patch, pattern) => assert.throws(() => parseDeduction({ ...valid, ...patch }), pattern);
  rejects({ deductee_name: '  ' }, /name/);
  rejects({ pan: 'ABCDE12345' }, /PAN/);
  rejects({ aadhaar: '1234' }, /Aadhaar/);
  rejects({ section: '194Z' }, /section/);
  rejects({ deduction_date: '2025-02-30' }, /deduction date/);
  rejects({ tds_amount: '20000' }, /TDS amount/);
  rejects({ tds_rate: '' }, /rate/);
  rejects({ deposit_date: '2025-10-01' }, /before the deduction/);
});
