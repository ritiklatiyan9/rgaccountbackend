import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transactionMovesMoney } from '../src/utils/transactionPosting.js';

const readSource = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');

test('the accounting policy posts credits immediately, gates debits by approval, and gates every cheque by clearance', () => {
  const cases = [
    ['pending cash credit', { direction: 'credit', status: 'pending', paymentMode: 'cash' }, true],
    ['approved cash credit', { direction: 'credit', status: 'approved', paymentMode: 'cash' }, true],
    ['rejected cash credit', { direction: 'credit', status: 'rejected', paymentMode: 'cash' }, false],
    ['pending cash debit', { direction: 'debit', status: 'pending', paymentMode: 'cash' }, false],
    ['approved cash debit', { direction: 'debit', status: 'approved', paymentMode: 'cash' }, true],
    ['pending cheque credit', { direction: 'credit', status: 'pending', paymentMode: 'cheque', chequeStatus: 'pending' }, false],
    ['cleared pending credit cheque', { direction: 'credit', status: 'pending', paymentMode: 'cheque', chequeStatus: 'cleared' }, true],
    ['cleared pending debit cheque', { direction: 'debit', status: 'pending', paymentMode: 'cheque', chequeStatus: 'cleared' }, false],
    ['cleared approved debit cheque', { direction: 'debit', status: 'approved', paymentMode: 'cheque', chequeStatus: 'cleared' }, true],
    ['bounced approved credit cheque', { direction: 'credit', status: 'approved', paymentMode: 'cheque', chequeStatus: 'bounced' }, false],
    ['cheque-status-only row', { direction: 'credit', status: 'pending', paymentMode: 'bank', chequeStatus: 'pending' }, false],
  ];

  for (const [name, input, expected] of cases) {
    assert.equal(transactionMovesMoney(input), expected, name);
  }
});

test('migration 118 installs one SQL policy and applies it independently to both ledger legs', async () => {
  const migration = await readSource('src/migrations/118_credit_first_posting.js');

  assert.match(migration, /CREATE OR REPLACE FUNCTION financial_transaction_posts/);
  assert.match(migration, /LOWER\(COALESCE\(TRIM\(p_direction\), ''\)\) = 'credit'/);
  assert.match(migration, /LOWER\(COALESCE\(NULLIF\(TRIM\(p_status\), ''\), 'approved'\)\) = 'approved'/);
  assert.match(migration, /UPPER\(COALESCE\(TRIM\(p_cheque_status\), ''\)\) <> 'CLEARED'/);
  assert.match(migration, /financial_transaction_posts\('debit', status, raw_mode, cheque_status\)/);
  assert.match(migration, /financial_transaction_posts\('credit', status, raw_mode, cheque_status\)/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION sync_vendor_inventory_order/);
});

test('shared frontend helpers expose effective debit and credit legs for running totals', async () => {
  const helper = await readSource('../rgaccount/src/utils/transactionPosting.js');

  assert.match(helper, /export const postedDebit/);
  assert.match(helper, /export const postedCredit/);
  assert.match(helper, /return direction === 'credit' \|\| \(direction === 'debit' && status === 'approved'\)/);
  assert.match(helper, /normalizedChequeStatus|chequeStatus/);
});
