import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTransferRequest } from '../src/services/siteMoneyTransfer.service.js';

const today = '2026-11-21';
const valid = { source_site_id: 5, destination_site_id: 6, source_ledger_id: '15', destination_ledger_id: '27',
  amount: '500000', mode: 'CASH', date: today, time: '14:05', approver_id: 7 };
const rejects = (patch, message) => assert.throws(() => parseTransferRequest({ ...valid, ...patch }, today), { message });

test('a valid request is normalised for storage', () => {
  assert.deepEqual(parseTransferRequest(valid, today), {
    sourceSiteId: 5, destinationSiteId: 6, amount: '500000.00', mode: 'cash', date: today, time: '14:05:00',
    approverId: 7, sourceLedgerId: 15, destinationLedgerId: 27, sourceBankId: null, destinationBankId: null, remarks: '',
  });
});

test('main-site routing requires an explicit choice for each ledger', () => {
  const input = parseTransferRequest({ ...valid, source_ledger_id: 'site', destination_ledger_id: 'site' }, today);
  assert.equal(input.sourceLedgerId, null);
  assert.equal(input.destinationLedgerId, null);
  rejects({ source_ledger_id: undefined }, 'Choose the debit ledger.');
  rejects({ destination_ledger_id: null }, 'Choose the credit ledger.');
  rejects({ destination_ledger_id: [] }, 'Choose the credit ledger.');
  rejects({ source_ledger_id: -1 }, 'Choose the debit ledger.');
  rejects({ idempotency_key: '' }, 'The transfer request key is invalid.');
});

test('bank accounts are kept only for bank transfers', () => {
  const bank = parseTransferRequest({ ...valid, mode: 'bank', source_bank_account_id: '3', destination_bank_account_id: 9 }, today);
  assert.equal(bank.sourceBankId, 3);
  assert.equal(bank.destinationBankId, 9);
  assert.equal(parseTransferRequest({ ...valid, source_bank_account_id: 3 }, today).sourceBankId, null);
});

test('money, sites, dates and modes are refused when unsafe', () => {
  rejects({ destination_site_id: 5 }, 'Choose a different receiving site.');
  rejects({ amount: '0' }, 'Enter an amount greater than zero.');
  rejects({ amount: '-10' }, 'Enter an amount greater than zero.');
  rejects({ amount: '10.555' }, 'Use a decimal amount with at most two decimal places.');
  rejects({ amount: '5,00,000' }, 'Use a decimal amount with at most two decimal places.');
  rejects({ mode: 'cheque' }, 'Choose Cash or Bank.');
  rejects({ date: '2026-11-22' }, 'The transfer date cannot be in the future.');
  rejects({ date: '2026-02-30' }, 'Choose a valid transfer date.');
  rejects({ time: '25:00' }, 'Choose a valid transfer time.');
  rejects({ approver_id: '' }, 'Choose who should approve.');
  rejects({ remarks: 'x'.repeat(1001) }, 'Keep remarks within 1000 characters.');
});
