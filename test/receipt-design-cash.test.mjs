import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_RECEIPT_DESIGN, normalizeReceiptDesign } from '../src/services/receiptDesign.service.js';

test('simple cash formats, broker fields and plot detail configuration survive saving', () => {
  for (const template_id of ['cash-simple', 'cash-lined', 'cash-compact']) {
    const saved = normalizeReceiptDesign({ cash: {
      template_id,
      fields: { broker_phone: false, broker_team: false },
      detail_items: [{ key: 'plot_no', label: 'Property', sample: 'B-22', enabled: true }],
    } });
    assert.equal(saved.cash.template_id, template_id);
    assert.equal(saved.cash.fields.broker_name, true);
    assert.equal(saved.cash.fields.broker_phone, false);
    assert.equal(saved.cash.fields.broker_team, false);
    assert.deepEqual(saved.cash.detail_items.find((row) => row.key === 'plot_no'), {
      key: 'plot_no', label: 'Property', sample: 'B-22', enabled: true,
    });
    assert.deepEqual(normalizeReceiptDesign(saved), saved);
  }
});

test('legacy cash designs gain broker settings without losing customization', () => {
  const design = normalizeReceiptDesign({ cash: {
    template_id: 'copper-vintage', font_family: 'Georgia',
    fields: { organization: true, address: true, qr: false },
    content: { title: 'My Cash Receipt' },
  } });
  assert.equal(design.cash.template_id, 'copper-vintage');
  assert.equal(design.cash.content.title, 'My Cash Receipt');
  assert.equal(design.cash.fields.organization, false);
  assert.equal(design.cash.fields.address, false);
  assert.equal(design.cash.fields.qr, false);
  assert.equal(design.cash.fields.broker_name, true);
  assert.equal(design.non_cash.fields.organization, true);
  assert.equal(design.cheque.fields.organization, true);
  assert.equal(DEFAULT_RECEIPT_DESIGN.cash.template_id, 'cash-simple');
});
