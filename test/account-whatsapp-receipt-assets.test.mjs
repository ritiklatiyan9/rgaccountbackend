import test from 'node:test';
import assert from 'node:assert/strict';
import { accountWhatsAppReceiptVerifyUrl, renderAccountWhatsAppReceipt } from '../src/services/accountWhatsAppDocuments.js';
import { verifyReceiptToken } from '../src/utils/receiptToken.js';

const recorded = {
  source_id: 40, receipt_module: 'plot_payment', site_id: 1,
  full_name: 'Recorded Buyer', site_name: 'OM ASSOCIATES', site_city: 'Ghaziabad', site_state: 'Uttar Pradesh',
  receipt_no: 'ACK-40', plot_no: 'A12', amount: 100000.25,
  payment_mode: 'BANK', payment_date: '2026-10-23',
};

test('receipt verification signs the native payment identity and current recorded display facts', () => {
  for (const [event, receipt_module, source_id, dr] of [
    ['PAYMENT_RECEIVED', 'plot_payment', 40, 'IN'],
    ['PAYMENT_SENT', 'plot_payment', 40, 'OUT'],
    ['INSTALLMENT_RECEIVED', 'plot_installment_payment', 60, 'IN'],
  ]) {
    const data = { ...recorded, receipt_module, source_id, amount: event === 'PAYMENT_SENT' ? -100000.25 : 100000.25 };
    const url = new URL(accountWhatsAppReceiptVerifyUrl(event, data));
    const result = verifyReceiptToken(url.searchParams.get('token'));
    assert.equal(result.valid, true);
    assert.deepEqual(result.payload, {
      t: 'PLT', i: `${receipt_module}_${source_id}`, a: 100000.25, dr,
      d: recorded.payment_date, pm: 'BANK', pn: 'Recorded Buyer', pl: 'A12',
      sn: 'OM ASSOCIATES', sy: 'Ghaziabad', ss: 'Uttar Pradesh',
    });
  }
  for (const data of [
    { ...recorded, source_id: null },
    { ...recorded, source_id: -1 },
    { ...recorded, source_id: 1.5 },
    { ...recorded, receipt_module: 'plot_installment_payment' },
  ]) assert.equal(accountWhatsAppReceiptVerifyUrl('PAYMENT_RECEIVED', data), '');
  assert.equal(accountWhatsAppReceiptVerifyUrl('CLIENT_ONBOARDED', recorded), '');
});

test('actual PDFs embed a verification QR only when enabled; fictional approval samples stay unverified', async () => {
  const design = { non_cash: { fields: { qr: true, customer_signature: false, authority_signature: false, evidence: false } } };
  const actual = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', recorded, { design });
  assert.match(actual.toString('latin1'), /\/Subtype \/Image/, 'the recorded receipt includes a real QR image');
  const sample = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', recorded, { design, sample: true });
  assert.doesNotMatch(sample.toString('latin1'), /\/Subtype \/Image/, 'sample data never becomes a signed receipt');
  design.non_cash.fields.qr = false;
  const disabled = await renderAccountWhatsAppReceipt('PAYMENT_RECEIVED', recorded, { design });
  assert.doesNotMatch(disabled.toString('latin1'), /\/Subtype \/Image/, 'the applied receipt design controls the QR');
});
