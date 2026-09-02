import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RECEIPT_DESIGN,
  RECEIPT_TEMPLATE_IDS,
  normalizeReceiptDesign,
} from '../src/services/receiptDesign.service.js';

test('cheque mode exists with its own defaults and survives normalization', () => {
  assert.equal(DEFAULT_RECEIPT_DESIGN.cheque.content.title, 'Cheque Receipt');
  assert.equal(DEFAULT_RECEIPT_DESIGN.cheque.template_id, 'teal-modern');

  // A stored design saved before the cheque mode existed gains cheque defaults.
  const legacy = normalizeReceiptDesign({ cash: {}, non_cash: {} });
  assert.equal(legacy.cheque.content.title, 'Cheque Receipt');

  // A customized cheque design round-trips instead of being stripped.
  const custom = normalizeReceiptDesign({
    cheque: { template_id: 'simple-green', content: { title: 'Cheque Ack' } },
  });
  assert.equal(custom.cheque.template_id, 'simple-green');
  assert.equal(custom.cheque.content.title, 'Cheque Ack');
});

test('frontend template catalog ids are all accepted by the backend whitelist', () => {
  for (const id of ['simple-office', 'simple-green', 'fine-line', 'receipt-book',
    'crafted-heritage', 'artisan-copper', 'sage-letterpress', 'royal-certificate']) {
    assert.ok(RECEIPT_TEMPLATE_IDS.includes(id), `${id} missing from RECEIPT_TEMPLATE_IDS`);
  }
});
