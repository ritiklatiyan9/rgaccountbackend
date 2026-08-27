import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as XLSX from '@e965/xlsx';
import {
  BankStatementParseError,
  decimalToMinorUnits,
  parseBankStatement,
} from '../src/services/bankStatementParser.service.js';

function workbookBuffer(rows, sheetName = 'Bank_Statement') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

test('parses common statement headers, dates, exact decimals, and string cheque numbers', () => {
  const buffer = workbookBuffer([
    ['Transaction ID', 'Transaction Date', 'Value Date', 'Narration', 'Cheque No', 'Debit Amount', 'Credit Amount', 'Balance', 'Account Suffix', 'Branch'],
    ['TX-1', '27/08/2026', '28/08/2026', 'CTS CLEARING CHQ 001234', '001234', '1,250.50', '', '99,000.25', '0042', 'Main'],
    ['TX-2', '2026-08-29', '', 'CHQ RETURN 778899', '778899', '', 4000, 95000.25, '0042', 'Main'],
  ]);
  const parsed = parseBankStatement(buffer, 'statement.xlsx');
  assert.equal(parsed.sheetName, 'Bank_Statement');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].normalized.transaction_date, '2026-08-27');
  assert.equal(parsed.rows[0].normalized.value_date, '2026-08-28');
  assert.equal(parsed.rows[0].normalized.cheque_reference, '001234');
  assert.equal(parsed.rows[0].normalized.debit, '1250.50');
  assert.equal(parsed.rows[0].normalized.credit, null);
  assert.equal(parsed.rows[1].normalized.credit, '4000.00');
  assert.equal(parsed.parseErrorCount, 0);
  assert.match(parsed.fileHash, /^[a-f0-9]{64}$/);
});

test('parses the exact Mount Valley Bank_Statement sheet with punctuation headers and correct Excel dates', (t) => {
  const fixturePath = process.env.MOUNT_VALLEY_FIXTURE_PATH
    || path.join(os.homedir(), 'Downloads', 'Mount_Valley_Residency_AI_Reconciliation_10_Cases.xlsx');
  if (!existsSync(fixturePath)) return t.skip(`Fixture not found: ${fixturePath}`);
  const parsed = parseBankStatement(readFileSync(fixturePath), path.basename(fixturePath));
  assert.equal(parsed.sheetName, 'Bank_Statement');
  assert.equal(parsed.rows.length, 10);
  assert.equal(parsed.parseErrorCount, 0);
  assert.deepEqual(parsed.rows[0].normalized, {
    transaction_date: '2026-08-20', value_date: '2026-08-20',
    narration: 'CTS CLEARING CHQ 123456 RAKESH KUMAR PLOT-B8',
    transaction_reference: 'MV-BNK-0001', cheque_reference: '123456',
    debit: null, credit: '500000.00', balance: '5500000.00',
    debit_minor: null, credit_minor: '50000000', account_suffix: '4412', branch: 'MUZAFFARNAGAR',
  });
  assert.equal(parsed.rows[1].normalized.transaction_date, '2026-08-21');
  assert.equal(parsed.rows[1].normalized.cheque_reference, '654321');
  assert.equal(parsed.rows[2].normalized.cheque_reference, '');
  assert.equal(parsed.rows[8].normalized.transaction_date, '2026-08-27');
  assert.equal(parsed.rows[8].normalized.cheque_reference, '246810');
  assert.equal(parsed.rows[9].normalized.transaction_date, '2026-08-27');
  assert.equal(parsed.rows[9].normalized.cheque_reference, '135790');
  assert.deepEqual(parsed.mappedHeaders._raw_headers.slice(0, 5), ['Transaction ID', 'Txn Date', 'Value Date', 'Description / Narration', 'Cheque / Reference No.']);
});

test('marks malformed and duplicate transactions independently without shifting columns', () => {
  const buffer = workbookBuffer([
    ['Date', 'Description', 'Cheque Number', 'Debit', 'Credit'],
    ['', 'Missing date', '1001', 100, ''],
    ['27/08/2026', 'Repeated row', '1002', 200, ''],
    ['27/08/2026', 'Repeated row', '1002', 200, ''],
  ], 'Statement');
  const parsed = parseBankStatement(buffer);
  assert.equal(parsed.rows.length, 3);
  assert.deepEqual(parsed.rows[0].errors, ['Transaction date is missing or invalid']);
  assert.ok(parsed.rows[1].errors.includes('Duplicate transaction row in this statement'));
  assert.ok(parsed.rows[2].errors.includes('Duplicate transaction row in this statement'));
  assert.equal(parsed.parseErrorCount, 3);
});

test('returns raw headers and source values when required Bank_Statement mappings are missing', () => {
  const buffer = workbookBuffer([
    ['Transaction ID', 'Txn Date', 'Value Date', 'Details Not Recognised', 'Reference Not Recognised', 'Debit', 'Credit', 'Balance', 'Account Last 4', 'Branch'],
    ['MV-BNK-ERR-1', '20/08/2026', '20/08/2026', 'RAW BANK NARRATION', '009999', '', 100, 1000, '4412', 'MUZAFFARNAGAR'],
  ]);
  const parsed = parseBankStatement(buffer);
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.parseErrorCount, 1);
  assert.match(parsed.rows[0].errors.join(' '), /narration, cheque_reference/);
  assert.match(parsed.rows[0].errors.join(' '), /Raw headers: Transaction ID \| Txn Date/);
  assert.equal(parsed.rows[0].raw['Details Not Recognised'], 'RAW BANK NARRATION');
  assert.equal(parsed.rows[0].raw['Reference Not Recognised'], '009999');
});

test('rejects duplicate headers, corrupt workbooks, and missing required mappings', () => {
  const duplicate = workbookBuffer([
    ['Date', 'Date', 'Narration', 'Debit'],
    ['27/08/2026', '27/08/2026', 'CHQ 1', 100],
  ]);
  assert.throws(() => parseBankStatement(duplicate), (error) => error instanceof BankStatementParseError && error.code === 'DUPLICATE_HEADERS');
  assert.throws(() => parseBankStatement(Buffer.from('not-a-workbook')), BankStatementParseError);
  const missing = workbookBuffer([['Name', 'Notes'], ['A', 'B']]);
  assert.throws(() => parseBankStatement(missing), (error) => error.code === 'HEADERS_NOT_FOUND');
});

test('converts monetary input to exact integer minor units', () => {
  assert.equal(decimalToMinorUnits('₹1,23,456.78'), 12345678n);
  assert.equal(decimalToMinorUnits('(12.345)'), -1235n);
  assert.equal(decimalToMinorUnits('0.004'), 0n);
  assert.equal(decimalToMinorUnits('not money'), null);
});
