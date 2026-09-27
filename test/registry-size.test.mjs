import test from 'node:test';
import assert from 'node:assert/strict';
import { registrySizeFromPlot, normalizeRegistrySize } from '../src/utils/registrySize.js';

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
