import test from 'node:test';
import assert from 'node:assert/strict';
import { registrySizeFromPlot, registryFinanceFromPlot, normalizeRegistrySize } from '../src/utils/registrySize.js';

test('master plot values replace stale registry sizes on list and detail responses', () => {
  const row = { size_source_plot_id: 2, source_plot_size: '130.56', source_plot_size_mtr: '109.3333', source_unit_type: 'plot', size_sqyard: '156.15', size_meter: '130.6', registry_payment: 787000 };
  const result = normalizeRegistrySize(row);
  assert.equal(result.size_sqyard, 130.56);
  assert.equal(result.size_meter, 109.3333);
  assert.equal(result.registry_payment, 787000);
  assert.equal(result.source_plot_size, undefined);
});
test('creation uses master plot sizes and preserves flat units', () => {
  assert.deepEqual(registrySizeFromPlot({ plot_size: 900, plot_size_mtr: 83.6127, unit_type: 'flat' }), { size_sqyard: 100, size_meter: 83.6127 });
  assert.deepEqual(registrySizeFromPlot({ plot_size: 900, unit_type: 'flat' }), { size_sqyard: 100, size_meter: 83.6127 });
  assert.deepEqual(registrySizeFromPlot({ plot_size: 130.56 }), { size_sqyard: 130.56, size_meter: 109.2004 });
  assert.deepEqual(registrySizeFromPlot({ plot_size: 36.67 }), { size_sqyard: 36.67, size_meter: 30.6708 });
  const legacy = { size_sqyard: 100, size_meter: 83.64 };
  assert.equal(normalizeRegistrySize(legacy), legacy);
  assert.equal(normalizeRegistrySize(null), null);
});

test('list and detail use the source bank target without ceiling or stale registry rates', () => {
  const row = { size_source_plot_id: 115, source_plot_size: '235', source_plot_size_mtr: '196.49', source_to_receive_bank: '14147280.38', source_circle_rate: '72000', registry_payment: '1652000', circle_rate: '8400', bank_amount: '1652000' };
  const result = normalizeRegistrySize(row);
  assert.equal(result.registry_payment, 14147280.38);
  assert.equal(result.bank_amount, 14147280.38);
  assert.equal(result.circle_rate, 72000);
  assert.equal(result.source_to_receive_bank, undefined);
  assert.equal(row.registry_payment, '1652000');
  assert.equal(normalizeRegistrySize({ ...row, source_to_receive_bank: 0 }).registry_payment, 0);
  assert.equal(normalizeRegistrySize({ ...row, source_to_receive_bank: null }).registry_payment, 0);
  const unlinked = { size_source_plot_id: null, registry_payment: '1000', source_to_receive_bank: null };
  assert.equal(normalizeRegistrySize(unlinked), unlinked);
  assert.deepEqual(registryFinanceFromPlot({ to_receive_bank: '787000.03', circle_rate: '7206.96' }), { registry_payment: 787000.03, bank_amount: 787000.03, circle_rate: 7206.96 });
});
