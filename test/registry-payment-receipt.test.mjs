import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyReceiptToken } from '../src/utils/receiptToken.js';
import { withRegistryPaymentVerifyUrl } from '../src/utils/registryPaymentReceipt.js';

test('registry BANK payment receives a valid public verification URL', () => {
  const payment = withRegistryPaymentVerifyUrl({
    id: 1,
    amount: '25000',
    payment_date: '2026-08-30',
    payment_mode: 'BANK',
  }, {
    customer_name: 'TEST CUSTOMER',
    plot_no: 'A2',
    site_name: 'BALAJI ASSOCIATES',
    site_city: 'SHAMLI',
    site_state: 'UTTAR PRADESH',
  });

  const url = new URL(payment.verifyUrl);
  assert.equal(url.origin, 'https://defencegarden.com');
  assert.equal(url.pathname, '/verify-receipt');

  const verified = verifyReceiptToken(url.searchParams.get('token'));
  assert.equal(verified.valid, true);
  assert.equal(verified.payload.i, 'registry_payment_1');
  assert.equal(verified.payload.pm, 'BANK');
  assert.equal(verified.payload.sn, 'BALAJI ASSOCIATES');
});
