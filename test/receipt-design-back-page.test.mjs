import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeReceiptDesign, DEFAULT_RECEIPT_DESIGN } from '../src/services/receiptDesign.service.js';

test('back page, letterhead lines, seal and official formats survive saving; junk is bounded', () => {
  const saved = normalizeReceiptDesign({
    non_cash: {
      template_id: 'official-invoice', fields: { seal: false },
      info_lines: [{ label: 'GSTIN', value: '09ABC' }, 'junk', ...Array(20).fill({ label: 'x', value: 'y' })],
      back_page: { enabled: true, two_columns: true, terms: 'One\nTwo', title: 'T&C', evil: '<script>' },
    },
  });
  assert.equal(saved.non_cash.template_id, 'official-invoice');
  assert.equal(saved.non_cash.fields.seal, false);
  assert.deepEqual(saved.non_cash.info_lines[0], { label: 'GSTIN', value: '09ABC' });
  assert.equal(saved.non_cash.info_lines.length, 12);
  assert.equal(saved.non_cash.back_page.enabled, true);
  assert.equal(saved.non_cash.back_page.terms, 'One\nTwo');
  assert.equal(saved.non_cash.back_page.evil, undefined);
  assert.equal(saved.cash.back_page.enabled, false);
  assert.equal(saved.cash.back_page.terms, DEFAULT_RECEIPT_DESIGN.cash.back_page.terms);
  assert.equal(saved.cash.fields.seal, true);
});
