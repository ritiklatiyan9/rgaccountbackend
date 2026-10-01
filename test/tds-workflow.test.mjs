import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultTdsWorkflow, parseTdsWorkflow, parsePaymentTds, commissionTdsModule } from '../src/services/tdsWorkflow.service.js';

const config = { enabled: true, section: '194H', rate: 2 };
test('one lakh at 2% stores only 98,000 as cash and 2,000 as withheld TDS', () => {
  const result = parsePaymentTds({ amount: '100000', tds_applicable: true }, config);
  assert.deepEqual(result, { amount: 98000, tds_amount: 2000, tds_mode: 'percentage', tds_rate: 2, tds_section: '194H' });
  assert.equal(result.amount + result.tds_amount, 100000);
  assert.equal(parsePaymentTds({ amount: '1234.56', tds_applicable: true }, config).tds_amount, 24.69);
});
test('manual deduction and refunds preserve cash separately from settlement', () => {
  const manual = parsePaymentTds({ amount: 100000, tds_applicable: true, tds_mode: 'manual', tds_amount: 2500 }, config);
  assert.equal(manual.amount, 97500); assert.equal(manual.tds_rate, 2.5);
  assert.equal(parsePaymentTds({ amount: -98000, tds_applicable: false }, config).amount, -98000);
  assert.throws(() => parsePaymentTds({ amount: -10, tds_applicable: true }, config), /outgoing/);
});
test('disabled modules reject new deductions while preserving existing snapshots', () => {
  const existing = { amount: 98000, tds_amount: 2000, tds_rate: 2, tds_section: '194H', tds_mode: 'percentage' };
  assert.throws(() => parsePaymentTds({ amount: 100000, tds_applicable: true }, { ...config, enabled: false }), /Enable/);
  assert.deepEqual(parsePaymentTds({ remarks: 'changed' }, { ...config, enabled: false }, existing), existing);
  assert.throws(() => parsePaymentTds({ amount: 98000 }, config, existing), /gross/);
  assert.equal(parsePaymentTds({ amount: 100000, tds_applicable: true }, { ...config, enabled: false }, existing).tds_amount, 2000);
});
test('invalid values cannot create negative, non-finite or excessive TDS', () => {
  const base = { amount: 100000, tds_applicable: true };
  for (const patch of [{ amount: 'abc' }, { amount: Infinity }, { amount: 0 }, { tds_applicable: 'false' },
    { tds_rate: 0 }, { tds_rate: '' }, { tds_rate: 101 }, { tds_rate: 'abc' }, { tds_rate: 100 },
    { tds_mode: 'unknown' }, { tds_section: 'bad' }, { tds_mode: 'manual', tds_amount: '' },
    { tds_mode: 'manual', tds_amount: 100001 }, { tds_mode: 'manual', tds_amount: -10 }]) {
    assert.throws(() => parsePaymentTds({ ...base, ...patch }, config), undefined, JSON.stringify(patch));
  }
});
test('each supported module has its own validated settings', () => {
  const modules = defaultTdsWorkflow(); assert.equal(Object.keys(modules).length, 3);
  assert.equal(commissionTdsModule({ plot_id: 1 }), 'plot_commission');
  assert.equal(commissionTdsModule({ farmer_id: 1 }), 'land_purchase_commission');
  assert.equal(commissionTdsModule({ land_deal_id: 1 }), 'land_sale_commission');
  modules.plot_commission.enabled = true;
  assert.equal(parseTdsWorkflow({ modules }).plot_commission.enabled, true);
  assert.equal(parseTdsWorkflow({ modules }).land_sale_commission.enabled, false);
  assert.throws(() => parseTdsWorkflow({ modules: { ...modules, expenses: config } }), /Unsupported/);
  for (const patch of [{ enabled: 'yes' }, { rate: '' }, { rate: 101 }, { section: 'bad' }])
    assert.throws(() => parseTdsWorkflow({ modules: { ...modules, plot_commission: { ...config, ...patch } } }));
});
