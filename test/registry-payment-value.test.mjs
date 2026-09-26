import assert from 'node:assert/strict';
import test from 'node:test';
import { registryPaymentFromGaz } from '../src/utils/registryPayment.js';

test('Registry Payment uses Gaz times Circle Rate, rounded to paise', () => {
  assert.equal(registryPaymentFromGaz(205.63, 7000), 1439410);
  assert.equal(registryPaymentFromGaz('100.125', '3456.75'), 346107.09);
  assert.equal(registryPaymentFromGaz('', 7000), null);
  assert.equal(registryPaymentFromGaz(205.63, 0), null);
});
