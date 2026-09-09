import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { validatePartnerPayment } from '../src/services/partnerPayments.service.js';

const payment = () => ({ member_id: 1, amount: '25000.25', date: '2026-01-15', payment_mode: 'CASH', request_id: randomUUID() });

test('partner payment accepts exact money, a real date and a bank for non-cash payments', () => {
  assert.equal(validatePartnerPayment(payment()).amount, '25000.25');
  assert.equal(validatePartnerPayment({ ...payment(), payment_mode: 'UPI', bank_account_id: 4 }).bankId, 4);
  assert.equal(validatePartnerPayment({ ...payment(), bank_account_id: 4 }).bankId, null);
});

test('invalid money, dates, partner IDs and modes cannot become paid transactions', () => {
  for (const amount of ['0', '-1', '1.001', 'Infinity', 'NaN', '1e6', '1,000', '10000000000000']) {
    assert.throws(() => validatePartnerPayment({ ...payment(), amount }), /positive amount/);
  }
  for (const date of ['1899-12-31', '2026-02-30', '2026-13-01', 'tomorrow', '2099-01-01']) {
    assert.throws(() => validatePartnerPayment({ ...payment(), date }), /date/);
  }
  for (const member_id of [0, -1, '1x', 1.5]) assert.throws(() => validatePartnerPayment({ ...payment(), member_id }), /partner/);
  for (const payment_mode of ['CHEQUE', 'ADJUST', 'OTHER']) assert.throws(() => validatePartnerPayment({ ...payment(), payment_mode }), /payment mode/);
  assert.throws(() => validatePartnerPayment({ ...payment(), payment_mode: 'BANK' }), /bank account/);
  assert.throws(() => validatePartnerPayment({ ...payment(), request_id: null }), /request ID/);
});
