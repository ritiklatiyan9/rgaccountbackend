import assert from 'node:assert/strict';
import test from 'node:test';
import { registryPaymentFromMetres, registryMetresFromGaz } from '../src/utils/registryPayment.js';

test('Registry Payment uses rounded square metres times Circle Rate', () => {
  assert.equal(registryMetresFromGaz(130.56), 109.2);
  assert.equal(registryPaymentFromMetres(109.2, 7000), 764400);
  assert.equal(registryPaymentFromMetres('100.125', '3456.75'), 346107.09);
  assert.equal(registryPaymentFromMetres('', 7000), null);
  assert.equal(registryPaymentFromMetres(109.2, 0), null);
});
