import assert from 'node:assert/strict';
import test from 'node:test';
import { registryPaymentFromMetres, registryMetresFromGaz } from '../src/utils/registryPayment.js';

test('Registry Payment rounds square metres times Circle Rate up to ₹1,000', () => {
  assert.equal(registryMetresFromGaz(130.56), 109.2004);
  assert.equal(registryMetresFromGaz(36.67), 30.6708);
  assert.equal(registryPaymentFromMetres(109.2, 7000), 765000);
  assert.equal(registryPaymentFromMetres('100.125', '3456.75'), 347000);
  assert.equal(registryPaymentFromMetres(100, 7000), 700000);
  assert.equal(registryPaymentFromMetres(1.000001, 1000), 2000);
  assert.equal(registryPaymentFromMetres('', 7000), null);
  assert.equal(registryPaymentFromMetres(109.2, 0), null);
});
