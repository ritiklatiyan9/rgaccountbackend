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

test('plain cash formats retain small uniform text and optional fields after save and reload', () => {
  for (const template_id of ['cash-plain-note', 'cash-plain-slip', 'cash-plain-letter']) {
    const saved = normalizeReceiptDesign({ cash: {
      template_id, base_font_size: 12, heading_size: 12, amount_size: 12,
      fields: { qr: false, declaration: false, printed_at: false, evidence: false, broker_phone: false, broker_team: false },
    } });
    assert.equal(saved.cash.template_id, template_id);
    assert.equal(saved.cash.heading_size, 12);
    assert.equal(saved.cash.amount_size, 12);
    assert.equal(saved.cash.fields.qr, false);
    assert.equal(saved.cash.fields.declaration, false);
    assert.equal(saved.cash.fields.printed_at, false);
    assert.equal(saved.cash.fields.customer_signature, true);
    assert.equal(saved.cash.fields.authority_signature, true);
    assert.deepEqual(normalizeReceiptDesign(saved), saved);
    assert.deepEqual(saved.non_cash, DEFAULT_RECEIPT_DESIGN.non_cash);
    assert.deepEqual(saved.cheque, DEFAULT_RECEIPT_DESIGN.cheque);
  }
});

test('plain cash formats are exclusive to cash receipts', () => {
  const saved = normalizeReceiptDesign({
    non_cash: { template_id: 'cash-plain-note' },
    cheque: { template_id: 'cash-plain-slip' },
  });
  assert.equal(saved.non_cash.template_id, DEFAULT_RECEIPT_DESIGN.non_cash.template_id);
  assert.equal(saved.cheque.template_id, DEFAULT_RECEIPT_DESIGN.cheque.template_id);
});

test('broker labels, sample names and plot buyer settings survive normalization', () => {
  const saved = normalizeReceiptDesign({ cash: {
    name_items: [{ key: 'broker_name', label: '  Dealer  ', sample: 'Preview Broker' }],
    detail_items: [{ key: 'plot_buyer', label: 'Purchaser', sample: 'Preview Buyer', enabled: false }],
  } });
  assert.deepEqual(saved.cash.name_items[0], { key: 'broker_name', label: 'Dealer', sample: 'Preview Broker' });
  assert.equal(saved.cash.name_items.length, 3);
  assert.deepEqual(saved.cash.detail_items.find((item) => item.key === 'plot_buyer'), {
    key: 'plot_buyer', label: 'Purchaser', sample: 'Preview Buyer', enabled: false,
  });
  assert.deepEqual(normalizeReceiptDesign(saved), saved);
  assert.deepEqual(saved.non_cash, DEFAULT_RECEIPT_DESIGN.non_cash);
  assert.deepEqual(normalizeReceiptDesign({ cash: {} }).cash.name_items, DEFAULT_RECEIPT_DESIGN.cash.name_items);
});

test('plot rate joins the saved cash detail configuration with a safe default', () => {
  const saved = normalizeReceiptDesign({ cash: {
    detail_items: [{ key: 'plot_rate', label: 'Rate per sq. yd.', sample: '₹2,500', enabled: false }],
  } });
  assert.deepEqual(saved.cash.detail_items.find((item) => item.key === 'plot_rate'), {
    key: 'plot_rate', label: 'Rate per sq. yd.', sample: '₹2,500', enabled: false,
  });
  assert.deepEqual(normalizeReceiptDesign({ cash: {} }).cash.detail_items.find((item) => item.key === 'plot_rate'), {
    key: 'plot_rate', label: 'Plot Rate', sample: '₹2,000', enabled: true,
  });
});
